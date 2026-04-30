module.exports = {
    apps: [{
        name        : 'bot-logistica',
        script      : 'server.js',

        // ── Reinicio automático ─────────────────────────────────────────
        watch         : false,          // No reiniciar por cambios de archivo
        autorestart   : true,           // Reiniciar si el proceso muere
        max_restarts  : 10,             // Máximo 10 reinicios seguidos (evita loops)
        min_uptime    : '10s',          // Considera estable si corre +10 segundos
        restart_delay : 3000,           // Esperar 3s entre reinicios

        // ── Límite de memoria (reinicia si supera 300MB) ────────────────
        max_memory_restart: '300M',

        // ── Variables de entorno (Hostinger las inyecta desde el panel) ─
        env: {
            NODE_ENV: 'production'
        },

        // ── Logs ────────────────────────────────────────────────────────
        error_file  : './logs/error.log',
        out_file    : './logs/output.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs  : true,

        // ── Limpieza de logs (máximo 7 días) ────────────────────────────
        log_type: 'json'
    }]
};
