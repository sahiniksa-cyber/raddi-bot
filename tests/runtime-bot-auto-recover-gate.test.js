'use strict';

// Regression guard for the concurrent-QR-pairing storm.
//
// Root cause (proven via an isolated single-socket probe that linked the exact
// merchant number on the first scan): on boot the platform auto-started EVERY
// bot whose desired_state was 'running', including UNLINKED ones. Many unlinked
// bots then held pre-pairing QR sockets simultaneously; WhatsApp terminated the
// concurrent sockets with code 428 (~every 30s) so no scan could ever complete.
//
// The fix: auto-recover ONLY previously-linked sessions (they reconnect with no
// QR). Unlinked bots wait for an explicit Start, opening ONE fresh pairing
// socket — the exact state that links reliably in isolation.
//
// This asserts the decision function directly. It fails on the pre-fix rule
// (which ignored hasSavedSession) and passes after.

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldAutoRecoverSession } = require('../src/services/bot/runtime-bot');

test('linked session (has saved creds) with desired_state=running auto-recovers', () => {
  assert.equal(
    shouldAutoRecoverSession({ desiredState: 'running', hasSavedSession: true, autoRecoverDisabled: false }),
    true,
  );
});

test('UNLINKED session with desired_state=running must NOT auto-recover (no QR storm)', () => {
  assert.equal(
    shouldAutoRecoverSession({ desiredState: 'running', hasSavedSession: false, autoRecoverDisabled: false }),
    false,
    'an unlinked running bot must not auto-open a pairing socket on boot',
  );
});

test('stopped session never auto-recovers, even with a saved session', () => {
  assert.equal(
    shouldAutoRecoverSession({ desiredState: 'stopped', hasSavedSession: true, autoRecoverDisabled: false }),
    false,
  );
});

test('WA_AUTO_RECOVER=false disables auto-recover for a linked running session', () => {
  assert.equal(
    shouldAutoRecoverSession({ desiredState: 'running', hasSavedSession: true, autoRecoverDisabled: true }),
    false,
  );
});
