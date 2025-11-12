import { createBot, createProvider, createFlow, addKeyword, EVENTS, MemoryDB } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { toAsk, httpInject } from '@builderbot-plugins/openai-assistants';
import { typing } from './utils/presence';
import { MongoAdapter } from '@builderbot/database-mongo';

const PORT = process.env.PORT ?? 3008;
const userQueues = new Map();
const userLocks = new Map();

/**
 * Procesa un mensaje del usuario mediante OpenAI (si lo tienes configurado)
 */
const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
  const REAL_ASSISTANT_ID = ''; // Puedes poner aquí el ID real si usas OpenAI

  try {
    await typing(ctx, provider);
    const response = await toAsk(REAL_ASSISTANT_ID, ctx.body, state);
    const chunks = response.split(/\n\n+/);
    for (const chunk of chunks) {
      const cleanedChunk = chunk.trim().replace(/【.*?】[ ] /g, '');
      await flowDynamic([{ body: cleanedChunk }]);
    }
  } catch (e) {
    console.error('Error llamando a OpenAI:', e.message);
    await flowDynamic([{ body: 'Hubo un error con la IA (temporal).' }]);
  }
};

/**
 * Manejo de cola por usuario (para procesar mensajes en orden)
 */
const handleQueue = async (userId) => {
  const queue = userQueues.get(userId);
  if (userLocks.get(userId)) return;

  while (queue.length > 0) {
    userLocks.set(userId, true);
    const { ctx, flowDynamic, state, provider } = queue.shift();
    try {
      await processUserMessage(ctx, { flowDynamic, state, provider });
    } catch (error) {
      console.error(`Error procesando mensaje para ${userId}:`, error);
    } finally {
      userLocks.set(userId, false);
    }
  }

  userLocks.delete(userId);
  userQueues.delete(userId);
};

/**
 * Flujo principal (welcome)
 */
const welcomeFlow = addKeyword<BaileysProvider, MemoryDB>(EVENTS.WELCOME)
  .addAction(async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from;
    if (!userQueues.has(userId)) userQueues.set(userId, []);
    const queue = userQueues.get(userId);
    queue.push({ ctx, flowDynamic, state, provider });
    if (!userLocks.get(userId) && queue.length === 1) {
      await handleQueue(userId);
    }
  });

/**
 * Main principal
 */
const main = async () => {
  const adapterFlow = createFlow([welcomeFlow]);

  // ✅ Aquí eliminamos el QR_PATH, y usamos printQR para mostrarlo por consola
  const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: true,
    readStatus: false,
    qr: {
      printQR: true, // <--- importante: imprime QR en logs
    },
  });

  // ✅ Tu conexión Mongo existente
  const HARDCODED_MONGO_URL =
    'mongodb+srv://baileys:L3bana!!09@cluster0.od58v3e.mongodb.net/?appName=Cluster0';

  const adapterDB = new MongoAdapter({
    dbUri: HARDCODED_MONGO_URL,
    dbName: 'baileys_session',
  });

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  httpInject(adapterProvider.server);

  // ✅ Eliminamos la parte del fs.createReadStream (no se usa)
  adapterProvider.server.get('/', (_, res) => {
    res.send('Bot Baileys funcionando. Escanea el QR en los logs la primera vez.');
  });

  httpServer(+PORT);
};

main();
