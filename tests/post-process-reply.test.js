'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  effectiveAvoidList,
  scanForbiddenContent,
  stripAvoidedContent,
} = require('../lib/post-process-reply');

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

test('stripAvoidedContent returns original when filter removes everything', () => {
  const config = { replyStyle: { avoidPhrases: ['السعر 99 ريال'] } };
  assert.equal(stripAvoidedContent('السعر 99 ريال', config), '');
});

test('avoidWords and avoidPhrases are both enforced with punctuation-insensitive matching', () => {
  const config = {
    replyStyle: {
      avoidWords: ['غالي'],
      avoidPhrases: ['كيف اقدر اساعدك'],
    },
  };
  const out = stripAvoidedContent('السعر غالي. كيف، أقدر أساعدك؟ الخيار الثاني مناسب.', config);

  assert.doesNotMatch(out, /غالي|كيف.*أقدر.*أساعدك/);
  assert.match(out, /الخيار الثاني مناسب/);
});

test('merchant avoid lists merge with platform identity defaults instead of replacing them', () => {
  const config = { replyStyle: { avoidWords: ['غالي'], avoidPhrases: ['أنا موجود'] } };
  const list = effectiveAvoidList(config);

  assert.ok(list.some(value => /ذكاء اصطناعي/.test(value)));
  assert.ok(list.some(value => /^AI$/i.test(value)));
  assert.ok(list.includes('غالي'));
  assert.ok(list.includes('أنا موجود'));
});

test('Arabic and English automation disclosures are removed despite spacing and punctuation variants', () => {
  const arabic = stripAvoidedContent('أنا، روبوت. السعر 99 ريال.', {});
  const english = stripAvoidedContent("I'm an A.I. assistant. السعر 99 ريال.", {});

  assert.doesNotMatch(arabic, /روبوت/);
  assert.doesNotMatch(english, /A\.I\.|assistant/i);
  assert.match(arabic, /99 ريال/);
  assert.match(english, /99 ريال/);
});

test('automation disclosure can be allowed only by an explicit merchant setting', () => {
  const config = { replyStyle: { allowAutomationDisclosure: true } };
  assert.match(stripAvoidedContent('أنا روبوت مخصص للمتجر.', config), /روبوت/);
});

test('scanForbiddenContent detects content that must never reach the send queue', () => {
  const result = scanForbiddenContent('أنا ذكاء اصطناعي، وإذا تحتاج شيء أنا موجود.', {
    replyStyle: { avoidPhrases: ['إذا تحتاج شيء أنا موجود'] },
  });

  assert.equal(result.blocked, true);
  assert.ok(result.matches.some(match => /ذكاء اصطناعي/.test(match)));
  assert.ok(result.matches.some(match => /إذا تحتاج/.test(match)));
});

test('a configured employee name cannot be used as a persona unless explicitly enabled', () => {
  const disabled = {
    replyStyle: { employeeName: 'محمد', employeeNameEnabled: false },
  };
  const enabled = {
    replyStyle: { employeeName: 'محمد', employeeNameEnabled: true },
  };

  assert.doesNotMatch(stripAvoidedContent('أنا محمد من خدمة العملاء، أبشر.', disabled), /محمد/);
  assert.equal(scanForbiddenContent('معك محمد من المتجر.', disabled).blocked, true);
  assert.match(stripAvoidedContent('أنا محمد من خدمة العملاء، أبشر.', enabled), /محمد/);
});

test('stripAvoidedContent is no-op when config has no avoidPhrases', () => {
  assert.equal(stripAvoidedContent('أبشر، السعر 99 ريال', {}), 'أبشر، السعر 99 ريال');
});

test('stripAvoidedContent handles null/empty inputs gracefully', () => {
  assert.equal(stripAvoidedContent(null), '');
  assert.equal(stripAvoidedContent(''), '');
  assert.equal(stripAvoidedContent(undefined), '');
});

test('stripAvoidedContent preserves WhatsApp marker like [تحويل:...]', () => {
  const reply = 'خلني أحوّلك للمختص [تحويل:محمد|مشكلة دفع]';
  assert.equal(stripAvoidedContent(reply), reply);
});

test('stripAvoidedContent does not strip apostrophes between digits (e.g. measurements)', () => {
  assert.equal(stripAvoidedContent("القياس 5'2"), "القياس 5'2");
});
