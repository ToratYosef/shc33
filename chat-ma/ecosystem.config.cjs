module.exports = {
  apps: [
    {
      name: 'chat-ma',
      script: 'server/server.js',
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        CHAT_MA_BASE_PATH: '/chat-ma'
      }
    }
  ]
};
