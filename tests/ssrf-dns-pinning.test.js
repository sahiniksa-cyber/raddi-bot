'use strict';

// Phase 10 (deferred item, now done safely): DNS-rebinding defense. fetchURL now
// pins the connection to the IP assertPublicUrl already validated via a custom
// dns.lookup. These tests verify the pinning function directly (the http connect
// itself needs a network and is covered by manual/staging checks).

const test = require('node:test');
const assert = require('node:assert/strict');
const { pinnedLookup } = require('../lib/helpers');

test('pinnedLookup returns the validated IPv4 with family 4 (single form)', (t, done) => {
  const lookup = pinnedLookup(['203.0.113.10']);
  lookup('evil.example.com', {}, (err, address, family) => {
    assert.equal(err, null);
    assert.equal(address, '203.0.113.10', 'connects to the pre-validated IP, NOT a re-resolved one');
    assert.equal(family, 4);
    done();
  });
});

test('pinnedLookup supports the callback-as-2nd-arg signature', (t, done) => {
  const lookup = pinnedLookup(['8.8.8.8']);
  lookup('host', (err, address, family) => {
    assert.equal(address, '8.8.8.8');
    assert.equal(family, 4);
    done();
  });
});

test('pinnedLookup supports { all: true } and reports IPv6 family', (t, done) => {
  const lookup = pinnedLookup(['2606:4700:4700::1111']);
  lookup('host', { all: true }, (err, result) => {
    assert.equal(err, null);
    assert.deepEqual(result, [{ address: '2606:4700:4700::1111', family: 6 }]);
    done();
  });
});

test('pinnedLookup ignores any hostname it is given (never re-resolves)', (t, done) => {
  // Even if asked to resolve a private host, it returns ONLY the pinned public IP.
  const lookup = pinnedLookup(['203.0.113.5']);
  lookup('127.0.0.1', {}, (err, address) => {
    assert.equal(address, '203.0.113.5');
    done();
  });
});
