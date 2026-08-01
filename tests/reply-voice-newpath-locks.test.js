'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AIClient = require('../lib/ai-client');

function withFlagsOn(fn) {
  const keys = ['PROMPT_STYLE_SPLIT_ENABLED', 'AI_SAMPLING_PENALTIES_ENABLED', 'AI_DRAFT_TEMPERATURE'];
  const prev = keys.map(k => [k, process.env[k]]);
  process.env.PROMPT_STYLE_SPLIT_ENABLED = 'true';
  process.env.AI_SAMPLING_PENALTIES_ENABLED = 'false';
  process.env.AI_DRAFT_TEMPERATURE = '0.3';
  try { return fn(); } finally { prev.forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; }); }
}

test('new path preserves all SAFETY CORE behaviors', () => {
  withFlagsOn(() => {
    const c = new AIClient({ storeName: 'متجر', botInstructions: 'أ'.repeat(100), model: 'gpt-4o', openaiApiKey: 'x' }, { info(){} });
    const s = c.buildSystemPrompt([{ role: 'user', content: 'انت بوت؟' }], {});
    assert.ok(/لا تنكر|لا تجادل/.test(s), 'identity deflection');
    assert.ok(/لا تخترع|ممنوع.*اختراع/.test(s), 'no invention');
    assert.ok(/توضيح/.test(s), 'clarify');
    assert.ok(/بصياغة مختلفة|لا تُعِد/.test(s), 'no reworded repetition');
    assert.ok(/جاوب على كل أسئلته|كل الأسئلة/.test(s), 'answer-all survives');
    assert.ok(/سؤالاً توضيحياً/.test(s), 'clarify-one-question survives');
    assert.ok(/بأقصر|باختصار|بإيجاز/.test(s), 'brevity qualifier present');
    assert.ok(!/نوّع صياغتك/.test(s), 'no vary-wording order');
    assert.ok(!/🌷/.test(s), 'no imposed emoji');
  });
});

test('new path applies to the DEFAULT (thin instructions) branch too', () => {
  withFlagsOn(() => {
    const c = new AIClient({ storeName: 'متجر', botInstructions: '', model: 'gpt-4o', openaiApiKey: 'x' }, { info(){} });
    const s = c.buildSystemPrompt([{ role: 'user', content: 'انت بوت؟' }], {});
    assert.ok(/لا تنكر|لا تجادل/.test(s), 'identity survives for thin merchants');
    assert.ok(/لا تخترع|ممنوع.*اختراع/.test(s), 'no-invention survives for thin merchants');
  });
});
