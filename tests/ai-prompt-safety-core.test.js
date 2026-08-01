'use strict';
const test = require('node:test');
const assert = require('node:assert');
const AIClient = require('../lib/ai-client');

function sysWithSplit(on) {
  const prev = process.env.PROMPT_STYLE_SPLIT_ENABLED;
  process.env.PROMPT_STYLE_SPLIT_ENABLED = on ? 'true' : 'false';
  try {
    const c = new AIClient({ storeName: 'متجر', botInstructions: '', model: 'gpt-4o', openaiApiKey: 'x' }, { info(){} });
    return c.buildSystemPrompt([{ role: 'user', content: 'ابغى سعر' }], {});
  } finally { if (prev === undefined) delete process.env.PROMPT_STYLE_SPLIT_ENABLED; else process.env.PROMPT_STYLE_SPLIT_ENABLED = prev; }
}

test('SAFETY CORE behaviors survive the split', () => {
  const s = sysWithSplit(true);
  assert.ok(/لا تخترع|ممنوع.*اختراع/.test(s), 'no-invention kept');
  assert.ok(/لا تنكر|لا تجادل/.test(s), 'identity deflection kept');
  assert.ok(/سؤالاً توضيحياً|توضيح/.test(s), 'clarify-dont-guess kept');
  assert.ok(/جاوب على (جميع|كل) الأسئلة|كل أسئلته/.test(s), 'answer-all kept (once)');
  assert.ok(/بصياغة مختلفة|لا تُعِد|لا تعيد/.test(s), 'no-reworded-repetition kept');
});

test('imposed STYLE removed under split', () => {
  const s = sysWithSplit(true);
  assert.ok(!/🌷/.test(s), 'no imposed emoji');
  assert.ok(!/ودّي أأكد لك المعلومة من المختص/.test(s), 'no imposed canned phrase');
});

test('answer-all stated at most once under split (was 3x)', () => {
  const s = sysWithSplit(true);
  const hits = (s.match(/جاوب على (جميع|كل) الأسئلة/g) || []).length;
  assert.ok(hits <= 1, `answer-all repeated ${hits} times`);
});

test('default (flag off) keeps the original block verbatim', () => {
  const s = sysWithSplit(false);
  assert.ok(/🌷/.test(s), 'legacy block unchanged when flag off');
});

test('answer-all is qualified as brief under split', () => {
  const s = sysWithSplit(true);
  assert.ok(/بأقصر|باختصار|بإيجاز/.test(s), 'answer-all must be paired with brevity');
});

test('per-product isolation rule present under split', () => {
  const s = sysWithSplit(true);
  assert.ok(/كل منتج له خياراته/.test(s), 'must forbid borrowing options between products');
  assert.ok(/ممنوع.*تنسب مدة أو سعر أو خيار من منتج/.test(s), 'explicit no cross-product attribution');
});
