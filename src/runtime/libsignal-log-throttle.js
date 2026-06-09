'use strict';

// libsignal writes "Bad MAC" stack traces straight to stderr via console.error
// from inside session_cipher.js, bypassing the Baileys pino logger entirely.
// One disconnect storm produces hundreds of these in seconds, which makes
// Railway hit its log rate-limit (`Messages dropped: N`) and we lose visibility
// into the real failure. This module monkey-patches console.error/log once at
// process start to detect libsignal lines (matched by an explicit
// "Session error" prefix OR a stack frame from libsignal/src/session_cipher),
// counts them, and prints ONE summary per minute. Real errors and our own
// logger output pass through untouched.
//
// Patch each child process directly. start-all.js uses stdio: 'inherit', so a
// patch in the parent does not see child writes — each child must require this
// at the very top, before anything that loads Baileys/libsignal.

const SUMMARY_INTERVAL_MS = parseInt(process.env.LIBSIGNAL_LOG_SUMMARY_MS || '60000', 10);

let installed = false;
const counts = new Map();
let summaryTimer = null;
let originalError = null;
let originalLog = null;

function looksLikeLibsignalNoise(args) {
  if (!args || args.length === 0) return false;
  // Detect by exact first-arg prefix. These are the literal strings libsignal
  // writes via console.error / console.log from session_cipher.js. We do NOT
  // sniff stack frames in isolation — an application error that happens to
  // wrap a libsignal cause would have the same stack substring, and we don't
  // want to swallow application errors. The "Session error" / "Closing open
  // session" prefixes are libsignal-specific and unambiguous.
  const first = args[0];
  if (typeof first !== 'string') return false;
  if (first.startsWith('Session error')) return true;
  if (first.startsWith('Closing open session')) return true;
  return false;
}

function bucketForArgs(args) {
  const first = args && args.length > 0 ? String(args[0] ?? '') : '';
  if (first.startsWith('Closing open session')) return 'prekey_rebuild';
  return 'bad_mac';
}

function recordAndMaybeSummarize(bucket) {
  counts.set(bucket, (counts.get(bucket) || 0) + 1);
  if (summaryTimer) return;
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    const snapshot = Array.from(counts.entries());
    counts.clear();
    if (!snapshot.length) return;
    const total = snapshot.reduce((s, [, n]) => s + n, 0);
    const parts = snapshot.map(([bucket, n]) => `${bucket}=${n}`).join(' ');
    originalError(`[libsignal-throttle] suppressed ${total} libsignal log(s) in last ${Math.round(SUMMARY_INTERVAL_MS / 1000)}s (${parts})`);
  }, SUMMARY_INTERVAL_MS);
  if (typeof summaryTimer.unref === 'function') summaryTimer.unref();
}

function install() {
  if (installed) return;
  installed = true;
  originalError = console.error.bind(console);
  originalLog = console.log.bind(console);

  console.error = function patchedError(...args) {
    if (looksLikeLibsignalNoise(args)) {
      recordAndMaybeSummarize(bucketForArgs(args));
      return;
    }
    originalError(...args);
  };

  console.log = function patchedLog(...args) {
    if (looksLikeLibsignalNoise(args)) {
      recordAndMaybeSummarize(bucketForArgs(args));
      return;
    }
    originalLog(...args);
  };
}

// Test-only reset hook so node --test can install, exercise, and uninstall.
function _resetForTests() {
  if (summaryTimer) clearTimeout(summaryTimer);
  summaryTimer = null;
  counts.clear();
  if (originalError) console.error = originalError;
  if (originalLog) console.log = originalLog;
  originalError = null;
  originalLog = null;
  installed = false;
}

module.exports = {
  install,
  _resetForTests,
  // Exposed for tests; not part of the public API.
  _internals: {
    looksLikeLibsignalNoise,
    bucketForArgs,
    get counts() { return counts; },
    get installed() { return installed; },
  },
};
