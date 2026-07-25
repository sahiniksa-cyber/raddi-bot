'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isRoutinePriceObjection,
  reviewFinalReplyBeforeSend,
} = require('../src/services/ai/reply-quality-gate');
const {
  routePreSendEscalation,
} = require('../src/workers/outgoing-whatsapp-worker');
const AIClient = require('../lib/ai-client');

const config = {
  storeName: 'Test Store',
  escalationContacts: [{
    name: 'الموظف',
    role: 'خدمة العملاء',
    phone: '966500000000',
  }],
  replyStyle: { emojiLevel: 'none' },
};

function reviewerResponse(body) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(body) } }],
          usage: {},
        }),
      },
    },
  };
}

test('reviewer uncertainty cannot escalate a harmless inherent product answer', async () => {
  const answer = 'نعم، المرايا الخارجية تنغسل مع غسيل السيارة';
  const reviewerReply = `${answer} [تحويل:الموظف|المرايا غير مذكورة حرفياً]`;
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'repair',
      reason: 'المرايا غير مذكورة حرفياً',
      confidence: 0.2,
      needs_human: true,
      human_reason: 'unsupported_information',
      handoff_summary: 'هل يشمل الغسيل المرايا',
      evidence_basis: 'natural_low_risk_inference',
      repeated_claims: [],
      violations: [],
      final_reply: reviewerReply,
    }),
    model: 'test',
    draft: answer,
    customerText: 'المرايا تنغسل؟',
    history: [{ role: 'user', speaker: 'customer', content: 'المرايا تنغسل؟' }],
    config: {
      ...config,
      products: [{ name: 'غسيل سيارة', description: 'غسيل خارجي للسيارة' }],
    },
  });

  assert.equal(result.audit.requiresHuman, false);
  assert.equal(result.audit.evidenceBasis, 'natural_low_risk_inference');
  assert.ok(result.audit.confidence < 0.65);
  assert.equal(result.reply, answer);
  assert.doesNotMatch(result.reply, /\[تحويل:/);
});

test('final transfer marker is stripped from customer text and enqueued once for the employee', async () => {
  const enqueued = [];
  const routed = await routePreSendEscalation({
    finalReply: 'تم، بخلي الموظف يتابع معك. [تحويل:الموظف|طلب تعويض عن خصم مالي]',
    config,
    userId: 'tenant-1',
    conversationId: 'conversation-1',
    sender: 'customer-1@s.whatsapp.net',
    replyMessageId: 'reply-1',
    inboundText: 'أبغى تعويض',
    enqueueOutgoing: async (payload, options) => enqueued.push({ payload, options }),
  });

  assert.equal(routed.escalated, true);
  assert.doesNotMatch(routed.reply, /\[تحويل:/);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].payload.escalation, true);
  assert.equal(enqueued[0].payload.customerSender, 'customer-1@s.whatsapp.net');
  assert.match(enqueued[0].payload.reply, /طلب تعويض/);
});

test('mandatory human handoff overrides a reviewer suppress decision', async () => {
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'suppress',
      reason: 'duplicate',
      confidence: 0.1,
      needs_human: true,
      human_reason: 'financial problem',
      handoff_summary: 'payment was charged twice',
      repeated_claims: ['already answered'],
      violations: [],
      final_reply: '',
    }),
    model: 'test',
    draft: 'سبق جاوبنا العميل.',
    customerText: 'انخصم المبلغ مرتين وأبغى موظف',
    history: [
      { role: 'assistant', speaker: 'bot', content: 'سبق جاوبنا العميل.' },
      { role: 'user', speaker: 'customer', content: 'انخصم المبلغ مرتين وأبغى موظف' },
    ],
    config,
  });

  assert.equal(result.suppressed, false);
  assert.equal(result.audit.requiresHuman, true);
  assert.match(result.reply, /\[تحويل:/);
});

test('routine price objection is acknowledged briefly instead of being escalated as unsupported information', async () => {
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'repair',
      reason: 'annual option under budget is unsupported',
      confidence: 0.9,
      needs_human: true,
      human_reason: 'unsupported_information',
      handoff_summary: 'العميل يبي اشتراك سنة بأقل من ٢٠٠',
      repeated_claims: [],
      violations: [],
      final_reply: 'ما عندنا اشتراك سنة بأقل من ٢٠٠',
    }),
    model: 'test',
    draft: 'والله اشتراك السنة مو متوفر حالياً اشتراكاتنا ما توقف، وراحة البال تستاهل',
    customerText: 'وعليكم السلام طلع ماعندكم اشتراك سنه يابعدي\nوغالي قوه انا ابيه اقل من ٢٠٠\nجزاك الله خير',
    history: [{
      role: 'user',
      speaker: 'customer',
      content: 'وعليكم السلام طلع ماعندكم اشتراك سنه يابعدي\nوغالي قوه انا ابيه اقل من ٢٠٠\nجزاك الله خير',
    }],
    config: {
      ...config,
      escalationContacts: [{ ...config.escalationContacts[0], name: 'محمد شاهيني' }],
      products: [{
        name: 'إشتراك أدوبي كرييتف كلاود',
        variants: [
          { label: 'اشتراك 4 اشهر', price: '189' },
          { label: 'اشتراك 8 اشهر', price: '289' },
        ],
      }],
    },
  });

  assert.equal(result.suppressed, false);
  assert.equal(result.audit.requiresHuman, false);
  assert.equal(result.audit.reason, 'routine_price_objection_acknowledged');
  assert.match(result.reply, /متفهم|السعر/);
  assert.doesNotMatch(result.reply, /\[تحويل:|محمد شاهيني|ذكاء اصطناعي|غير مؤكد/);
});

test('a safe natural reviewer reply is preserved instead of replaced by a canned price acknowledgement', async () => {
  const naturalReply = 'الله يجزاك خير يا بعدي، ومتفهم إن السعر ما ناسب ميزانيتك';
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'pass',
      reason: 'natural acknowledgement of a closed price objection',
      confidence: 0.95,
      needs_human: false,
      human_reason: '',
      handoff_summary: '',
      repeated_claims: [],
      violations: [],
      final_reply: naturalReply,
    }),
    model: 'test',
    draft: naturalReply,
    customerText: 'غالي مرة أبيه أقل من ٢٠٠، جزاك الله خير',
    history: [{ role: 'user', content: 'غالي مرة أبيه أقل من ٢٠٠، جزاك الله خير' }],
    config,
  });

  assert.equal(result.suppressed, false);
  assert.equal(result.audit.requiresHuman, false);
  assert.equal(result.reply, naturalReply);
  assert.notEqual(result.audit.reason, 'routine_price_objection_acknowledged');
});

test('a price question with a polite phrase is not mistaken for a closed sale', () => {
  assert.equal(isRoutinePriceObjection('ليش السعر غالي؟ جزاك الله خير'), false);
  assert.equal(isRoutinePriceObjection('غالي وأبيه أقل من ٢٠٠، عندكم خيار؟'), false);
  assert.equal(isRoutinePriceObjection('أبيه أقل من ٢٠٠، هل فيه عرض؟'), false);
  assert.equal(isRoutinePriceObjection('السعر ما يناسبني، هل فيه بديل؟'), false);
  assert.equal(isRoutinePriceObjection('غالي، أبيه أقل من ٢٠٠ عندكم'), false);
  assert.equal(isRoutinePriceObjection('غالي أبيه أقل من ٢٠٠ وش المتوفر'), false);
  assert.equal(isRoutinePriceObjection('غالي أبيه أقل من ٢٠٠ إذا موجود'), false);
  assert.equal(isRoutinePriceObjection('غالي أبيه أقل من ٢٠٠ هل يوجد'), false);
  assert.equal(isRoutinePriceObjection('غالي، جزاك الله خير، أبيه أقل من ٢٠٠ لو عندك'), false);
  assert.equal(isRoutinePriceObjection('شكراً، أبيه أقل من ٢٠٠ لو فيه'), false);
  assert.equal(isRoutinePriceObjection('غالي، يعطيك العافية، أبيه أقل من ٢٠٠ تقدر توفره'), false);
  assert.equal(isRoutinePriceObjection('شكراً، أبيه أقل من ٢٠٠ تقدر تجيبه'), false);
  assert.equal(isRoutinePriceObjection('غالي، أبيه أقل من ٢٠٠ تقدر توفره، يعطيك العافية'), false);
  assert.equal(isRoutinePriceObjection('أبيه أقل من ٢٠٠ تقدر تجيبه شكراً'), false);
  assert.equal(isRoutinePriceObjection('غالي وأبيه أقل من ٢٠٠ لو تقدر، ما قصرت'), false);
});

test('a price objection with an explicit staff request is never treated as routine', () => {
  assert.equal(isRoutinePriceObjection('غالي وخلاص، حولني للدعم'), false);
  assert.equal(isRoutinePriceObjection('غالي وخلاص، كلم الإدارة'), false);
  assert.equal(isRoutinePriceObjection('غالي وخلاص، ممكن أكلم الموظف؟'), false);
});

test('reviewer metadata alone cannot escalate a closed price objection', async () => {
  for (const reviewer of [
    {
      decision: 'repair',
      reason: 'customer data conflicts',
      confidence: 0.9,
      needs_human: true,
      human_reason: 'data_contradiction',
      evidence_basis: 'general_conversation',
    },
    {
      decision: 'repair',
      reason: 'uncertain',
      confidence: 0.2,
      needs_human: false,
      human_reason: '',
      evidence_basis: 'general_conversation',
    },
  ]) {
    const result = await reviewFinalReplyBeforeSend({
      openai: reviewerResponse({
        ...reviewer,
        handoff_summary: 'تحتاج مراجعة',
        repeated_claims: [],
        violations: [],
        final_reply: 'ما عندنا اشتراك سنة بأقل من ٢٠٠',
      }),
      model: 'test',
      draft: 'السعر ما يناسب ميزانية العميل',
      customerText: 'غالي وأبيه أقل من ٢٠٠، خلاص',
      history: [{ role: 'user', content: 'غالي وأبيه أقل من ٢٠٠، خلاص' }],
      config,
    });
    assert.equal(result.audit.requiresHuman, false);
    assert.doesNotMatch(result.reply, /\[تحويل:/);
  }
});

test('a reviewer-confirmed missing material product fact still escalates', async () => {
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'clarify',
      reason: 'ضمان طبقة النانو غير موجود في أي مصدر',
      confidence: 0.95,
      needs_human: true,
      human_reason: 'missing_product_fact',
      handoff_summary: 'العميل يسأل عن ضمان طبقة النانو',
      evidence_basis: 'missing_product_fact',
      repeated_claims: [],
      violations: [],
      final_reply: 'ضمان طبقة النانو غير مذكور عندي بشكل مؤكد',
    }),
    model: 'test',
    draft: 'ضمان طبقة النانو غير مذكور عندي بشكل مؤكد [تحويل:الموظف|التحقق من ضمان طبقة النانو]',
    customerText: 'كم ضمان طبقة النانو؟',
    history: [{ role: 'user', content: 'كم ضمان طبقة النانو؟' }],
    config: {
      ...config,
      products: [{ name: 'غسيل سيارة', description: 'غسيل خارجي للسيارة' }],
    },
  });

  assert.equal(result.audit.requiresHuman, true);
  assert.equal(result.audit.evidenceBasis, 'missing_product_fact');
  assert.match(result.reply, /\[تحويل:/);
  assert.doesNotMatch(result.reply, /محمد|ذكاء اصطناعي|بوت/);
});

test('authorized missing-product transfer preserves the selected contact in a multi-contact store', async () => {
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'repair',
      reason: 'تفصيل فني غير موجود',
      confidence: 0.95,
      needs_human: true,
      human_reason: 'missing_product_fact',
      handoff_summary: 'التحقق من طبقة النانو',
      evidence_basis: 'missing_product_fact',
      repeated_claims: [],
      violations: [],
      final_reply: 'بخلي الفريق يتأكد لك',
    }),
    model: 'test',
    draft: 'بخلي الفريق يتأكد لك [تحويل:الدعم الفني|التحقق من طبقة النانو]',
    customerText: 'هل الغسيل يشمل طبقة نانو؟',
    history: [{ role: 'user', content: 'هل الغسيل يشمل طبقة نانو؟' }],
    config: {
      ...config,
      escalationContacts: [
        { name: 'المالك', phone: '966500000001' },
        { name: 'فريق الدعم الفني', phone: '966500000002' },
      ],
      products: [{ name: 'غسيل سيارة', description: 'غسيل خارجي للسيارة' }],
    },
  });

  assert.match(result.reply, /\[تحويل:الدعم الفني\|التحقق من طبقة النانو\]/);
  assert.doesNotMatch(result.reply, /\[تحويل:المالك\|/);
});

test('missing_product_fact metadata cannot hijack a grounded draft without an authorized transfer marker', async () => {
  const answer = 'المتاح 4 أشهر بـ189 ريال أو 8 أشهر بـ289 ريال';
  const result = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'repair',
      reason: 'اعتبر المدد مفقودة بالخطأ',
      confidence: 0.95,
      needs_human: true,
      human_reason: 'missing_product_fact',
      handoff_summary: 'التحقق من المدد',
      evidence_basis: 'missing_product_fact',
      repeated_claims: [],
      violations: [],
      final_reply: answer,
    }),
    model: 'test',
    draft: answer,
    customerText: 'وش المدد المتاحة؟',
    history: [{ role: 'user', content: 'وش المدد المتاحة؟' }],
    config: {
      ...config,
      products: [{
        name: 'اشتراك أدوبي',
        variants: [
          { label: '4 أشهر', price: '189 ريال' },
          { label: '8 أشهر', price: '289 ريال' },
        ],
      }],
    },
  });

  assert.equal(result.audit.requiresHuman, false);
  assert.equal(result.reply, answer);
  assert.doesNotMatch(result.reply, /\[تحويل:/);
});

test('real human handoff keeps the internal contact name out of the customer-visible acknowledgement', async () => {
  const privateContactConfig = {
    ...config,
    escalationContacts: [{ ...config.escalationContacts[0], name: 'محمد شاهيني' }],
  };
  const reviewed = await reviewFinalReplyBeforeSend({
    openai: reviewerResponse({
      decision: 'repair',
      reason: 'refund requires staff',
      confidence: 0.95,
      needs_human: true,
      human_reason: 'refund_or_compensation',
      handoff_summary: 'طلب استرجاع',
      repeated_claims: [],
      violations: [],
      final_reply: 'بحول طلبك للموظف',
    }),
    model: 'test',
    draft: 'بحول طلبك للموظف',
    customerText: 'أبغى استرجاع المبلغ',
    history: [{ role: 'user', speaker: 'customer', content: 'أبغى استرجاع المبلغ' }],
    config: privateContactConfig,
  });
  const routed = await routePreSendEscalation({
    finalReply: reviewed.reply,
    config: privateContactConfig,
    userId: 'tenant-1',
    conversationId: 'conversation-1',
    sender: 'customer-1@s.whatsapp.net',
    replyMessageId: 'reply-private-contact',
    inboundText: 'أبغى استرجاع المبلغ',
    enqueueOutgoing: async () => {},
  });

  assert.equal(reviewed.audit.requiresHuman, true);
  assert.equal(routed.escalated, true);
  assert.doesNotMatch(routed.reply, /محمد شاهيني|ذكاء اصطناعي|بوت|غير مؤكد/);
  assert.match(routed.reply, /الفريق|المتابعة/);
});

test('reported Adobe price-objection replay stays a short customer reply through the full AIClient send review', async () => {
  const productionLikeConfig = {
    products: [{
      name: 'إشتراك أدوبي كرييتف كلاود',
      variants: [
        { label: 'اشتراك 4 اشهر', price: '189' },
        { label: 'اشتراك 8 اشهر', price: '289' },
      ],
    }],
    maxResponseLength: 200,
    replyStyle: {
      replyLength: 'short',
      lineBreakMode: 'topic',
      lineBreakCount: 2,
      lineBreakWords: 12,
      avoidWords: ['كيف اقدر اساعدك اليوم؟', '.', '!', 'أنا هنا'],
      avoidPhrases: ['إذا عندك استفسار انا موجود', 'مختص', 'مختصين'],
      emojiLevel: 'medium',
    },
    escalationContacts: [{
      name: 'محمد شاهيني',
      phone: 'متجر برو خدمة عملاء',
      when: 'مشكلة او استفسار ما عرفت له',
    }],
  };
  const ai = new AIClient(productionLikeConfig, {
    info() {},
    warn() {},
    error() {},
  }, { record() {} });
  ai.buildClient = () => ({
    model: 'test',
    openai: reviewerResponse({
      decision: 'repair',
      reason: 'annual option under budget is unsupported',
      confidence: 0.9,
      needs_human: true,
      human_reason: 'unsupported_information',
      handoff_summary: 'العميل يبي اشتراك سنة بأقل من ٢٠٠',
      repeated_claims: [],
      violations: [],
      final_reply: 'ما عندنا اشتراك سنة بأقل من ٢٠٠',
    }),
  });
  const customerText = 'وعليكم السلام طلع ماعندكم اشتراك سنه يابعدي\nوغالي قوه انا ابيه اقل من ٢٠٠\nجزاك الله خير';
  const reviewed = await ai.reviewBeforeSend({
    draft: 'والله اشتراك السنة مو متوفر حالياً اشتراكاتنا ما توقف، وراحة البال تستاهل',
    customerText,
    history: [{ role: 'user', speaker: 'customer', content: customerText }],
  });
  const routed = await routePreSendEscalation({
    finalReply: reviewed.reply,
    config: productionLikeConfig,
    userId: 'tenant-1',
    conversationId: 'conversation-adobe',
    sender: 'customer-adobe@s.whatsapp.net',
    replyMessageId: 'reply-adobe',
    inboundText: customerText,
    enqueueOutgoing: async () => {
      throw new Error('routine price objection must not enqueue escalation');
    },
  });

  assert.equal(reviewed.suppressed, false);
  assert.equal(reviewed.audit.requiresHuman, false);
  assert.equal(routed.escalated, false);
  assert.equal(routed.reply, 'الله يجزاك خير، ومتفهم إن السعر ما ناسبك');
  assert.doesNotMatch(routed.reply, /محمد|ذكاء اصطناعي|غير مؤكد|تحويل/);
});

test('merchant forbidden words cannot corrupt the internal transfer marker', async () => {
  const configWithPrivateNameForbidden = {
    ...config,
    replyStyle: {
      emojiLevel: 'none',
      avoidPhrases: ['محمد شاهيني'],
    },
    escalationContacts: [{
      ...config.escalationContacts[0],
      name: 'محمد شاهيني',
    }],
  };
  const ai = new AIClient(configWithPrivateNameForbidden, {
    info() {},
    warn() {},
    error() {},
  }, { record() {} });
  ai.buildClient = () => ({
    model: 'test',
    openai: reviewerResponse({
      decision: 'repair',
      reason: 'refund requires staff',
      confidence: 0.95,
      needs_human: true,
      human_reason: 'refund_or_compensation',
      handoff_summary: 'طلب استرجاع',
      repeated_claims: [],
      violations: [],
      final_reply: 'بحول طلبك للفريق',
    }),
  });
  const reviewed = await ai.reviewBeforeSend({
    draft: 'بحول طلبك للفريق',
    customerText: 'أبغى استرجاع المبلغ',
    history: [{ role: 'user', content: 'أبغى استرجاع المبلغ' }],
  });
  const enqueued = [];
  const routed = await routePreSendEscalation({
    finalReply: reviewed.reply,
    config: configWithPrivateNameForbidden,
    userId: 'tenant-1',
    conversationId: 'conversation-refund',
    sender: 'customer-refund@s.whatsapp.net',
    replyMessageId: 'reply-refund',
    inboundText: 'أبغى استرجاع المبلغ',
    enqueueOutgoing: async payload => enqueued.push(payload),
  });

  assert.equal(routed.escalated, true);
  assert.equal(enqueued.length, 1);
  assert.doesNotMatch(routed.reply, /محمد شاهيني|تحويل/);
});

test('first-pass unsupported evidence survives the safe handoff second pass', async () => {
  const inventedPriceConfig = {
    ...config,
    products: [],
    escalationContacts: [{
      ...config.escalationContacts[0],
      name: 'المالك',
    }],
  };
  const ai = new AIClient(inventedPriceConfig, {
    info() {},
    warn() {},
    error() {},
  }, { record() {} });
  ai.buildClient = () => ({
    model: 'test',
    openai: reviewerResponse({
      decision: 'pass',
      reason: 'looks fine',
      confidence: 0.95,
      needs_human: false,
      human_reason: '',
      handoff_summary: '',
      repeated_claims: [],
      violations: [],
      final_reply: 'السعر 777 ريال',
    }),
  });
  const result = await ai.reviewBeforeSend({
    draft: 'السعر 777 ريال',
    customerText: 'كم السعر؟',
    history: [{ role: 'user', content: 'كم السعر؟' }],
  });

  assert.equal(result.audit.hardFallback, true);
  assert.ok(result.audit.unsupportedClaims.some(claim => /777/.test(claim)));
  assert.match(result.reply, /\[تحويل:/);
});
