import fs from 'fs';
import path from 'path';
import { createBot, createProvider, createFlow, addKeyword, EVENTS, MemoryDB } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { toAsk, httpInject } from '@builderbot-plugins/openai-assistants';
import { typing } from './utils/presence';
import { MongoAdapter } from '@builderbot/database-mongo';

const PORT = process.env.PORT ?? 3008;
const userQueues = new Map();
const userLocks = new Map();

const QR_PATH = process.env.QR_PATH || path.join(process.cwd(), 'bot.qr.png');

const processUserMessage = async (ctx, { flowDynamic, state, provider }) => {
  const REAL_ASSISTANT_ID = '';
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

const main = async () => {
  const adapterFlow = createFlow([welcomeFlow]);

  const adapterProvider = createProvider(BaileysProvider, {
    groupsIgnore: true,
    readStatus: false,
    // puedes usar printQR: true si no quieres guardar el archivo
    qr: {
      path: QR_PATH,
      printQR: true
    }
  });

  const HARDCODED_MONGO_URL =
    'mongodb+srv://baileys:L3bana!!09@cluster0.od58v3e.mongodb.net/?appName=Cluster0';

  const adapterDB = new MongoAdapter({
    dbUri: HARDCODED_MONGO_URL,
    dbName: 'baileys_session'
  });

  const { httpServer } = await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB
  });

  httpInject(adapterProvider.server);

  adapterProvider.server.get('/', (req, res) => {
    const qrFile = QR_PATH;
    fs.stat(qrFile, (err, stats) => {
      if (err || !stats.isFile()) {
        res.status(404).send('Generando QR... refresca en unos segundos.');
        return;
      }
      const stream = fs.createReadStream(qrFile);
      stream.on('error', () => {
        res.status(500).send('Error leyendo el QR.');
      });
      res.setHeader('Content-Type', 'image/png');
      stream.pipe(res);
    });
  });

  httpServer(+PORT);
};

main();
