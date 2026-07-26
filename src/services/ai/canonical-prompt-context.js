'use strict';

const { compileMerchantPolicy } = require('../../policy/merchant-policy-compiler');
const { minorUnitForCurrency } = require('../../policy/iso-4217');

function policyError(code, details) {
  const error = new Error(code);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function requireActiveMerchantPolicy(config) {
  if (!config
      || !Object.prototype.hasOwnProperty.call(config, 'merchantPolicy')
      || config.merchantPolicy === null) {
    throw policyError('MERCHANT_POLICY_MISSING');
  }
  const compiled = compileMerchantPolicy(config.merchantPolicy);
  if (!compiled.ok) throw policyError('MERCHANT_POLICY_INVALID', compiled.errors);
  if (compiled.policy.status !== 'active') {
    throw policyError('MERCHANT_POLICY_NOT_ACTIVE', {
      status: compiled.policy.status,
    });
  }
  return compiled;
}

function formatMinorAmount(price) {
  if (!price) return '';
  const digits = minorUnitForCurrency(price.currency);
  if (!Number.isInteger(digits)) return '';
  const divisor = 10 ** digits;
  return `${(price.amountMinor / divisor).toFixed(digits)} ${price.currency}`;
}

function formatProduct(product) {
  const lines = [`- [${product.id}] ${product.name}`];
  if (product.description) lines.push(`  الوصف: ${product.description}`);
  for (const variant of product.variants) {
    const facts = [
      variant.name,
      formatMinorAmount(variant.price),
      variant.duration,
      variant.availability,
    ].filter(Boolean);
    lines.push(`  - [${variant.id}] ${facts.join(' | ')}`);
  }
  for (const link of product.links) lines.push(`  الرابط: ${link}`);
  return lines.join('\n');
}

function formatBusinessRule(rule) {
  return `- [${rule.id}] ${rule.topic}: ${rule.statement}`;
}

function formatInstantReply(reply) {
  return `- [${reply.id}] المحفزات: ${reply.triggers.join(' | ')}\n  الرد الحرفي: ${reply.reply}\n  الأدلة: ${reply.evidenceRefs.join(', ') || 'none'}`;
}

function collectCanonicalInstantReplies(compiledPolicy, text) {
  if (!compiledPolicy?.ok || compiledPolicy.policy?.status !== 'active') {
    throw policyError('MERCHANT_POLICY_NOT_ACTIVE');
  }
  const normalized = String(text || '').normalize('NFKC').toLocaleLowerCase('en-US').trim();
  if (!normalized) return { matched: [], hasExtraQuestion: false };

  const candidates = [];
  for (const reply of compiledPolicy.policy.instantReplies) {
    for (const trigger of reply.triggers) {
      const key = String(trigger).normalize('NFKC').toLocaleLowerCase('en-US').trim();
      if (key && normalized.includes(key)) {
        candidates.push({ key, reply });
      }
    }
  }
  candidates.sort((left, right) => right.key.length - left.key.length);

  let remainder = normalized;
  const seen = new Set();
  const matched = [];
  for (const candidate of candidates) {
    if (!remainder.includes(candidate.key) || seen.has(candidate.reply.id)) continue;
    remainder = remainder.split(candidate.key).join(' ');
    seen.add(candidate.reply.id);
    matched.push({
      id: candidate.reply.id,
      keyword: candidate.key,
      reply: candidate.reply.reply,
      evidenceRefs: candidate.reply.evidenceRefs,
    });
  }
  const meaningful = remainder
    .replace(/[؟?.,،!]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length >= 2);
  return {
    matched,
    hasExtraQuestion: matched.length > 0
      && (/[؟?]/.test(remainder) || meaningful.length >= 2),
  };
}

function buildCanonicalAutomatedPrompt({
  config,
  customerText = '',
  alreadyAnswered = '',
  customerProfile = null,
  escalationPending = false,
} = {}) {
  const compiled = requireActiveMerchantPolicy(config);
  const { policy } = compiled;
  const persona = policy.persona;
  const products = policy.catalog.products.map(formatProduct).join('\n') || '- لا توجد منتجات معتمدة.';
  const rules = policy.businessRules.map(formatBusinessRule).join('\n') || '- لا توجد قواعد تجارية معتمدة.';
  const instantReplies = policy.instantReplies.map(formatInstantReply).join('\n') || '- لا توجد ردود فورية معتمدة.';
  const forbidden = [
    ...policy.prohibitions.words,
    ...policy.prohibitions.phrases,
    ...policy.prohibitions.claims,
  ].join(' | ') || 'لا توجد عناصر إضافية.';
  const profileEnabled = process.env.CUSTOMER_PROFILE_ENABLED !== 'false';
  const profileEntries = profileEnabled && customerProfile && typeof customerProfile === 'object'
    ? Object.entries(customerProfile)
      .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    : [];
  const profileBlock = profileEntries.length
    ? [
        '<customer_profile_non_authoritative>',
        'معلومات محفوظة عن هذا العميل (سياق فقط وليست مصدراً لحقائق المنتجات أو الأسعار):',
        ...profileEntries.map(([key, value]) => {
          const labels = {
            name: 'الاسم',
            email: 'الإيميل',
            last_order_ref: 'آخر مرجع طلب',
          };
          return `${labels[key] || key}: ${String(value)}`;
        }),
        '</customer_profile_non_authoritative>',
      ]
    : [];
  const pendingBlock = escalationPending
    ? [
        '<pending_handoff>',
        'طلب العميل قيد المتابعة البشرية بالفعل. لا تسجّل الطلب من جديد ولا تعد بإعادة التصعيد.',
        '</pending_handoff>',
      ]
    : [];

  return [
    '<platform_contract>',
    'أنت وكيل خدمة عملاء فقط. أجب عن رسالة العميل الحالية مباشرة وباختصار.',
    'جاوب على جميع الأسئلة الواردة في الرسالة الحالية؛ لا تتجاهل سؤالاً لمجرد وجود تحية.',
    'إذا لم تفهم طلب العميل أو كان المقصود غير واضح، اطلب توضيحاً بسؤالاً توضيحياً واحداً محدداً أو استخدم مسار التصعيد البرمجي المعتمد. لا ترد بكلام عام، وممنوع تخمين الجواب.',
    'لا تعيد معلومة سبق إرسالها، حتى بصياغة مختلفة أو كلمات مختلفة؛ أضف فقط ما يجيب عن الجزء الجديد.',
    'إذا شك العميل أنك بوت أو سأل إن كنت إنساناً: لا تنكر، لا تجادل، ولا تؤكد أنك إنسان؛ حوّل الحديث بهدوء إلى خدمته.',
    'لا تُنشئ علامة تصعيد أو وجهة اتصال من نفسك؛ التوجيه قرار برمجي يعتمد على معرّف قاعدة ومعرّف جهة معتمدين.',
    'لا تخترع منتجًا أو سعرًا أو رقمًا أو رابطًا أو مدة أو توفرًا أو ضمانًا أو وعدًا.',
    'المعلومات التجارية الوحيدة المسموحة موجودة أدناه وتحمل معرفات أدلة ثابتة.',
    'التوجيهات الاحتمالية أو الردود المتعلمة ليست مصدر حقائق ولا تمنح صلاحية إرسال.',
    `policyVersion: ${compiled.policyVersion}`,
    '</platform_contract>',
    '<persona>',
    `role: ${persona.role}`,
    `displayName: ${persona.displayName || ''}`,
    `language: ${persona.language}`,
    `dialect: ${persona.dialect}`,
    `tone: ${persona.tone}`,
    `brevity: ${persona.brevity}`,
    `formatting: ${JSON.stringify(persona.formatting)}`,
    '</persona>',
    '<canonical_products>',
    products,
    '</canonical_products>',
    '<canonical_business_rules>',
    rules,
    '</canonical_business_rules>',
    '<canonical_instant_replies>',
    instantReplies,
    '</canonical_instant_replies>',
    '<prohibitions>',
    forbidden,
    '</prohibitions>',
    ...profileBlock,
    ...pendingBlock,
    '<current_customer_message>',
    String(customerText || ''),
    '</current_customer_message>',
    '<already_answered_verbatim>',
    String(alreadyAnswered || ''),
    'لا تكرر هذا الجزء؛ أجب فقط عن الجزء المتبقي من رسالة العميل.',
    '</already_answered_verbatim>',
  ].join('\n');
}

module.exports = {
  buildCanonicalAutomatedPrompt,
  collectCanonicalInstantReplies,
  formatMinorAmount,
  requireActiveMerchantPolicy,
};
