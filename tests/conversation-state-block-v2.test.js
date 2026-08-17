'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateState, buildConversationStateBlock } = require('../src/services/ai/conversation-state');

function block(stateInput, opts = {}) {
  return buildConversationStateBlock(validateState(stateInput), { canInject: true, ...opts });
}

test('§14 block renders goal, topic, active entities, resolved references, pending expectation, corrections', () => {
  const b = block({
    customer_goal: 'شراء اشتراك',
    active_topic: 'اشتراك Adobe',
    active_entities: [
      { type: 'subscription', ref: 'adobe_cc', label: 'اشتراك Adobe', status: 'active', confidence: 'high', last_seen: '9' },
      { type: 'payment_method', ref: 'tamara', label: 'تمارا', confidence: 'high', last_seen: '9' },
    ],
    open_issues: [{ id: 'o1', summary: 'تفعيل الترخيص', status: 'open' }],
    resolved_issues: [{ id: 'r1', summary: 'تسجيل الدخول', resolved_by: 'customer_confirmed' }],
    known_facts: { الجوال: '05xxxxxxxx' },
    pending_expectation: { type: 'phone_number', purpose: 'إرسال طلب الدفع', related_entity: 'اشتراك Adobe' },
    last_turn_understanding: {
      intent: 'ask_warranty',
      resolved_references: [{ text: 'الاشتراك', entity: 'اشتراك Adobe', confidence: 'high' }],
      customer_correction: true,
    },
  }, { latestUserText: 'الاشتراك مضمون؟' });

  assert.ok(b.includes('حالة المحادثة'), 'keeps the internal header');
  assert.ok(b.includes('شراء اشتراك'), 'goal');
  assert.ok(b.includes('اشتراك Adobe'), 'active entity / topic');
  assert.ok(b.includes('تمارا'), 'second active entity');
  assert.ok(b.includes('الاشتراك') && b.includes('اشتراك Adobe'), 'resolved reference rendered');
  assert.ok(b.includes('تفعيل الترخيص'), 'open issue');
  assert.ok(b.includes('تسجيل الدخول'), 'resolved issue (do not re-suggest)');
  assert.ok(/لا تقترحها|تأكّد حلّها/.test(b), 'do-not-resuggest instruction');
  assert.ok(/بانتظار|ينتظر|في انتظار/.test(b) && b.includes('إرسال طلب الدفع'), 'pending expectation');
  assert.ok(/صحّح|صحح|غيّر|تصحيح/.test(b), 'customer correction surfaced');
});

test('§14 footer carries the behavioural instructions', () => {
  const b = block({ active_topic: 'x', open_issues: [{ id: 'o', summary: 'مشكلة', status: 'open' }] });
  assert.ok(/لا تسأل عن معلومة معروفة|معلومة معروفة/.test(b), 'do not ask for known info');
  assert.ok(/الغموض|غامض/.test(b) && /تصعيد|تصعّد/.test(b), 'ambiguity alone is not escalation');
  assert.ok(/لا تدّعِ|لا تزعم|لم يؤكّده النظام|إلا إذا أكّده/.test(b), 'never claim an unconfirmed action happened');
});

test('previous_bot_statement memory is shown as UNVERIFIED, never as a confirmed fact (§9/Test K)', () => {
  const b = block({
    salient_memories: [
      { summary: 'وعد البوت بخصم 20%', source: 'previous_bot_statement', confidence: 'low' },
    ],
    known_facts: {},
  }, { latestUserText: 'الخصم' });
  assert.ok(b.includes('وعد البوت بخصم 20%'));
  assert.ok(/غير مؤكد|غير مؤكّد|لم يتأكد|سبق أن قال البوت/.test(b), 'flagged as unverified');
  // and it is NOT under the confirmed-facts section
  assert.ok(!/معلومات مؤكدة[^]*وعد البوت بخصم 20%/.test(b), 'not rendered as a confirmed fact');
});

test('§13 relevant memories: the memory matching the latest message is selected over unrelated ones', () => {
  const memories = [
    { summary: 'العميل يناقش الشحن الدولي', source: 'customer', confidence: 'high', related_entities: ['شحن'] },
    { summary: 'العميل مهتم باشتراك Adobe السنوي', source: 'customer', confidence: 'high', related_entities: ['اشتراك Adobe'] },
  ];
  const b = block({ salient_memories: memories }, { latestUserText: 'طيب الاشتراك مضمون؟', maxChars: 600 });
  assert.ok(b.includes('اشتراك Adobe'), 'the on-topic memory is present');
});

test('§19 budget: an oversized state is capped and high-priority content survives while low-value memories are dropped', () => {
  const memories = [];
  for (let i = 0; i < 40; i++) memories.push({ summary: `تفصيل قديم منخفض القيمة رقم ${i} حشو حشو حشو`, source: 'unknown', confidence: 'low' });
  const b = block({
    pending_expectation: { type: 'order_id', purpose: 'متابعة الطلب', related_entity: 'الطلب' },
    last_turn_understanding: { resolved_references: [{ text: 'الطلب', entity: 'الطلب رقم 123', confidence: 'high' }] },
    salient_memories: memories,
  }, { latestUserText: 'وش صار في طلبي', maxChars: 700 });

  assert.ok(b.length <= 700 + 200, `block too large: ${b.length}`); // small tolerance for header/footer essentials
  assert.ok(b.includes('الطلب رقم 123'), 'high-priority resolved reference survives');
  assert.ok(/متابعة الطلب/.test(b), 'pending expectation survives');
  const junk = (b.match(/تفصيل قديم منخفض القيمة/g) || []).length;
  assert.ok(junk < 40, 'not all 40 low-value memories are dumped');
});

test('backward compatible: a V1-shaped state still renders and an empty state yields ""', () => {
  const v1 = {
    open_issues: [{ id: 'i2', summary: 'الترخيص غير ظاهر', status: 'open' }],
    resolved_issues: [{ id: 'i1', summary: 'تشغيل البرنامج', resolved_by: 'customer_confirmed' }],
    known_facts: { payment_method: 'تحويل بنكي' },
    active_topic: 'الترخيص', active_entity: null, customer_goal: null,
    actions_attempted: [], last_reply_intent: null,
  };
  const b = buildConversationStateBlock(v1, { canInject: true });
  assert.ok(b.includes('تشغيل البرنامج') && b.includes('الترخيص غير ظاهر') && b.includes('تحويل بنكي'));
  assert.equal(buildConversationStateBlock(validateState({}), { canInject: true }), '');
});
