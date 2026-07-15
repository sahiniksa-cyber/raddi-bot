'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('node:fs');
const path = require('node:path');
const { applyLineBreakFormat, resolveLineBreakSettings } = require('../lib/post-process-reply');

// Wiring: ai-client must run the formatter on the generated reply, otherwise the
// dashboard setting would silently do nothing.
test('ai-client.getReply applies the line-break formatter', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'ai-client.js'), 'utf8');
  assert.match(src, /reply = applyLineBreakFormat\(reply, this\.config\)/);
});

// ── resolveLineBreakSettings (mode resolution + legacy + clamps) ──────────
test('resolveLineBreakSettings defaults to connected', () => {
  const s = resolveLineBreakSettings({});
  assert.equal(s.mode, 'connected');
});

test('resolveLineBreakSettings maps legacy multilineFormat:true to ai', () => {
  assert.equal(resolveLineBreakSettings({ multilineFormat: true }).mode, 'ai');
});

test('resolveLineBreakSettings honours an explicit mode over legacy', () => {
  assert.equal(resolveLineBreakSettings({ multilineFormat: true, lineBreakMode: 'sentence' }).mode, 'sentence');
});

test('resolveLineBreakSettings falls back to connected for an unknown mode', () => {
  assert.equal(resolveLineBreakSettings({ lineBreakMode: 'nonsense' }).mode, 'connected');
});

test('resolveLineBreakSettings clamps count and words to safe ranges', () => {
  assert.equal(resolveLineBreakSettings({ lineBreakMode: 'topic', lineBreakCount: 99 }).count, 5);
  assert.equal(resolveLineBreakSettings({ lineBreakMode: 'topic', lineBreakCount: 0 }).count, 1);
  assert.equal(resolveLineBreakSettings({ lineBreakMode: 'words', lineBreakWords: 1 }).words, 2);
  assert.equal(resolveLineBreakSettings({ lineBreakMode: 'words', lineBreakWords: 999 }).words, 60);
});

// ── connected / ai → no enforcement ──────────────────────────────────────
test('connected mode leaves the text untouched', () => {
  const t = 'جملة أولى. جملة ثانية. جملة ثالثة';
  assert.equal(applyLineBreakFormat(t, { replyStyle: { lineBreakMode: 'connected' } }), t);
});

test('ai mode leaves the text untouched (the model decided)', () => {
  const t = 'سطر أول\nسطر ثاني';
  assert.equal(applyLineBreakFormat(t, { replyStyle: { lineBreakMode: 'ai' } }), t);
});

test('ai mode repairs a long single block when the model ignored the line setting', () => {
  const t = 'المنتج متوفر. السعر 99 ريال. التوصيل يتم بعد تأكيد الطلب.';
  const out = applyLineBreakFormat(t, { replyStyle: { lineBreakMode: 'ai', lineBreakWords: 8 } });
  assert.match(out, /\n/);
  assert.match(out, /99 ريال/);
});

test('ai mode keeps a genuinely short reply on one natural line', () => {
  assert.equal(applyLineBreakFormat('متوفر حياك الله', { replyStyle: { lineBreakMode: 'ai' } }), 'متوفر حياك الله');
});

// ── sentence mode (deterministic) ────────────────────────────────────────
test('sentence mode puts each sentence on its own line', () => {
  const out = applyLineBreakFormat('جملة أولى. جملة ثانية؟ جملة ثالثة!', { replyStyle: { lineBreakMode: 'sentence' } });
  assert.equal(out, 'جملة أولى.\nجملة ثانية؟\nجملة ثالثة!');
});

test('sentence mode does NOT split a decimal number', () => {
  const out = applyLineBreakFormat('السعر 5.2 ريال فقط', { replyStyle: { lineBreakMode: 'sentence' } });
  assert.equal(out, 'السعر 5.2 ريال فقط');
});

test('sentence mode does NOT break a URL', () => {
  const out = applyLineBreakFormat('زر الرابط prostoree.com/NAADyOm وكمل. شكراً', { replyStyle: { lineBreakMode: 'sentence' } });
  assert.match(out, /prostoree\.com\/NAADyOm/);
  assert.equal(out, 'زر الرابط prostoree.com/NAADyOm وكمل.\nشكراً');
});

// ── words mode (deterministic) ───────────────────────────────────────────
test('words mode inserts a newline every N words', () => {
  const out = applyLineBreakFormat('واحد اثنان ثلاثة اربعة خمسة', { replyStyle: { lineBreakMode: 'words', lineBreakWords: 2 } });
  assert.equal(out, 'واحد اثنان\nثلاثة اربعة\nخمسة');
});

// ── topic mode (AI sets boundaries; code normalises the gap size) ─────────
test('topic mode normalises any blank-line run to exactly count newlines', () => {
  const out = applyLineBreakFormat('الموضوع الأول\n\n\n\nالموضوع الثاني', { replyStyle: { lineBreakMode: 'topic', lineBreakCount: 2 } });
  assert.equal(out, 'الموضوع الأول\n\nالموضوع الثاني');
});

test('topic mode creates topic gaps when the model returned one long block', () => {
  const out = applyLineBreakFormat('السعر 99 ريال. التوصيل خلال يومين.', { replyStyle: { lineBreakMode: 'topic', lineBreakCount: 2 } });
  assert.match(out, /\n\n/);
});


// ── protection: the escalation marker must never be split ─────────────────
test('does not break the escalation marker even in sentence mode', () => {
  const out = applyLineBreakFormat('تمام بسجل طلبك. [تحويل:المالك|ملخص. فيه نقطة]', { replyStyle: { lineBreakMode: 'sentence' } });
  assert.match(out, /\[تحويل:المالك\|ملخص\. فيه نقطة\]/);
});

// ── safety: empty / non-string ───────────────────────────────────────────
test('applyLineBreakFormat is safe on empty / non-string input', () => {
  assert.equal(applyLineBreakFormat('', { replyStyle: { lineBreakMode: 'sentence' } }), '');
  assert.equal(applyLineBreakFormat(null, { replyStyle: { lineBreakMode: 'sentence' } }), null);
});
