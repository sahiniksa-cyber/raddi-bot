'use strict';

const crypto = require('node:crypto');
const {
  ISO_4217_CURRENCY_CODES,
  isIso4217CurrencyCode,
} = require('./iso-4217');

const POLICY_SCHEMA_VERSION = 1;
const POLICY_STATUSES = Object.freeze(['active', 'needs_review', 'invalid']);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const VOLATILE_MIGRATION_KEYS = new Set([
  'createdAt',
  'generatedAt',
  'migratedAt',
  'migrationTimestamp',
  'updatedAt',
]);
const ALLOWED_KEYS = {
  root: new Set([
    'schemaVersion',
    'policyVersion',
    'status',
    'catalog',
    'persona',
    'businessRules',
    'prohibitions',
    'routing',
    'instantReplies',
    'migration',
  ]),
  catalog: new Set(['products']),
  product: new Set([
    'id',
    'name',
    'aliases',
    'description',
    'variants',
    'links',
    'attributes',
  ]),
  variant: new Set([
    'id',
    'name',
    'price',
    'duration',
    'availability',
    'attributes',
  ]),
  price: new Set(['amountMinor', 'currency']),
  persona: new Set([
    'role',
    'displayName',
    'language',
    'dialect',
    'tone',
    'brevity',
    'formatting',
  ]),
  businessRule: new Set(['id', 'topic', 'statement']),
  prohibitions: new Set(['words', 'phrases', 'claims', 'destinations']),
  routing: new Set(['contacts', 'rules', 'pauseAfterHandoff']),
  contact: new Set(['id', 'name', 'phoneNumber']),
  routingRule: new Set(['id', 'topic', 'contactId']),
  instantReply: new Set(['id', 'triggers', 'reply', 'evidenceRefs']),
  migration: new Set([
    'legacyArchived',
    'reviewItems',
    ...VOLATILE_MIGRATION_KEYS,
  ]),
  reviewItem: new Set(['path', 'code']),
};

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeLookupKey(value) {
  return String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US');
}

function defineOwn(target, key, value) {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function childPath(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  return parent ? `${parent}.${key}` : key;
}

function canonicalize(value, path = [], ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_number');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('non_json_value');
  if (ancestors.has(value)) throw new TypeError('cyclic_value');
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError('invalid_prototype');
  }

  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry, index) => canonicalize(entry, [...path, index], ancestors));
  } else {
    result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      if (path.length === 0 && key === 'policyVersion') continue;
      if (path[0] === 'migration' && VOLATILE_MIGRATION_KEYS.has(key)) continue;
      defineOwn(
        result,
        key,
        canonicalize(value[key], [...path, key], ancestors),
      );
    }
  }
  ancestors.delete(value);
  return result;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function derivePolicyVersion(policy) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(policy), 'utf8').digest('hex')}`;
}

function cloneJsonValue(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('non_finite_number');
    return value;
  }
  if (typeof value !== 'object') throw new TypeError('non_json_value');
  if (ancestors.has(value)) throw new TypeError('cyclic_value');
  if (!Array.isArray(value) && !isPlainObject(value)) {
    throw new TypeError('invalid_prototype');
  }

  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => cloneJsonValue(entry, ancestors));
  } else {
    result = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    for (const key of Object.keys(value)) {
      defineOwn(result, key, cloneJsonValue(value[key], ancestors));
    }
  }
  ancestors.delete(value);
  return result;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function scanJsonSafety(value, path, addError, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) addError(path, 'invalid_number');
    return;
  }
  if (typeof value !== 'object') {
    addError(path, 'non_json_value');
    return;
  }
  if (ancestors.has(value)) {
    addError(path, 'cyclic_value');
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) {
    addError(path, 'invalid_prototype');
    return;
  }

  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      scanJsonSafety(entry, childPath(path, index), addError, ancestors);
    });
  } else {
    for (const key of Object.keys(value)) {
      const pathForKey = childPath(path, key);
      if (FORBIDDEN_KEYS.has(key)) addError(pathForKey, 'forbidden_key');
      scanJsonSafety(value[key], pathForKey, addError, ancestors);
    }
  }
  ancestors.delete(value);
}

function rejectUnexpectedKeys(value, allowed, path, addError) {
  if (!isPlainObject(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key) && !FORBIDDEN_KEYS.has(key)) {
      addError(childPath(path, key), 'unexpected_key');
    }
  }
}

function validateMerchantPolicy(input) {
  const errors = [];
  const addError = (path, code) => errors.push({ path, code });
  const requiredSections = [
    'schemaVersion',
    'status',
    'catalog',
    'persona',
    'businessRules',
    'prohibitions',
    'routing',
    'instantReplies',
    'migration',
  ];

  if (!isPlainObject(input)) {
    return {
      ok: false,
      status: 'invalid',
      errors: [{ path: '', code: 'invalid_type' }],
    };
  }

  scanJsonSafety(input, '', addError);
  rejectUnexpectedKeys(input, ALLOWED_KEYS.root, '', addError);

  for (const section of requiredSections) {
    if (!Object.prototype.hasOwnProperty.call(input, section)) addError(section, 'required');
  }

  if (Object.prototype.hasOwnProperty.call(input, 'schemaVersion')
      && input.schemaVersion !== POLICY_SCHEMA_VERSION) {
    addError('schemaVersion', 'unsupported_schema_version');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'status')
      && !POLICY_STATUSES.includes(input.status)) {
    addError('status', 'invalid_enum');
  }

  const registeredIds = new Map();
  const evidenceIds = new Set();
  const contactIds = new Set();
  const productLookupKeys = new Map();

  const registerId = (id, path, { evidence = false, contact = false } = {}) => {
    if (typeof id !== 'string' || id.trim() === '') {
      addError(path, 'invalid_id');
      return;
    }
    if (registeredIds.has(id)) addError(path, 'duplicate_id');
    else registeredIds.set(id, path);
    if (evidence) evidenceIds.add(id);
    if (contact) contactIds.add(id);
  };

  if (isPlainObject(input.catalog)) {
    rejectUnexpectedKeys(input.catalog, ALLOWED_KEYS.catalog, 'catalog', addError);
    if (!Array.isArray(input.catalog.products)) {
      addError('catalog.products', Object.prototype.hasOwnProperty.call(input.catalog, 'products')
        ? 'invalid_type'
        : 'required');
    } else {
      input.catalog.products.forEach((product, productIndex) => {
        const base = `catalog.products[${productIndex}]`;
        if (!isPlainObject(product)) {
          addError(base, 'invalid_type');
          return;
        }
        rejectUnexpectedKeys(product, ALLOWED_KEYS.product, base, addError);
        registerId(product.id, `${base}.id`, { evidence: true });
        if (typeof product.name !== 'string' || product.name.trim() === '') {
          addError(`${base}.name`, product.name === undefined ? 'required' : 'invalid_string');
        }
        if (!Array.isArray(product.aliases)) {
          addError(`${base}.aliases`, product.aliases === undefined ? 'required' : 'invalid_type');
        } else {
          const lookupValues = [product.name, ...product.aliases];
          lookupValues.forEach((alias, aliasIndex) => {
            const aliasPath = aliasIndex === 0
              ? `${base}.name`
              : `${base}.aliases[${aliasIndex - 1}]`;
            if (typeof alias !== 'string' || alias.trim() === '') {
              addError(aliasPath, 'invalid_string');
              return;
            }
            const normalized = normalizeLookupKey(alias);
            const owner = productLookupKeys.get(normalized);
            if (owner !== undefined && owner !== product.id) addError(aliasPath, 'duplicate_alias');
            else productLookupKeys.set(normalized, product.id);
          });
        }
        if (typeof product.description !== 'string') {
          addError(
            `${base}.description`,
            product.description === undefined ? 'required' : 'invalid_string',
          );
        }
        if (!Array.isArray(product.variants)) {
          addError(`${base}.variants`, product.variants === undefined ? 'required' : 'invalid_type');
        } else {
          product.variants.forEach((variant, variantIndex) => {
            const variantBase = `${base}.variants[${variantIndex}]`;
            if (!isPlainObject(variant)) {
              addError(variantBase, 'invalid_type');
              return;
            }
            rejectUnexpectedKeys(variant, ALLOWED_KEYS.variant, variantBase, addError);
            registerId(variant.id, `${variantBase}.id`);
            if (typeof variant.name !== 'string' || variant.name.trim() === '') {
              addError(
                `${variantBase}.name`,
                variant.name === undefined ? 'required' : 'invalid_string',
              );
            }
            if (!isPlainObject(variant.price)) {
              addError(
                `${variantBase}.price`,
                variant.price === undefined ? 'required' : 'invalid_type',
              );
            } else {
              rejectUnexpectedKeys(
                variant.price,
                ALLOWED_KEYS.price,
                `${variantBase}.price`,
                addError,
              );
              if (!Object.prototype.hasOwnProperty.call(variant.price, 'amountMinor')) {
                addError(`${variantBase}.price.amountMinor`, 'required');
              } else if (!Number.isSafeInteger(variant.price.amountMinor)
                         || variant.price.amountMinor < 0) {
                addError(`${variantBase}.price.amountMinor`, 'invalid_integer');
              }
              if (!Object.prototype.hasOwnProperty.call(variant.price, 'currency')) {
                addError(`${variantBase}.price.currency`, 'required');
              } else if (typeof variant.price.currency !== 'string'
                         || !isIso4217CurrencyCode(variant.price.currency)) {
                addError(`${variantBase}.price.currency`, 'invalid_currency');
              }
            }
            for (const nullableField of ['duration', 'availability']) {
              if (!Object.prototype.hasOwnProperty.call(variant, nullableField)) {
                addError(`${variantBase}.${nullableField}`, 'required');
              } else if (variant[nullableField] !== null
                         && typeof variant[nullableField] !== 'string') {
                addError(`${variantBase}.${nullableField}`, 'invalid_type');
              }
            }
            if (!isPlainObject(variant.attributes)) {
              addError(
                `${variantBase}.attributes`,
                variant.attributes === undefined ? 'required' : 'invalid_type',
              );
            }
          });
        }
        if (!Array.isArray(product.links)) {
          addError(`${base}.links`, product.links === undefined ? 'required' : 'invalid_type');
        }
        if (!isPlainObject(product.attributes)) {
          addError(
            `${base}.attributes`,
            product.attributes === undefined ? 'required' : 'invalid_type',
          );
        }
      });
    }
  } else if (Object.prototype.hasOwnProperty.call(input, 'catalog')) {
    addError('catalog', 'invalid_type');
  }

  if (isPlainObject(input.persona)) {
    const persona = input.persona;
    rejectUnexpectedKeys(persona, ALLOWED_KEYS.persona, 'persona', addError);
    if (persona.role !== 'customer_service_agent') addError('persona.role', 'invalid_enum');
    if (persona.displayName !== null && typeof persona.displayName !== 'string') {
      addError('persona.displayName', persona.displayName === undefined ? 'required' : 'invalid_type');
    }
    if (typeof persona.language !== 'string' || persona.language.trim() === '') {
      addError('persona.language', persona.language === undefined ? 'required' : 'invalid_string');
    }
    if (!['saudi', 'neutral'].includes(persona.dialect)) {
      addError('persona.dialect', persona.dialect === undefined ? 'required' : 'invalid_enum');
    }
    if (typeof persona.tone !== 'string' || persona.tone.trim() === '') {
      addError('persona.tone', persona.tone === undefined ? 'required' : 'invalid_string');
    }
    if (!['concise', 'normal'].includes(persona.brevity)) {
      addError('persona.brevity', persona.brevity === undefined ? 'required' : 'invalid_enum');
    }
    if (!isPlainObject(persona.formatting)) {
      addError('persona.formatting', persona.formatting === undefined ? 'required' : 'invalid_type');
    }
  } else if (Object.prototype.hasOwnProperty.call(input, 'persona')) {
    addError('persona', 'invalid_type');
  }

  if (!Array.isArray(input.businessRules)) {
    if (Object.prototype.hasOwnProperty.call(input, 'businessRules')) {
      addError('businessRules', 'invalid_type');
    }
  } else {
    input.businessRules.forEach((rule, index) => {
      const base = `businessRules[${index}]`;
      if (!isPlainObject(rule)) {
        addError(base, 'invalid_type');
        return;
      }
      rejectUnexpectedKeys(rule, ALLOWED_KEYS.businessRule, base, addError);
      registerId(rule.id, `${base}.id`, { evidence: true });
      for (const field of ['topic', 'statement']) {
        if (typeof rule[field] !== 'string' || rule[field].trim() === '') {
          addError(`${base}.${field}`, rule[field] === undefined ? 'required' : 'invalid_string');
        }
      }
    });
  }

  if (isPlainObject(input.prohibitions)) {
    rejectUnexpectedKeys(
      input.prohibitions,
      ALLOWED_KEYS.prohibitions,
      'prohibitions',
      addError,
    );
    for (const field of ['words', 'phrases', 'claims', 'destinations']) {
      if (!Array.isArray(input.prohibitions[field])) {
        addError(
          `prohibitions.${field}`,
          input.prohibitions[field] === undefined ? 'required' : 'invalid_type',
        );
      } else {
        input.prohibitions[field].forEach((entry, index) => {
          if (typeof entry !== 'string' || entry.trim() === '') {
            addError(`prohibitions.${field}[${index}]`, 'invalid_string');
          }
        });
      }
    }
  } else if (Object.prototype.hasOwnProperty.call(input, 'prohibitions')) {
    addError('prohibitions', 'invalid_type');
  }

  if (isPlainObject(input.routing)) {
    rejectUnexpectedKeys(input.routing, ALLOWED_KEYS.routing, 'routing', addError);
    if (!Array.isArray(input.routing.contacts)) {
      addError(
        'routing.contacts',
        input.routing.contacts === undefined ? 'required' : 'invalid_type',
      );
    } else {
      input.routing.contacts.forEach((contact, index) => {
        const base = `routing.contacts[${index}]`;
        if (!isPlainObject(contact)) {
          addError(base, 'invalid_type');
          return;
        }
        rejectUnexpectedKeys(contact, ALLOWED_KEYS.contact, base, addError);
        registerId(contact.id, `${base}.id`, { evidence: true, contact: true });
        if (typeof contact.name !== 'string' || contact.name.trim() === '') {
          addError(`${base}.name`, contact.name === undefined ? 'required' : 'invalid_string');
        }
        if (typeof contact.phoneNumber !== 'string'
            || !/^\+[1-9]\d{7,14}$/.test(contact.phoneNumber)) {
          addError(
            `${base}.phoneNumber`,
            contact.phoneNumber === undefined ? 'required' : 'invalid_phone_number',
          );
        }
      });
    }
    if (!Array.isArray(input.routing.rules)) {
      addError('routing.rules', input.routing.rules === undefined ? 'required' : 'invalid_type');
    } else {
      input.routing.rules.forEach((rule, index) => {
        const base = `routing.rules[${index}]`;
        if (!isPlainObject(rule)) {
          addError(base, 'invalid_type');
          return;
        }
        rejectUnexpectedKeys(rule, ALLOWED_KEYS.routingRule, base, addError);
        registerId(rule.id, `${base}.id`);
        if (typeof rule.topic !== 'string' || rule.topic.trim() === '') {
          addError(`${base}.topic`, rule.topic === undefined ? 'required' : 'invalid_string');
        }
        if (typeof rule.contactId !== 'string' || rule.contactId.trim() === '') {
          addError(
            `${base}.contactId`,
            rule.contactId === undefined ? 'required' : 'invalid_id',
          );
        }
      });
    }
    if (typeof input.routing.pauseAfterHandoff !== 'boolean') {
      addError(
        'routing.pauseAfterHandoff',
        input.routing.pauseAfterHandoff === undefined ? 'required' : 'invalid_type',
      );
    }
  } else if (Object.prototype.hasOwnProperty.call(input, 'routing')) {
    addError('routing', 'invalid_type');
  }

  if (!Array.isArray(input.instantReplies)) {
    if (Object.prototype.hasOwnProperty.call(input, 'instantReplies')) {
      addError('instantReplies', 'invalid_type');
    }
  } else {
    input.instantReplies.forEach((reply, index) => {
      const base = `instantReplies[${index}]`;
      if (!isPlainObject(reply)) {
        addError(base, 'invalid_type');
        return;
      }
      rejectUnexpectedKeys(reply, ALLOWED_KEYS.instantReply, base, addError);
      registerId(reply.id, `${base}.id`);
      if (!Array.isArray(reply.triggers) || reply.triggers.length === 0) {
        addError(
          `${base}.triggers`,
          reply.triggers === undefined ? 'required' : 'invalid_array',
        );
      } else {
        reply.triggers.forEach((trigger, triggerIndex) => {
          if (typeof trigger !== 'string' || trigger.trim() === '') {
            addError(`${base}.triggers[${triggerIndex}]`, 'invalid_string');
          }
        });
      }
      if (typeof reply.reply !== 'string' || reply.reply.trim() === '') {
        addError(`${base}.reply`, reply.reply === undefined ? 'required' : 'invalid_string');
      }
      if (!Array.isArray(reply.evidenceRefs)) {
        addError(
          `${base}.evidenceRefs`,
          reply.evidenceRefs === undefined ? 'required' : 'invalid_type',
        );
      }
    });
  }

  if (isPlainObject(input.migration)) {
    rejectUnexpectedKeys(
      input.migration,
      ALLOWED_KEYS.migration,
      'migration',
      addError,
    );
    if (!isPlainObject(input.migration.legacyArchived)) {
      addError(
        'migration.legacyArchived',
        input.migration.legacyArchived === undefined ? 'required' : 'invalid_type',
      );
    }
    if (!Array.isArray(input.migration.reviewItems)) {
      addError(
        'migration.reviewItems',
        input.migration.reviewItems === undefined ? 'required' : 'invalid_type',
      );
    } else {
      input.migration.reviewItems.forEach((item, index) => {
        const base = `migration.reviewItems[${index}]`;
        if (!isPlainObject(item)) {
          addError(base, 'invalid_type');
          return;
        }
        rejectUnexpectedKeys(item, ALLOWED_KEYS.reviewItem, base, addError);
        for (const field of ['path', 'code']) {
          if (typeof item[field] !== 'string' || item[field].trim() === '') {
            addError(
              `${base}.${field}`,
              item[field] === undefined ? 'required' : 'invalid_string',
            );
          }
        }
      });
    }
  } else if (Object.prototype.hasOwnProperty.call(input, 'migration')) {
    addError('migration', 'invalid_type');
  }

  if (Array.isArray(input.routing?.rules)) {
    input.routing.rules.forEach((rule, index) => {
      if (isPlainObject(rule)
          && typeof rule.contactId === 'string'
          && rule.contactId.trim() !== ''
          && !contactIds.has(rule.contactId)) {
        addError(`routing.rules[${index}].contactId`, 'unknown_contact_ref');
      }
    });
  }

  if (Array.isArray(input.instantReplies)) {
    input.instantReplies.forEach((reply, replyIndex) => {
      if (!isPlainObject(reply) || !Array.isArray(reply.evidenceRefs)) return;
      reply.evidenceRefs.forEach((reference, referenceIndex) => {
        const path = `instantReplies[${replyIndex}].evidenceRefs[${referenceIndex}]`;
        if (typeof reference !== 'string' || reference.trim() === '') {
          addError(path, 'invalid_id');
        } else if (!evidenceIds.has(reference)) {
          addError(path, 'unknown_evidence_ref');
        }
      });
    });
  }

  let policyVersion;
  try {
    policyVersion = derivePolicyVersion(input);
  } catch {
    addError('', 'not_canonicalizable');
  }
  if (typeof policyVersion === 'string'
      && Object.prototype.hasOwnProperty.call(input, 'policyVersion')
      && input.policyVersion !== policyVersion) {
    addError('policyVersion', 'policy_version_mismatch');
  }

  if (errors.length > 0) return { ok: false, status: 'invalid', errors };

  let policy;
  try {
    policy = cloneJsonValue(input);
  } catch {
    return {
      ok: false,
      status: 'invalid',
      errors: [{ path: '', code: 'not_canonicalizable' }],
    };
  }
  policy.policyVersion = policyVersion;
  deepFreeze(policy);
  return { ok: true, policy, policyVersion };
}

module.exports = {
  POLICY_SCHEMA_VERSION,
  POLICY_STATUSES,
  ISO_4217_CURRENCY_CODES,
  canonicalJson,
  deepFreeze,
  derivePolicyVersion,
  isPlainObject,
  normalizeLookupKey,
  validateMerchantPolicy,
};
