'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeConfigPatch } = require('../lib/config-diff');
const { mergeConfigForSave } = require('../src/controllers/config.controller');

test('patch contains only fields that actually changed vs the loaded snapshot', () => {
  const snapshot = { storeName: 'A', botInstructions: 'OLD', welcomeMessage: 'hi' };
  const payload = { storeName: 'A', botInstructions: 'OLD', welcomeMessage: 'HELLO' }; // only welcome edited
  assert.deepEqual(computeConfigPatch(snapshot, payload), { welcomeMessage: 'HELLO' });
});

test('unchanged full payload → empty patch (nothing overwritten)', () => {
  const snap = { a: 1, b: 'x', c: [1, 2], d: { k: 1 } };
  assert.deepEqual(computeConfigPatch(snap, { ...snap }), {});
});

test('a brand-new field is included', () => {
  assert.deepEqual(computeConfigPatch({ a: 1 }, { a: 1, newField: 'v' }), { newField: 'v' });
});

// The P4 regression: field A changed EXTERNALLY (e.g. botInstructions via a
// WhatsApp edit) while the page is stale; the stale page saves field B.
// A must stay unchanged, B must update.
test('P4 regression: stale page save does not clobber an externally-changed field', () => {
  const loadedSnapshot = { botInstructions: 'OLD', welcomeMessage: 'hi' }; // what the page loaded
  const formPayload = { botInstructions: 'OLD', welcomeMessage: 'CHANGED' }; // user edited only welcome
  const patch = computeConfigPatch(loadedSnapshot, formPayload);

  // Meanwhile the server's botInstructions was updated out-of-band:
  const serverExisting = { botInstructions: 'NEW من واتساب', welcomeMessage: 'hi' };
  const merged = mergeConfigForSave({ existing: serverExisting, incoming: patch, isAdmin: false });

  assert.equal(merged.botInstructions, 'NEW من واتساب', 'externally-changed field A preserved');
  assert.equal(merged.welcomeMessage, 'CHANGED', 'field B updates');
});

test('P4 two tenants: each patch is independent (pure, no shared state / no leak)', () => {
  const a = computeConfigPatch({ storeName: 'A', maxResponseLength: 300 }, { storeName: 'A', maxResponseLength: 400 });
  const b = computeConfigPatch({ storeName: 'B', maxResponseLength: 300 }, { storeName: 'B', maxResponseLength: 300 });
  assert.deepEqual(a, { maxResponseLength: 400 });
  assert.deepEqual(b, {}); // tenant B unchanged → nothing saved, cannot affect A
});
