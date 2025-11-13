import { MongoClient, Collection } from 'mongodb';
import { AuthenticationCreds, SignalDataTypeMap, AuthenticationState } from '@whiskeysockets/baileys';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

export async function useMongoAuthState(mongoUrl: string, sessionId: string = 'whatsapp-session') {
  const client = new MongoClient(mongoUrl);
  await client.connect();
  console.log('✅ Conectado a MongoDB para auth state');

  // Usar base de datos 'whatsapp' explícitamente
  const db = client.db('whatsapp');
  const collection: Collection = db.collection('auth_states');

  // Crear índice para mejorar rendimiento
  try {
    await collection.createIndex({ _id: 1 });
  } catch (error) {
    console.warn('Advertencia creando índice:', error);
  }

  // Función para escribir datos con serialización correcta de Buffers
  const writeData = async (data: any, key: string) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await collection.updateOne(
        { _id: sessionId },
        { $set: { [key]: serialized } },
        { upsert: true }
      );
    } catch (error) {
      console.error(`❌ Error escribiendo ${key}:`, error);
      throw error;
    }
  };

  // Función para leer datos con deserialización correcta de Buffers
  const readData = async (key: string) => {
    try {
      const doc = await collection.findOne({ _id: sessionId });
      if (!doc || !doc[key]) return null;
      
      const parsed = JSON.parse(doc[key], BufferJSON.reviver);
      return parsed;
    } catch (error) {
      console.error(`❌ Error leyendo ${key}:`, error);
      return null;
    }
  };

  // Función para eliminar datos
  const removeData = async (key: string) => {
    try {
      await collection.updateOne(
        { _id: sessionId },
        { $unset: { [key]: '' } }
      );
    } catch (error) {
      console.error(`❌ Error eliminando ${key}:`, error);
    }
  };

  // Cargar o inicializar credenciales
  const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const data: { [id: string]: any } = {};
          
          await Promise.all(
            ids.map(async (id) => {
              try {
                let value = await readData(`${type}-${id}`);
                
                if (type === 'app-state-sync-key' && value) {
                  // Reconstruir protobuf para app-state-sync-key
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                
                // Asegurar que los valores sean del tipo correcto (Buffer si es necesario)
                if (value && typeof value === 'object' && value.type === 'Buffer' && value.data) {
                  value = Buffer.from(value.data);
                }
                
                data[id] = value;
              } catch (error) {
                console.error(`Error obteniendo ${type}-${id}:`, error);
                data[id] = null;
              }
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
              
              // Si el valor existe, escribirlo; si no, eliminarlo
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          
          await Promise.all(tasks);
        },
      },
    } as AuthenticationState,
    
    saveCreds: async () => {
      return writeData(creds, 'creds');
    },
  };
}
