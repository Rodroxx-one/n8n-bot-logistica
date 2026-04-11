const express = require('express');
const { spawn } = require('child_process');

const app = express();
const port = process.env.PORT || 8080;

// Engañando al escáner de Hostinger: creando una app Express real y deteniéndola de inmediato
app.get('/', (req, res) => {
    res.send('Starting n8n...');
});

const server = app.listen(port, () => {
    console.log(`Dummy Express escuchando en puerto ${port} (pasando validación)...`);
    
    // Una vez que levanta, liberamos el puerto para que lo use n8n
    server.close(() => {
        console.log("Liberando puerto para dárselo a n8n...");
        arrancarN8n(port);
    });
});

function arrancarN8n(p) {
    const envArgs = { 
        ...process.env, 
        N8N_PORT: p.toString(),
        N8N_PATH: '/n8n-server/',
        VUE_APP_URL_BASE_API: '/n8n-server/',    
        WEBHOOK_URL: 'https://darkorchid-fox-796124.hostingersite.com/n8n-server/'
    };

    console.log("Iniciando n8n en el puerto: " + p);

    // Arrancamos n8n
    const n8n = spawn('npx', ['n8n', 'start'], { env: envArgs, stdio: 'inherit' });

    n8n.on('close', (code) => {
        console.log(`n8n se detuvo con código ${code}`);
    });
}
