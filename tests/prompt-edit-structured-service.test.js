'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('../src/services/prompt-edit/prompt-edit.service');
const { canonicalConfig } = require('./helpers/canonical-config');

test('policy writer refuses caller-forged policyVersion', async () => {
  const candidate = canonicalConfig().merchantPolicy;
  candidate.policyVersion = 'sha256:forged';
  const database = { query: async () => ({ rowCount: 1 }) };
  await assert.rejects(
    svc.applySectionValue(database, 'u1', 'merchantPolicy', candidate),
    error => error.code === 'INVALID_MERCHANT_POLICY',
  );
});

test('policy writer persists only the canonical merchantPolicy path', async () => {
  const calls = [];
  const database = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rowCount: 1 };
    },
  };
  await svc.applySectionValue(database, 'u1', 'merchantPolicy', canonicalConfig().merchantPolicy);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /\{merchantPolicy\}/);
  assert.doesNotMatch(calls[0].sql, /\{products\}|\{autoReplyKeywords\}/);
});
