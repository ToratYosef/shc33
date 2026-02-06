const nodemailer = require('nodemailer');

function createEmailTransportConfig({ pooled = true } = {}) {
  return {
    service: 'gmail',
    pool: pooled,
    maxConnections: Number(process.env.EMAIL_MAX_CONNECTIONS || 5),
    maxMessages: Number(process.env.EMAIL_MAX_MESSAGES || 100),
    connectionTimeout: Number(process.env.EMAIL_CONNECTION_TIMEOUT_MS || 8000),
    greetingTimeout: Number(process.env.EMAIL_GREETING_TIMEOUT_MS || 8000),
    socketTimeout: Number(process.env.EMAIL_SOCKET_TIMEOUT_MS || 15000),
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  };
}

function createEmailTransporter({ pooled = true } = {}) {
  return nodemailer.createTransport(createEmailTransportConfig({ pooled }));
}

function createEmailClient() {
  const transporter = createEmailTransporter({ pooled: true });

  async function sendMailWithFallback(mailOptions) {
    try {
      return await transporter.sendMail(mailOptions);
    } catch (error) {
      const isTimeout = error && (error.code === 'ETIMEDOUT' || error.command === 'CONN');
      if (!isTimeout) {
        throw error;
      }

      console.error('Primary SMTP attempt timed out; retrying with fresh Gmail transport.', {
        code: error.code,
        command: error.command,
        message: error.message,
      });

      const retryTransporter = createEmailTransporter({ pooled: false });
      return retryTransporter.sendMail(mailOptions);
    }
  }

  return { transporter, sendMailWithFallback };
}

module.exports = {
  createEmailTransportConfig,
  createEmailTransporter,
  createEmailClient,
};
