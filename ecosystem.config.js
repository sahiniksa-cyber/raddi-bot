module.exports = {
  apps: [{
    name: 'jwab-bot',
    script: 'index.js',
    watch: false,
    autorestart: true,
    max_restarts: 10,
    restart_delay: 5000,
    max_memory_restart: '500M',
    env: { NODE_ENV: 'production', PORT: 3000 },
    error_file: 'logs/err.log',
    out_file: 'logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
  }],
};
