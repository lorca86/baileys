import fs from 'fs';
import path from 'path';
import "dotenv/config"
import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot'
import { MemoryDB } from '@builderbot/bot' // Usaremos MemoryDB para el flujo, Mongo para la sesión
import { BaileysProvider } from '@builderbot/provider-baileys'
import { toAsk, httpInject } from "@builderbot-plugins/openai-assistants"
import { typing } from "./utils/presence"
import { MongoAdapter } from '@builderbot/database-mongo'; // Importamos Mongo

/** Puerto en el que se ejecutará el servidor */
const PORT = process.env.PORT ?? 3008
/** ID del asistente de OpenAI */
const ASSISTANT_ID = process.env.ASSISTANT_ID ?? ''
const userQueues = new Map();
const userLocks = new Map(); // New lock mechanism

// Usamos process.cwd() para obtener la ruta base del contenedor (/app)
const QR_PATH = path.join(process.cwd(), 'bot.qr.png'); 

/**
 * Function to process the user's message by sending it to the OpenAI API
 * and sending the response back to the user.
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
    await typing(ctx, provider);
    const response = await toAsk(ASSISTANT_ID, ctx.body, state);

    // Split the response into chunks and send them sequentially
    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
        const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, "");
        await flowDynamic([{ body: cleanedChunk }]);
    }
};

/**
 * Function to handle the queue for each user.
 */
const handleQueue = async (userId) => {
    const queue = userQueues.get(userId);
    
    if (userLocks.get(userId)) {
        return; // If locked, skip processing
  }

    while (queue.length > 0) {
        userLocks.set(userId, true); // Lock the queue
        const { ctx, flowDynamic, state, provider } = queue.shift();
        try {
            await processUserMessage(ctx, { flowDynamic, state, provider });
        } catch (error) {
            console.error(`Error processing message for user ${userId}:`, error);
        } finally {
            userLocks.set(userId, false); // Release the lock
        }
    }

    userLocks.delete(userId); // Remove the lock once all messages are processed
    userQueues.delete(userId); // Remove the queue once all messages are processed
};

/**
 * Flujo de bienvenida que maneja las respuestas del asistente de IA
 * @type {import('@builderbot/bot').Flow<BaileysProvider, MemoryDB>}
 */
const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
    .addAction(async (ctx, { flowDynamic, state, provider }) => {
        const userId = ctx.from; // Use the user's ID to create a unique queue for each user

        if (!userQueues.has(userId)) {
            userQueues.set(userId, []);
        }

        const queue = userQueues.get(userId);
        queue.push({ ctx, flowDynamic, state, provider });

        // If this is the only message in the queue, process it immediately
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
        qr: { // Le dice a Baileys dónde guardar el QR
            path: QR_PATH,
        }
    });

    /**
     * Base de datos
     * Aquí le decimos que use Mongo para guardar la sesión
     */
    const adapterDB = new MongoAdapter({ 
        dbUri: process.env.MONGO_URL, // <-- Lee la variable que pusiste en Railway
        dbName: 'baileys_session'
    });


    /**
     * Configuración y creación del bot
     */
    const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB, // <-- ¡Importante! Usamos la DB de Mongo
    });

    // --- ¡AQUÍ ESTÁ EL ARREGLO IMPORTANTE! ---
    
    // 1. Dejamos que httpInject configure sus rutas primero
    httpInject(adapterProvider.server);

    // 2. AHORA, sobreescribimos la ruta '/' con nuestra versión SEGURA.
    //    Esto evita el "crash" porque nuestra ruta SÍ comprueba si el archivo existe.
    adapterProvider.server.get('/', (req, res) => {
        if (fs.existsSync(QR_PATH)) {
            // Si el QR existe, lo mandamos
            res.setHeader('Content-Type', 'image/png');
            fs.createReadStream(QR_PATH).pipe(res);
        } else {
            // Si no existe (porque se está generando), mandamos un mensaje
            res.status(404).send('Generando QR... por favor, refresca la página en 10 segundos.');
        }
    });
    // --- FIN DEL ARREGLO ---

    // 3. Iniciamos el servidor
    httpServer(+PORT);
};

main();
