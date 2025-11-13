import { MongoClient, Collection } from 'mongodb';
import { AuthenticationCreds, SignalDataTypeMap, AuthenticationState } from '@whiskeysockets/baileys';
import { BufferJSON, initAuthCreds, proto } from '@whiskeysockets/baileys';

export async function useMongoAuthState(mongoUrl: string, sessionId: string = 'whatsapp-session') {
  const client = new MongoClient(mongoUrl);
  await client.connect();
  console.log('✅ Conectado a MongoDB para auth state');

  const db = client.db('whatsapp');
  const collection: Collection = db.collection('auth_states');

  // Crear índice
  try {
    await collection.createIndex({ _id: 1 });
  } catch (error) {
    console.warn('Advertencia creando índice:', error);
  }

  // Leer el estado completo de la base de datos
  const readState = async () => {
    try {
      const doc = await collection.findOne({ _id: sessionId });
      if (!doc?.state) return null;
      
      // Deserializar con BufferJSON.reviver
      return JSON.parse(JSON.stringify(doc.state), BufferJSON.reviver);
    } catch (error) {
      console.error('❌ Error leyendo estado de MongoDB:', error);
      return null;
    }
  };

  // Escribir el estado completo
  const writeState = async (state: any) => {
    try {
      // Serializar con BufferJSON.replacer
      const serialized = JSON.parse(JSON.stringify(state, BufferJSON.replacer));
      
      await collection.updateOne(
        { _id: sessionId },
        { $set: { state: serialized } },
        { upsert: true }
      );
    } catch (error) {
      console.error('❌ Error escribiendo estado en MongoDB:', error);
      throw error;
    }
  };

  // Eliminar una key específica
  const removeKey = async (key: string) => {
    try {
      await collection.updateOne(
        { _id: sessionId },
        { $unset: { [`state.keys.${key}`]: '' } }
      );
    } catch (error) {
      console.error('❌ Error eliminando key:', error);
    }
  };

  // Cargar estado guardado o inicializar nuevo
  const savedState = (await readState()) || {};
  const creds: AuthenticationCreds = savedState.creds || initAuthCreds();
  const keys: any = savedState.keys || {};

  // Función para guardar todo el estado
  const saveFullState = async () => {
    await writeState({ creds, keys });
  };

  return {
    state: {
      creds,
      keys: {
        get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
          const result: { [id: string]: any } = {};
          
          for (const id of ids) {
            const key = `${type}-${id}`;
            let data = keys?.[key];
            
            if (data) {
              // Manejar app-state-sync-key especialmente
              if (type === 'app-state-sync-key') {
                try {
                  data = proto.Message.AppStateSyncKeyData.fromObject(data);
                } catch (error) {
                  console.error(`Error convirtiendo app-state-sync-key ${id}:`, error);
                }
              }
              
              result[id] = data;
            }
          }
          
          return result;
        },
        
        set: async (newData: any) => {
          for (const category of Object.keys(newData)) {
            for (const id of Object.keys(newData[category])) {
              const value = newData[category][id];
              const key = `${category}-${id}`;
              
              if (value) {
                keys[key] = value;
              } else {
                delete keys[key];
                await removeKey(key);
              }
            }
          }
          
          // Guardar el estado completo después de cada actualización
          await saveFullState();
        },
      },
    } as AuthenticationState,
    
    saveCreds: async () => {
      await saveFullState();
    },
  };
}
