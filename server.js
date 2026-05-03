require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');

// ─── Validación de variables de entorno ────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !SPREADSHEET_ID) {
    console.error('❌ Faltan variables de entorno. Revisa tu archivo .env');
    process.exit(1);
}

// ─── Inicialización del bot ─────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('🤖 Bot de logística iniciado correctamente.');
console.log(`🔧 Gemini modelo: ${GEMINI_MODEL}`);

// ─── Cola de procesamiento Gemini/Sheets (evita saturar la API) ────────────
let processingQueue = Promise.resolve();
const DELAY_MS = 1500;
let totalRegistrados = 0;

// ─── Caché de IDs de carpetas en Drive (evita buscar en cada foto) ──────────
// { 'YYYY-MM-DD/observacion': folderId }
const driveFolderCache = new Map();
const DRIVE_ROOT_NAME = process.env.GOOGLE_DRIVE_ROOT_NAME || 'Logística Bot';
const DRIVE_ROOT_ID   = process.env.GOOGLE_DRIVE_FOLDER_ID || null; // ID fijo de carpeta raíz (opcional)

// ─── Estado de conversación por usuario ────────────────────────────────────
//
// ESTRUCTURA POR USUARIO:
// {
//   estado     : 'esperando_decision' | 'esperando_obs' | null
//   pendiente  : { fileIds, isAlbum, operario }   ← lote ACTUAL preguntado
//   cola       : [ { fileIds, isAlbum, operario }, ... ]  ← lotes EN ESPERA
//   processing : boolean                               ← lote en procesamiento
//   timestamp  : Date.now()
//   msgId      : message_id del mensaje de pregunta (para editarlo)
// }
//
// El usuario siempre ve UNA pregunta a la vez.
// Los lotes que llegan mientras hay pregunta activa se encolan automáticamente.
//
const userStates = new Map();

// ─── Rastreo de álbumes de Telegram ────────────────────────────────────────
const albumTracker = new Map();

// ═══════════════════════════════════════════════════════════════════════════
// MANEJADORES DE ENTRADA
// ═══════════════════════════════════════════════════════════════════════════

// ─── Manejador de fotos ─────────────────────────────────────────────────────
bot.on('photo', async (msg) => {
    const chatId     = msg.chat.id;
    const operario   = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
    const mediaGroup = msg.media_group_id;
    const fileId     = msg.photo[msg.photo.length - 1].file_id;

    console.log(`📩 Foto recibida chat=${chatId} mediaGroup=${mediaGroup || 'none'} operario=${operario}`);

    try {
        if (mediaGroup) {
            manejarFotoDeAlbum(mediaGroup, chatId, operario, fileId);
        } else {
            // Foto individual → encolar o preguntar
            await encolarLote(chatId, { fileIds: [fileId], isAlbum: false, operario });
        }
    } catch (err) {
        console.error('❌ Error en handler foto:', err);
        await bot.sendMessage(chatId,
            `❌ Error interno al recibir la foto: _${String(err).substring(0, 200)}_\n\nEscribe /reset e intenta de nuevo.`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
});

// ─── Manejar foto de álbum ──────────────────────────────────────────────────
function manejarFotoDeAlbum(mediaGroupId, chatId, operario, fileId) {
    if (!albumTracker.has(mediaGroupId)) {
        albumTracker.set(mediaGroupId, { chatId, operario, fileIds: [], timer: null, timestamp: Date.now() });
    }

    const album = albumTracker.get(mediaGroupId);
    album.fileIds.push(fileId);

    clearTimeout(album.timer);
    album.timer = setTimeout(async () => {
        try {
            const data = albumTracker.get(mediaGroupId);
            if (!data) return;
            const { fileIds } = data;
            albumTracker.delete(mediaGroupId);
            console.log(`📦 Álbum completo chat=${chatId} fotos=${fileIds.length}`);
            // Álbum completo → encolar lote
            await encolarLote(chatId, { fileIds, isAlbum: true, operario });
        } catch (err) {
            console.error('❌ Error procesando álbum:', err);
            await bot.sendMessage(chatId,
                `❌ Error interno al procesar el álbum: _${String(err).substring(0, 200)}_\n\nEscribe /reset e intenta de nuevo.`,
                { parse_mode: 'Markdown' }
            ).catch(() => {});
        }
    }, 2000);
}

// ═══════════════════════════════════════════════════════════════════════════
// NÚCLEO: COLA DE LOTES POR USUARIO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Recibe un lote nuevo para un chatId.
 * - Si NO hay pregunta activa → pregunta de inmediato.
 * - Si HAY pregunta activa → agrega a la cola y notifica al usuario.
 */
async function encolarLote(chatId, lote) {
    const state = userStates.get(chatId);
    const estaOcupado = state && (
        state.estado ||
        state.pendiente ||
        state.processing ||
        (state.cola && state.cola.length > 0)
    );

    if (!estaOcupado) {
        // No hay nada pendiente ni en procesamiento → preguntar ahora
        console.log(`📤 Pregunta de observación para chat=${chatId} fotos=${lote.fileIds.length} album=${lote.isAlbum}`);
        await pedirObservacion(chatId, lote);
    } else {
        // Ya hay un lote activo, en procesamiento o en espera → encolar y avisar
        state.cola.push(lote);
        state.timestamp = Date.now();
        const posicion = state.cola.length;
        const cantidad = lote.fileIds.length;
        console.log(`📥 Lote encolado pos=${posicion} | chat=${chatId} | fotos=${cantidad}`);

        await bot.sendMessage(chatId,
            `🕐 *${cantidad} foto${cantidad > 1 ? 's' : ''} recibida${cantidad > 1 ? 's' : ''}* — en cola (posición ${posicion}).\n` +
            `_Responde la pregunta actual o espera a que termine el lote en proceso para continuar._`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }
}

/**
 * Envía la pregunta de observación para el lote actual.
 * Guarda el estado en userStates.
 */
async function pedirObservacion(chatId, lote) {
    const cantidad = lote.fileIds.length;
    const txt = lote.isAlbum
        ? `📦 *${cantidad} foto${cantidad > 1 ? 's' : ''} recibida${cantidad > 1 ? 's' : ''}.*\n\n¿Deseas agregar una observación para este lote?`
        : `📷 *Foto recibida.*\n\n¿Deseas agregar una observación?`;

    // ⚠️ CRÍTICO: reservar estado SÍNCRONAMENTE antes de cualquier await
    // Esto impide que llamadas concurrentes pasen el check de encolarLote
    const colaExistente = userStates.get(chatId)?.cola || [];
    userStates.set(chatId, {
        estado    : 'esperando_decision',
        pendiente : lote,
        cola      : colaExistente,
        processing: false,
        timestamp : Date.now(),
        msgId     : null  // se actualiza tras el send
    });

    let msgEnviado;
    try {
        msgEnviado = await bot.sendMessage(chatId, txt, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [[
                    { text: '✅ Sin observación',    callback_data: `obs_no|${chatId}` },
                    { text: '📝 Agregar observación', callback_data: `obs_si|${chatId}` }
                ]]
            }
        });
        // Actualizar msgId ahora que tenemos el ID del mensaje enviado
        const state = userStates.get(chatId);
        if (state) state.msgId = msgEnviado.message_id;
    } catch (err) {
        // Rollback del estado si el send falló
        console.error('❌ Error enviando pregunta:', err.message);
        userStates.delete(chatId);
    }
}


/**
 * Cuando el lote actual termina, saca el siguiente de la cola y pregunta.
 * Si la cola está vacía, limpia el estado.
 */
async function procesarSiguienteDeLaCola(chatId) {
    const state = userStates.get(chatId);
    if (!state) return;

    if (state.cola.length === 0) {
        userStates.delete(chatId);
        console.log(`✅ Cola vacía para chat ${chatId}`);
        return;
    }

    // Sacar el primero de la cola
    const siguienteLote = state.cola.shift();
    console.log(`📤 Procesando siguiente de la cola | chat=${chatId} | fotos=${siguienteLote.fileIds.length} | restantes=${state.cola.length}`);

    // Eliminar estado actual antes de pedir nuevo (evita duplicar)
    userStates.delete(chatId);

    // Pequeña pausa para que el mensaje de resumen llegue primero
    await esperar(800);

    const restantes = state.cola.length; // ya hicimos shift
    if (restantes > 0) {
        await bot.sendMessage(chatId,
            `📋 _Siguiente lote en cola (${restantes} lote${restantes > 1 ? 's' : ''} más después de este)_`,
            { parse_mode: 'Markdown' }
        ).catch(() => {});
    }

    await pedirObservacion(chatId, siguienteLote);
}

// ═══════════════════════════════════════════════════════════════════════════
// MANEJADORES DE RESPUESTA DEL USUARIO
// ═══════════════════════════════════════════════════════════════════════════

// ─── Manejador de botones inline ────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data; // "obs_no|chatId" o "obs_si|chatId"

    await bot.answerCallbackQuery(query.id).catch(() => {});

    const state = userStates.get(chatId);
    if (!state || !state.pendiente) {
        await bot.editMessageText('⚠️ Esta acción ya fue procesada.', {
            chat_id: chatId, message_id: query.message.message_id
        }).catch(() => {});
        return;
    }

    if (data.startsWith('obs_no')) {
        // Sin observación → procesar de inmediato
        const lote = state.pendiente;
        // Marcar como procesando (estado null para no bloquear cola)
        userStates.set(chatId, { ...state, estado: null, pendiente: null, processing: true });

        await bot.editMessageText(
            `⏳ *Procesando${lote.isAlbum ? ` ${lote.fileIds.length} fotos` : ''}...*`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
        ).catch(() => {});

        await iniciarProcesamiento(chatId, lote, 'Sin observaciones');
        await procesarSiguienteDeLaCola(chatId);

    } else if (data.startsWith('obs_si')) {
        // Pedir texto de observación
        userStates.set(chatId, { ...state, estado: 'esperando_obs' });
        await bot.editMessageText(
            `✏️ *Escribe la observación ahora:*\n_Ejemplo: Camión #4, ingreso bodega norte_`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
        ).catch(() => {});
    }
});

// ─── Manejador de mensajes de texto ─────────────────────────────────────────
bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const texto  = msg.text;

    // ── Comandos siempre disponibles ─────────────────────────────────────────
    if (texto === '/reset') {
        const state = userStates.get(chatId);
        const lotesEnCola = state?.cola?.length || 0;
        userStates.delete(chatId);
        await bot.sendMessage(chatId,
            `🔄 *Estado reiniciado.*\n` +
            (lotesEnCola > 0 ? `⚠️ Se cancelaron ${lotesEnCola} lote${lotesEnCola > 1 ? 's' : ''} en espera.\n` : '') +
            `Ya puedes enviar fotos nuevamente.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    if (texto === '/cola') {
        const state = userStates.get(chatId);
        if (!state) {
            await bot.sendMessage(chatId, `✅ No hay lotes en espera.`);
        } else {
            const enCola = state.cola?.length || 0;
            let estadoTexto = 'sin actividad reciente';
            if (state.estado === 'esperando_decision') estadoTexto = 'esperando tu respuesta';
            else if (state.estado === 'esperando_obs') estadoTexto = 'esperando observación';
            else if (state.processing) estadoTexto = 'procesando lote actual';

            await bot.sendMessage(chatId,
                `📋 *Estado de la cola:*\n` +
                `• 1 lote activo (${estadoTexto})\n` +
                `• ${enCola} lote${enCola !== 1 ? 's' : ''} en espera\n\n` +
                `Responde la pregunta actual para continuar.\nEscribe /reset para cancelar todo.`,
                { parse_mode: 'Markdown' }
            );
        }
        return;
    }

    if (texto === '/start' || texto === '/ayuda') {
        await bot.sendMessage(chatId,
            `👋 *Bot de Logística — Escaneo de Rollos*\n\n` +
            `📋 *Cómo usar:*\n\n` +
            `*📷 Foto individual:*\nEnvía una foto → el bot pregunta si tienes observación → registra.\n\n` +
            `*📦 Álbum (múltiples fotos):*\nSelecciona hasta *10 fotos* y envíalas juntas.\nEl bot procesa todo el lote con una sola observación.\n\n` +
            `*💡 Tip para camiones grandes:*\nPuedes enviar múltiples grupos sin esperar.\nEl bot encola automáticamente y pregunta uno por uno.\n\n` +
            `*📌 Comandos:*\n` +
            `/cola — Ver lotes en espera\n` +
            `/reset — Cancelar todo y reiniciar\n` +
            `/ayuda — Ver esta ayuda`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // ── Si el usuario está escribiendo la observación ────────────────────────
    const state = userStates.get(chatId);
    if (state && state.estado === 'esperando_obs') {
        const observacion = texto.trim();
        const lote = state.pendiente;

        // Marcar como procesando antes de todo
        userStates.set(chatId, { ...state, estado: null, pendiente: null, processing: true });

        await bot.sendMessage(chatId,
            `✅ Observación guardada: _"${observacion}"_\n⏳ *Procesando...*`,
            { parse_mode: 'Markdown' }
        );

        await iniciarProcesamiento(chatId, lote, observacion);
        await procesarSiguienteDeLaCola(chatId);
        return;
    }

    // ── Texto sin contexto ────────────────────────────────────────────────────
    await bot.sendMessage(chatId,
        `ℹ️ Solo proceso *fotos de etiquetas*.\nEnvía una foto o un álbum.\nEscribe /ayuda para instrucciones.`,
        { parse_mode: 'Markdown' }
    );
});

// ═══════════════════════════════════════════════════════════════════════════
// PROCESAMIENTO DE FOTOS
// ═══════════════════════════════════════════════════════════════════════════

// ─── Iniciar el procesamiento de fotos (devuelve Promise) ──────────────────
function iniciarProcesamiento(chatId, pendiente, observacion) {
    const { fileIds, isAlbum, operario } = pendiente;

    return new Promise((resolve) => {
        if (!isAlbum) {
            // Foto individual
            processingQueue = processingQueue.then(async () => {
                try {
                    const { buffer, ...datos } = await descargarYProcesar(fileIds[0]);
                    const nombreObs = sanitizarNombre(observacion);
                    const [, carpetaId] = await Promise.all([
                        guardarEnSheets({ ...datos, operario, observaciones: observacion }),
                        subirFotoADrive(buffer, `${datos.idRollo !== 'No detectado' ? datos.idRollo : 'foto_1'}.jpg`, nombreObs)
                    ]);
                    const linkDrive = carpetaId ? `https://drive.google.com/drive/folders/${carpetaId}` : null;
                    await bot.sendMessage(chatId,
                        `✅ *¡Rollo registrado!*\n\n` +
                        `📦 *ID:* ${datos.idRollo}\n` +
                        `🏷️ *Artículo:* ${datos.articulo}\n` +
                        `📐 *Medidas:* ${datos.ancho}cm × ${datos.largo}m\n` +
                        `🎨 *Color:* ${datos.color}\n` +
                        `📝 *Obs:* ${observacion}` +
                        (linkDrive ? `\n📂 [Ver en Drive](${linkDrive})` : ''),
                        { parse_mode: 'Markdown', disable_web_page_preview: true }
                    );
                } catch (error) {
                    console.error('❌ Error procesando etiqueta:', error);
                    await bot.sendMessage(chatId,
                        `❌ *Error al procesar la etiqueta.*\n_${error.message.substring(0, 150)}_`,
                        { parse_mode: 'Markdown' }
                    );
                }
                await esperar(DELAY_MS);
                resolve();
            });
        } else {
            // Álbum — procesar todas en cola
            const total = fileIds.length;
            let exitosos = 0;
            let fallidos = 0;
            const detalles = [];
            let linkDrive = null;
            const nombreObs = sanitizarNombre(observacion);

            console.log(`📦 Álbum: ${total} fotos | ${operario} | Obs: "${observacion}"`);

            for (let i = 0; i < fileIds.length; i++) {
                const numero = i + 1;
                const esUltimo = numero === total;

                processingQueue = processingQueue.then(async () => {
                    try {
                        const { buffer, ...datos } = await descargarYProcesar(fileIds[i]);
                        const nombreFoto = `${datos.idRollo !== 'No detectado' ? datos.idRollo : `foto_${numero}`}.jpg`;
                        const [, carpetaId] = await Promise.all([
                            guardarEnSheets({ ...datos, operario, observaciones: observacion }),
                            subirFotoADrive(buffer, nombreFoto, nombreObs)
                        ]);
                        if (!linkDrive && carpetaId) {
                            linkDrive = `https://drive.google.com/drive/folders/${carpetaId}`;
                        }
                        exitosos++;
                        detalles.push(`✅ ${numero}. *${datos.idRollo}* — ${datos.color} ${datos.ancho}cm×${datos.largo}m`);
                        console.log(`✅ [${numero}/${total}] ${datos.idRollo}`);
                    } catch (error) {
                        fallidos++;
                        detalles.push(`❌ ${numero}. Error — ${error.message.substring(0, 60)}`);
                        console.error(`❌ [${numero}/${total}]`, error.message);
                    }

                    if (esUltimo) {
                        await enviarResumenAlbum(chatId, total, exitosos, fallidos, detalles, linkDrive);
                        resolve();
                    }
                    await esperar(DELAY_MS);
                });
            }
        }
    });
}

// ─── Enviar resumen del lote ──────────────────────────────────────────────────
async function enviarResumenAlbum(chatId, total, exitosos, fallidos, detalles, linkDrive) {
    const icono = fallidos === 0 ? '🎉' : fallidos === total ? '❌' : '⚠️';
    const txtDrive = linkDrive ? `\n📂 [Ver fotos en Drive](${linkDrive})` : '';
    await bot.sendMessage(chatId,
        `${icono} *Lote completado: ${exitosos}/${total} rollos registrados*\n` +
        (fallidos > 0 ? `⚠️ ${fallidos} foto(s) con error\n` : ``) +
        txtDrive +
        `\n\n${detalles.join('\n')}`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
}

// ─── Descargar y procesar foto con Gemini ────────────────────────────────────
async function descargarYProcesar(fileId) {
    const fileUrl = await bot.getFileLink(fileId);
    console.log('📥 Descargando:', fileUrl);
    let res;
    try {
        res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    } catch (err) {
        const detail = formatAxiosError(err);
        console.error(`❌ Falló descarga de Telegram: ${detail}`);
        throw new Error(`Error descargando la imagen de Telegram: ${detail}`);
    }

    const buffer = Buffer.from(res.data);
    const b64    = buffer.toString('base64');
    console.log(`🖼️ ${res.data.byteLength} bytes`);
    const datos = await llamarGeminiVision(b64);
    return { ...datos, buffer }; // buffer incluido para subir a Drive
}


// ─── Llamar a Gemini Vision API ─────────────────────────────────────────────
async function llamarGeminiVision(imageBase64) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `Eres un asistente de logística especializado en etiquetas de rollos de tela.
Analiza esta imagen y extrae los siguientes campos.

Devuelve ÚNICAMENTE un JSON válido con exactamente estas claves:
- idRollo: código o ID del rollo
- articulo: nombre del artículo o referencia
- ancho: ancho en cm (solo el número, sin unidades)
- largo: largo en metros (solo el número, sin unidades)
- color: color del rollo

Si algún campo no se puede leer claramente, usa "No detectado".
Nunca devuelvas markdown, bloques de código ni explicaciones. Solo el JSON puro.`;

    let response;
    try {
        response = await axios.post(url, {
            contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }] }]
        }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
        const detail = formatAxiosError(err);
        console.error(`❌ Falló llamada a Gemini: ${detail}`);
        if (err.response?.status === 403) {
            throw new Error(`Error en Gemini Vision: acceso denegado (403). Verifica que tu proyecto tenga permiso para usar Gemini. ${detail}`);
        }
        throw new Error(`Error en Gemini Vision: ${detail}`);
    }

    let raw = response.data.candidates[0].content.parts[0].text.trim();
    raw = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').replace(/^```\n?/, '').replace(/\n?```$/, '');

    try { return JSON.parse(raw); }
    catch (e) { throw new Error(`Formato inválido de Gemini: ${raw.substring(0, 200)}`); }
}

// ─── Guardar en Google Sheets ───────────────────────────────────────────────
async function guardarEnSheets(data) {
    let creds;
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY_B64) {
        creds = {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key : Buffer.from(process.env.GOOGLE_PRIVATE_KEY_B64, 'base64').toString('utf8'),
        };
    } else if (process.env.GOOGLE_CREDENTIALS_JSON) {
        try {
            creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        } catch (e) {
            throw new Error('GOOGLE_CREDENTIALS_JSON tiene formato JSON inválido');
        }
    } else {
        const credsPath = path.join(__dirname, 'credentials.json');
        if (!fs.existsSync(credsPath)) {
            throw new Error('Faltan credenciales de Google: define GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY en el entorno');
        }
        creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    }

    const auth = new JWT({
        email: creds.client_email,
        key  : creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    await sheet.addRow({
        'Fecha de Escaneo': new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
        'Operario'        : data.operario,
        'ID del Rollo'    : data.idRollo,
        'Artículo'        : data.articulo,
        'Ancho (cm)'      : data.ancho,
        'Largo (m)'       : data.largo,
        'Color'           : data.color,
        'Observaciones'   : data.observaciones
    });

    console.log(`✅ Sheets: ${data.idRollo} | ${data.operario}`);
    totalRegistrados++;
}

// ─── Helpers Google Drive ────────────────────────────────────────────────────

/** Carga credenciales igual que Sheets (misma service account) */
function obtenerCreds() {
    if (process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY_B64) {
        return {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key : Buffer.from(process.env.GOOGLE_PRIVATE_KEY_B64, 'base64').toString('utf8'),
        };
    } else if (process.env.GOOGLE_CREDENTIALS_JSON) {
        return JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    } else {
        const p = path.join(__dirname, 'credentials.json');
        if (!fs.existsSync(p)) throw new Error('Sin credenciales Google');
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
}

/** Limpia nombres para usarlos como carpetas en Drive */
function sanitizarNombre(nombre) {
    return (nombre || 'Sin-observacion')
        .replace(/[/\\?%*:|"<>]/g, '-')  // caracteres no permitidos
        .replace(/\s+/g, '_')
        .substring(0, 60);
}

/**
 * Obtiene o crea la carpeta en Drive con estructura:
 * [raíz] / YYYY-MM-DD / [observacion]
 * Usa caché en memoria para evitar búsquedas repetidas.
 * Retorna el ID de la carpeta de la observación.
 */
async function obtenerOCrearCarpeta(drive, nombreObs) {
    const hoy    = new Date().toLocaleDateString('es-CL', { timeZone: 'America/Santiago' }).replace(/\//g, '-');
    const clave  = `${hoy}/${nombreObs}`;

    if (driveFolderCache.has(clave)) return driveFolderCache.get(clave);

    // ── Carpeta raíz ──────────────────────────────────────────────────────────
    let rootId = DRIVE_ROOT_ID;
    if (!rootId) {
        const buscarRoot = await drive.files.list({
            q: `name='${DRIVE_ROOT_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id)',
            spaces: 'drive'
        });
        if (buscarRoot.data.files.length > 0) {
            rootId = buscarRoot.data.files[0].id;
        } else {
            const crear = await drive.files.create({
                requestBody: { name: DRIVE_ROOT_NAME, mimeType: 'application/vnd.google-apps.folder' },
                fields: 'id'
            });
            rootId = crear.data.id;
        }
        driveFolderCache.set('__root__', rootId);
    }

    // ── Subcarpeta de fecha ───────────────────────────────────────────────────
    const claveHoy = `__date__/${hoy}`;
    let fechaId = driveFolderCache.get(claveHoy);
    if (!fechaId) {
        const buscar = await drive.files.list({
            q: `name='${hoy}' and '${rootId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            fields: 'files(id)', spaces: 'drive'
        });
        if (buscar.data.files.length > 0) {
            fechaId = buscar.data.files[0].id;
        } else {
            const crear = await drive.files.create({
                requestBody: { name: hoy, mimeType: 'application/vnd.google-apps.folder', parents: [rootId] },
                fields: 'id'
            });
            fechaId = crear.data.id;
        }
        driveFolderCache.set(claveHoy, fechaId);
    }

    // ── Subcarpeta de observación ─────────────────────────────────────────────
    let obsId;
    const buscarObs = await drive.files.list({
        q: `name='${nombreObs}' and '${fechaId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)', spaces: 'drive'
    });
    if (buscarObs.data.files.length > 0) {
        obsId = buscarObs.data.files[0].id;
    } else {
        const crear = await drive.files.create({
            requestBody: { name: nombreObs, mimeType: 'application/vnd.google-apps.folder', parents: [fechaId] },
            fields: 'id'
        });
        obsId = crear.data.id;
    }

    driveFolderCache.set(clave, obsId);
    return obsId;
}

/**
 * Sube una foto a Drive en la carpeta correcta.
 * Retorna el ID de la carpeta de destino (para construir el link).
 */
async function subirFotoADrive(buffer, nombreArchivo, nombreObs) {
    if (!process.env.GOOGLE_DRIVE_ENABLED || process.env.GOOGLE_DRIVE_ENABLED === 'false') {
        return null; // Drive desactivado por config
    }
    try {
        const creds = obtenerCreds();
        const auth  = new google.auth.JWT({
            email : creds.client_email,
            key   : creds.private_key,
            scopes: [
                'https://www.googleapis.com/auth/drive.file',
                'https://www.googleapis.com/auth/drive'
            ],
        });
        const drive    = google.drive({ version: 'v3', auth });
        const carpetaId = await obtenerOCrearCarpeta(drive, nombreObs);

        const stream = Readable.from(buffer);
        const response = await drive.files.create({
            requestBody: {
                name    : nombreArchivo,
                parents : [carpetaId],
                mimeType: 'image/jpeg'
            },
            media: {
                mimeType: 'image/jpeg',
                body: stream
            },
            fields: 'id'
        });

        const fileId = response.data?.id;
        console.log(`☁️ Drive: ${nombreArchivo} → ${nombreObs} [fileId=${fileId}]`);
        return carpetaId;
    } catch (err) {
        // Drive falla silenciosamente — Sheets siempre tiene prioridad
        console.error('⚠️ Drive upload falló (no crítico):', err.stack || err.message || err);
        return null;
    }
}

// ─── Utilidad ───────────────────────────────────────────────────────────────
function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatAxiosError(error) {
    if (!error) return 'Error desconocido';
    const status = error.response?.status;
    const statusText = error.response?.statusText ? ` ${error.response.statusText}` : '';
    const data = error.response?.data;
    const dataText = data ? ` | response: ${typeof data === 'string' ? data : JSON.stringify(data).substring(0, 500)}` : '';
    return `${error.message || 'Error Axios'}${status ? ` (status ${status}${statusText})` : ''}${dataText}`;
}

// ─── Limpieza periódica (evita fugas de memoria) ────────────────────────────
setInterval(() => {
    const ahora = Date.now();
    const TIMEOUT_USUARIO = 15 * 60 * 1000; // 15 min sin actividad
    const TIMEOUT_ALBUM   = 5  * 60 * 1000;

    for (const [chatId, state] of userStates.entries()) {
        if (ahora - (state.timestamp || 0) > TIMEOUT_USUARIO) {
            userStates.delete(chatId);
            console.log(`🧹 Estado+cola limpiados para chat ${chatId}`);
            // Notificar al usuario si tenía cosas pendientes
            if (state.cola?.length > 0 || state.pendiente) {
                bot.sendMessage(chatId,
                    `⏰ *Sesión expirada por inactividad.*\nSe cancelaron los lotes pendientes.\nPuedes volver a enviar fotos cuando quieras.`,
                    { parse_mode: 'Markdown' }
                ).catch(() => {});
            }
        }
    }

    for (const [groupId, album] of albumTracker.entries()) {
        if (ahora - (album.timestamp || 0) > TIMEOUT_ALBUM) {
            clearTimeout(album.timer);
            albumTracker.delete(groupId);
        }
    }
}, 5 * 60 * 1000);

// ─── Servidor HTTP (Hostinger) ──────────────────────────────────────────────
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => res.send('Bot de Logística activo ✅'));

app.get('/health', (_, res) => {
    const mem = process.memoryUsage();
    // Calcular lotes totales en cola
    let lotesEnCola = 0;
    for (const state of userStates.values()) {
        lotesEnCola += (state.cola?.length || 0) + (state.pendiente ? 1 : 0);
    }
    res.json({
        status         : 'ok',
        uptime_horas   : (process.uptime() / 3600).toFixed(1),
        memoria_mb     : (mem.rss / 1024 / 1024).toFixed(1),
        registrados    : totalRegistrados,
        estados_activos: userStates.size,
        lotes_en_cola  : lotesEnCola,
        albumes_activos: albumTracker.size,
        timestamp      : new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })
    });
});

app.listen(PORT, () => console.log(`🌐 Servidor HTTP activo en puerto ${PORT}`));

process.on('unhandledRejection', (r) => console.error('❌ Error no manejado:', r));
