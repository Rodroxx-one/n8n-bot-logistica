require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

// ─── Validación de variables de entorno ────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !SPREADSHEET_ID) {
    console.error('❌ Faltan variables de entorno. Revisa tu archivo .env');
    process.exit(1);
}

// ─── Inicialización del bot ─────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('🤖 Bot de logística iniciado correctamente.');

// ─── Cola de procesamiento ──────────────────────────────────────────────────
let processingQueue = Promise.resolve();
const DELAY_MS = 1500;
let totalRegistrados = 0; // Contador global para el health check

// ─── Estado de conversación por usuario ────────────────────────────────────
// Permite saber si el usuario está esperando escribir una observación
const userStates = new Map();
// { chatId → { estado: 'esperando_obs', pendiente: { fileIds, isAlbum, operario } } }

// ─── Rastreo de álbumes de Telegram ────────────────────────────────────────
const albumTracker = new Map();

// ─── Manejador de fotos ─────────────────────────────────────────────────────
bot.on('photo', async (msg) => {
    const chatId     = msg.chat.id;
    const operario   = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
    const mediaGroup = msg.media_group_id;
    const fileId     = msg.photo[msg.photo.length - 1].file_id;

    // Si el usuario está en espera de observación, ignorar foto nueva (sin solapar)
    if (userStates.has(chatId)) {
        await bot.sendMessage(chatId,
            `⚠️ Aún hay fotos pendientes de procesar. Responde primero la observación anterior.`
        );
        return;
    }

    if (mediaGroup) {
        manejarFotoDeAlbum(mediaGroup, chatId, operario, fileId);
    } else {
        await pedirObservacion(chatId, operario, [fileId], false, msg.message_id);
    }
});

// ─── Manejar foto de álbum ──────────────────────────────────────────────────
function manejarFotoDeAlbum(mediaGroupId, chatId, operario, fileId) {
    if (!albumTracker.has(mediaGroupId)) {
        albumTracker.set(mediaGroupId, { chatId, operario, fileIds: [], timer: null });
    }

    const album = albumTracker.get(mediaGroupId);
    album.fileIds.push(fileId);

    clearTimeout(album.timer);
    album.timer = setTimeout(async () => {
        const { fileIds } = albumTracker.get(mediaGroupId);
        albumTracker.delete(mediaGroupId);
        await pedirObservacion(chatId, operario, fileIds, true, null);
    }, 2000);
}

// ─── Preguntar observación con teclado inline ───────────────────────────────
async function pedirObservacion(chatId, operario, fileIds, isAlbum, replyToId) {
    const cantidad = fileIds.length;
    const txt = isAlbum
        ? `📦 *${cantidad} fotos recibidas.*\n\n¿Deseas agregar una observación para este lote?`
        : `📷 *Foto recibida.*\n\n¿Deseas agregar una observación?`;

    const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [[
                { text: '✅ Sin observación', callback_data: `obs_no|${chatId}` },
                { text: '📝 Agregar observación', callback_data: `obs_si|${chatId}` }
            ]]
        }
    };
    if (replyToId) opts.reply_to_message_id = replyToId;

    await bot.sendMessage(chatId, txt, opts);

    // Guardar estado pendiente
    userStates.set(chatId, {
        estado: 'esperando_decision',
        pendiente: { fileIds, isAlbum, operario }
    });
}

// ─── Manejador de botones inline ────────────────────────────────────────────
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data; // "obs_no|chatId" o "obs_si|chatId"

    await bot.answerCallbackQuery(query.id); // quitar el "cargando..." del botón

    const state = userStates.get(chatId);
    if (!state) {
        await bot.editMessageText('⚠️ Esta acción ya expiró.', {
            chat_id: chatId, message_id: query.message.message_id
        });
        return;
    }

    if (data.startsWith('obs_no')) {
        // Sin observación → procesar de inmediato
        userStates.delete(chatId);
        await bot.editMessageText(
            `⏳ *Procesando${state.pendiente.isAlbum ? ` ${state.pendiente.fileIds.length} fotos` : ''}...*`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
        );
        iniciarProcesamiento(chatId, state.pendiente, 'Sin observaciones');

    } else if (data.startsWith('obs_si')) {
        // Pedir texto de observación
        userStates.set(chatId, { ...state, estado: 'esperando_obs' });
        await bot.editMessageText(
            `✏️ *Escribe la observación ahora:*\n_Ejemplo: Camión #4, ingreso bodega norte_`,
            { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
        );
    }
});

// ─── Manejador de mensajes de texto ─────────────────────────────────────────
bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const texto  = msg.text;

    // Comandos siempre disponibles
    if (texto === '/start' || texto === '/ayuda') {
        await bot.sendMessage(chatId,
            `👋 *Bot de Logística — Escaneo de Rollos*\n\n` +
            `📋 *Cómo usar:*\n\n` +
            `*📷 Foto individual:*\nEnvía una foto → el bot pregunta si tienes observación → registra.\n\n` +
            `*📦 Álbum (múltiples fotos):*\nSelecciona hasta *10 fotos* y envíalas juntas.\nEl bot procesa todo el lote con una sola observación.\n\n` +
            `*💡 Tip para camiones:*\nEnvía grupos de 10 fotos → espera el resumen → continúa con el siguiente grupo.`,
            { parse_mode: 'Markdown' }
        );
        return;
    }

    // Si el usuario está esperando escribir una observación
    const state = userStates.get(chatId);
    if (state && state.estado === 'esperando_obs') {
        const observacion = texto.trim();
        userStates.delete(chatId);

        await bot.sendMessage(chatId,
            `✅ Observación guardada: _"${observacion}"_\n⏳ *Procesando...*`,
            { parse_mode: 'Markdown' }
        );

        iniciarProcesamiento(chatId, state.pendiente, observacion);
        return;
    }

    // Mensaje de texto sin contexto
    await bot.sendMessage(chatId,
        `ℹ️ Solo proceso *fotos de etiquetas*.\nEnvía una foto o un álbum.\nEscribe /ayuda para instrucciones.`,
        { parse_mode: 'Markdown' }
    );
});

// ─── Iniciar el procesamiento de fotos (individual o lote) ─────────────────
function iniciarProcesamiento(chatId, pendiente, observacion) {
    const { fileIds, isAlbum, operario } = pendiente;

    if (!isAlbum) {
        // Foto individual
        processingQueue = processingQueue.then(async () => {
            try {
                const datos = await descargarYProcesar(fileIds[0]);
                await guardarEnSheets({ ...datos, operario, observaciones: observacion });
                await bot.sendMessage(chatId,
                    `✅ *¡Rollo registrado!*\n\n` +
                    `📦 *ID:* ${datos.idRollo}\n` +
                    `🏷️ *Artículo:* ${datos.articulo}\n` +
                    `📐 *Medidas:* ${datos.ancho}cm × ${datos.largo}m\n` +
                    `🎨 *Color:* ${datos.color}\n` +
                    `📝 *Obs:* ${observacion}`,
                    { parse_mode: 'Markdown' }
                );
            } catch (error) {
                console.error('❌ Error:', error.message);
                if (error.response) console.error('❌ API:', JSON.stringify(error.response?.data).substring(0, 300));
                await bot.sendMessage(chatId,
                    `❌ *Error al procesar la etiqueta.*\n_${error.message.substring(0, 150)}_`,
                    { parse_mode: 'Markdown' }
                );
            }
            await esperar(DELAY_MS);
        });
    } else {
        // Álbum — procesar todas en cola
        const total = fileIds.length;
        let exitosos = 0;
        let fallidos = 0;
        const detalles = [];

        console.log(`📦 Álbum: ${total} fotos | ${operario} | Obs: "${observacion}"`);

        for (let i = 0; i < fileIds.length; i++) {
            const numero = i + 1;
            processingQueue = processingQueue.then(async () => {
                try {
                    const datos = await descargarYProcesar(fileIds[i]);
                    await guardarEnSheets({ ...datos, operario, observaciones: observacion });
                    exitosos++;
                    detalles.push(`✅ ${numero}. *${datos.idRollo}* — ${datos.color} ${datos.ancho}cm×${datos.largo}m`);
                    console.log(`✅ [${numero}/${total}] ${datos.idRollo}`);
                } catch (error) {
                    fallidos++;
                    detalles.push(`❌ ${numero}. Error — ${error.message.substring(0, 60)}`);
                    console.error(`❌ [${numero}/${total}]`, error.message);
                }
                if (numero === total) await enviarResumenAlbum(chatId, total, exitosos, fallidos, detalles);
                await esperar(DELAY_MS);
            });
        }
    }
}

// ─── Enviar resumen del lote ─────────────────────────────────────────────────
async function enviarResumenAlbum(chatId, total, exitosos, fallidos, detalles) {
    const icono = fallidos === 0 ? '🎉' : fallidos === total ? '❌' : '⚠️';
    await bot.sendMessage(chatId,
        `${icono} *Lote completado: ${exitosos}/${total} rollos registrados*\n` +
        (fallidos > 0 ? `⚠️ ${fallidos} foto(s) con error\n` : ``) +
        `\n${detalles.join('\n')}`,
        { parse_mode: 'Markdown' }
    );
}

// ─── Descargar y procesar foto con Gemini ───────────────────────────────────
async function descargarYProcesar(fileId) {
    const fileUrl = await bot.getFileLink(fileId);
    console.log('📥 Descargando:', fileUrl);
    const res = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const b64 = Buffer.from(res.data).toString('base64');
    console.log(`🖼️ ${res.data.byteLength} bytes`);
    return await llamarGeminiVision(b64);
}

// ─── Llamar a Gemini Vision API ─────────────────────────────────────────────
async function llamarGeminiVision(imageBase64) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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

    const response = await axios.post(url, {
        contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }] }]
    }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

    let raw = response.data.candidates[0].content.parts[0].text.trim();
    raw = raw.replace(/^```json\n?/, '').replace(/\n?```$/, '').replace(/^```\n?/, '').replace(/\n?```$/, '');

    try { return JSON.parse(raw); }
    catch (e) { throw new Error(`Formato inválido de Gemini: ${raw.substring(0, 200)}`); }
}

// ─── Guardar en Google Sheets ───────────────────────────────────────────────
async function guardarEnSheets(data) {
    const credsPath = path.join(__dirname, 'credentials.json');
    if (!fs.existsSync(credsPath)) throw new Error('Falta credentials.json');

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const auth  = new JWT({
        email: creds.client_email,
        key: creds.private_key,
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
    totalRegistrados++; // Sumar al contador del health check
}

// ─── Utilidad ───────────────────────────────────────────────────────────────
function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Limpieza periódica (evita fugas de memoria en fines de semana) ──────────
// Borra estados de conversación que llevan más de 10 minutos sin actividad
setInterval(() => {
    const ahora = Date.now();

    // Limpiar userStates antiguos (>10 min)
    for (const [chatId, state] of userStates.entries()) {
        if (state.timestamp && ahora - state.timestamp > 10 * 60 * 1000) {
            userStates.delete(chatId);
            console.log(`🧹 Estado limpiado para chat ${chatId}`);
        }
    }

    // Limpiar albumTracker colgados (>5 min)
    for (const [groupId, album] of albumTracker.entries()) {
        if (album.timestamp && ahora - album.timestamp > 5 * 60 * 1000) {
            clearTimeout(album.timer);
            albumTracker.delete(groupId);
        }
    }
}, 5 * 60 * 1000); // Cada 5 minutos

// ─── Servidor HTTP (Hostinger) ──────────────────────────────────────────────
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Bot de Logística activo ✅'));
app.get('/health', (_, res) => {
    const mem = process.memoryUsage();
    res.json({
        status      : 'ok',
        uptime_horas: (process.uptime() / 3600).toFixed(1),
        memoria_mb  : (mem.rss / 1024 / 1024).toFixed(1),
        registrados : totalRegistrados,
        estados_activos: userStates.size,
        albumes_activos: albumTracker.size,
        timestamp   : new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' })
    });
});
app.listen(PORT, () => console.log(`🌐 Servidor HTTP activo en puerto ${PORT}`));

process.on('unhandledRejection', (r) => console.error('❌ Error no manejado:', r));
