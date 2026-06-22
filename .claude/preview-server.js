'use strict';

// Lightweight static + mock-API server for previewing the dashboard
// without requiring Postgres/Redis. NOT committed to the repo (lives in .claude/).

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PREVIEW_PORT || '3100', 10);
const DASHBOARD_DIR = path.join(__dirname, '..', 'dashboard');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}

function nowIso(offsetMin = 0) {
  return new Date(Date.now() - offsetMin * 60_000).toISOString();
}

const MOCK_CONVERSATIONS = [
  {
    id: 'c1', status: 'ongoing',
    phoneNumber: '966501234567',
    lastMessageAt: nowIso(2),
    messages: [
      { id: 'm1', direction: 'inbound',  role: 'user',      content: 'السلام عليكم، أبغى اشترك في خدمتكم', createdAt: nowIso(10), status: 'stored' },
      { id: 'm2', direction: 'outbound', role: 'assistant', content: 'وعليكم السلام، أهلاً بك! نوفّر اشتراك شهري بـ 99 ريال واشتراك سنوي بـ 999 ريال. أيّهما يناسبك؟', createdAt: nowIso(9), status: 'sent' },
      { id: 'm3', direction: 'inbound',  role: 'user',      content: 'كم سعر السنوي؟', createdAt: nowIso(3), status: 'stored' },
      { id: 'm4', direction: 'outbound', role: 'assistant', content: 'الاشتراك السنوي 999 ريال، يشمل كل التطبيقات مع توفير مقارنة بالشهري.', createdAt: nowIso(2), status: 'sent' },
    ],
  },
  {
    id: 'c2', status: 'ongoing',
    phoneNumber: '966555111222',
    lastMessageAt: nowIso(15),
    messages: [
      { id: 'm5', direction: 'inbound', role: 'user', content: 'متى يوصل طلبي؟', createdAt: nowIso(15), status: 'stored' },
    ],
  },
  {
    id: 'c3', status: 'finished',
    phoneNumber: '966509998877',
    lastMessageAt: nowIso(60 * 3),
    messages: [
      { id: 'm6', direction: 'inbound',  role: 'user',      content: 'شكراً لكم', createdAt: nowIso(60 * 3 + 1), status: 'stored' },
      { id: 'm7', direction: 'outbound', role: 'assistant', content: 'العفو، نسعد بخدمتك دائماً.', createdAt: nowIso(60 * 3), status: 'sent' },
    ],
  },
  {
    id: 'c4', status: 'finished',
    phoneNumber: null, // simulates @lid-only old customer
    lastMessageAt: nowIso(60 * 24 * 2),
    messages: [
      { id: 'm8', direction: 'inbound', role: 'user', content: 'مرحبا، تتوفر منتجات جديدة؟', createdAt: nowIso(60 * 24 * 2), status: 'stored' },
    ],
  },
  {
    id: 'c5', status: 'ongoing',
    phoneNumber: '966547774433',
    lastMessageAt: nowIso(45),
    messages: [
      { id: 'm9', direction: 'inbound', role: 'user', content: 'أبغى ألغي الاشتراك', createdAt: nowIso(50), status: 'stored' },
      { id: 'm10', direction: 'outbound', role: 'assistant', content: 'بسعدنا مساعدتك. ممكن تأكد رقم الاشتراك؟', createdAt: nowIso(45), status: 'sent' },
    ],
  },
];

const MOCK_CONFIG = {
  model: 'google/gemini-2.0-flash',
  storeName: 'متجر ProStoree (معاينة)',
  botInstructions: 'مساعد ذكي لخدمة عملاء المتجر — رد بطريقة طبيعية ومختصرة.',
  products: [
    { name: 'اشتراك Adobe', price: '', variants: [{ label: 'شهري', price: '99 ريال' }, { label: 'سنوي', price: '999 ريال' }] },
    { name: 'اشتراك Office 365', price: '49 ريال' },
  ],
  welcomeMessage: 'أهلاً بك في متجرنا 🌟',
  welcomeMode: 'inline',
  replyStyle: { employeeName: 'سارة', avoidWords: ['AI', 'بوت'] },
  escalationContacts: [{ name: 'فهد', phone: '966500000000', role: 'مدير المبيعات' }],
};

const MOCK_BILLING = {
  state: { hasAccess: true, status: 'active', plan: 'paid', expiresAt: nowIso(-60 * 24 * 30) },
  account: { remainingMessages: 2400, totalMessages: 3000, messagePriceHalalas: 33 },
  messages: { used: 600, remaining: 2400, total: 3000 },
};

function api(req, res, urlPath) {
  // simple JSON routes
  if (urlPath === '/api/auth/me') {
    return send(res, 200, JSON.stringify({ success: true, loggedIn: true, id: 'preview-user', email: 'preview@local', name: 'معاينة (Preview)', role: 'user' }));
  }
  if (urlPath === '/api/config') {
    if (req.method === 'POST') return send(res, 200, JSON.stringify({ success: true }));
    return send(res, 200, JSON.stringify({ ...MOCK_CONFIG }));
  }
  if (urlPath === '/api/conversations' || urlPath.startsWith('/api/conversations?')) {
    return send(res, 200, JSON.stringify({ success: true, conversations: MOCK_CONVERSATIONS }));
  }
  if (urlPath === '/api/billing/state') {
    return send(res, 200, JSON.stringify({
      success: true,
      state: { accessActive: true, accessBypass: true, status: 'active', autoRenewEnabled: true, receivableHalalas: 0 },
      settings: {},
    }));
  }
  if (urlPath === '/api/billing/messages') {
    return send(res, 200, JSON.stringify({ success: true, ...MOCK_BILLING.messages }));
  }
  if (urlPath === '/api/billing/account') {
    return send(res, 200, JSON.stringify({ success: true, account: MOCK_BILLING.account }));
  }
  if (urlPath === '/api/bot/status') {
    return send(res, 200, JSON.stringify({ success: true, status: 'connected', phone: '966500000000' }));
  }
  if (urlPath === '/api/health') {
    return send(res, 200, JSON.stringify({ ok: true, checks: [] }));
  }
  // generic 200 for anything else under /api
  if (urlPath.startsWith('/api/')) {
    return send(res, 200, JSON.stringify({ success: true }));
  }
  return null;
}

function serveStatic(req, res, urlPath) {
  let filePath;
  if (urlPath === '/' || urlPath === '') filePath = path.join(DASHBOARD_DIR, 'index.html');
  else filePath = path.join(DASHBOARD_DIR, urlPath);

  // basic path safety: must stay inside DASHBOARD_DIR
  if (!filePath.startsWith(DASHBOARD_DIR)) return send(res, 403, 'forbidden', 'text/plain');

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // SPA fallback: serve index.html for unknown routes
      return fs.readFile(path.join(DASHBOARD_DIR, 'index.html'), (e2, data) => {
        if (e2) return send(res, 404, 'not found', 'text/plain');
        send(res, 200, data, MIME['.html']);
      });
    }
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (e3, data) => {
      if (e3) return send(res, 500, 'read error', 'text/plain');
      send(res, 200, data, MIME[ext] || 'application/octet-stream');
    });
  });
}

const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // collect body for POST (we discard it but need to consume the stream)
  if (req.method === 'POST' || req.method === 'PUT') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1e6) req.connection.destroy(); });
    req.on('end', () => {
      const apiResult = api(req, res, urlPath);
      if (apiResult !== null) return;
      serveStatic(req, res, urlPath);
    });
    return;
  }

  const apiResult = api(req, res, urlPath);
  if (apiResult !== null) return;
  serveStatic(req, res, urlPath);
});

server.listen(PORT, () => {
  console.log(`Preview server listening on http://localhost:${PORT}`);
});
