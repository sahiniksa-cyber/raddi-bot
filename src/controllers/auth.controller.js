'use strict';

const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const db = require('../db/client');
const { consumePreActivationForUser } = require('../services/admin/pre-activations');
const { setAccess, setAccessExpiry } = require('../services/billing/billing-service');

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => (err ? reject(err) : resolve()));
  });
}

function publicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role || 'user',
  };
}

function createAuthController() {
  return {
    async login(req, res) {
      try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        const remember = !!(req.body.remember || req.body.rememberMe);
        if (!email || !password) return res.json({ success: false, message: 'الإيميل وكلمة المرور مطلوبة' });

        const result = await db.query(
          'SELECT id, email, name, password_hash, role FROM users WHERE email = $1 LIMIT 1',
          [email],
        );
        const user = result.rows[0];
        if (!user) return res.json({ success: false, message: 'بيانات الدخول غير صحيحة' });

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.json({ success: false, message: 'بيانات الدخول غير صحيحة' });

        req.session.userId = user.id;
        req.session.userName = user.name;
        if (remember) req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
        await saveSession(req);
        res.json({ success: true, ...publicUser(user) });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async register(req, res) {
      try {
        const name = String(req.body.name || '').trim();
        const phone = String(req.body.phone || '').trim();
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '');
        if (!name || !email || password.length < 8) {
          return res.json({ success: false, message: 'الاسم والإيميل وكلمة مرور 8 أحرف مطلوبة' });
        }

        const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows[0]) return res.json({ success: false, message: 'هذا الإيميل مسجل مسبقاً' });

        const count = await db.query('SELECT COUNT(*)::int AS count FROM users');
        const role = count.rows[0].count === 0 ? 'admin' : 'user';
        const hash = await bcrypt.hash(password, 12);
        const id = uuidv4();
        const result = await db.query(
          `INSERT INTO users (id, email, name, phone, password_hash, role, email_verified)
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)
           RETURNING id, email, name, role`,
          [id, email, name, phone || null, hash, role],
        );

        // Auto-activate the account if an admin pre-registered this email.
        // Failures here must not block signup — the user is already created.
        try {
          const preActivation = await consumePreActivationForUser({ email, userId: id });
          if (preActivation && preActivation.durationDays > 0) {
            await setAccess(id, 'active', 'pre_activation', `pre-activation #${preActivation.id}`);
            await setAccessExpiry(id, preActivation.durationDays, `pre-activation #${preActivation.id}`);
          }
        } catch (preErr) {
          // Swallow — pre-activation is best-effort. Log via console only.
          console.error('pre-activation consume failed:', preErr.message);
        }

        req.session.userId = id;
        req.session.userName = name;
        await saveSession(req);
        res.json({ success: true, verified: true, ...publicUser(result.rows[0]) });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },

    async me(req, res) {
      if (!req.session?.userId) return res.json({ loggedIn: false });
      const result = await db.query(
        'SELECT id, email, name, role FROM users WHERE id = $1 LIMIT 1',
        [req.session.userId],
      );
      const user = result.rows[0];
      if (!user) return res.json({ loggedIn: false });
      req.session.userName = user.name;
      res.json({ loggedIn: true, ...publicUser(user) });
    },

    logout(req, res) {
      req.session.destroy(() => res.json({ success: true }));
    },

    async changePassword(req, res) {
      try {
        const currentPassword = String(req.body.currentPassword || '');
        const newPassword = String(req.body.newPassword || '');
        if (newPassword.length < 8) return res.status(400).json({ success: false, message: 'كلمة المرور قصيرة' });

        const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
        const user = result.rows[0];
        if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
          return res.status(400).json({ success: false, message: 'كلمة المرور الحالية غير صحيحة' });
        }

        const hash = await bcrypt.hash(newPassword, 12);
        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
        res.json({ success: true });
      } catch (err) {
        res.status(500).json({ success: false, message: err.message });
      }
    },
  };
}

module.exports = { createAuthController };
