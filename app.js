const { spawn } = require('child_process');

// Hostinger inyecta el puerto disponible dinámicamente
const port = process.env.PORT || 8080;

// Definimos variables de entorno obligatorias
const envArgs = { 
    ...process.env, 
    N8N_PORT: port.toString(),
    N8N_PATH: '/n8n-server/',
    VUE_APP_URL_BASE_API: '/n8n-server/',    
    WEBHOOK_URL: 'https://darkorchid-fox-796124.hostingersite.com/n8n-server/'
};

console.log("Iniciando n8n en el puerto: " + port);

// Arrancamos n8n
const n8n = spawn('npx', ['n8n', 'start'], { env: envArgs, stdio: 'inherit' });

n8n.on('close', (code) => {
    console.log(`n8n se detuvo con código ${code}`);
});
