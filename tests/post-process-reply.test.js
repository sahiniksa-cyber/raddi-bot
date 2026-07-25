'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { stripAvoidedContent } = require('../lib/post-process-reply');

test('markdown link is converted to a clickable "label: url" (WhatsApp does not render markdown)', () => {
  const out = stripAvoidedContent('تفضل رابط الاشتراك: [أدوبي كريتف كلاود](https://prostoree.com/NAADyOm)');
  assert.match(out, /https:\/\/prostoree\.com\/NAADyOm/, 'bare URL must survive');
  assert.doesNotMatch(out, /\]\(/, 'no leftover markdown link syntax');
  assert.match(out, /أدوبي كريتف كلاود: https:\/\/prostoree\.com\/NAADyOm/);
});

test('a bare URL is not broken by whitespace tidying (dots kept intact)', () => {
  const out = stripAvoidedContent('شوف الرابط https://prostoree.com/NAADyOm وكمل الطلب.');
  assert.match(out, /https:\/\/prostoree\.com\/NAADyOm/, 'URL dots/slashes preserved');
  assert.doesNotMatch(out, /prostoree\. com/, 'must NOT insert a space after the dot');
});

test('markdown link with no label collapses to just the URL', () => {
  const out = stripAvoidedContent('[https://prostoree.com/x](https://prostoree.com/x)');
  assert.equal(out, 'https://prostoree.com/x');
});

test('the escalation marker [تحويل:...] is still preserved (not a link)', () => {
  const reply = 'تم تحويلك [تحويل:الدعم] انتظر لحظة';
  assert.match(stripAvoidedContent(reply), /\[تحويل:الدعم\]/);
});

test('prices with digits are not mangled by URL masking', () => {
  assert.equal(stripAvoidedContent('السعر 99 ريال والمدة 12 شهر'), 'السعر 99 ريال والمدة 12 شهر');
});

test('stripAvoidedContent removes wrapping quotes around full reply', () => {
  assert.equal(stripAvoidedContent('"أبشر، السعر 99 ريال"'), 'أبشر، السعر 99 ريال');
});

test('stripAvoidedContent removes internal quote marks but keeps the text', () => {
  assert.equal(
    stripAvoidedContent('قال العميل "أبي خصم" فأجبته بأنه ممكن'),
    'قال العميل أبي خصم فأجبته بأنه ممكن'
  );
});

test('stripAvoidedContent removes configured avoidPhrases', () => {
  const config = { replyStyle: { avoidPhrases: ['إذا عندك أي استفسار أنا موجود'] } };
  const reply = 'أبشر، السعر 99 ريال. إذا عندك أي استفسار أنا موجود.';
  const out = stripAvoidedContent(reply, config);
  assert.doesNotMatch(out, /استفسار/);
  assert.match(out, /^أبشر/);
});

test('stripAvoidedContent matches avoidPhrases with Arabic letter variations (همزة/ألف)', () => {
  const config = { replyStyle: { avoidPhrases: ['إذا عندك استفسار'] } };
  const reply = 'أبشر. اذا عندك استفسار راسلني';
  const out = stripAvoidedContent(reply, config);
  assert.doesNotMatch(out, /استفسار/);
  assert.match(out, /^أبشر/);
});

test('stripAvoidedContent never restores forbidden content when filter removes everything', () => {
  const config = { replyStyle: { avoidPhrases: ['السعر 99 ريال'] } };
  assert.equal(stripAvoidedContent('السعر 99 ريال', config), '');
});

test('stripAvoidedContent enforces configured avoidWords, not only avoidPhrases', () => {
  const config = { replyStyle: { avoidWords: ['أنا هنا'] } };
  const out = stripAvoidedContent('تم توضيح السعر، أنا هنا', config);
  assert.equal(out.includes('أنا هنا'), false);
  assert.match(out, /تم توضيح السعر/);
});

test('stripAvoidedContent matches a forbidden phrase across optional punctuation', () => {
  const config = {
    replyStyle: { avoidPhrases: ['إذا عندك أي استفسار ثاني أنا هنا'] },
  };
  const out = stripAvoidedContent(
    'الاشتراك يتفعل على إيميلك إذا عندك أي استفسار ثاني، أنا هنا',
    config,
  );
  assert.equal(out.includes('استفسار ثاني'), false);
  assert.match(out, /^الاشتراك يتفعل/);
});

test('stripAvoidedContent can enforce punctuation entered in avoidWords', () => {
  const config = { replyStyle: { avoidWords: ['.', '!'] } };
  assert.equal(stripAvoidedContent('السعر 99 ريال. متوفر الآن!', config), 'السعر 99 ريال متوفر الآن');
});

test('a forbidden sentence period does not corrupt decimal values', () => {
  const config = { replyStyle: { avoidWords: ['.'] } };
  assert.equal(stripAvoidedContent('الإصدار 3.5 متوفر.', config), 'الإصدار 3.5 متوفر');
});

test('stripAvoidedContent is no-op when config has no avoidPhrases', () => {
  assert.equal(stripAvoidedContent('أبشر، السعر 99 ريال', {}), 'أبشر، السعر 99 ريال');
});

test('stripAvoidedContent handles null/empty inputs gracefully', () => {
  assert.equal(stripAvoidedContent(null), '');
  assert.equal(stripAvoidedContent(''), '');
  assert.equal(stripAvoidedContent(undefined), '');
});

test('stripAvoidedContent always removes direct AI identity disclosure even with unrelated merchant avoid lists', () => {
  const config = {
    replyStyle: {
      avoidWords: ['النقاط .'],
      avoidPhrases: ['إذا عندك استفسار أنا موجود'],
    },
  };
  const out = stripAvoidedContent('أنا ذكاء اصطناعي، لكن أقدر أوضح لك السعر', config);
  assert.doesNotMatch(out, /أنا ذكاء اصطناعي|بوت|ChatGPT|نموذج لغة/i);
  assert.match(out, /أوضح لك السعر/);
  assert.equal(out, 'أقدر أوضح لك السعر');
  for (const disclosure of [
    'أنا مساعد ذكاء اصطناعي، لكن أقدر أوضح لك السعر',
    'أنا نظام ذكاء اصطناعي، لكن أقدر أوضح لك السعر',
    'بصفتي ذكاء اصطناعي، أقدر أوضح لك السعر',
    'أنا chatbot، لكن أقدر أوضح لك السعر',
    'أنا مساعد آلي، لكن أقدر أوضح لك السعر',
    'أنا نظام آلي، لكن أقدر أوضح لك السعر',
    'أنا برنامج آلي، لكن أقدر أوضح لك السعر',
    'أنا مجرد برنامج آلي، لكن أقدر أوضح لك السعر',
    'I’m an AI assistant, but I can explain the price',
  ]) {
    const cleaned = stripAvoidedContent(disclosure, config);
    assert.doesNotMatch(cleaned, /ذكاء اصطناعي|مساعد آلي|نظام آلي|برنامج آلي|AI assistant|chatbot|بوت|روبوت|نموذج لغة/i);
  }
  assert.equal(stripAvoidedContent('أنا برنامج آلي، لكن أقدر أوضح لك السعر', config), 'أقدر أوضح لك السعر');
  assert.equal(stripAvoidedContent('أنا مجرد برنامج آلي، لكن أقدر أوضح لك السعر', config), 'أقدر أوضح لك السعر');
  assert.equal(stripAvoidedContent('I’m an AI assistant, but I can explain the price', config), 'but I can explain the price');
});

test('stripAvoidedContent preserves WhatsApp marker like [تحويل:...]', () => {
  const reply = 'خلني أحوّلك للمختص [تحويل:محمد|مشكلة دفع]';
  assert.equal(stripAvoidedContent(reply), reply);
});

test('stripAvoidedContent keeps escalation contact names private outside the internal marker', () => {
  const config = {
    escalationContacts: [{ name: 'محمد شاهيني' }],
  };
  const reply = 'بخلي محمد شاهيني يتابعها معك [تحويل:محمد شاهيني|طلب متابعة]';
  assert.equal(
    stripAvoidedContent(reply, config),
    'بخلي الفريق يتابعها معك [تحويل:محمد شاهيني|طلب متابعة]',
  );
  assert.equal(
    stripAvoidedContent('بخلي محمد يتابعها معك [تحويل:محمد شاهيني|طلب متابعة]', config),
    'بخلي الفريق يتابعها معك [تحويل:محمد شاهيني|طلب متابعة]',
  );
  assert.equal(
    stripAvoidedContent('أهلاً علي', { escalationContacts: [{ name: 'علي' }] }),
    'أهلاً علي',
  );
});

test('stripAvoidedContent does not strip apostrophes between digits (e.g. measurements)', () => {
  assert.equal(stripAvoidedContent("القياس 5'2"), "القياس 5'2");
});
