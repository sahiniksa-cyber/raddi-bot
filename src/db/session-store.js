'use strict';

const session = require('express-session');
const db = require('./client');

const Store = session.Store;

class PostgresSessionStore extends Store {
  constructor({ ttlMs = 30 * 24 * 60 * 60 * 1000, cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.ttlMs = ttlMs;
    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch(() => {});
    }, cleanupIntervalMs);
    if (typeof this.cleanupTimer.unref === 'function') this.cleanupTimer.unref();
  }

  expiry(sess) {
    const expires = sess?.cookie?.expires ? new Date(sess.cookie.expires) : null;
    if (expires && !Number.isNaN(expires.getTime())) return expires;
    return new Date(Date.now() + this.ttlMs);
  }

  get(sid, callback) {
    db.query('SELECT sess FROM app_sessions WHERE sid = $1 AND expire > NOW()', [sid])
      .then((result) => callback(null, result.rows[0]?.sess || null))
      .catch((err) => callback(err));
  }

  set(sid, sess, callback = () => {}) {
    db.query(
      `INSERT INTO app_sessions (sid, sess, expire)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
      [sid, JSON.stringify(sess), this.expiry(sess)],
    )
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  touch(sid, sess, callback = () => {}) {
    db.query('UPDATE app_sessions SET expire = $2 WHERE sid = $1', [sid, this.expiry(sess)])
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  destroy(sid, callback = () => {}) {
    db.query('DELETE FROM app_sessions WHERE sid = $1', [sid])
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  cleanup() {
    return db.query('DELETE FROM app_sessions WHERE expire <= NOW()');
  }
}

module.exports = { PostgresSessionStore };
