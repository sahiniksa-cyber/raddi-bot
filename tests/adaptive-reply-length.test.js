'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { describeReplyLength } = require('../src/services/bot/platform-features');

function withFlag(on, fn) {
  const prev = process.env.ADAPTIVE_LENGTH_ENABLED;
  if (on) process.env.ADAPTIVE_LENGTH_ENABLED = 'true';
  else delete process.env.ADAPTIVE_LENGTH_ENABLED;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.ADAPTIVE_LENGTH_ENABLED;
    else process.env.ADAPTIVE_LENGTH_ENABLED = prev;
  }
}

test('flag ON → length instruction is need-based, not a rigid sentence count', () => {
  withFlag(true, () => {
    const s = describeReplyLength({ maxResponseLength: 200, replyStyle: { useShortReplies: true } });
    assert.match(s, /تكيّفي/, 'must be adaptive');
    assert.match(s, /لا تُسقط أي سؤال/, 'must not drop a real question');
    assert.match(s, /بدون حشو/, 'must forbid padding');
    assert.match(s, /عدة أسئلة/, 'must handle multi-question');
    assert.ok(!/جملة إلى جملتين قصيرتين فقط/.test(s), 'must drop the rigid 1-2 sentence cap');
  });
});

test('flag ON → level sets a default LEAN (short leans shortest)', () => {
  withFlag(true, () => {
    const shortLean = describeReplyLength({ maxResponseLength: 200, replyStyle: { useShortReplies: true } });
    const longLean = describeReplyLength({ maxResponseLength: 200, replyStyle: { replyLength: 'long' } });
    assert.match(shortLean, /أقصر ما يمكن/);
    assert.match(longLean, /عند الحاجة/);
  });
});

test('flag OFF → legacy rigid instruction unchanged', () => {
  withFlag(false, () => {
    const s = describeReplyLength({ maxResponseLength: 200, replyStyle: { useShortReplies: true } });
    assert.match(s, /جملة إلى جملتين قصيرتين فقط/, 'legacy short instruction preserved when flag off');
  });
});
