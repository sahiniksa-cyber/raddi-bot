'use strict';

// Phase 10 (security slice): SSRF guard now blocks additional reserved IPv4
// ranges that can reach internal/cloud infrastructure. Additive only — it must
// block MORE, never wrongly block genuine public addresses.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPrivateIp } = require('../src/middleware/ssrf-guard');

test('blocks CGNAT 100.64.0.0/10 (cloud-internal)', () => {
  assert.equal(isPrivateIp('100.64.0.1'), true);
  assert.equal(isPrivateIp('100.100.50.1'), true);
  assert.equal(isPrivateIp('100.127.255.255'), true);
});

test('blocks IETF 192.0.0.0/24 and benchmarking 198.18.0.0/15', () => {
  assert.equal(isPrivateIp('192.0.0.8'), true);
  assert.equal(isPrivateIp('198.18.0.1'), true);
  assert.equal(isPrivateIp('198.19.255.255'), true);
});

test('does NOT over-block genuine public addresses near the new ranges', () => {
  assert.equal(isPrivateIp('100.63.255.255'), false, '100.63 is public');
  assert.equal(isPrivateIp('100.128.0.1'), false, '100.128 is public');
  assert.equal(isPrivateIp('192.0.1.1'), false, '192.0.1 is public');
  assert.equal(isPrivateIp('198.17.0.1'), false, '198.17 is public');
  assert.equal(isPrivateIp('198.20.0.1'), false, '198.20 is public');
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
});

test('still blocks the classic private/loopback/metadata ranges (regression guard)', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
  assert.equal(isPrivateIp('169.254.169.254'), true);
  assert.equal(isPrivateIp('10.0.0.1'), true);
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('::1'), true);
});
