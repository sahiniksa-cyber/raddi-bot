'use strict';

const { isDeepStrictEqual } = require('node:util');

const {
  compileMerchantPolicy,
} = require('../../policy/merchant-policy-compiler');
const {
  PLATFORM_REPLY_POLICY,
} = require('../../policy/platform-reply-policy');

const MATERIAL_CODES = Object.freeze({
  availability: 'UNSUPPORTED_AVAILABILITY',
  compatibility: 'UNSUPPORTED_COMPATIBILITY',
  delivery: 'UNSUPPORTED_DELIVERY',
  discount: 'UNSUPPORTED_DISCOUNT',
  duration: 'UNSUPPORTED_DURATION',
  price: 'UNSUPPORTED_PRODUCT_PRICE',
  promise: 'UNSUPPORTED_COMMERCIAL_PROMISE',
  refund: 'UNSUPPORTED_REFUND',
  warranty: 'UNSUPPORTED_WARRANTY',
});

const TOPIC_MARKERS = Object.freeze({
  availability: [
    'متاح',
    'متاحة',
    'متوفر',
    'متوفرة',
    'توفر',
    'available',
    'availability',
    'in stock',
    'موجود',
    'موجودة',
    'نافد',
    'نافذة',
  ],
  compatibility: [
    'متوافق',
    'متوافقة',
    'توافق',
    'compatible',
    'compatibility',
    'works with',
    'يعمل على',
    'تعمل على',
    'يدعم',
    'تدعم',
  ],
  contact: [
    'اتصل',
    'تواصل',
    'رقم التواصل',
    'خدمة العملاء',
    'contact',
    'call',
    'phone',
    'support number',
  ],
  delivery: [
    'توصيل',
    'التوصيل',
    'شحن',
    'الشحن',
    'delivery',
    'shipping',
    'مجاني',
    'مجانية',
    'free',
  ],
  discount: [
    'خصم',
    'الخصم',
    'تخفيض',
    'التخفيض',
    'discount',
    'promotion',
    'promo',
    'عرض خاص',
  ],
  duration: [
    'مدة',
    'مده',
    'يوم',
    'ايام',
    'أيام',
    'اسبوع',
    'أسبوع',
    'شهر',
    'اشهر',
    'أشهر',
    'سنة',
    'سنه',
    'سنوات',
    'duration',
    'day',
    'week',
    'month',
    'year',
  ],
  number: [
    'رقم',
    'رمز',
    'كود',
    'number',
    'code',
  ],
  price: [
    'سعر',
    'السعر',
    'تكلفة',
    'تكلفه',
    'price',
    'cost',
  ],
  promise: [
    'نضمن',
    'اضمن',
    'أضمن',
    'نتعهد',
    'التزام',
    'guarantee',
    'promise',
    'commit',
    'مضمون',
    'مضمونة',
  ],
  refund: [
    'استرجاع',
    'الاسترجاع',
    'استرداد',
    'الاسترداد',
    'refund',
    'return',
    'ترجيع',
    'الترجيع',
  ],
  url: [
    'رابط',
    'الموقع',
    'link',
    'url',
    'website',
  ],
  warranty: [
    'ضمان',
    'الضمان',
    'كفالة',
    'warranty',
    'مكفول',
    'مكفولة',
    'ضمانا',
    'شامل',
    'مدى الحياة',
  ],
});

const CURRENCY_MARKERS = Object.freeze([
  { code: 'SAR', values: ['ريال سعودي', 'ريال', 'ر س', 'sar'] },
  { code: 'AED', values: ['درهم اماراتي', 'درهم إماراتي', 'درهم', 'aed'] },
  { code: 'KWD', values: ['دينار كويتي', 'kwd'] },
  { code: 'USD', values: ['دولار امريكي', 'دولار أمريكي', 'دولار', 'usd', '$'] },
  { code: 'EUR', values: ['يورو', 'eur', '€'] },
  { code: 'GBP', values: ['جنيه استرليني', 'جنيه إسترليني', 'gbp', '£'] },
]);

const URL_RE = /(?:https?:\/\/|www\.)[^\s<>()]+|(?:[a-z0-9-]+\.)+[a-z]{2,63}(?:\/[^\s<>()]*)?/giu;
const PHONE_RE = /(?:\+?\d[\d\s().-]{6,}\d)/gu;
const NUMBER_RE = /\d+(?:\.\d+)?/gu;
const ARABIC_DIACRITICS_RE = /[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/gu;

function normalizeDigits(value) {
  return String(value || '')
    .replace(/[\u0660-\u0669]/gu, digit => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06f0-\u06f9]/gu, digit => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u066c,](?=\d{3}(?:\D|$))/gu, '')
    .replace(/\u066b/gu, '.');
}

function normalizeText(value) {
  return normalizeDigits(value)
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(ARABIC_DIACRITICS_RE, '')
    .replace(/\u0640/gu, '')
    .replace(/[أإآٱ]/gu, 'ا')
    .replace(/[ة]/gu, 'ه')
    .replace(/[،؛؟!?()[\]{}"'`~_:;,./\\|@#%^&*=+<>-]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeUrl(value) {
  const raw = normalizeDigits(value)
    .trim()
    .replace(/[،؛,.!?]+$/gu, '');
  const withScheme = /^(?:https?:\/\/)/iu.test(raw)
    ? raw
    : `https://${raw.replace(/^www\./iu, '')}`;
  try {
    const parsed = new URL(withScheme);
    const port = parsed.port ? `:${parsed.port}` : '';
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
    return `${parsed.hostname.toLocaleLowerCase('en-US')}${port}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return raw;
  }
}

function normalizePhone(value) {
  const normalized = normalizeDigits(value).trim();
  const prefix = normalized.startsWith('+') ? '+' : '';
  return `${prefix}${normalized.replace(/\D/gu, '')}`;
}

function hasPhrase(text, phrase) {
  const haystack = ` ${normalizeText(text)} `;
  const needle = normalizeText(phrase);
  return needle !== '' && haystack.includes(` ${needle} `);
}

function hasTopicMarker(text, marker) {
  const normalizedText = normalizeText(text);
  const normalizedMarker = normalizeText(marker);
  if (!normalizedMarker) return false;
  if (/[\u0600-\u06ff]/u.test(normalizedMarker)) {
    return normalizedText.includes(normalizedMarker);
  }
  return hasPhrase(normalizedText, normalizedMarker);
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value !== ''))];
}

function asFocus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      evidenceRefs: [],
      productId: null,
      topics: [],
      variantId: null,
    };
  }
  return {
    evidenceRefs: uniqueStrings(Array.isArray(value.evidenceRefs) ? value.evidenceRefs : []),
    productId: typeof value.productId === 'string' ? value.productId : null,
    topics: uniqueStrings(Array.isArray(value.topics) ? value.topics.map(normalizeTopic) : []),
    variantId: typeof value.variantId === 'string' ? value.variantId : null,
  };
}

function normalizeTopic(value) {
  const topic = normalizeText(value);
  for (const [canonical, markers] of Object.entries(TOPIC_MARKERS)) {
    if (canonical === topic || markers.some(marker => hasPhrase(topic, marker))) return canonical;
  }
  if (['commercial promise', 'commercial_promise'].includes(topic)) return 'promise';
  return topic;
}

function textTopics(value) {
  const normalized = normalizeText(value);
  const topics = [];
  for (const [topic, markers] of Object.entries(TOPIC_MARKERS)) {
    if (markers.some(marker => hasTopicMarker(normalized, marker))) topics.push(topic);
  }
  if (/(?:^|\s)(?:السلام|هلا|مرحبا|اهلا|حياك|hello|hi)(?:\s|$)/u.test(normalized)) {
    topics.push('greeting');
  }
  return uniqueStrings(topics);
}

function inferFactType(key, value) {
  const combined = `${normalizeText(key)} ${normalizeText(value)}`;
  for (const topic of [
    'compatibility',
    'warranty',
    'availability',
    'duration',
    'delivery',
    'refund',
    'discount',
    'promise',
    'price',
  ]) {
    if (TOPIC_MARKERS[topic].some(marker => hasPhrase(combined, marker))) return topic;
  }
  return 'product_fact';
}

function addAttributeFacts(facts, ref, attributes, parentKey = '') {
  if (!attributes || typeof attributes !== 'object') return;
  for (const [key, value] of Object.entries(attributes)) {
    const path = parentKey ? `${parentKey}.${key}` : key;
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === 'object') addAttributeFacts(facts, ref, entry, path);
        else if (entry !== null && entry !== undefined) {
          facts.push({
            ref,
            type: inferFactType(path, entry),
            value: String(entry),
          });
        }
      }
    } else if (value && typeof value === 'object') {
      addAttributeFacts(facts, ref, value, path);
    } else if (value !== null && value !== undefined) {
      facts.push({
        ref,
        type: inferFactType(path, value),
        value: String(value),
      });
    }
  }
}

function currencyFractionDigits(currency) {
  try {
    return new Intl.NumberFormat('en-US', {
      currency,
      style: 'currency',
    }).resolvedOptions().maximumFractionDigits;
  } catch {
    return 2;
  }
}

function priceAmounts(price) {
  const fractionDigits = currencyFractionDigits(price.currency);
  const major = price.amountMinor / (10 ** fractionDigits);
  const values = new Set([
    String(major),
    major.toFixed(fractionDigits),
  ]);
  if (Number.isInteger(major)) values.add(major.toFixed(0));
  return [...values];
}

function productFacts(product, variantId) {
  const facts = [
    { ref: product.id, type: 'product', value: product.name },
    ...product.aliases.map(value => ({ ref: product.id, type: 'product', value })),
    ...product.links.map(value => ({ ref: product.id, type: 'url', value })),
  ];
  if (product.description) {
    facts.push({ ref: product.id, type: 'product_fact', value: product.description });
  }
  addAttributeFacts(facts, product.id, product.attributes);

  if (variantId) {
    const variant = product.variants.find(entry => entry.id === variantId);
    if (variant) {
      facts.push({
        ref: product.id,
        type: 'variant',
        value: variant.name,
        variantId: variant.id,
      });
      for (const alias of Array.isArray(variant.attributes?.aliases)
        ? variant.attributes.aliases
        : []) {
        facts.push({
          ref: product.id,
          type: 'variant',
          value: alias,
          variantId: variant.id,
        });
      }
      facts.push({
        amountMinor: variant.price.amountMinor,
        amounts: priceAmounts(variant.price),
        currency: variant.price.currency,
        ref: product.id,
        type: 'price',
        value: `${variant.price.amountMinor} ${variant.price.currency}`,
        variantId: variant.id,
      });
      if (variant.duration) {
        facts.push({
          ref: product.id,
          type: 'duration',
          value: variant.duration,
          variantId: variant.id,
        });
      }
      if (variant.availability) {
        facts.push({
          ref: product.id,
          type: 'availability',
          value: variant.availability,
          variantId: variant.id,
        });
      }
      addAttributeFacts(facts, product.id, variant.attributes);
    }
  }
  return facts;
}

function resolveEvidence(compiledPolicy, focus) {
  const facts = [];
  const resolvedRefs = [];
  const indexes = compiledPolicy.indexes;

  for (const ref of focus.evidenceRefs) {
    const product = indexes.productsById[ref];
    if (product && focus.productId === product.id) {
      facts.push(...productFacts(product, focus.variantId));
      resolvedRefs.push(ref);
      continue;
    }
    const rule = indexes.businessRulesById[ref];
    if (rule) {
      facts.push({
        ref,
        type: normalizeTopic(rule.topic),
        value: rule.statement,
      });
      resolvedRefs.push(ref);
      continue;
    }
    const contact = indexes.contactsById[ref];
    if (contact) {
      facts.push({
        ref,
        type: 'contact',
        value: contact.phoneNumber,
      });
      resolvedRefs.push(ref);
    }
  }
  return {
    facts: facts.map(fact => ({ ...fact, normalized: normalizeText(fact.value) })),
    refs: uniqueStrings(resolvedRefs),
  };
}

function extractUrls(reply) {
  return [...String(reply || '').matchAll(URL_RE)].map(match => normalizeUrl(match[0]));
}

function extractPhones(reply, urls) {
  let withoutUrls = normalizeDigits(reply);
  for (const url of urls) withoutUrls = withoutUrls.replace(url, ' ');
  return [...withoutUrls.matchAll(PHONE_RE)]
    .map(match => normalizePhone(match[0]))
    .filter(value => value.replace(/\D/gu, '').length >= 8);
}

function currencyInText(normalizedReply) {
  for (const currency of CURRENCY_MARKERS) {
    if (currency.values.some(marker => hasPhrase(normalizedReply, marker))) return currency.code;
  }
  const iso = normalizedReply.match(/(?:^|\s)([a-z]{3})(?:\s|$)/u)?.[1]?.toUpperCase();
  return iso || null;
}

function numberValues(reply) {
  return [...normalizeDigits(reply).matchAll(NUMBER_RE)].map(match => match[0]);
}

function removeNumericIdentities(reply, facts) {
  let remaining = normalizeDigits(reply);
  const numericIdentities = facts
    .filter(fact => ['product', 'variant'].includes(fact.type))
    .filter(fact => numberValues(fact.value).length > 0)
    .sort((left, right) => String(right.value).length - String(left.value).length);
  for (const fact of numericIdentities) {
    const phrase = normalizeDigits(fact.value);
    if (!phrase) continue;
    remaining = remaining.split(phrase).join(' ');
  }
  return remaining;
}

function factContained(reply, fact) {
  return fact.normalized !== '' && hasPhrase(reply, fact.normalized);
}

function compatibilityTargets(reply, facts) {
  const normalized = normalizeText(reply);
  const match = normalized.match(
    /(?:متوافق(?:ه)?\s+مع|compatible\s+with|works\s+with|يعمل\s+على|تعمل\s+على|يدعم|تدعم)\s+(.+)$/u,
  );
  if (!match) return [];
  let target = match[1];
  for (const fact of facts.filter(entry => ['product', 'variant'].includes(entry.type))) {
    target = target.split(fact.normalized).join(' ');
  }
  return uniqueStrings(target
    .split(/\s+(?:و|او|أو|and|or)\s+|[,/]/u)
    .map(value => normalizeText(value))
    .filter(Boolean));
}

function materialClaimTypes(reply) {
  const topics = textTopics(reply);
  const normalizedReply = normalizeText(reply);
  const types = [];
  for (const topic of [
    'price',
    'duration',
    'compatibility',
    'delivery',
    'warranty',
    'refund',
    'discount',
    'promise',
  ]) {
    if (topic === 'duration' && topics.includes('warranty')) continue;
    if (topics.includes(topic)) types.push(topic);
  }
  const strongAvailability = [
    'متوفر',
    'متوفره',
    'غير متوفر',
    'نافد',
    'موجود',
    'available',
    'unavailable',
    'in stock',
    'out of stock',
  ].some(marker => hasTopicMarker(normalizedReply, marker));
  const genericAvailabilityOnly = topics.includes('availability')
    && !topics.some(topic => ['delivery', 'refund', 'discount'].includes(topic));
  if (strongAvailability || genericAvailabilityOnly) types.push('availability');
  return uniqueStrings(types);
}

function mentionedProducts(reply, compiledPolicy) {
  const found = [];
  for (const product of Object.values(compiledPolicy.indexes.productsById)) {
    if ([product.name, ...product.aliases].some(alias => hasPhrase(reply, alias))) {
      found.push(product.id);
    }
  }
  return uniqueStrings(found);
}

function mentionedVariants(reply, compiledPolicy) {
  const found = [];
  for (const product of Object.values(compiledPolicy.indexes.productsById)) {
    for (const variant of product.variants) {
      const aliases = Array.isArray(variant.attributes?.aliases)
        ? variant.attributes.aliases
        : [];
      if ([variant.name, ...aliases].some(alias => hasPhrase(reply, alias))) {
        found.push({ productId: product.id, variantId: variant.id });
      }
    }
  }
  return found;
}

function removeFactsFromReply(reply, facts) {
  let residual = ` ${normalizeText(reply)} `;
  for (const fact of [...facts].sort((a, b) => b.normalized.length - a.normalized.length)) {
    if (!fact.normalized) continue;
    residual = residual.split(` ${fact.normalized} `).join(' ');
  }
  return normalizeText(residual);
}

function hasContradictoryNegation(reply, fact) {
  const normalizedReply = ` ${normalizeText(reply)} `;
  const value = fact.normalized;
  if (!value) return false;
  const positiveFact = !/(?:^|\s)(?:غير|ليس|مو|not|unavailable)(?:\s|$)/u.test(value);
  if (!positiveFact) return false;
  return [
    ` غير ${value} `,
    ` ليس ${value} `,
    ` مو ${value} `,
    ` not ${value} `,
  ].some(pattern => normalizedReply.includes(pattern));
}

function exactFactAllows(type, reply, facts) {
  const candidates = facts.filter(fact => fact.type === type);
  if (type === 'compatibility') {
    const targets = compatibilityTargets(reply, facts);
    if (targets.length === 0) return false;
    return targets.every(target => candidates.some(fact => normalizeText(fact.value) === target));
  }
  const contained = candidates.filter(fact => factContained(reply, fact));
  if (contained.length === 0) return false;
  if (contained.some(fact => hasContradictoryNegation(reply, fact))) return false;
  if (type === 'duration') return true;
  const residual = removeFactsFromReply(reply, contained);
  return !textTopics(residual).includes(type);
}

function decimalToMinor(value, fractionDigits) {
  const match = String(value).match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match) return null;
  const fraction = match[2] || '';
  if (fraction.length > fractionDigits) return null;
  const padded = `${fraction}${'0'.repeat(fractionDigits)}`.slice(0, fractionDigits);
  const major = BigInt(match[1]);
  const minor = major * (10n ** BigInt(fractionDigits)) + BigInt(padded || '0');
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}

function pricePairs(reply, facts) {
  const remaining = removeNumericIdentities(reply, facts);
  const matches = [...remaining.matchAll(NUMBER_RE)];
  return matches.map((match, index) => {
    const nextIndex = matches[index + 1]?.index ?? remaining.length;
    const previousEnd = index === 0
      ? Math.max(0, match.index - 24)
      : matches[index - 1].index + matches[index - 1][0].length;
    const after = remaining.slice(match.index + match[0].length, nextIndex);
    const before = remaining.slice(previousEnd, match.index);
    return {
      currency: currencyInText(normalizeText(after))
        || currencyInText(normalizeText(before)),
      value: match[0],
    };
  });
}

function priceClaim(reply, facts) {
  const normalizedReply = normalizeText(reply);
  const currency = currencyInText(normalizedReply);
  const hasPriceMarker = TOPIC_MARKERS.price.some(marker => hasPhrase(normalizedReply, marker));
  if (!currency && !hasPriceMarker) return null;

  const pairs = pricePairs(reply, facts);
  const allowed = pairs.length > 0 && pairs.every(pair => facts
    .filter(fact => fact.type === 'price')
    .some(fact => {
      if (!pair.currency || fact.currency !== pair.currency) return false;
      const minor = decimalToMinor(pair.value, currencyFractionDigits(pair.currency));
      return minor !== null && minor === fact.amountMinor;
    }));
  return {
    allowed,
    currency: pairs.length === 1 ? pairs[0].currency : null,
    pairs,
    type: 'price',
    value: pairs.map(pair => `${pair.value}:${pair.currency || '?'}`).join(','),
    values: pairs.map(pair => pair.value),
  };
}

function canonicalNumberAllowed(value, facts) {
  return facts.some(fact => {
    if (fact.type === 'price') {
      return fact.amounts.some(amount => Number(amount) === Number(value));
    }
    if (fact.type === 'contact') {
      return normalizePhone(fact.value).replace(/\D/gu, '') === value;
    }
    return numberValues(fact.value).includes(value);
  });
}

function authenticatePolicyContext(compiledPolicy, platformPolicy) {
  if (!compiledPolicy) return { ok: false, code: 'POLICY_MISSING' };
  if (!isDeepStrictEqual(platformPolicy, PLATFORM_REPLY_POLICY)) {
    return { ok: false, code: 'POLICY_INVALID' };
  }
  if (compiledPolicy.ok !== true
      || !compiledPolicy.policy
      || typeof compiledPolicy.policy !== 'object'
      || !compiledPolicy.indexes
      || typeof compiledPolicy.indexes !== 'object') {
    return { ok: false, code: 'POLICY_INVALID' };
  }

  const rebuilt = compileMerchantPolicy(compiledPolicy.policy);
  if (!rebuilt.ok) {
    const errors = Array.isArray(rebuilt.errors) ? rebuilt.errors : [];
    const versionFailure = errors.length > 0
      && errors.every(error => error.code === 'policy_version_mismatch');
    return {
      ok: false,
      code: versionFailure ? 'POLICY_VERSION_MISMATCH' : 'POLICY_INVALID',
    };
  }
  if (rebuilt.policy.status !== 'active') {
    return { ok: false, code: 'POLICY_INVALID' };
  }
  if (compiledPolicy.policyVersion !== rebuilt.policyVersion) {
    return { ok: false, code: 'POLICY_VERSION_MISMATCH' };
  }
  if (!isDeepStrictEqual(compiledPolicy.indexes, rebuilt.indexes)) {
    return { ok: false, code: 'POLICY_INVALID' };
  }
  return {
    ok: true,
    compiledPolicy: rebuilt,
    platformPolicy: PLATFORM_REPLY_POLICY,
  };
}

function validateAutomatedReply({
  customerText = '',
  conversationFocus = {},
  reply = '',
  compiledPolicy,
  platformPolicy,
} = {}) {
  const authenticated = authenticatePolicyContext(compiledPolicy, platformPolicy);
  if (!authenticated.ok) {
    return {
      claims: [],
      evidenceRefs: [],
      ok: false,
      status: 'rejected',
      violations: [{ code: authenticated.code, evidenceRefs: [] }],
    };
  }
  compiledPolicy = authenticated.compiledPolicy;

  const focus = asFocus(conversationFocus);
  const evidence = resolveEvidence(compiledPolicy, focus);
  const claims = [];
  const violations = [];
  const seenViolations = new Set();
  const addViolation = (code, claim, evidenceRefs = []) => {
    const key = `${code}:${claim?.type || ''}:${claim?.value || ''}`;
    if (seenViolations.has(key)) return;
    seenViolations.add(key);
    violations.push({
      code,
      evidenceRefs: uniqueStrings(evidenceRefs),
      ...(claim ? { claim } : {}),
    });
  };

  const products = mentionedProducts(reply, compiledPolicy);
  for (const productId of products) {
    const claim = { type: 'product', value: productId };
    claims.push(claim);
    if (productId !== focus.productId || !evidence.refs.includes(productId)) {
      addViolation('UNSUPPORTED_PRODUCT', claim);
    }
  }

  for (const mentioned of mentionedVariants(reply, compiledPolicy)) {
    const claim = { type: 'variant', value: mentioned.variantId };
    claims.push(claim);
    if (mentioned.productId !== focus.productId || mentioned.variantId !== focus.variantId) {
      addViolation('UNSUPPORTED_PRODUCT', claim);
    }
  }

  const urls = extractUrls(reply);
  for (const url of urls) {
    const claim = { type: 'url', value: url };
    claims.push(claim);
    const allowed = evidence.facts.some(fact =>
      fact.type === 'url' && normalizeUrl(fact.value) === url);
    if (!allowed) addViolation('UNSUPPORTED_URL', claim);
  }

  const phones = extractPhones(reply, urls);
  for (const phone of phones) {
    const claim = { type: 'contact', value: phone };
    claims.push(claim);
    const allowed = evidence.facts.some(fact =>
      fact.type === 'contact' && normalizePhone(fact.value) === phone);
    if (!allowed) addViolation('UNAUTHORIZED_CONTACT', claim);
  }

  const price = priceClaim(reply, evidence.facts);
  const priceNumbers = new Set();
  if (price) {
    const claim = {
      currency: price.currency,
      type: price.type,
      value: price.value,
    };
    claims.push(claim);
    price.values.forEach(value => priceNumbers.add(value));
    if (!price.allowed) addViolation(MATERIAL_CODES.price, claim);
  }

  const detectedMaterialTypes = materialClaimTypes(reply);
  for (const type of detectedMaterialTypes) {
    if (type === 'price') continue;
    const claim = { type, value: normalizeText(reply) };
    claims.push(claim);
    if (!exactFactAllows(type, reply, evidence.facts)) {
      addViolation(MATERIAL_CODES[type], claim);
    }
  }

  const replyTextTopics = textTopics(reply).filter(topic =>
    !['availability', 'duration'].includes(topic) || detectedMaterialTypes.includes(topic));
  if (replyTextTopics.includes('contact') && phones.length === 0) {
    claims.push({ type: 'contact', value: 'contact_advice' });
  }
  if (/(?:^|\s)(?:ميزه|ميزة|feature)(?:\s|$)/iu.test(normalizeText(reply))) {
    const claim = { type: 'product', value: 'unspecified_feature' };
    claims.push(claim);
    const exactFeature = evidence.facts
      .filter(fact => fact.type === 'product_fact')
      .some(fact => factContained(reply, fact));
    if (!exactFeature) addViolation('UNSUPPORTED_PRODUCT', claim);
  }

  const phoneDigits = new Set(phones.map(phone => phone.replace(/\D/gu, '')));
  for (const value of numberValues(reply)) {
    if (priceNumbers.has(value)) continue;
    if (phoneDigits.has(value)) continue;
    if (urls.some(url => numberValues(url).includes(value))) continue;
    if (canonicalNumberAllowed(value, evidence.facts)) continue;
    const claim = { type: 'number', value };
    claims.push(claim);
    addViolation('UNSUPPORTED_NUMBER', claim);
  }

  const prohibited = compiledPolicy.policy.prohibitions;
  for (const value of [
    ...prohibited.words,
    ...prohibited.phrases,
    ...prohibited.claims,
    ...prohibited.destinations,
  ]) {
    if (hasPhrase(reply, value)) {
      addViolation('PROHIBITED_CONTENT', { type: 'prohibited', value });
    }
  }
  if (/\[(?:تحويل|تصعيد|transfer|escalate)[^\]]*\]|<[^>]*(?:system|internal)[^>]*>/iu
    .test(String(reply || ''))) {
    addViolation('INTERNAL_MARKER_LEAK', { type: 'internal_marker', value: 'redacted' });
  }

  const customerTopics = textTopics(customerText);
  const greetingOnly = customerTopics.includes('greeting')
    && customerTopics.every(topic => topic === 'greeting');
  const normalizedCustomer = normalizeText(customerText);
  const allowsCarryover = !greetingOnly && (
    customerTopics.some(topic => topic !== 'greeting')
    || /(?:سعره|سعرها|مدته|مدتها|توفره|توفرها|تقصد|تقصدين|عنه|عنها|it|its)/iu
      .test(normalizedCustomer)
  );
  const customerProducts = mentionedProducts(customerText, compiledPolicy);
  const currentTopics = uniqueStrings([
    ...customerTopics,
    ...(allowsCarryover ? focus.topics : []),
    ...(customerProducts.length > 0 || (allowsCarryover && focus.productId) ? ['product'] : []),
  ]);
  if (currentTopics.includes('contact')) currentTopics.push('number');
  const replyTopics = uniqueStrings([
    ...replyTextTopics,
    ...claims.map(claim => claim.type),
  ].filter(type => [
      'availability',
      'compatibility',
      'contact',
      'delivery',
      'discount',
      'duration',
      'number',
      'price',
      'promise',
      'refund',
      'url',
      'product',
      'variant',
      'warranty',
      'greeting',
    ].includes(type)));
  const comparableReplyTopics = replyTopics.map(topic => topic === 'variant' ? 'product' : topic);
  const offTopic = comparableReplyTopics.some(topic => !currentTopics.includes(topic));
  if (offTopic) {
    addViolation('OFF_TOPIC_CURRENT_TURN', {
      type: 'relevance',
      value: comparableReplyTopics.filter(topic => !currentTopics.includes(topic)).join(','),
    });
  }

  return {
    claims,
    evidenceRefs: evidence.refs,
    ok: violations.length === 0,
    status: violations.length === 0 ? 'approved' : 'rejected',
    violations,
  };
}

module.exports = {
  authenticatePolicyContext,
  normalizeDigits,
  normalizePhone,
  normalizeText,
  normalizeUrl,
  validateAutomatedReply,
};
