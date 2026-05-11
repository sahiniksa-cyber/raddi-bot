/**
 * lib/logger.js — Structured Logger
 *
 * كل رسالة مرتبطة بمرحلة (stage) ومعرّف مستخدم (userId)
 * يحتفظ بآخر 50 رسالة للعرض في الداشبورد
 */
'use strict';

class Logger {
  constructor(userId, maxEntries = 50) {
    this.userId = userId;
    this.maxEntries = maxEntries;
    this.entries = [];     // أحدث الأحداث — تُعرض في لوحة التحكم
  }

  /**
   * @param {'boot'|'auth'|'qr'|'connection'|'heartbeat'|'message'|'ai'|'queue'|'escalation'|'config'|'error'|'system'} stage
   * @param {string} message
   * @param {object} [meta] — بيانات إضافية (خطأ، رقم، موديل...)
   */
  _write(level, stage, message, meta) {
    const ts = new Date();
    const iso = ts.toISOString();
    const timeStr = ts.toLocaleTimeString('ar');
    const line = `[${timeStr}] [${stage}] ${message}`;

    // Console output
    const prefix = `[${this.userId.slice(0, 8)}]`;
    const normalizedMeta = meta instanceof Error
      ? { error: meta.message, stack: meta.stack }
      : meta;
    const metaStr = normalizedMeta ? ` ${JSON.stringify(normalizedMeta)}` : '';
    const consoleLine = `[${iso}] ${prefix} [${level.toUpperCase()}] [${stage}] ${message}${metaStr}`;

    if (level === 'error') {
      console.error(consoleLine);
    } else if (level === 'warn') {
      console.warn(consoleLine);
    } else {
      console.log(consoleLine);
    }

    // Dashboard log buffer
    this.entries.unshift(line);
    if (this.entries.length > this.maxEntries) this.entries.pop();
  }

  info(stage, message, meta)  { this._write('info', stage, message, meta); }
  warn(stage, message, meta)  { this._write('warn', stage, message, meta); }
  error(stage, message, meta) { this._write('error', stage, message, meta); }

  /** backward-compat shortcut: log(msg) — يُعامل كـ info/system */
  log(message) { this.info('system', message); }

  /** استرجع آخر N سطر (للداشبورد) */
  recent(n = 8) { return this.entries.slice(0, n); }

  /** كل السطور */
  all() { return this.entries; }
}

module.exports = Logger;
