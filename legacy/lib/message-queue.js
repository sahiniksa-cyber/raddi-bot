/**
 * lib/message-queue.js — Decoupled Message Queue
 *
 * ██ المبدأ: استقبال الرسائل (enqueue) منفصل تماماً عن المعالجة (process)
 *
 * - enqueue() فوري — لا يحجب event loop أبداً
 * - لكل sender طابور خاص (per-sender serialization)
 * - معالجة واحدة فقط لكل sender في نفس الوقت
 * - تنظيف تلقائي: الأقفال تنتهي بعد 3 دقائق (حماية من العلق)
 * - dedup: الرسائل المكررة (نفس الـ ID) تُتجاهل
 *
 * Usage:
 *   const queue = new MessageQueue(logger);
 *   queue.onProcess(async (sender, msg, meta) => { ... });
 *   queue.enqueue(sender, msg, meta);
 */
'use strict';

const { TIMERS } = require('../../lib/constants');

class MessageQueue {
  constructor(logger) {
    this.logger = logger;

    /** @type {Map<string, Array<{msg, meta, enqueuedAt}>>} sender → pending messages */
    this._queues = new Map();

    /** @type {Map<string, number>} sender → processing start timestamp */
    this._processing = new Map();

    /** @type {Set<string>} handled message IDs (dedup) */
    this._handledIds = new Set();

    /** @type {Function|null} async (sender, msg, meta) => void */
    this._handler = null;

    /** @type {Set<NodeJS.Timeout>} delayed retry timers */
    this._retryTimers = new Set();

    this._stats = {
      enqueued: 0,
      processed: 0,
      failed: 0,
      retried: 0,
      dropped: 0,
    };

    this._maxHandledIds = 800;
    this._trimAt = 400;
  }

  /**
   * سجّل handler المعالجة
   * @param {Function} fn — async (sender, msg, meta) => void
   */
  onProcess(fn) {
    this._handler = fn;
  }

  /**
   * أضف رسالة للطابور — يعود فوراً
   * @param {string} sender — معرف المرسل (e.g. "966...@c.us")
   * @param {object} msg — كائن الرسالة من whatsapp-web.js
   * @param {object} [meta] — بيانات إضافية (isFirstMsg, etc.)
   * @returns {boolean} true إذا أُضيفت، false إذا مكررة أو مرفوضة
   */
  enqueue(sender, msg, meta = {}) {
    // ── Dedup by message ID ──
    const msgId = msg.id?._serialized || msg.id?.id;
    if (msgId && !meta.skipDedup) {
      if (this._handledIds.has(msgId)) {
        this.logger.info('queue', `⏭ رسالة مكررة — تجاهل`);
        return false;
      }
      this._handledIds.add(msgId);
      if (this._handledIds.size > this._maxHandledIds) {
        const arr = Array.from(this._handledIds);
        this._handledIds = new Set(arr.slice(-this._trimAt));
      }
    }

    // ── Auto-expire stuck processing locks ──
    if (this._processing.has(sender)) {
      const startedAt = this._processing.get(sender);
      if (startedAt && Date.now() - startedAt > TIMERS.PROCESSING_LOCK_EXPIRE_MS) {
        this._processing.delete(sender);
        this.logger.warn('queue', `${this._short(sender)} — كان عالق ${Math.round(TIMERS.PROCESSING_LOCK_EXPIRE_MS / 60000)}+ دقائق، تم التحرير`);
      }
    }

    // ── Enqueue ──
    if (!this._queues.has(sender)) this._queues.set(sender, []);
    this._queues.get(sender).push({ msg, meta, enqueuedAt: Date.now() });
    this._stats.enqueued++;

    // ── Trigger processing (non-blocking) ──
    this._drain(sender);
    return true;
  }

  retryLater(sender, msg, meta = {}, reason = '') {
    const attempt = (meta.attempt || 1) + 1;
    if (attempt > TIMERS.MESSAGE_MAX_ATTEMPTS) {
      this._stats.dropped++;
      this.logger.error('queue', `${this._short(sender)} — dropped after ${TIMERS.MESSAGE_MAX_ATTEMPTS} attempts (${reason})`);
      return false;
    }

    this._stats.retried++;
    const delay = TIMERS.MESSAGE_RETRY_DELAY_MS * (attempt - 1);
    this.logger.warn('queue', `${this._short(sender)} — retry ${attempt}/${TIMERS.MESSAGE_MAX_ATTEMPTS} in ${Math.round(delay / 1000)}s (${reason})`);
    const timer = setTimeout(() => {
      this._retryTimers.delete(timer);
      this.enqueue(sender, msg, { ...meta, attempt, skipDedup: true });
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
    this._retryTimers.add(timer);
    return true;
  }

  /**
   * معالجة الطابور لمرسل معين — يعالج رسالة واحدة في كل مرة
   * @private
   */
  async _drain(sender) {
    // إذا المرسل قيد المعالجة حالياً، الرسالة الجديدة تنتظر دورها
    if (this._processing.has(sender)) return;

    const queue = this._queues.get(sender);
    if (!queue || queue.length === 0) {
      this._queues.delete(sender);
      return;
    }

    // خذ أول رسالة
    const { msg, meta } = queue.shift();
    if (queue.length === 0) this._queues.delete(sender);

    this._processing.set(sender, Date.now());

    try {
      if (this._handler) {
        await this._handler(sender, msg, meta);
        this._stats.processed++;
      }
    } catch (err) {
      this._stats.failed++;
      this.logger.error('queue', `خطأ في معالجة رسالة من ${this._short(sender)}: ${err.message}`);
    } finally {
      this._processing.delete(sender);
      // معالجة الرسالة التالية إن وجدت (بعد tick واحد)
      const next = this._queues.get(sender);
      if (next && next.length > 0) {
        setImmediate(() => this._drain(sender));
      }
    }
  }

  /** هل المرسل قيد المعالجة الآن؟ */
  isProcessing(sender) {
    if (!this._processing.has(sender)) return false;
    const startedAt = this._processing.get(sender);
    if (Date.now() - startedAt > TIMERS.PROCESSING_LOCK_EXPIRE_MS) {
      this._processing.delete(sender);
      return false;
    }
    return true;
  }

  /** عدد الرسائل المنتظرة لمرسل */
  pendingCount(sender) {
    return this._queues.get(sender)?.length || 0;
  }

  /** عدد المرسلين قيد المعالجة */
  activeCount() {
    return this._processing.size;
  }

  stats() {
    let pending = 0;
    for (const queue of this._queues.values()) pending += queue.length;
    return {
      ...this._stats,
      pending,
      active: this._processing.size,
      senders: this._queues.size,
      scheduledRetries: this._retryTimers.size,
    };
  }

  /** تنظيف شامل */
  clear() {
    for (const timer of this._retryTimers) clearTimeout(timer);
    this._retryTimers.clear();
    this._queues.clear();
    this._processing.clear();
  }

  _short(sender) {
    return sender.replace('@c.us', '').replace('@lid', '');
  }
}

module.exports = MessageQueue;
