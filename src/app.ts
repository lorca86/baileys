import fs from 'fs';
import path from 'path';
// "dotenv/config" HA SIDO ELIMINADO. ¡Era la causa de que 'undefined'!!
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot' 
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"
import { MongoAdapter } from '@builderbot/database-mongo'; 

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? '' // Railway inyectará esta variable
const userQueues = new Map();
const userLocks = new Map(); 

const QR_PATH = path.join(process.cwd(), 'bot.qr.png'); 

/**
 * Function to process the user's message by sending it to the OpenAI API
 * and sending the response back to the user.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    // Si no usas OpenAI, esta parte fallará.
    // Deberás reemplazarla con tu propia lógica.
    try {
        await typing(ctx, provider);
        const response = await toAsk(ASSISTANT_ID, ctx.body, state);

        const chunks = response.split(/\n\n+/);
        for (const chunk of chunks) {
            const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
            await flowDynamic([{ body: cleanedChunk }]);
        }
    } catch (e) {
        console.error("Error en processUserMessage (probablemente OpenAI):", e.message);
        await flowDynamic([{ body: "Hubo un error con la IA." }]);
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
    
    // Ya no está hardcodeado. Railway inyectará la variable
    // gracias a que quitamos dotenv y el build script.
    const adapterDB = new MongoAdapter({ 
        dbUri: process.env.MONGO_URL, 
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
    adapterProvider.server.get('/', (req, res) => {
        try {
            // Comprobamos si existe Y si es un archivo
            if (fs.existsSync(QR_PATH) && fs.lstatSync(QR_PATH).isFile()) {
                res.setHeader('Content-Type', 'image/png');
                fs.createReadStream(QR_PATH).pipe(res);
            } else {
                // Si no, mandamos el 404 sin crashear
                res.status(404).send('Generando QR... por favor, refresca la página en 10 segundos.');
            }
        } catch (e) {
            // Un catch-all por si acaso fs.lstatSync falla
            console.error("Error en la ruta /:", e.message);
            res.status(500).send('Error interno generando el QR.');
        }
    });
    // --- FIN DEL ARREGLO ---

    httpServer(+PORT);
};

main();
