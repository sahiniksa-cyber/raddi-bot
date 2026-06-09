'use strict';

// libsignal's session_cipher.js writes "Bad MAC" stack traces directly to
// stderr via console.error, bypassing the Baileys pino logger. One disconnect
// storm produces hundreds of these in seconds, which hits Railway's log
// rate-limit. The throttle suppresses libsignal lines, counts them, and prints
// one summary line periodically. Every other console call must pass through.

const test = require('node:test');
const assert = require('node:assert/strict');

const throttle = require('../src/runtime/libsignal-log-throttle');

test('suppresses Session error lines, lets unrelated lines through', () => {
  throttle._resetForTests();
  const printed = [];
  const origError = console.error;
  console.error = (...args) => printed.push(args);
  try {
    throttle.install();
    console.error('Session error: Error: Bad MAC Error: Bad MAC');
    console.error('Session error:', new Error('Bad MAC'));
    console.error('something else entirely');
    console.error('a different real error', new Error('oops'));
  } finally {
    throttle._resetForTests();
    console.error = origError;
  }
  // Two Session error calls were suppressed; the two "real" lines went through.
  assert.equal(printed.length, 2);
  assert.match(String(printed[0][0]), /something else entirely/);
  assert.match(String(printed[1][0]), /a different real error/);
});

test('non-matching first arg passes through, even with a libsignal stack frame', () => {
  // Deliberately narrow: an application error that happens to wrap a
  // libsignal cause MUST pass through. Suppressing it would hide real bugs
  // that look like "the bot's send-path tripped a libsignal failure deep in
  // the stack." Only the literal "Session error" / "Closing open session"
  // first-arg prefixes get swallowed.
  throttle._resetForTests();
  const printed = [];
  const origError = console.error;
  console.error = (...args) => printed.push(args);
  try {
    throttle.install();
    const libErr = new Error('Bad MAC');
    libErr.stack = `Error: Bad MAC
    at SessionCipher.doDecryptWhisperMessage (/app/node_modules/libsignal/src/session_cipher.js:250:16)`;
    console.error('our app: failed to deliver reply', libErr);
  } finally {
    throttle._resetForTests();
    console.error = origError;
  }
  assert.equal(printed.length, 1, 'app errors that mention libsignal in the stack must NOT be suppressed');
});

test('"Closing open session" lines are suppressed (separate bucket)', () => {
  throttle._resetForTests();
  const printed = [];
  const origError = console.error;
  const origLog = console.log;
  console.error = (...args) => printed.push(['err', ...args]);
  console.log = (...args) => printed.push(['log', ...args]);
  try {
    throttle.install();
    // libsignal writes this on console.log, not console.error.
    console.log('Closing open session in favor of incoming prekey bundle');
  } finally {
    throttle._resetForTests();
    console.error = origError;
    console.log = origLog;
  }
  assert.equal(printed.length, 0, '"Closing open session" must be suppressed');
});

test('install() is idempotent', () => {
  throttle._resetForTests();
  const origError = console.error;
  try {
    throttle.install();
    const afterFirst = console.error;
    throttle.install();
    const afterSecond = console.error;
    assert.equal(afterFirst, afterSecond, 'second install must not double-wrap');
  } finally {
    throttle._resetForTests();
    console.error = origError;
  }
});

test('classifier detects libsignal noise by first-arg prefix only', () => {
  const { _internals } = throttle;
  // Positives: the literal prefixes libsignal writes.
  assert.equal(_internals.looksLikeLibsignalNoise(['Session error: ...']), true);
  assert.equal(_internals.looksLikeLibsignalNoise(['Closing open session in favor of incoming prekey bundle']), true);
  // Negatives: anything else, including non-string first args.
  assert.equal(_internals.looksLikeLibsignalNoise(['hello world']), false);
  assert.equal(_internals.looksLikeLibsignalNoise([]), false);
  assert.equal(_internals.looksLikeLibsignalNoise([null]), false);
  assert.equal(_internals.looksLikeLibsignalNoise([new Error('Bad MAC')]), false);
  // Stack content alone (without the prefix) is NOT enough — this prevents
  // accidentally swallowing application errors that wrap a libsignal cause.
  const err = { stack: 'at libsignal/src/session_cipher.js:200' };
  assert.equal(_internals.looksLikeLibsignalNoise(['some app error', err]), false);
});
