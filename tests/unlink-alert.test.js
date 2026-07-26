'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  buildUnlinkMessage,
  configureUnlinkAlerts,
  sendUnlinkAlert,
  __lastSent,
} = require('../src/services/monitoring/unlink-alert');

function fakeOwnerBot({ status = 'connected' } = {}) {
  const sent = [];
  return {
    sent,
    userId: 'owner-user',
    appState: { status },
    client: { sendMessage: async (jid, text) => { sent.push({ jid, text }); } },
  };
}

function fakeMailer() {
  const mails = [];
  return { mails, sendMail: async (m) => { mails.push(m); } };
}

function fakeDb(phone = null, email = null) {
  return {
    isConfigured: () => true,
    query: async () => ({ rows: [{ phone, email }] }),
  };
}

test('buildUnlinkMessage contains the re-link URL and the phone', () => {
  const msg = buildUnlinkMessage({ phone: '966512345678' });
  assert.match(msg, /انفصل|فك/, 'must say the link was severed');
  assert.match(msg, /jwap\.net/, 'must include the dashboard URL');
  assert.match(msg, /966512345678/);
});

test('sendUnlinkAlert sends via admin bot to owner phone and merchant phone, plus email', async () => {
  __lastSent.clear();
  const bot = fakeOwnerBot();
  const mailer = fakeMailer();
  const prevPhone = process.env.OWNER_ALERT_PHONE;
  const prevEmail = process.env.OWNER_ALERT_EMAIL;
  process.env.OWNER_ALERT_PHONE = '966500000001';
  process.env.OWNER_ALERT_EMAIL = 'alerts@example.com';
  try {
    configureUnlinkAlerts({
      getOwnerBot: async () => bot,
      mailer,
      database: fakeDb('966512345678', 'merchant@example.com'),
      gatewayFactory: () => ({
        send: async request => {
          bot.sent.push({ jid: request.destination, text: request.content });
          return { decision: 'sent' };
        },
      }),
    });
    const result = await sendUnlinkAlert({ userId: 'u1', phone: '966512345678' });
    assert.ok(result.channels.includes('whatsapp_owner'), `owner WhatsApp channel, got ${result.channels}`);
    assert.ok(result.channels.includes('whatsapp_merchant'), 'merchant WhatsApp channel');
    assert.ok(result.channels.includes('email'), 'email channel');
    assert.equal(bot.sent.length, 2, 'two WhatsApp messages (owner + merchant)');
    assert.match(bot.sent[0].text, /jwap\.net/);
    // The MERCHANT's own contact data (the same data shown in the admin page)
    // must be targeted — not just the platform owner's.
    assert.ok(bot.sent.some(s => s.jid === '966512345678@s.whatsapp.net'), 'merchant WhatsApp number must receive the alert');
    assert.ok(mailer.mails.some(m => m.to === 'merchant@example.com'), 'merchant email must receive the alert');
    assert.ok(mailer.mails.some(m => m.to === 'alerts@example.com'), 'owner email copy');
  } finally {
    if (prevPhone === undefined) delete process.env.OWNER_ALERT_PHONE; else process.env.OWNER_ALERT_PHONE = prevPhone;
    if (prevEmail === undefined) delete process.env.OWNER_ALERT_EMAIL; else process.env.OWNER_ALERT_EMAIL = prevEmail;
  }
});

test('merchant phone falls back to the unlinked session number when users.phone is empty', async () => {
  // The unlink kills the BOT link only — the merchant's own WhatsApp account
  // on their phone still receives messages, so alerting that same number works.
  __lastSent.clear();
  const bot = fakeOwnerBot();
  const prev = process.env.OWNER_ALERT_PHONE;
  process.env.OWNER_ALERT_PHONE = '966500000001';
  try {
    configureUnlinkAlerts({
      getOwnerBot: async () => bot,
      mailer: null,
      database: fakeDb(null, null),
      gatewayFactory: () => ({
        send: async request => {
          bot.sent.push({ jid: request.destination, text: request.content });
          return { decision: 'sent' };
        },
      }),
    });
    const result = await sendUnlinkAlert({ userId: 'u1', phone: '966593216744' });
    assert.ok(result.channels.includes('whatsapp_merchant'), `expected merchant channel via session phone, got ${result.channels}`);
    assert.ok(bot.sent.some(s => s.jid === '966593216744@s.whatsapp.net'));
  } finally {
    if (prev === undefined) delete process.env.OWNER_ALERT_PHONE; else process.env.OWNER_ALERT_PHONE = prev;
  }
});

test('cooldown: a second alert for the same user within the window is suppressed', async () => {
  __lastSent.clear();
  const bot = fakeOwnerBot();
  const prev = process.env.OWNER_ALERT_PHONE;
  process.env.OWNER_ALERT_PHONE = '966500000001';
  try {
    configureUnlinkAlerts({ getOwnerBot: async () => bot, mailer: null, database: fakeDb() });
    await sendUnlinkAlert({ userId: 'u1', phone: '' });
    const sentAfterFirst = bot.sent.length;
    const second = await sendUnlinkAlert({ userId: 'u1', phone: '' });
    assert.deepEqual(second.channels, []);
    assert.equal(second.skipped, 'cooldown');
    assert.equal(bot.sent.length, sentAfterFirst, 'second call must send nothing new');
  } finally {
    if (prev === undefined) delete process.env.OWNER_ALERT_PHONE; else process.env.OWNER_ALERT_PHONE = prev;
  }
});

test('dead admin bot: falls through to email without throwing', async () => {
  __lastSent.clear();
  const mailer = fakeMailer();
  const prevPhone = process.env.OWNER_ALERT_PHONE;
  const prevEmail = process.env.OWNER_ALERT_EMAIL;
  process.env.OWNER_ALERT_PHONE = '966500000001';
  process.env.OWNER_ALERT_EMAIL = 'alerts@example.com';
  try {
    configureUnlinkAlerts({ getOwnerBot: async () => fakeOwnerBot({ status: 'stopped' }), mailer, database: fakeDb() });
    const result = await sendUnlinkAlert({ userId: 'u1', phone: '9665' });
    assert.ok(!result.channels.includes('whatsapp_owner'));
    assert.ok(result.channels.includes('email'));
  } finally {
    if (prevPhone === undefined) delete process.env.OWNER_ALERT_PHONE; else process.env.OWNER_ALERT_PHONE = prevPhone;
    if (prevEmail === undefined) delete process.env.OWNER_ALERT_EMAIL; else process.env.OWNER_ALERT_EMAIL = prevEmail;
  }
});

test('feature flag off: no channels, no sends', async () => {
  __lastSent.clear();
  const bot = fakeOwnerBot();
  process.env.UNLINK_ALERT_ENABLED = 'false';
  try {
    configureUnlinkAlerts({ getOwnerBot: async () => bot, mailer: null, database: fakeDb() });
    const result = await sendUnlinkAlert({ userId: 'u1', phone: '9665' });
    assert.deepEqual(result.channels, []);
    assert.equal(bot.sent.length, 0);
  } finally {
    delete process.env.UNLINK_ALERT_ENABLED;
  }
});

// ── wiring: manager emits, runtime-bot listens, server configures

test('baileys manager emits logged_out inside the loggedOut branch', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'whatsapp', 'baileys-connection-manager.js'), 'utf8');
  const branch = src.indexOf('DisconnectReason.loggedOut');
  const emitIdx = src.indexOf("emit('logged_out'", branch);
  const disconnectedIdx = src.indexOf("emit('disconnected'", branch);
  assert.ok(emitIdx > branch, 'logged_out must be emitted in the loggedOut branch');
  assert.ok(emitIdx < disconnectedIdx, 'logged_out fires before the generic disconnected event');
});

test('runtime-bot wires logged_out to sendUnlinkAlert and server configures the service', () => {
  const rb = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'bot', 'runtime-bot.js'), 'utf8');
  assert.match(rb, /connection\.on\('logged_out'/);
  assert.match(rb, /sendUnlinkAlert/);
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(server, /configureUnlinkAlerts/);
});
