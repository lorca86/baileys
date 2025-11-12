import { createBot, createProvider, createFlow, addKeyword, EVENTS } from '@builderbot/bot';
import { BaileysProvider } from '@builderbot/provider-baileys';
import { toAsk, httpInject } from '@builderbot-plugins/openai-assistants';
import { useMongoAuthState } from './utils/mongoAuthState';
import 'dotenv/config';

const PORT = process.env.PORT ?? 3008;
const MONGO_URL = process.env.MONGO_URL || '';
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID || '';

// Sistema de colas por usuario
const userQueues = new Map<string, any[]>();
const userLocks = new Map<string, boolean>();

const processUserMessage = async (ctx: any, { flowDynamic, state, provider }: any) => {
  if (!OPENAI_ASSISTANT_ID) {
    await flowDynamic([{ body: 'Error: No se ha configurado el Assistant ID de OpenAI' }]);
    return;
  }

  try {
    const response = await toAsk(OPENAI_ASSISTANT_ID, ctx.body, state);
    const chunks = response.split(/\n\n+/);

    for (const chunk of chunks) {
      const cleanedChunk = chunk.trim().replace(/【.*?】\s*/g, '');
      if (cleanedChunk) {
        await flowDynamic([{ body: cleanedChunk }]);
      }
    }
  } catch (e: any) {
    console.error('Error llamando a OpenAI:', e.message);
    await flowDynamic([{ body: 'Hubo un error temporal con la IA. Intenta de nuevo.' }]);
  }
};

const handleQueue = async (userId: string) => {
  const queue = userQueues.get(userId);
  if (!queue || userLocks.get(userId)) return;

  while (queue.length > 0) {
    userLocks.set(userId, true);
    const { ctx, flowDynamic, state, provider } = queue.shift();

    try {
      await processUserMessage(ctx, { flowDynamic, state, provider });
    } catch (error: any) {
      console.error(`Error procesando mensaje para ${userId}:`, error);
    } finally {
      userLocks.set(userId, false);
    }
  }

  userLocks.delete(userId);
  userQueues.delete(userId);
};

const welcomeFlow = addKeyword(EVENTS.WELCOME).addAction(
  async (ctx, { flowDynamic, state, provider }) => {
    const userId = ctx.from;

    if (!userQueues.has(userId)) {
      userQueues.set(userId, []);
    }

    const queue = userQueues.get(userId)!;
    queue.push({ ctx, flowDynamic, state, provider });

    if (!userLocks.get(userId) && queue.length === 1) {
      await handleQueue(userId);
    }
  }
);

const main = async () => {
  try {
    console.log('🚀 Iniciando bot de WhatsApp...');

    if (!MONGO_URL) {
      throw new Error('❌ MONGO_URL no está configurado en las variables de entorno');
    }

    // Crear auth state personalizado con MongoDB
    const { state, saveCreds } = await useMongoAuthState(MONGO_URL, 'whatsapp-baileys-session');
    console.log('✅ Auth state de MongoDB inicializado');

    const adapterFlow = createFlow([welcomeFlow]);

    const adapterProvider = createProvider(BaileysProvider, {
      groupsIgnore: true,
      readStatus: false,
      auth: state,
      printQRInTerminal: true,
    });

    // Guardar credenciales cuando se actualicen
    adapterProvider.on('auth_update', saveCreds);

    const { httpServer } = await createBot({
      flow: adapterFlow,
      provider: adapterProvider,
      database: undefined, // No usamos database adapter
    });

    httpInject(adapterProvider.server);

    adapterProvider.server.get('/', (_, res) => {
      res.send('✅ Bot Baileys funcionando correctamente. Sesión persistente en MongoDB.');
    });

    httpServer(+PORT);
    console.log(`✅ Servidor HTTP escuchando en puerto ${PORT}`);
    console.log('📱 Escanea el QR en los logs de Railway para conectar WhatsApp');
  } catch (error: any) {
    console.error('❌ Error fatal al iniciar el bot:', error.message);
    process.exit(1);
  }
};

main();
