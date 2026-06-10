'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { retrieveRelevantPolicies } = require('../src/services/ai/knowledge-retrieval');

test('learned replies participate in knowledge injection alongside manual keywords', () => {
  const config = {
    autoReplyKeywords: { 'الشحن': 'الشحن مجاني فوق 200 ريال' },
    learnedReplies: [
      { keyword: 'كم يستغرق الشحن للرياض؟', reply: 'إذا سُئلت "كم يستغرق الشحن للرياض؟" فجواب صاحب المتجر: يومين عمل' },
    ],
  };
  const result = retrieveRelevantPolicies(config, 'كم يستغرق الشحن للرياض');
  assert.match(result.block, /يومين عمل/, 'learned answer must be injected');
  assert.match(result.block, /الشحن مجاني/, 'manual keyword must still be injected');
});

test('learned replies work even when the merchant has no manual keywords', () => {
  const config = {
    learnedReplies: [
      { keyword: 'هل يوجد ضمان على الاشتراك؟', reply: 'إذا سُئلت "هل يوجد ضمان على الاشتراك؟" فجواب صاحب المتجر: نعم ضمان كامل المدة' },
    ],
  };
  const result = retrieveRelevantPolicies(config, 'عندكم ضمان على الاشتراك؟');
  assert.match(result.block, /ضمان كامل المدة/);
});

test('malformed learned entries are skipped without breaking retrieval', () => {
  const config = {
    autoReplyKeywords: { 'الدفع': 'ندعم مدى وأبل باي' },
    learnedReplies: [null, {}, { keyword: '', reply: 'بدون سؤال' }, { keyword: 'سؤال بلا جواب', reply: '' }],
  };
  const result = retrieveRelevantPolicies(config, 'كيف الدفع عندكم');
  assert.match(result.block, /مدى/);
});

test('ai-worker attaches learned replies to the config after resolving it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'workers', 'ai-worker.js'), 'utf8');
  const resolveIdx = source.indexOf('const config = await resolveConfigForAI(userId)');
  const learnedIdx = source.indexOf('loadActiveLearnedReplies', resolveIdx);
  assert.ok(resolveIdx > -1, 'config resolution call must exist');
  assert.ok(learnedIdx > resolveIdx, 'learned replies must be loaded after config resolution');
  assert.match(source, /config\.learnedReplies\s*=/);
});
