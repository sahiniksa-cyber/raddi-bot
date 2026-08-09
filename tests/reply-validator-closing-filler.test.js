'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { stripClosingFiller } = require('../src/services/ai/reply-validator');

function withFlag(on, fn) {
  const prev = process.env.CLOSING_FILLER_STRIP_ENABLED;
  if (on) process.env.CLOSING_FILLER_STRIP_ENABLED = 'true';
  else delete process.env.CLOSING_FILLER_STRIP_ENABLED;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CLOSING_FILLER_STRIP_ENABLED;
    else process.env.CLOSING_FILLER_STRIP_ENABLED = prev;
  }
}

// --- MUST strip (banned trailing filler) ---
const STRIP_CASES = [
  ['اشتراك كانفا برو يوصلك خلال ساعات كحد أقصى 12 ساعة إذا عندك أي استفسار ثاني، أنا هنا',
   'اشتراك كانفا برو يوصلك خلال ساعات كحد أقصى 12 ساعة'],
  ['التفعيل خلال ساعات إذا تحتاج تفاصيل اضافية بلغني', 'التفعيل خلال ساعات'],
  ['السعر 189 ريال أي شي ثاني أنا هنا', 'السعر 189 ريال'],
  ['تمام نعتمده لك تبي شي ثاني؟', 'تمام نعتمده لك'],
  ['يوصلك خلال ساعات أنا هنا لو تحتاج', 'يوصلك خلال ساعات'],
  ['خلصنا طلبك في خدمتك', 'خلصنا طلبك'],
  // صيغ متنوّعة كانت تفلت سابقاً (قولي/راسلني/لا تتردد/تواصل معنا/أي وقت)
  ['السعر ٩٩ ريال، وإذا تحتاج أي شي قولي', 'السعر ٩٩ ريال'],
  ['متوفر باللون الأسود لو عندك أي استفسار تواصل معي', 'متوفر باللون الأسود'],
  ['تم الحجز لا تتردد في التواصل معنا', 'تم الحجز'],
  ['الطلب جاهز أنا موجود لأي استفسار', 'الطلب جاهز'],
  ['المقاس متوفر وإذا احتجتي شي راسليني', 'المقاس متوفر'],
  ['شكراً لك نحن في خدمتك دائماً', 'شكراً لك'],
  ['تم إرسال التفاصيل ولا تتردد بالسؤال', 'تم إرسال التفاصيل'],
  ['خلصنا أي وقت تحتاجني خبرني', 'خلصنا'],
  ['تم، تواصل معنا في أي وقت', 'تم'],
  ['الأسعار في القائمة إذا حاب أي مساعدة أنا حاضر لك', 'الأسعار في القائمة'],
];

for (const [input, expected] of STRIP_CASES) {
  test(`strips filler → "${input.slice(-25)}"`, () => {
    withFlag(true, () => assert.strictEqual(stripClosingFiller(input), expected));
  });
}

// --- MUST NOT strip (legitimate content that merely contains هنا/موجود) ---
const KEEP_CASES = [
  'المنتج موجود ومتاح',
  'الرابط هنا prostoree.com',
  'التفعيل خلال ساعات كحد أقصى 12 ساعة',
  'أدوبي كريتف كلاود المدة 4 أشهر السعر 189 ريال',
  'أي لون تحب نجهزه لك',
  // محتوى مشروع يشبه الخاتمة لكنه يحمل معلومة — ممنوع مسّه
  'إذا تحتاج توصيل سريع نوفره بـ 20 ريال',
  'لو عندك كود خصم اكتبه عند الدفع',
  'للاستفسار تواصل مع الدعم على الرقم 920012345',
  'المنتج موجود في الفرع الرئيسي',
  'إذا الحجم ما يناسبك نبدله لك خلال أسبوع',
  'نحن نوفّر ضمان سنتين على الجهاز',
  'إذا مو موجود نطلبه لك من المستودع',
];

for (const input of KEEP_CASES) {
  test(`keeps legit content → "${input.slice(0, 25)}"`, () => {
    withFlag(true, () => assert.strictEqual(stripClosingFiller(input), input));
  });
}

test('flag OFF → no change (reversible)', () => {
  withFlag(false, () => {
    const s = 'السعر 189 ريال إذا عندك أي استفسار ثاني، أنا هنا';
    assert.strictEqual(stripClosingFiller(s), s);
  });
});

test('never nukes a reply that is only filler', () => {
  withFlag(true, () => {
    const s = 'أنا هنا لو تحتاج';
    assert.ok(stripClosingFiller(s).length > 0, 'must not return empty');
  });
});
