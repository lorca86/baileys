import { MongoClient, Collection } from 'mongodb';
import { 
    initAuthCreds, 
    BufferJSON, 
    proto, 
    AuthenticationCreds, 
    AuthenticationState,
    SignalDataTypeMap
} from '@whiskeysockets/baileys';

/**
 * Almacena la sesión de Baileys en MongoDB.
 * Esta versión guarda cada clave (creds, keys, etc.) como un documento separado
 * para un rendimiento óptimo, evitando escribir todo el estado en cada cambio.
 */
export const useMongoAuthState = async (mongoUrl: string, collectionName: string = 'auth_states'): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> => {
    
    const client = new MongoClient(mongoUrl);
    await client.connect();
    
    // El usuario en su 'mongoAuthState.ts' especificó la DB 'whatsapp'
    const db = client.db('whatsapp'); 
    const collection: Collection = db.collection(collectionName);

    // Crear índice para optimizar búsquedas
    try {
        await collection.createIndex({ _id: 1 });
    } catch (e) {
        console.warn('Advertencia al crear índice de Mongo:', e);
    }

    // Función para escribir datos (convierte Buffers a JSON string seguro)
    const writeData = async (data: any, key: string) => {
        try {
            // Usamos BufferJSON.replacer para asegurar que los Buffers se guarden bien
            const value = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            await collection.updateOne(
                { _id: key as any },
                { $set: { value } },
                { upsert: true }
            );
        } catch (error) {
            console.error(`❌ Error escribiendo ${key} en Mongo:`, error);
        }
    };

    // Función para leer datos (convierte JSON string de vuelta a Buffers)
    const readData = async (key: string) => {
        try {
            const data = await collection.findOne({ _id: key as any });
            if (data && data.value) {
                // 🔥 AQUÍ ESTÁ LA SOLUCIÓN AL ERROR "Received type string" 🔥
                // Usamos BufferJSON.reviver para restaurar los Buffers
                return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error(`❌ Error leyendo ${key} de Mongo:`, error);
            return null;
        }
    };

    // Cargar credenciales iniciales
    const creds: AuthenticationCreds = (await readData('creds')) || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type: keyof SignalDataTypeMap, ids: string[]) => {
                    const data: { [key: string]: any } = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                try {
                                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                                } catch (err) {
                                    console.error('Error al parsear AppStateSyncKeyData', err);
                                    value = null;
                                }
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        for (const id in data[category as keyof typeof data]) {
                            const value = data[category as keyof typeof data][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : (async () => {
                                await collection.deleteOne({ _id: key as any });
                            })());
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: async () => {
            // Guardar solo las 'creds'
            await writeData(creds, 'creds');
        },
    };
};
