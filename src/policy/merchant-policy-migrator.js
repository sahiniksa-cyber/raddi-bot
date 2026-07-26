'use strict';

const crypto = require('node:crypto');

const {
  derivePolicyVersion,
  isPlainObject,
  normalizeLookupKey,
  validateMerchantPolicy,
} = require('./merchant-policy-schema');

const ARCHIVED_FIELDS = [
  'products',
  'replyStyle',
  'responseLanguage',
  'avoidWords',
  'avoidPhrases',
  'businessRules',
  'routing',
  'escalationContacts',
  'escalationConditions',
  'escalationPausesBot',
  'autoReplyKeywords',
  'botInstructions',
];

function cloneValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Legacy config must contain JSON values');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('Legacy config must contain JSON values');
  if (ancestors.has(value)) throw new TypeError('Legacy config cannot contain cycles');

  ancestors.add(value);
  const copy = Array.isArray(value) ? [] : {};
  for (const key of Object.keys(value)) copy[key] = cloneValue(value[key], ancestors);
  ancestors.delete(value);
  return copy;
}

function legacyHash(config) {
  return `sha256:${crypto
    .createHash('sha256')
    .update(JSON.stringify(config), 'utf8')
    .digest('hex')}`;
}

function stableId(kind, ...parts) {
  const material = parts.map((part) => normalizeLookupKey(part)).join('\u0000');
  const digest = crypto.createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
  return `${kind}-${digest}`;
}

function addReview(reviewItems, path, code) {
  reviewItems.push({ path, code });
}

function archiveLegacyFields(config) {
  const archived = {};
  for (const field of ARCHIVED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(config, field)) {
      archived[field] = cloneValue(config[field]);
    }
  }
  return archived;
}

function currencyCode(raw, fallback = 'SAR') {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const normalized = String(raw).normalize('NFKC').trim();
  if (/^[A-Za-z]{3}$/.test(normalized)) return normalized.toUpperCase();
  if (/^(?:ر\.?\s?س\.?|ريال|ريال سعودي)$/.test(normalized)) return 'SAR';
  return null;
}

function parseStructuredPrice(rawPrice, fallbackCurrency) {
  if (isPlainObject(rawPrice)) {
    if (!Number.isInteger(rawPrice.amountMinor) || rawPrice.amountMinor < 0) return null;
    const currency = currencyCode(rawPrice.currency, null);
    if (!currency) return null;
    return { amountMinor: rawPrice.amountMinor, currency };
  }

  if (typeof rawPrice === 'number') {
    if (!Number.isFinite(rawPrice) || rawPrice < 0) return null;
    const currency = currencyCode(fallbackCurrency);
    if (!currency) return null;
    const amountMinor = Math.round(rawPrice * 100);
    if (!Number.isSafeInteger(amountMinor)) return null;
    return { amountMinor, currency };
  }

  if (typeof rawPrice !== 'string') return null;
  const match = rawPrice
    .normalize('NFKC')
    .trim()
    .match(/^(\d+)(?:[.,](\d{1,2}))?(?:\s*([A-Za-z]{3}|ر\.?\s?س\.?|ريال|ريال سعودي))?$/);
  if (!match) return null;
  const currency = currencyCode(match[3], currencyCode(fallbackCurrency));
  if (!currency) return null;
  const fraction = (match[2] || '').padEnd(2, '0');
  const amountMinor = (Number(match[1]) * 100) + Number(fraction || 0);
  if (!Number.isSafeInteger(amountMinor)) return null;
  return { amountMinor, currency };
}

function rawProductPriceSignature(product) {
  if (!isPlainObject(product)) return 'invalid';
  const prices = [];
  if (Object.prototype.hasOwnProperty.call(product, 'price')) {
    const price = parseStructuredPrice(product.price, product.currency);
    prices.push(price ? `${price.amountMinor}:${price.currency}` : 'invalid');
  }
  if (Array.isArray(product.variants)) {
    for (const variant of product.variants) {
      const price = isPlainObject(variant)
        ? parseStructuredPrice(variant.price, variant.currency || product.currency)
        : null;
      prices.push(price ? `${price.amountMinor}:${price.currency}` : 'invalid');
    }
  }
  return prices.join('|');
}

function mapProduct(rawProduct, index, reviewItems) {
  const path = `products[${index}]`;
  if (!isPlainObject(rawProduct)
      || typeof rawProduct.name !== 'string'
      || rawProduct.name.trim() === '') {
    addReview(reviewItems, path, 'ambiguous_product');
    return null;
  }

  const name = rawProduct.name;
  const productId = typeof rawProduct.id === 'string' && rawProduct.id.trim() !== ''
    ? rawProduct.id
    : stableId('product', name);
  const aliases = Array.isArray(rawProduct.aliases)
    ? rawProduct.aliases.filter((alias) => typeof alias === 'string' && alias.trim() !== '')
    : [];
  if (rawProduct.aliases !== undefined && !Array.isArray(rawProduct.aliases)) {
    addReview(reviewItems, `${path}.aliases`, 'ambiguous_product_aliases');
    return null;
  }

  const variants = [];
  if (Array.isArray(rawProduct.variants) && rawProduct.variants.length > 0) {
    if (Object.prototype.hasOwnProperty.call(rawProduct, 'price')) {
      const topLevel = parseStructuredPrice(rawProduct.price, rawProduct.currency);
      const soleVariant = rawProduct.variants.length === 1 && isPlainObject(rawProduct.variants[0])
        ? parseStructuredPrice(
          rawProduct.variants[0].price,
          rawProduct.variants[0].currency || rawProduct.currency,
        )
        : null;
      if (!topLevel || !soleVariant
          || topLevel.amountMinor !== soleVariant.amountMinor
          || topLevel.currency !== soleVariant.currency) {
        addReview(reviewItems, `${path}.price`, 'conflicting_product_prices');
        return null;
      }
    }

    for (let variantIndex = 0; variantIndex < rawProduct.variants.length; variantIndex += 1) {
      const rawVariant = rawProduct.variants[variantIndex];
      const variantPath = `${path}.variants[${variantIndex}]`;
      if (!isPlainObject(rawVariant)) {
        addReview(reviewItems, variantPath, 'ambiguous_product_variant');
        return null;
      }
      const variantName = typeof rawVariant.name === 'string' && rawVariant.name.trim() !== ''
        ? rawVariant.name
        : rawVariant.label;
      const price = parseStructuredPrice(
        rawVariant.price,
        rawVariant.currency || rawProduct.currency,
      );
      if (typeof variantName !== 'string' || variantName.trim() === '' || !price) {
        addReview(reviewItems, variantPath, 'ambiguous_product_variant');
        return null;
      }
      variants.push({
        id: typeof rawVariant.id === 'string' && rawVariant.id.trim() !== ''
          ? rawVariant.id
          : stableId('variant', productId, variantName),
        name: variantName,
        price,
        duration: rawVariant.duration === null || typeof rawVariant.duration === 'string'
          ? rawVariant.duration
          : null,
        availability: rawVariant.availability === null
          || typeof rawVariant.availability === 'string'
          ? rawVariant.availability
          : null,
        attributes: isPlainObject(rawVariant.attributes)
          ? cloneValue(rawVariant.attributes)
          : {},
      });
    }
  } else if (Object.prototype.hasOwnProperty.call(rawProduct, 'price')) {
    const price = parseStructuredPrice(rawProduct.price, rawProduct.currency);
    if (!price) {
      addReview(reviewItems, `${path}.price`, 'ambiguous_product_price');
      return null;
    }
    variants.push({
      id: stableId('variant', productId, 'default'),
      name: 'default',
      price,
      duration: null,
      availability: null,
      attributes: {},
    });
  } else if (rawProduct.variants !== undefined && !Array.isArray(rawProduct.variants)) {
    addReview(reviewItems, `${path}.variants`, 'ambiguous_product_variants');
    return null;
  }

  return {
    id: productId,
    name,
    aliases,
    description: typeof rawProduct.description === 'string' ? rawProduct.description : '',
    variants,
    links: Array.isArray(rawProduct.links) ? cloneValue(rawProduct.links) : [],
    attributes: isPlainObject(rawProduct.attributes) ? cloneValue(rawProduct.attributes) : {},
  };
}

function mapProducts(config, reviewItems, mapped) {
  if (!Object.prototype.hasOwnProperty.call(config, 'products')) return [];
  if (!Array.isArray(config.products)) {
    addReview(reviewItems, 'products', 'ambiguous_products');
    return [];
  }
  mapped.push('products->merchantPolicy.catalog.products');

  const conflicts = new Set();
  const byName = new Map();
  config.products.forEach((product, index) => {
    if (!isPlainObject(product) || typeof product.name !== 'string') return;
    const key = normalizeLookupKey(product.name);
    const previous = byName.get(key);
    const signature = rawProductPriceSignature(product);
    if (previous && previous.signature !== signature) {
      conflicts.add(key);
      addReview(reviewItems, `products[${index}]`, 'conflicting_product_prices');
      if (!previous.reported) {
        addReview(reviewItems, `products[${previous.index}]`, 'conflicting_product_prices');
        previous.reported = true;
      }
    } else if (!previous) {
      byName.set(key, { signature, index, reported: false });
    }
  });

  const seen = new Set();
  const products = [];
  config.products.forEach((product, index) => {
    const key = isPlainObject(product) && typeof product.name === 'string'
      ? normalizeLookupKey(product.name)
      : `invalid:${index}`;
    if (conflicts.has(key) || seen.has(key)) return;
    const mappedProduct = mapProduct(product, index, reviewItems);
    if (mappedProduct) {
      products.push(mappedProduct);
      seen.add(key);
    }
  });
  return products;
}

function mapPersona(config, reviewItems, mapped) {
  const persona = {
    role: 'customer_service_agent',
    displayName: null,
    language: 'ar',
    dialect: 'neutral',
    tone: 'ودود ومحترم',
    brevity: 'normal',
    formatting: {},
  };

  if (Object.prototype.hasOwnProperty.call(config, 'responseLanguage')) {
    mapped.push('responseLanguage->merchantPolicy.persona.language');
    const language = typeof config.responseLanguage === 'string'
      ? normalizeLookupKey(config.responseLanguage)
      : '';
    const languageMap = new Map([
      ['ar', 'ar'],
      ['arabic', 'ar'],
      ['العربية', 'ar'],
      ['en', 'en'],
      ['english', 'en'],
      ['الإنجليزية', 'en'],
    ]);
    if (languageMap.has(language)) persona.language = languageMap.get(language);
    else addReview(reviewItems, 'responseLanguage', 'ambiguous_response_language');
  }

  if (typeof config.employeeName === 'string' && config.employeeName.trim() !== '') {
    persona.displayName = config.employeeName;
  }

  if (Object.prototype.hasOwnProperty.call(config, 'replyStyle')) {
    mapped.push('replyStyle->merchantPolicy.persona');
    if (typeof config.replyStyle === 'string' && config.replyStyle.trim() !== '') {
      persona.tone = config.replyStyle;
    } else if (isPlainObject(config.replyStyle)) {
      const style = config.replyStyle;
      if (typeof style.tone === 'string' && style.tone.trim() !== '') persona.tone = style.tone;
      if (style.useShortReplies === true) persona.brevity = 'concise';
      if (style.useShortReplies === false) persona.brevity = 'normal';

      if (style.useDialect === false) {
        persona.dialect = 'neutral';
      } else if (style.dialect !== undefined) {
        const dialect = normalizeLookupKey(style.dialect);
        const saudi = new Set(['saudi', 'السعودية', 'السعودي', 'اللهجة السعودية']);
        const neutral = new Set(['neutral', 'محايد', 'المحايدة']);
        if (saudi.has(dialect)) persona.dialect = 'saudi';
        else if (neutral.has(dialect)) persona.dialect = 'neutral';
        else addReview(reviewItems, 'replyStyle.dialect', 'ambiguous_dialect');
      } else if (style.useDialect === true) {
        addReview(reviewItems, 'replyStyle.dialect', 'ambiguous_dialect');
      }

      if (typeof style.multilineFormat === 'boolean') {
        persona.formatting.multiline = style.multilineFormat;
      }
      if (typeof style.emojiLevel === 'string' && style.emojiLevel.trim() !== '') {
        persona.formatting.emoji = style.emojiLevel;
      }
    } else {
      addReview(reviewItems, 'replyStyle', 'ambiguous_reply_style');
    }
  }

  return persona;
}

function mapBusinessRules(config, reviewItems, mapped) {
  if (!Object.prototype.hasOwnProperty.call(config, 'businessRules')) return [];
  if (!Array.isArray(config.businessRules)) {
    addReview(reviewItems, 'businessRules', 'ambiguous_business_rules');
    return [];
  }
  mapped.push('businessRules->merchantPolicy.businessRules');
  const rules = [];
  config.businessRules.forEach((rule, index) => {
    const path = `businessRules[${index}]`;
    if (!isPlainObject(rule)
        || typeof rule.topic !== 'string'
        || rule.topic.trim() === ''
        || typeof rule.statement !== 'string'
        || rule.statement.trim() === '') {
      addReview(reviewItems, path, 'ambiguous_business_rule');
      return;
    }
    rules.push({
      id: typeof rule.id === 'string' && rule.id.trim() !== ''
        ? rule.id
        : stableId('rule', rule.topic, rule.statement),
      topic: rule.topic,
      statement: rule.statement,
    });
  });
  return rules;
}

function uniqueStrings(raw, path, reviewItems) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    addReview(reviewItems, path, 'ambiguous_prohibitions');
    return [];
  }
  const seen = new Set();
  const values = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      addReview(reviewItems, `${path}[${index}]`, 'ambiguous_prohibition');
      return;
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      values.push(entry);
    }
  });
  return values;
}

function mapProhibitions(config, reviewItems, mapped) {
  const words = uniqueStrings(config.avoidWords, 'avoidWords', reviewItems);
  const phrases = uniqueStrings(config.avoidPhrases, 'avoidPhrases', reviewItems);
  if (Object.prototype.hasOwnProperty.call(config, 'avoidWords')) {
    mapped.push('avoidWords->merchantPolicy.prohibitions.words');
  }
  if (Object.prototype.hasOwnProperty.call(config, 'avoidPhrases')) {
    mapped.push('avoidPhrases->merchantPolicy.prohibitions.phrases');
  }
  if (isPlainObject(config.replyStyle) && config.replyStyle.avoidPhrases !== undefined) {
    const stylePhrases = uniqueStrings(
      config.replyStyle.avoidPhrases,
      'replyStyle.avoidPhrases',
      reviewItems,
    );
    for (const phrase of stylePhrases) {
      if (!phrases.includes(phrase)) phrases.push(phrase);
    }
  }
  return { words, phrases, claims: [], destinations: [] };
}

function normalizePhoneNumber(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).normalize('NFKC').trim();
  if (!/^(?:\+|00)?[\d\s()-]+$/.test(text)) return null;
  let compact = text.replace(/[\s()-]/g, '');
  if (compact.startsWith('00')) compact = `+${compact.slice(2)}`;
  if (/^05\d{8}$/.test(compact)) compact = `+966${compact.slice(1)}`;
  else if (/^9665\d{8}$/.test(compact)) compact = `+${compact}`;
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return null;
  return compact;
}

function mapContact(rawContact, path, reviewItems) {
  const contact = isPlainObject(rawContact)
    ? rawContact
    : { name: 'التصعيد', number: rawContact };
  const rawNumber = contact.phoneNumber ?? contact.number ?? contact.phone;
  const phoneNumber = normalizePhoneNumber(rawNumber);
  if (!phoneNumber) {
    addReview(reviewItems, `${path}.number`, 'ambiguous_contact_number');
    return null;
  }
  const name = typeof contact.name === 'string' && contact.name.trim() !== ''
    ? contact.name
    : 'التصعيد';
  return {
    id: typeof contact.id === 'string' && contact.id.trim() !== ''
      ? contact.id
      : stableId('contact', name, phoneNumber),
    name,
    phoneNumber,
  };
}

function mapRouting(config, reviewItems, mapped) {
  const contacts = [];
  const rules = [];
  const contactIds = new Set();
  const rawToCanonicalId = new Map();
  let pauseAfterHandoff = false;

  const addContacts = (rawContacts, path) => {
    if (!Array.isArray(rawContacts)) {
      addReview(reviewItems, path, 'ambiguous_contacts');
      return;
    }
    rawContacts.forEach((rawContact, index) => {
      const contact = mapContact(rawContact, `${path}[${index}]`, reviewItems);
      if (!contact || contactIds.has(contact.id)) return;
      contacts.push(contact);
      contactIds.add(contact.id);
      if (isPlainObject(rawContact)
          && typeof rawContact.id === 'string'
          && rawContact.id.trim() !== '') {
        rawToCanonicalId.set(rawContact.id, contact.id);
      }
    });
  };

  if (Object.prototype.hasOwnProperty.call(config, 'routing')) {
    mapped.push('routing->merchantPolicy.routing');
    if (!isPlainObject(config.routing)) {
      addReview(reviewItems, 'routing', 'ambiguous_routing');
    } else {
      if (config.routing.contacts !== undefined) addContacts(config.routing.contacts, 'routing.contacts');
      if (typeof config.routing.pauseAfterHandoff === 'boolean') {
        pauseAfterHandoff = config.routing.pauseAfterHandoff;
      } else if (config.routing.pauseAfterHandoff !== undefined) {
        addReview(
          reviewItems,
          'routing.pauseAfterHandoff',
          'ambiguous_pause_after_handoff',
        );
      }
      if (config.routing.rules !== undefined) {
        if (!Array.isArray(config.routing.rules)) {
          addReview(reviewItems, 'routing.rules', 'ambiguous_routing_rules');
        } else {
          config.routing.rules.forEach((rawRule, index) => {
            const path = `routing.rules[${index}]`;
            if (!isPlainObject(rawRule)
                || typeof rawRule.topic !== 'string'
                || rawRule.topic.trim() === ''
                || typeof rawRule.contactId !== 'string'
                || rawRule.contactId.trim() === '') {
              addReview(reviewItems, path, 'ambiguous_routing_rule');
              return;
            }
            const contactId = rawToCanonicalId.get(rawRule.contactId) || rawRule.contactId;
            if (!contactIds.has(contactId)) {
              addReview(reviewItems, `${path}.contactId`, 'unknown_contact_ref');
              return;
            }
            rules.push({
              id: typeof rawRule.id === 'string' && rawRule.id.trim() !== ''
                ? rawRule.id
                : stableId('route', rawRule.topic, contactId),
              topic: rawRule.topic,
              contactId,
            });
          });
        }
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(config, 'escalationContacts')) {
    mapped.push('escalationContacts->merchantPolicy.routing.contacts');
    addContacts(config.escalationContacts, 'escalationContacts');
  }
  if (Object.prototype.hasOwnProperty.call(config, 'escalationPausesBot')) {
    mapped.push('escalationPausesBot->merchantPolicy.routing.pauseAfterHandoff');
    if (typeof config.escalationPausesBot === 'boolean') {
      if (isPlainObject(config.routing)
          && typeof config.routing.pauseAfterHandoff === 'boolean'
          && config.routing.pauseAfterHandoff !== config.escalationPausesBot) {
        addReview(reviewItems, 'escalationPausesBot', 'conflicting_pause_after_handoff');
      } else {
        pauseAfterHandoff = config.escalationPausesBot;
      }
    } else {
      addReview(reviewItems, 'escalationPausesBot', 'ambiguous_pause_after_handoff');
    }
  }
  if (typeof config.escalationConditions === 'string'
      && config.escalationConditions.trim() !== '') {
    addReview(reviewItems, 'escalationConditions', 'untyped_routing_condition');
  } else if (config.escalationConditions !== undefined
             && config.escalationConditions !== '') {
    addReview(reviewItems, 'escalationConditions', 'ambiguous_routing_condition');
  }

  return { contacts, rules, pauseAfterHandoff };
}

function deterministicEvidenceRefs(trigger, reply, products, rules, contacts) {
  const refs = [];
  const triggerKey = normalizeLookupKey(trigger);
  const replyKey = normalizeLookupKey(reply);
  for (const product of products) {
    const keys = [product.name, ...product.aliases].map(normalizeLookupKey);
    if (keys.includes(triggerKey) || normalizeLookupKey(product.name) === replyKey) {
      refs.push(product.id);
    }
  }
  for (const rule of rules) {
    if (rule.statement === reply) refs.push(rule.id);
  }
  for (const contact of contacts) {
    if (contact.phoneNumber === reply || contact.name === reply) refs.push(contact.id);
  }
  return [...new Set(refs)];
}

function mapInstantReplies(config, products, rules, contacts, reviewItems, mapped) {
  if (!Object.prototype.hasOwnProperty.call(config, 'autoReplyKeywords')) return [];
  if (!isPlainObject(config.autoReplyKeywords)) {
    addReview(reviewItems, 'autoReplyKeywords', 'ambiguous_instant_replies');
    return [];
  }
  mapped.push('autoReplyKeywords->merchantPolicy.instantReplies');
  const replies = [];
  Object.entries(config.autoReplyKeywords).forEach(([trigger, reply]) => {
    const path = `autoReplyKeywords[${JSON.stringify(trigger)}]`;
    if (trigger.trim() === '' || typeof reply !== 'string' || reply.trim() === '') {
      addReview(reviewItems, path, 'ambiguous_instant_reply');
      return;
    }
    replies.push({
      id: stableId('reply', trigger, reply),
      triggers: [trigger],
      reply,
      evidenceRefs: deterministicEvidenceRefs(trigger, reply, products, rules, contacts),
    });
  });
  return replies;
}

function invalidMigrationResult(config, rollbackConfig, hash, errors) {
  const reviewItems = errors.map((error) => ({
    path: error.path,
    code: `schema_${error.code}`,
  }));
  return {
    migratedConfig: cloneValue(config),
    report: {
      status: 'invalid',
      mapped: [],
      reviewItems,
      legacyHash: hash,
    },
    rollbackConfig,
  };
}

function migrateLegacyConfig(config) {
  if (!isPlainObject(config)) throw new TypeError('Legacy config must be a plain object');

  const input = cloneValue(config);
  if (Object.prototype.hasOwnProperty.call(input, 'merchantPolicy')) {
    const rollbackConfig = cloneValue(input);
    delete rollbackConfig.merchantPolicy;
    const hash = legacyHash(rollbackConfig);
    const validation = validateMerchantPolicy(input.merchantPolicy);
    if (!validation.ok) {
      return invalidMigrationResult(input, rollbackConfig, hash, validation.errors);
    }
    const replay = migrateLegacyConfig(rollbackConfig);
    return {
      migratedConfig: input,
      report: replay.report,
      rollbackConfig,
    };
  }

  const rollbackConfig = cloneValue(input);
  const hash = legacyHash(rollbackConfig);
  const mapped = [];
  const reviewItems = [];
  const legacyArchived = archiveLegacyFields(input);
  const products = mapProducts(input, reviewItems, mapped);
  const persona = mapPersona(input, reviewItems, mapped);
  const businessRules = mapBusinessRules(input, reviewItems, mapped);
  const prohibitions = mapProhibitions(input, reviewItems, mapped);
  const routing = mapRouting(input, reviewItems, mapped);
  const instantReplies = mapInstantReplies(
    input,
    products,
    businessRules,
    routing.contacts,
    reviewItems,
    mapped,
  );

  if (Object.prototype.hasOwnProperty.call(input, 'botInstructions')) {
    if (typeof input.botInstructions === 'string' && input.botInstructions.trim() !== '') {
      addReview(reviewItems, 'botInstructions', 'untyped_bot_instructions');
    } else if (typeof input.botInstructions !== 'string') {
      addReview(reviewItems, 'botInstructions', 'ambiguous_bot_instructions');
    }
  }

  const rawPolicy = {
    schemaVersion: 1,
    status: reviewItems.length === 0 ? 'active' : 'needs_review',
    catalog: { products },
    persona,
    businessRules,
    prohibitions,
    routing,
    instantReplies,
    migration: {
      legacyArchived,
      reviewItems,
    },
  };
  const validation = validateMerchantPolicy(rawPolicy);
  const migratedConfig = cloneValue(input);

  if (!validation.ok) {
    rawPolicy.status = 'invalid';
    rawPolicy.policyVersion = derivePolicyVersion(rawPolicy);
    migratedConfig.merchantPolicy = rawPolicy;
    return {
      migratedConfig,
      report: {
        status: 'invalid',
        mapped,
        reviewItems: [
          ...cloneValue(reviewItems),
          ...validation.errors.map((error) => ({
            path: error.path,
            code: `schema_${error.code}`,
          })),
        ],
        legacyHash: hash,
      },
      rollbackConfig,
    };
  }

  migratedConfig.merchantPolicy = validation.policy;
  return {
    migratedConfig,
    report: {
      status: validation.policy.status,
      mapped,
      reviewItems: cloneValue(reviewItems),
      legacyHash: hash,
    },
    rollbackConfig,
  };
}

module.exports = {
  migrateLegacyConfig,
};
