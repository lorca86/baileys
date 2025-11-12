import fs from 'fs';
import path from 'path';
// dotenv/config ya no es necesario
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot' 
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"
import { MongoAdapter } from '@builderbot/database-mongo'; 

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008
/** ID del asistente de OpenAI */
// const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '' // Ya no leemos esto de las variables
const userQueues = new Map();
const userLocks = new Map(); 

const QR_PATH = path.join(process.cwd(), 'bot.qr.png'); 

/**
 * Function to process the user's message by sending it to the OpenAI API
 * and sending the response back to the user.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    // Lo ponemos como un string vacío ya que no lo estás usando.
    const REAL_ASSISTANT_ID = ""; 
    
    // Si no usas OpenAI, esta línea probablemente fallará,
    // pero por ahora solo queremos ver si la app arranca.
    try {
        await typing(ctx, provider);
        const response = await toAsk(REAL_ASSISTANT_ID, ctx.body, state);

        const chunks = response.split(/\n\n+/);
        for (const chunk of chunks) {
            const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
            await flowDynamic([{ body: cleanedChunk }]);
        }
    } catch (e) {
        console.error("Error llamando a OpenAI (esperado si no está configurado):", e.message);
        await flowDynamic([{ body: "Hubo un error con la IA (temporal)." }]);
    }
};

/**
 * Function to handle the queue for each user.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    
    if (userLocks.get(userId)) {
        return; 
  }

    while (queue.length > 0) {
        userLocks.set(userId, true); 
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`Error processing message for user ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); 
        }
    }

    userLocks.delete(userId); 
    userQueues.delete(userId); 
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 * @type {import('@builderbot/bot').Flow<BaileysProvider, MemoryDB>}
 */
const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from; 

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        if (!userLocks.get(userId) && queue.length === 1) {
            await handleQueue(userId);
        }
    });

/**
 * Función principal que configura y inicia el bot
 * @async
 * @returns {Promise<void>}
 */
const main = async () => {
    /**
     * Flujo del bot
     * @type {import('@builderbot/bot').Flow<BaileysProvider, MemoryDB>}
     */
    const adapterFlow = createFlow([welcomeFlow]);

    /**
     * Proveedor de servicios de mensajería
     * @type {BaileysProvider}
  A    */
    const adapterProvider = createProvider(BaileysProvider, {
        groupsIgnore: true,
        readStatus: false,
        // @ts-ignore
        qr: { 
            path: QR_PATH,
        }
    });

    /**
     * Base de datos
     */
    
    // Mantenemos la URL hardcodeada ya que probamos que es la única forma
    const HARDCODED_MONGO_URL = "mongodb+srv://baileys:L3bana!!09@cluster0.od58v3e.mongodb.net/?appName=Cluster0";
    
    const adapterDB = new MongoAdapter({ 
        dbUri: HARDCODED_MONGO_URL, 
        dbName: 'baileys_session'
    });


    /**
     * Configuración y creación del bot
     */
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB, 
    });
    
    httpInject(adapterProvider.server);

    // --- ¡ARREGLO DEFINITIVO PARA EL CRASH DEL QR! ---
    // Envolvemos todo en un try...catch para que sea 100% a prueba de fallos
    adapterProvider.server.get('/', (req, res) => {
        try {
            if (fs.existsSync(QR_PATH)) {
                res.setHeader('Content-Type', 'image/png');
                fs.createReadStream(QR_PATH).pipe(res);
            } else {
                res.status(404).send('Generando QR... por favor, refresca la página en 10 segundos.');
            }
        } catch (e) {
            console.error("Error en la ruta / (esperado si el QR se está creando):", e.message);
            res.status(500).send('Error interno, el QR se está generando. Intenta de nuevo.');
        }
    });
    // --- FIN DEL ARREGLO ---

    httpServer(+PORT);
};

main();
