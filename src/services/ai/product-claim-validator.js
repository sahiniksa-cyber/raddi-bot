'use strict';

const { normalizeProductText } = require('../products/product-knowledge');
const {
  parseDuration,
  parsePrice,
} = require('../products/product-facts');

const DURATION_FRAGMENT = '(?:\\d+(?:[.,]\\d+)?|واحد(?:ه)?|اثن(?:ين|ان)|ثلاث(?:ه)?|اربع(?:ه)?|خمس(?:ه)?|ست(?:ه)?|سبع(?:ه)?|ثمان(?:يه)?|تسع(?:ه)?|عشر(?:ه)?|احد\\s+عشر|اثن(?:ا|ي)\\s+عشر|شهرين)';
const DURATION_UNIT = '(?:اشهر|شهور|شهر|سنه|سنوات|عام)';
const DURATION_RE = new RegExp(`(?:ال)?${DURATION_FRAGMENT}\\s*${DURATION_UNIT}|(?:ال)?(?:سنه|عام)`, 'giu');
const DURATION_PRICE_RE = new RegExp(
  `((?:ال)?${DURATION_FRAGMENT}\\s*${DURATION_UNIT}|(?:ال)?(?:سنه|عام))\\D{0,24}?(\\d+(?:[.,]\\d+)?)\\s*(ريال|ر\\.?\\s?س|sar|درهم|aed|دولار|usd|\\$|﷼)?`,
  'giu',
);
const PRODUCT_AVAILABILITY_RE = /(?:متوفر|متاح|موجود|غير\s+متوفر|غير\s+متاح|لا\s+يوجد|ما\s+فيه)/u;
const POSITIVE_AVAILABILITY_RE = /(?:متوفر|متاح|موجود)/u;
const NEGATIVE_AVAILABILITY_RE = /(?:غير\s+متوفر|غير\s+متاح|لا\s+يوجد|ما\s+فيه)/u;

function durationMonths(duration) {
  if (!duration) return null;
  return duration.unit === 'year' ? Number(duration.value) * 12 : Number(duration.value);
}

function sameDuration(left, right) {
  const leftMonths = durationMonths(left);
  const rightMonths = durationMonths(right);
  return leftMonths !== null && rightMonths !== null && leftMonths === rightMonths;
}

function matchingProductIds(catalog, text) {
  const normalized = normalizeProductText(text);
  if (!normalized) return [];
  return (catalog?.products || [])
    .filter(product => product.aliases.some(alias => {
      const normalizedAlias = normalizeProductText(alias);
      return normalizedAlias && normalized.includes(normalizedAlias);
    }))
    .map(product => product.productId);
}

function availabilityFromText(text) {
  const normalized = normalizeProductText(text);
  if (NEGATIVE_AVAILABILITY_RE.test(normalized)) return false;
  if (POSITIVE_AVAILABILITY_RE.test(normalized)) return true;
  return null;
}

function extractDurationPricePairs(text) {
  const normalized = normalizeProductText(text);
  const pairs = [];
  for (const match of normalized.matchAll(DURATION_PRICE_RE)) {
    const duration = parseDuration(match[1].replace(/^ال(?=[^\s])/u, ''));
    const price = parsePrice(`${match[2]} ${match[3] || ''}`);
    if (duration && price) {
      pairs.push({ raw: match[0], duration, price });
    }
  }
  return pairs;
}

function extractStandaloneDurations(text) {
  const normalized = normalizeProductText(text);
  return Array.from(normalized.matchAll(DURATION_RE))
    .map(match => ({
      raw: match[0],
      duration: parseDuration(match[0].replace(/^ال(?=[^\s])/u, '')),
    }))
    .filter(item => item.duration);
}

function extractStandalonePrices(text) {
  const normalized = normalizeProductText(text);
  return Array.from(normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*(ريال|ر\s*س|sar|درهم|aed|دولار|usd|\$|﷼)/giu))
    .map(match => ({ raw: match[0], price: parsePrice(match[0]) }))
    .filter(item => item.price);
}

function resolveClaimProductIds({ explicitIds, inheritedIds, focus }) {
  if (explicitIds.length) return explicitIds;
  if (inheritedIds.length) return inheritedIds;
  return [...(focus?.productIds || [])];
}

function extractCommercialClaims(reply, { catalog, focus } = {}) {
  const text = String(reply || '').trim();
  if (!text) return [];

  const segments = text.split(/(?<=[\n.!?؟؛;،])/u).map(value => value.trim()).filter(Boolean);
  const claims = [];
  let inheritedIds = [];

  for (const segment of segments) {
    const explicitIds = [...new Set(matchingProductIds(catalog, segment))];
    if (explicitIds.length) inheritedIds = explicitIds;
    const productIds = resolveClaimProductIds({ explicitIds, inheritedIds, focus });
    const pairs = extractDurationPricePairs(segment);
    const availability = availabilityFromText(segment);

    for (const pair of pairs) {
      claims.push({
        raw: pair.raw,
        productId: productIds.length === 1 ? productIds[0] : null,
        productIds,
        duration: pair.duration,
        price: pair.price,
        availability,
      });
    }

    if (!pairs.length) {
      const durations = extractStandaloneDurations(segment);
      const prices = extractStandalonePrices(segment);
      if (durations.length === 1 && prices.length === 1) {
        claims.push({
          raw: segment,
          productId: productIds.length === 1 ? productIds[0] : null,
          productIds,
          duration: durations[0].duration,
          price: prices[0].price,
          availability,
        });
      } else {
        for (const duration of durations) {
          claims.push({
            raw: duration.raw,
            productId: productIds.length === 1 ? productIds[0] : null,
            productIds,
            duration: duration.duration,
            price: null,
            availability,
          });
        }
        for (const price of prices) {
          claims.push({
            raw: price.raw,
            productId: productIds.length === 1 ? productIds[0] : null,
            productIds,
            duration: null,
            price: price.price,
            availability,
          });
        }
      }
    }

    if (!pairs.length
      && !extractStandaloneDurations(segment).length
      && !extractStandalonePrices(segment).length
      && availability !== null
      && PRODUCT_AVAILABILITY_RE.test(normalizeProductText(segment))
      && productIds.length) {
      claims.push({
        raw: segment,
        productId: productIds.length === 1 ? productIds[0] : null,
        productIds,
        duration: null,
        price: null,
        availability,
      });
    }
  }

  return claims;
}

function issueFor(claim, reason, details = {}) {
  return {
    type: 'unsupported_product_claim',
    reason,
    value: claim.raw,
    productId: claim.productId,
    ...details,
  };
}

function validateClaim(claim, catalog) {
  if (!claim.productIds.length) return { issue: issueFor(claim, 'product_unknown') };
  if (claim.productIds.length !== 1 || !claim.productId) return { issue: issueFor(claim, 'product_ambiguous') };

  const product = (catalog?.products || []).find(item => item.productId === claim.productId);
  if (!product) return { issue: issueFor(claim, 'product_not_found') };
  if (!product.available && claim.availability !== false) {
    return { issue: issueFor(claim, 'product_unavailable') };
  }

  let candidates = product.plans || [];
  if (claim.duration) candidates = candidates.filter(plan => sameDuration(plan.duration, claim.duration));
  if (claim.duration && candidates.length === 0) {
    return claim.availability === false
      ? { claim: { ...claim, matchedPlanId: null, verifiedAbsence: true } }
      : { issue: issueFor(claim, 'plan_not_found') };
  }

  if (claim.price) {
    const exactPrice = candidates.filter(plan =>
      plan.price
      && Number(plan.price.amount) === Number(claim.price.amount)
      && String(plan.price.currency) === String(claim.price.currency));
    if (!exactPrice.length) return { issue: issueFor(claim, 'tuple_mismatch') };
    candidates = exactPrice;
  }

  if (claim.availability === false) {
    if (candidates.some(plan => plan.available)) return { issue: issueFor(claim, 'availability_mismatch') };
    return { claim: { ...claim, matchedPlanId: candidates[0]?.planId || null } };
  }

  const available = candidates.find(plan => plan.available);
  if (!available && (claim.duration || claim.price || claim.availability === true)) {
    return { issue: issueFor(claim, 'plan_unavailable') };
  }
  if (!available && !claim.duration && !claim.price && claim.availability === null) {
    return { claim };
  }
  return { claim: { ...claim, matchedPlanId: available?.planId || null } };
}

function validateCommercialClaims(reply, { catalog, focus } = {}) {
  const claims = extractCommercialClaims(reply, { catalog, focus });
  const verifiedClaims = [];
  const issues = [];
  for (const claim of claims) {
    const result = validateClaim(claim, catalog);
    if (result.issue) issues.push(result.issue);
    else verifiedClaims.push(result.claim);
  }
  return {
    valid: issues.length === 0,
    claims: verifiedClaims,
    issues,
  };
}

function extractRequestedDurations(customerText) {
  const seen = new Set();
  const durations = [];
  for (const item of extractStandaloneDurations(customerText)) {
    const key = durationMonths(item.duration);
    if (seen.has(key)) continue;
    seen.add(key);
    durations.push(item.duration);
  }
  return durations;
}

function displayDuration(duration) {
  if (duration?.unit === 'year' && Number(duration.value) === 1) return 'السنة';
  if (duration?.unit === 'year') return `${duration.value} سنوات`;
  return `${duration?.value} أشهر`;
}

function displayPlan(plan) {
  const duration = plan.duration ? displayDuration(plan.duration).replace(/^ال/u, '') : plan.label;
  return `${duration} بـ${plan.price.amount} ريال`;
}

function conciseProductName(product) {
  return product.canonicalName.replace(/^(?:اشتراك|خدمة|منتج|باقة)\s+/u, '').trim();
}

function buildDeterministicCatalogReply({ customerText = '', focus, catalog } = {}) {
  if (focus?.status !== 'resolved' || focus.productIds.length !== 1) {
    return {
      decision: 'clarify',
      reply: 'أي منتج تقصد؟ اكتب اسم المنتج لو سمحت.',
      productId: null,
      planIds: [],
    };
  }

  const product = (catalog?.products || []).find(item => item.productId === focus.productIds[0]);
  if (!product) {
    return {
      decision: 'clarify',
      reply: 'اكتب اسم المنتج لو سمحت عشان أتأكد لك.',
      productId: null,
      planIds: [],
    };
  }

  const requested = extractRequestedDurations(customerText);
  const availablePlans = product.plans.filter(plan => plan.available && plan.price);
  const selected = requested.length
    ? requested.map(duration => ({
      duration,
      plan: availablePlans.find(candidate => sameDuration(candidate.duration, duration)) || null,
    }))
    : availablePlans.map(plan => ({ duration: plan.duration, plan }));

  const productName = conciseProductName(product);
  const lines = selected.map(({ duration, plan }) => (
    plan
      ? displayPlan(plan)
      : `${displayDuration(duration)} غير متوفرة لـ${productName}`
  ));

  if (!lines.length) {
    return {
      decision: 'answer',
      reply: `${productName} غير متوفر حاليًا.`,
      productId: product.productId,
      planIds: [],
    };
  }

  return {
    decision: 'answer',
    reply: lines.join('، ') + '.',
    productId: product.productId,
    planIds: selected.filter(item => item.plan).map(item => item.plan.planId),
  };
}

module.exports = {
  buildDeterministicCatalogReply,
  extractCommercialClaims,
  extractRequestedDurations,
  validateCommercialClaims,
};
