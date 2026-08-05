'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../lib/edit-menu');

test('parseSelection: western, arabic-indic, prefixed, invalid', () => {
  assert.equal(m.parseSelection('1'), 1);
  assert.equal(m.parseSelection('٣'), 3);
  assert.equal(m.parseSelection('  ٨ '), 8);
  assert.equal(m.parseSelection('رقم 5'), 5);
  assert.equal(m.parseSelection('2️⃣'), 2); // emoji keycap carries the digit
  assert.equal(m.parseSelection('نعم'), null);
  assert.equal(m.parseSelection(''), null);
  assert.equal(m.parseSelection('أضف منتج'), null);
});

test('isMenuTrigger: deliberate words yes, action verbs / chatter no', () => {
  for (const w of ['تعديل', 'تعديلات', 'عدل', 'فلاش', 'قائمة', 'ضبط', 'اعدادات']) {
    assert.equal(m.isMenuTrigger(w), true, `${w} should trigger`);
  }
  assert.equal(m.isMenuTrigger('تعديل:'), true); // trailing punctuation tolerated
  assert.equal(m.isMenuTrigger('تعدیل'), true);   // one-char typo tolerated
  // Action verbs and normal chatter must NOT open the menu.
  for (const w of ['احذف', 'احظر', 'شيل', 'امسح', 'غير', 'ضيف', 'صباح', 'السلام']) {
    assert.equal(m.isMenuTrigger(w), false, `${w} must NOT trigger`);
  }
});

test('main menu lists all 8 sections in order', () => {
  const text = m.buildMainMenu();
  for (const s of m.SECTIONS) assert.ok(text.includes(s.label), `menu has ${s.label}`);
  assert.equal(m.SECTIONS.length, 8);
  assert.ok(/للإلغاء/.test(text));
});

test('sectionByNumber maps 1..8 and rejects out-of-range', () => {
  assert.equal(m.sectionByNumber(1).key, 'prompt');
  assert.equal(m.sectionByNumber(4).key, 'do_not_reply');
  assert.equal(m.sectionByNumber(8).key, 'forbidden');
  assert.equal(m.sectionByNumber(0), null);
  assert.equal(m.sectionByNumber(9), null);
});

test('style attribute + value menus and lookups', () => {
  assert.equal(m.styleAttrByNumber(1).field, 'tone');
  assert.equal(m.styleAttrByNumber(3).field, 'dialect');
  assert.equal(m.styleAttrByNumber(6), null);
  const toneVal = m.styleValueByNumber('tone', 3);
  assert.equal(toneVal.v, 'مرح ولطيف');
  assert.equal(m.styleValueByNumber('emoji', 1).v, 'none');
  assert.equal(m.styleValueByNumber('length', 3).v, 'long');
  assert.equal(m.styleValueByNumber('tone', 99), null);
  assert.ok(m.buildStyleValueMenu('dialect').includes('الحجازية'));
  assert.equal(m.buildStyleValueMenu('nope'), null);
});

test('forbidden kind menu maps word/phrase to the right style field', () => {
  assert.equal(m.forbiddenKindByNumber(1).styleField, 'avoidWords');
  assert.equal(m.forbiddenKindByNumber(2).styleField, 'avoidPhrases');
  assert.equal(m.forbiddenKindByNumber(3), null);
});

test('parseListInput: add vs remove', () => {
  assert.deepEqual(m.parseListInput('تأمر شي ثاني؟'), { action: 'add', value: 'تأمر شي ثاني؟' });
  assert.deepEqual(m.parseListInput('احذف: تأمر شي ثاني؟'), { action: 'remove', value: 'تأمر شي ثاني؟' });
  assert.deepEqual(m.parseListInput('امسح للأسف'), { action: 'remove', value: 'للأسف' });
  // remove typo tolerance is via normalize only (احذف with alef variants)
  assert.equal(m.parseListInput('شيل مستحيل').action, 'remove');
});

test('applyPhraseDelta: add new, dedupe, remove present, remove missing, empty', () => {
  assert.deepEqual(
    m.applyPhraseDelta(['أهلاً'], { action: 'add', value: 'حياك' }),
    { value: ['أهلاً', 'حياك'], summary: 'إضافة: حياك' },
  );
  // dedupe is normalized (ة/ه, أ/ا) — "اهلا" ~ "أهلاً"
  const dup = m.applyPhraseDelta(['أهلاً'], { action: 'add', value: 'اهلا' });
  assert.ok(dup.noop);
  const rem = m.applyPhraseDelta(['أهلاً', 'حياك'], { action: 'remove', value: 'حياك' });
  assert.deepEqual(rem.value, ['أهلاً']);
  const remMissing = m.applyPhraseDelta(['أهلاً'], { action: 'remove', value: 'وينك' });
  assert.ok(remMissing.noop);
  assert.ok(m.applyPhraseDelta([], { action: 'add', value: '  ' }).error);
});
