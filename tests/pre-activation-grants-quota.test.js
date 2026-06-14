'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'auth.controller.js'), 'utf8');
const initSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'db', 'migrations', 'init.js'), 'utf8');

test('ROOT FIX: registration grants a real message quota for a pre-activated email', () => {
  // The bug was: pre-activation set only the old access flags, but the bot gates
  // on message quota — so pre-activated merchants had 0 messages and stayed silent.
  assert.match(authSrc, /addMessagesToQuota/);
  assert.match(authSrc, /preActivation\.messages > 0/);
  assert.match(authSrc, /expireResetsQuota: false/); // messages deplete by use, not by time
});

test('registration supports PERMANENT activation (no expiry when no duration)', () => {
  assert.match(authSrc, /if \(preActivation\.durationDays && preActivation\.durationDays > 0\)/);
  // setAccess is always called; setAccessExpiry only when a duration exists
  assert.match(authSrc, /setAccess\(id, 'active', 'pre_activation'/);
});

test('migration adds the messages column and allows permanent (nullable duration)', () => {
  assert.match(initSrc, /ALTER TABLE pre_activations ADD COLUMN IF NOT EXISTS messages/);
  assert.match(initSrc, /ALTER TABLE pre_activations DROP CONSTRAINT IF EXISTS pre_activations_duration_days_check/);
  assert.match(initSrc, /ALTER COLUMN duration_days DROP NOT NULL/);
});
