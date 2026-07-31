'use strict';

// Phase 9: a BEHAVIORAL test of the real admin-password comparison primitive.
// The pre-existing test re-implemented the compare inline / grepped source; this
// imports and executes the actual shipped timingSafeEqualStr so a regression in
// the real function is caught.

const test = require('node:test');
const assert = require('node:assert/strict');
const { timingSafeEqualStr } = require('../src/routes/admin.routes');

test('timingSafeEqualStr accepts the exact password', () => {
  assert.equal(timingSafeEqualStr('s3cret-pass', 's3cret-pass'), true);
});

test('timingSafeEqualStr rejects a wrong password', () => {
  assert.equal(timingSafeEqualStr('s3cret-pass', 'wrong-pass'), false);
});

test('timingSafeEqualStr is length-independent (hashing avoids a length-leak/throw)', () => {
  // Different lengths must NOT throw (both operands are hashed to 32 bytes) and must compare false.
  assert.equal(timingSafeEqualStr('short', 'a-much-longer-incorrect-password'), false);
});

test('timingSafeEqualStr treats empty/nullish as non-matching against a real secret', () => {
  assert.equal(timingSafeEqualStr('', 'realsecret'), false);
  assert.equal(timingSafeEqualStr(undefined, 'realsecret'), false);
  assert.equal(timingSafeEqualStr(null, 'realsecret'), false);
});
