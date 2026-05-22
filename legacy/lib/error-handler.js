/**
 * lib/error-handler.js — Bulletproof Error Handling
 *
 * يلتقط:
 *   - uncaughtException
 *   - unhandledRejection
 *   - SIGTERM / SIGINT
 *
 * لا يُسقط العملية أبداً — يسجل الخطأ ويستمر.
 * يوفر cleanup callback لإغلاق البوتات بأمان.
 */
'use strict';

let _cleanupFn = null;
let _shuttingDown = false;

/**
 * تسجيل الحماية الشاملة للأخطاء
 * @param {object} opts
 * @param {Function} opts.onCleanup — يُنادى عند SIGTERM/SIGINT لإغلاق الموارد
 */
function install({ onCleanup } = {}) {
  _cleanupFn = onCleanup;

  // ── uncaughtException ──
  process.on('uncaughtException', (err) => {
    console.error('');
    console.error('══════════════ UNCAUGHT EXCEPTION ══════════════');
    console.error(`[${new Date().toISOString()}] ${err.message}`);
    console.error(err.stack || err);
    console.error('════════════════════════════════════════════════');
    console.error('');
    // لا نخرج — البوت يستمر. الأخطاء الحرجة تُعالج بالـ heartbeat
  });

  // ── unhandledRejection ──
  process.on('unhandledRejection', (reason, promise) => {
    console.error('');
    console.error('══════════════ UNHANDLED REJECTION ═════════════');
    console.error(`[${new Date().toISOString()}]`);
    console.error('Reason:', reason instanceof Error ? reason.message : reason);
    if (reason instanceof Error && reason.stack) console.error(reason.stack);
    console.error('════════════════════════════════════════════════');
    console.error('');
  });

  // ── Graceful shutdown ──
  const shutdown = async (signal) => {
    if (_shuttingDown) return;
    _shuttingDown = true;
    console.log(`\n🛑 ${signal} — إغلاق آمن...`);
    try {
      if (_cleanupFn) await Promise.race([_cleanupFn(), new Promise(r => setTimeout(r, 8000))]);
    } catch (e) {
      console.error('⚠️ خطأ أثناء الإغلاق:', e.message);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

module.exports = { install };
