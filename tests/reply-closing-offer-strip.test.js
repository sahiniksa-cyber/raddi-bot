'use strict';

// Deterministic removal of the "reach out / if you need anything, tell me"
// closing-filler family — regardless of how the model phrases it. This is the
// second filler family alongside OFFER_HELP ("كيف أقدر أساعدك؟"). It must strip
// varied phrasings but NEVER remove legitimate content (product info, real
// contact numbers, return policies).

const test = require('node:test');
const assert = require('node:assert/strict');
const { stripClosingOffers } = require('../src/services/ai/reply-validator');

// ── Positives: the trailing closing plea MUST be removed, the lead info kept ──
const POSITIVES = [
  { in: 'السعر ٩٩ ريال، وإذا تحتاج أي شي قولي', keep: 'السعر ٩٩ ريال', drop: 'قولي' },
  { in: 'التوصيل مجاني. إذا احتجت أي شيء خبرني', keep: 'التوصيل مجاني', drop: 'خبرني' },
  { in: 'متوفر باللون الأسود. لو عندك أي استفسار تواصل معي', keep: 'متوفر باللون الأسود', drop: 'تواصل' },
  { in: 'تم الحجز. لا تتردد في التواصل معنا', keep: 'تم الحجز', drop: 'تتردد' },
  { in: 'الطلب جاهز. أنا موجود لأي استفسار', keep: 'الطلب جاهز', drop: 'موجود' },
  { in: 'خلصنا. أي وقت تحتاجني خبرني', keep: 'خلصنا', drop: 'خبرني' },
  { in: 'الأسعار في القائمة. إذا حاب أي مساعدة أنا حاضر لك', keep: 'الأسعار في القائمة', drop: 'حاضر' },
  { in: 'تم. تواصل معنا في أي وقت', keep: 'تم', drop: 'تواصل' },
  { in: 'المقاس متوفر، وإذا احتجتي شي راسليني', keep: 'المقاس متوفر', drop: 'راسليني' },
  { in: 'شكراً لك. نحن في خدمتك دائماً', keep: 'شكراً لك', drop: 'خدمت' },
  { in: 'تم إرسال التفاصيل، ولا تتردد بالسؤال', keep: 'تم إرسال التفاصيل', drop: 'تتردد' },
  { in: 'السعر ١٥٠ ريال. إذا عندك أي استفسار لا تتردد تسألني', keep: 'السعر ١٥٠ ريال', drop: 'تتردد' },
];

for (const c of POSITIVES) {
  test(`stripClosingOffers removes closing: "${c.in.slice(-24)}"`, () => {
    const out = stripClosingOffers(c.in);
    assert.ok(!out.includes(c.drop), `should drop "${c.drop}" — got: ${out}`);
    assert.ok(out.includes(c.keep), `should keep "${c.keep}" — got: ${out}`);
    assert.ok(out.length < c.in.length, 'output should be shorter than input');
    assert.ok(!/[،,]\s*$/.test(out), `no dangling comma — got: ${out}`);
  });
}

// ── Negatives: legitimate content MUST be returned unchanged ──
const NEGATIVES = [
  'إذا تحتاج توصيل سريع نوفّره بـ ٢٠ ريال',          // product offer, not a plea
  'لو عندك كود خصم اكتبه عند الدفع',                 // instruction
  'للاستفسار تواصل مع الدعم على الرقم 920012345',    // a REAL contact number
  'المنتج موجود في الفرع الرئيسي',                    // product availability
  'إذا الحجم ما يناسبك نبدله لك خلال أسبوع',          // return policy
  'الشحن يوصل خلال يومين عبر سمسا',                   // plain info
  'نحن نوفّر ضمان سنتين على الجهاز',                  // starts with نحن but legit
  'إذا مو موجود نطلبه لك من المستودع',                // "if not available we order it"
];

for (const s of NEGATIVES) {
  test(`stripClosingOffers keeps legit content: "${s.slice(0, 22)}…"`, () => {
    assert.equal(stripClosingOffers(s), s);
  });
}

// ── Idempotency + safety ──
test('stripClosingOffers is a no-op on empty/whitespace', () => {
  assert.equal(stripClosingOffers(''), '');
  assert.equal(stripClosingOffers('   '), '');
});

test('stripClosingOffers never returns empty when the whole reply is a closing', () => {
  // If the reply is ONLY a closing plea, keep the original (don't send nothing).
  const only = 'إذا تحتاج أي شي قولي';
  const out = stripClosingOffers(only);
  assert.ok(out.length > 0, 'must not blank out a reply');
});
