'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { humanPauseExpiry, resolvePauseMinutes } = require('../src/services/instagram/instagram-pause');

test('humanPauseExpiry returns a future Date minutes ahead of now', () => {
  const now = 1_000_000;
  const expiry = humanPauseExpiry(30, now);
  assert.ok(expiry instanceof Date);
  assert.equal(expiry.getTime(), now + 30 * 60 * 1000);
});

test('humanPauseExpiry returns null for non-positive or invalid minutes', () => {
  assert.equal(humanPauseExpiry(0, 1000), null);
  assert.equal(humanPauseExpiry(-5, 1000), null);
  assert.equal(humanPauseExpiry('abc', 1000), null);
  assert.equal(humanPauseExpiry(null, 1000), null);
});

test('resolvePauseMinutes defaults to 30 when env is unset or invalid', () => {
  assert.equal(resolvePauseMinutes({}), 30);
  assert.equal(resolvePauseMinutes({ INSTAGRAM_HUMAN_PAUSE_MINUTES: '' }), 30);
  assert.equal(resolvePauseMinutes({ INSTAGRAM_HUMAN_PAUSE_MINUTES: 'oops' }), 30);
});

test('resolvePauseMinutes honors a valid positive env override', () => {
  assert.equal(resolvePauseMinutes({ INSTAGRAM_HUMAN_PAUSE_MINUTES: '45' }), 45);
});

test('resolvePauseMinutes treats a zero/negative override as "disabled" (0)', () => {
  assert.equal(resolvePauseMinutes({ INSTAGRAM_HUMAN_PAUSE_MINUTES: '0' }), 0);
  assert.equal(resolvePauseMinutes({ INSTAGRAM_HUMAN_PAUSE_MINUTES: '-3' }), 0);
});
