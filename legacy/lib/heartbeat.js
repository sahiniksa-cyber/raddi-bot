/**
 * lib/heartbeat.js — Heartbeat & Watchdog
 *
 * مسؤوليتان:
 *   1. Heartbeat: فحص دوري (كل 30 ثانية) — إذا فشل مرتين متتاليتين يُبلّغ
 *   2. Watchdog: timer أحادي — إذا لم يتصل خلال 90 ثانية يُبلّغ
 *
 * لا يعرف شيئاً عن WhatsApp — يستقبل callbacks ويُبلّغ عن المشاكل فقط.
 *
 * Usage:
 *   const hb = new Heartbeat(logger);
 *   hb.startHeartbeat(checkFn, onFailure);
 *   hb.startWatchdog(timeoutMs, onTimeout);
 */
'use strict';

const { TIMERS } = require('../../lib/constants');

class Heartbeat {
  constructor(logger) {
    this.logger = logger;
    this._heartbeatInterval = null;
    this._watchdogTimer = null;
    this._healthProbeTimer = null;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────

  /**
   * @param {Function} checkFn — async () => 'CONNECTED' | other | throws
   * @param {Function} onFailure — (reason: string) => void
   * @param {object} [opts]
   * @param {number} [opts.intervalMs] — فترة الفحص
   * @param {number} [opts.failThreshold] — عدد الفشل المتتالي قبل التبليغ
   */
  startHeartbeat(checkFn, onFailure, opts = {}) {
    this.stopHeartbeat();
    const interval = opts.intervalMs || TIMERS.HEARTBEAT_INTERVAL_MS;
    const threshold = opts.failThreshold || TIMERS.HEARTBEAT_FAIL_THRESHOLD;
    let failCount = 0;

    this._heartbeatInterval = setInterval(async () => {
      try {
        const state = await Promise.race([
          checkFn(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
        ]);

        if (state === 'CONNECTED') {
          failCount = 0;
        } else {
          failCount++;
          this.logger.warn('heartbeat', `الحالة "${state}" بدلاً من CONNECTED (${failCount}/${threshold})`);
          if (failCount >= threshold) {
            this.logger.error('heartbeat', 'اتصال غير مستقر — إعادة التشغيل تلقائياً');
            failCount = 0;
            this.stopHeartbeat();
            onFailure('heartbeat: state=' + state);
          }
        }
      } catch (e) {
        failCount++;
        this.logger.warn('heartbeat', `فشل الفحص (${failCount}/${threshold}) — ${e.message.substring(0, 50)}`);
        if (failCount >= threshold) {
          this.logger.error('heartbeat', 'البوت لا يستجيب — إعادة التشغيل تلقائياً');
          failCount = 0;
          this.stopHeartbeat();
          onFailure('heartbeat: ' + e.message.substring(0, 50));
        }
      }
    }, interval);

    this.logger.info('heartbeat', `💓 تم تشغيل مراقب الاتصال (نبض كل ${interval / 1000} ثانية)`);
  }

  stopHeartbeat() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
  }

  // ── Watchdog ──────────────────────────────────────────────────────────

  /**
   * @param {Function} shouldSkipFn — () => boolean — إذا true لا يُطلق الـ watchdog
   * @param {Function} onTimeout — (reason: string) => void
   * @param {number} [timeoutMs]
   */
  startWatchdog(shouldSkipFn, onTimeout, timeoutMs) {
    this.clearWatchdog();
    const timeout = timeoutMs || TIMERS.WATCHDOG_TIMEOUT_MS;

    this._watchdogTimer = setTimeout(() => {
      if (shouldSkipFn()) return;
      this.logger.error('boot', `⏱ انتظرنا ${timeout / 1000} ثانية بدون تشغيل فعلي — Chrome متجمد`);
      onTimeout('watchdog: no ready in ' + (timeout / 1000) + 's');
    }, timeout);
  }

  clearWatchdog() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ── Health Probe (post-ready verification) ────────────────────────────

  /**
   * فحص بعد الاتصال — يتأكد أن الاتصال حقيقي وليس ghost session
   * @param {Function} checkFn — async () => state string
   * @param {Function} onSuccess — () => void — يُستدعى إذا CONNECTED
   * @param {Function} onFailure — (reason: string) => void
   * @param {number} [delayMs]
   */
  scheduleHealthProbe(checkFn, onSuccess, onFailure, delayMs) {
    this.clearHealthProbe();
    const delay = delayMs || TIMERS.HEALTH_PROBE_DELAY_MS;

    this._healthProbeTimer = setTimeout(async () => {
      try {
        const state = await Promise.race([
          checkFn(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
        ]);
        if (state === 'CONNECTED') {
          this.logger.info('connection', '✅ فحص الاتصال: تم التأكد — البوت يعمل فعلاً');
          onSuccess();
        } else {
          this.logger.warn('connection', `فحص ما بعد الاتصال: الحالة "${state}" — إعادة التشغيل`);
          onFailure('post-ready: state is ' + state);
        }
      } catch (e) {
        this.logger.warn('connection', 'فحص ما بعد الاتصال فشل: ' + e.message + ' — إعادة التشغيل');
        onFailure('post-ready health probe: ' + e.message);
      }
    }, delay);
  }

  clearHealthProbe() {
    if (this._healthProbeTimer) {
      clearTimeout(this._healthProbeTimer);
      this._healthProbeTimer = null;
    }
  }

  // ── Tear down ─────────────────────────────────────────────────────────
  destroy() {
    this.stopHeartbeat();
    this.clearWatchdog();
    this.clearHealthProbe();
  }
}

module.exports = Heartbeat;
