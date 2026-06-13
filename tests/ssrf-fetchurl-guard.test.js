'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchURL } = require('../lib/helpers');
const { assertPublicUrl } = require('../src/middleware/ssrf-guard');

// SEC-1: fetchURL must refuse to reach private/internal addresses or
// non-http(s) schemes. These cases all resolve WITHOUT a network round-trip
// (IP literals + localhost + protocol check), so the test is hermetic.

test('fetchURL rejects loopback 127.0.0.1', async () => {
  await assert.rejects(() => fetchURL('http://127.0.0.1/x'), /private_address/);
});

test('fetchURL rejects the cloud metadata IP 169.254.169.254', async () => {
  await assert.rejects(() => fetchURL('http://169.254.169.254/latest/meta-data/'), /private_address/);
});

test('fetchURL rejects localhost', async () => {
  await assert.rejects(() => fetchURL('http://localhost:8080/internal'), /private_address/);
});

test('fetchURL rejects IPv6 loopback [::1]', async () => {
  await assert.rejects(() => fetchURL('http://[::1]/x'), /private_address/);
});

test('fetchURL rejects private 10.x and 192.168.x', async () => {
  await assert.rejects(() => fetchURL('http://10.0.0.5/admin'), /private_address/);
  await assert.rejects(() => fetchURL('http://192.168.1.1/'), /private_address/);
});

test('fetchURL rejects non-http(s) schemes (file://)', async () => {
  await assert.rejects(() => fetchURL('file:///etc/passwd'), /unsupported_protocol/);
});

test('assertPublicUrl: IPv4-mapped IPv6 of a private host is rejected', async () => {
  await assert.rejects(() => assertPublicUrl('http://[::ffff:127.0.0.1]/'), /private_address/);
});
