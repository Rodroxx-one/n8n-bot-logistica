require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');
const path = require('path');

// ─── Validación de variables de entorno ────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;
const SPREADSHEET_ID  = process.env.SPREADSHEET_ID;

if (!TELEGRAM_TOKEN || !GEMINI_API_KEY || !SPREADSHEET_ID) {
    console.error('❌ Faltan variables de entorno. Revisa tu archivo .env');
    process.exit(1);
}

// ─── Inicialización del bot ─────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('🤖 Bot de logística iniciado correctamente.');

// ─── Manejador de mensajes con foto ────────────────────────────────────────
bot.on('photo', async (msg) => {
    const chatId    = msg.chat.id;
    const operario  = `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim();
    const caption   = msg.caption || 'Sin observaciones';
    let ackMsgId    = null;

    try {
        // 1. Acuse de recibo inmediato
        const ackMsg = await bot.sendMessage(chatId,
            '📷 Imagen recibida. Leyendo etiqueta con IA... ⏳',
            { reply_to_message_id: msg.message_id }
        );
        ackMsgId = ackMsg.message_id;

        // 2. Obtener el file_id de la mejor resolución disponible
        const photos  = msg.photo;
        const bestPhoto = photos[photos.length - 1]; // última = mayor resolución
        const fileId  = bestPhoto.file_id;

        // 3. Obtener URL de descarga de Telegram (método oficial)
        const fileUrl = await bot.getFileLink(fileId);
        console.log('📥 Descargando imagen desde:', fileUrl);

        // 4. Descargar imagen como buffer
        const imageResponse = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const imageBase64   = Buffer.from(imageResponse.data).toString('base64');
        console.log(`🖼️ Imagen descargada: ${imageResponse.data.byteLength} bytes`);

        // 5. Llamar a Gemini Vision API
        const geminiData = await llamarGeminiVision(imageBase64);

        // 6. Guardar en Google Sheets
        await guardarEnSheets({
            fechaEscaneo : new Date().toLocaleString('es-CL', { timeZone: 'America/Santiago' }),
            operario,
            ...geminiData,
            observaciones: caption
        });

        // 7. Respuesta de éxito
        await bot.sendMessage(chatId,
            `✅ *¡Rollo registrado exitosamente!*\n\n` +
            `📦 *ID Rollo:* ${geminiData.idRollo}\n` +
            `🏷️ *Artículo:* ${geminiData.articulo}\n` +
            `📐 *Medidas:* ${geminiData.ancho}cm × ${geminiData.largo}m\n` +
            `🎨 *Color:* ${geminiData.color}\n` +
            `👤 *Operario:* ${operario}\n` +
            `📝 *Obs:* ${caption}`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error('❌ Error procesando foto:', error.message);
        console.error('❌ Stack:', error.stack);
        if (error.response) console.error('❌ API Response:', JSON.stringify(error.response?.data).substring(0, 500));
        await bot.sendMessage(chatId,
            `❌ *Error al procesar la etiqueta.*\n\n` +
            `Por favor:\n` +
            `• Asegúrate que la foto sea clara y bien iluminada\n` +
            `• La etiqueta debe ser completamente legible\n` +
            `• Intenta enviar la foto nuevamente\n\n` +
            `_Detalle: ${error.message.substring(0, 100)}_`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ─── Manejador de mensajes de texto ────────────────────────────────────────
bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    const texto  = msg.text;

    if (texto === '/start') {
        await bot.sendMessage(chatId,
            `👋 ¡Hola! Soy el *Bot de Logística*.\n\n` +
            `📋 *¿Cómo usar?*\n` +
            `Envíame una foto de la etiqueta del rollo de tela y automáticamente:\n` +
            `1️⃣ Leeré los datos con IA\n` +
            `2️⃣ Registraré el rollo en Google Sheets\n` +
            `3️⃣ Te confirmaré los datos capturados\n\n` +
            `_Puedes agregar una descripción/observación como caption de la foto._`,
            { parse_mode: 'Markdown' }
        );
    } else {
        await bot.sendMessage(chatId,
            `⚠️ Solo proceso *fotos de etiquetas*.\n\nEnvía una imagen de la etiqueta del rollo.`,
            { parse_mode: 'Markdown' }
        );
    }
});

// ─── Función: llamar a Gemini Vision ───────────────────────────────────────
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
        contents: [{
            parts: [
                { text: prompt },
                { inlineData: { mimeType: 'image/jpeg', data: imageBase64 } }
            ]
        }]
    }, {
        timeout: 30000,
        headers: { 'Content-Type': 'application/json' }
    });

    // Extraer y parsear la respuesta
    let rawText = response.data.candidates[0].content.parts[0].text.trim();

    // Limpiar posible markdown que Gemini agregue
    rawText = rawText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    rawText = rawText.replace(/^```\n?/, '').replace(/\n?```$/, '');

    try {
        return JSON.parse(rawText);
    } catch (e) {
        throw new Error(`Gemini devolvió un formato inválido: ${rawText.substring(0, 200)}`);
    }
}

// ─── Función: guardar en Google Sheets ─────────────────────────────────────
async function guardarEnSheets(data) {
    // Cargar credenciales de service account
    const credsPath = path.join(__dirname, 'credentials.json');
    if (!fs.existsSync(credsPath)) {
        throw new Error('Falta el archivo credentials.json (Service Account de Google)');
    }

    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));

    const auth = new JWT({
        email: creds.client_email,
        key: creds.private_key,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    const doc = new GoogleSpreadsheet(SPREADSHEET_ID, auth);
    await doc.loadInfo();

    const sheet = doc.sheetsByIndex[0]; // Primera hoja

    await sheet.addRow({
        'Fecha de Escaneo' : data.fechaEscaneo,
        'Operario'         : data.operario,
        'ID del Rollo'     : data.idRollo,
        'Artículo'         : data.articulo,
        'Ancho (cm)'       : data.ancho,
        'Largo (m)'        : data.largo,
        'Color'            : data.color,
        'Observaciones'    : data.observaciones
    });

    console.log(`✅ Rollo registrado: ${data.idRollo} por ${data.operario}`);
}

// ─── Servidor HTTP (requerido por Hostinger para mantener el proceso vivo) ─
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot de Logística activo ✅'));
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(PORT, () => {
    console.log(`🌐 Servidor HTTP activo en puerto ${PORT}`);
});

// ─── Manejo de errores globales ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    console.error('❌ Error no manejado:', reason);
});
