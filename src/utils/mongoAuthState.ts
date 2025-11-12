import { MongoClient, Collection } from 'mongodb';
import { AuthenticationCreds, SignalDataTypeMap } from '@whiskeysockets/baileys';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

export async function useMongoAuthState(mongoUrl: string, sessionId: string = 'whatsapp-session') {
  const client = new MongoClient(mongoUrl);
  await client.connect();

  // !! ---- AQUÍ ESTÁ LA CORRECCIÓN ---- !!
  // Le quitamos ('baileys') para que use la DB por defecto de Railway
  const db = client.db(); 
  // !! ------------------------------------ !!

  const collection: Collection = db.collection('auth_states');

  // Inicializar documento de sesión
  const sessionDoc = await collection.findOne({ _id: sessionId });

  const writeData = async (data: any, key: string) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await collection.updateOne(
        { _id: sessionId },
        { $set: { [key]: serialized } },
        { upsert: true }
      );
    } catch (error) {
      console.error(`Error escribiendo ${key}:`, error);
    }
  };

  const readData = async (key: string) => {
    try {
      const doc = await collection.findOne({ _id: sessionId });
      if (!doc || !doc[key]) return null;
      return JSON.parse(doc[key], BufferJSON.reviver);
    } catch (error) {
      console.error(`Error leyendo ${key}:`, error);
      return null;
    }
  };

  const removeData = async (key: string) => {
    try {
      await collection.updateOne(
        { _id: sessionId },
        { $unset: { [key]: '' } }
      );
    } catch (error) {
      console.error(`Error eliminando ${key}:`, error);
    }
  };

  const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const data: { [id: string]: any } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data: any) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: async () => {
      return writeData(creds, 'creds');
    },
  };
}
