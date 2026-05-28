'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPrivateIp, assertPublicUrl } = require('../src/middleware/ssrf-guard');

test('isPrivateIp blocks loopback 127.0.0.1', () => {
  assert.equal(isPrivateIp('127.0.0.1'), true);
});

test('isPrivateIp blocks link-local 169.254.169.254 (AWS metadata)', () => {
  assert.equal(isPrivateIp('169.254.169.254'), true);
});

test('isPrivateIp blocks RFC1918 10.x.x.x', () => {
  assert.equal(isPrivateIp('10.0.0.5'), true);
  assert.equal(isPrivateIp('10.255.255.255'), true);
});

test('isPrivateIp blocks RFC1918 192.168.x.x and 172.16-31.x.x', () => {
  assert.equal(isPrivateIp('192.168.1.1'), true);
  assert.equal(isPrivateIp('172.16.0.1'), true);
  assert.equal(isPrivateIp('172.31.255.255'), true);
  assert.equal(isPrivateIp('172.15.0.1'), false, '172.15 is public');
  assert.equal(isPrivateIp('172.32.0.1'), false, '172.32 is public');
});

test('isPrivateIp blocks IPv6 loopback and ULA/link-local', () => {
  assert.equal(isPrivateIp('::1'), true);
  assert.equal(isPrivateIp('fc00::1'), true);
  assert.equal(isPrivateIp('fd00::1'), true);
  assert.equal(isPrivateIp('fe80::1'), true);
});

test('isPrivateIp allows public addresses', () => {
  assert.equal(isPrivateIp('8.8.8.8'), false);
  assert.equal(isPrivateIp('1.1.1.1'), false);
});

test('assertPublicUrl rejects non-http(s) schemes', async () => {
  await assert.rejects(assertPublicUrl('file:///etc/passwd'), /unsupported_protocol/);
  await assert.rejects(assertPublicUrl('ftp://example.com'), /unsupported_protocol/);
  await assert.rejects(assertPublicUrl('gopher://example.com'), /unsupported_protocol/);
});

test('assertPublicUrl rejects literal private IPs', async () => {
  await assert.rejects(assertPublicUrl('http://127.0.0.1/admin'), /private_address/);
  await assert.rejects(assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /private_address/);
  await assert.rejects(assertPublicUrl('http://10.0.0.1/'), /private_address/);
  await assert.rejects(assertPublicUrl('http://192.168.1.1/'), /private_address/);
  await assert.rejects(assertPublicUrl('http://[::1]/'), /private_address/);
});

test('assertPublicUrl rejects localhost hostname', async () => {
  await assert.rejects(assertPublicUrl('http://localhost:8080/admin'), /private_address/);
});

test('assertPublicUrl rejects malformed URLs', async () => {
  await assert.rejects(assertPublicUrl('not-a-url'), /invalid_url/);
});
