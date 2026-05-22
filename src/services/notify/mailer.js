'use strict';

let nodemailer;
try { nodemailer = require('nodemailer'); } catch (_) { nodemailer = null; }

function createMailer(env = process.env) {
  if (!nodemailer) return null;
  const host = env.SMTP_HOST;
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASS;
  if (!host || !user || !pass) return null;

  const transport = nodemailer.createTransport({
    host,
    port: parseInt(env.SMTP_PORT || '587', 10),
    secure: env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
  const from = env.SMTP_FROM || user;

  return {
    async sendMail({ to, subject, text, html }) {
      return transport.sendMail({ from: `"جواب" <${from}>`, to, subject, text, html });
    },
  };
}

module.exports = { createMailer };
