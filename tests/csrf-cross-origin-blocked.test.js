'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const requireSameOrigin = require('../src/middleware/require-same-origin');

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

test('GET requests pass through without same-origin check', () => {
  const res = makeRes();
  let called = false;
  requireSameOrigin({ method: 'GET', headers: {} }, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(res.statusCode, 200);
});

test('POST without Origin/Referer is rejected (403 origin_required)', () => {
  const res = makeRes();
  requireSameOrigin({ method: 'POST', headers: { host: 'app.example.com' } }, res, () => {
    assert.fail('next() must not be called when origin missing');
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'origin_required');
});

test('POST with mismatched Origin is rejected (403 cross_origin)', () => {
  const res = makeRes();
  requireSameOrigin({
    method: 'POST',
    headers: { host: 'app.example.com', origin: 'https://attacker.com' },
  }, res, () => {
    assert.fail('next() must not be called for cross-origin POST');
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'cross_origin');
});

test('POST with mismatched Referer is rejected (403 cross_origin)', () => {
  const res = makeRes();
  requireSameOrigin({
    method: 'POST',
    headers: { host: 'app.example.com', referer: 'https://attacker.com/page' },
  }, res, () => {
    assert.fail('next() must not be called for cross-referer POST');
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'cross_origin');
});

test('POST with same-origin Origin header is allowed through', () => {
  const res = makeRes();
  let called = false;
  requireSameOrigin({
    method: 'POST',
    headers: { host: 'app.example.com', origin: 'https://app.example.com' },
  }, res, () => { called = true; });
  assert.equal(called, true, 'next() must be called for same-origin POST');
  assert.equal(res.statusCode, 200);
});

test('POST with bad Origin URL is rejected (403 bad_origin)', () => {
  const res = makeRes();
  requireSameOrigin({
    method: 'POST',
    headers: { host: 'app.example.com', origin: 'not a url' },
  }, res, () => {
    assert.fail('next() must not be called for malformed origin');
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, 'bad_origin');
});

test('DELETE/PUT/PATCH are all enforced', () => {
  for (const method of ['DELETE', 'PUT', 'PATCH']) {
    const res = makeRes();
    requireSameOrigin({ method, headers: { host: 'a.example.com', origin: 'https://b.example.com' } }, res, () => {
      assert.fail(`${method} cross-origin must not pass`);
    });
    assert.equal(res.statusCode, 403, `${method} must be 403`);
  }
});
