'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AIClient = require('../lib/ai-client');

function makeClient() {
  return new AIClient({ storeName: 'متجر', botInstructions: '', model: 'gpt-4o', openaiApiKey: 'x' }, { info(){}, warn(){}, error(){} });
}

test('penalties disabled when AI_SAMPLING_PENALTIES_ENABLED=false', () => {
  const prev = process.env.AI_SAMPLING_PENALTIES_ENABLED;
  process.env.AI_SAMPLING_PENALTIES_ENABLED = 'false';
  try {
    const c = makeClient();
    const s = c.resolveSampling({});
    assert.strictEqual(s.usePenalties, false);
  } finally { if (prev === undefined) delete process.env.AI_SAMPLING_PENALTIES_ENABLED; else process.env.AI_SAMPLING_PENALTIES_ENABLED = prev; }
});

test('draft temperature honors AI_DRAFT_TEMPERATURE', () => {
  const prev = process.env.AI_DRAFT_TEMPERATURE;
  process.env.AI_DRAFT_TEMPERATURE = '0.3';
  try {
    const c = makeClient();
    const s = c.resolveSampling({});
    assert.strictEqual(s.temperature, 0.3);
  } finally { if (prev === undefined) delete process.env.AI_DRAFT_TEMPERATURE; else process.env.AI_DRAFT_TEMPERATURE = prev; }
});

test('defaults unchanged when flags unset (penalties on, temp 0.45)', () => {
  const prevP = process.env.AI_SAMPLING_PENALTIES_ENABLED;
  const prevT = process.env.AI_DRAFT_TEMPERATURE;
  delete process.env.AI_SAMPLING_PENALTIES_ENABLED;
  delete process.env.AI_DRAFT_TEMPERATURE;
  try {
    const c = makeClient();
    const s = c.resolveSampling({});
    assert.strictEqual(s.usePenalties, true);
    assert.strictEqual(s.temperature, 0.45);
  } finally {
    if (prevP !== undefined) process.env.AI_SAMPLING_PENALTIES_ENABLED = prevP;
    if (prevT !== undefined) process.env.AI_DRAFT_TEMPERATURE = prevT;
  }
});
