'use strict';

/**
 * Deterministic price calculations (PURE, no I/O) — Platform-level & Multi-Tenant.
 *
 * A GENERAL calculation engine driven entirely by each tenant's configured
 * rule(s) + trusted numbers (the product's own base price). Nothing is hardcoded
 * per store/product/provider: there is no `if Tamara → +10%`. A tenant declares
 * a rule ({ type, value }) and the SAME engine computes it for any product and
 * any store. If a base price is unknown, the engine refuses rather than invents.
 *
 * The arithmetic is done HERE, in code — never left to the LLM to guess.
 */

// Normalize Arabic-Indic (٠-٩) and Eastern (۰-۹) digits to ASCII, and the Arabic
// percent sign ٪ to % — so merchant text and prices written in Arabic numerals
// parse identically. No hardcoded values, just a numeral/locale normalization.
function toWestern(value) {
  return String(value == null ? '' : value)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/٪/g, '%');
}

// Pull the first numeric value out of a number or a price string like "99 ريال"
// or "1,250 ر.س" (Arabic numerals supported). null when there is no number.
function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  const cleaned = toWestern(value).replace(/[,٬]/g, '');
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * @param {object} args
 * @param {number|string} args.basePrice - the product's trusted base price.
 * @param {number} [args.quantity=1]
 * @param {{type:string, value?:number}|null} args.rule - tenant-configured rule.
 * @returns {{ok:true, basePrice, quantity, subtotal, adjustment, total, ruleType}
 *          | {ok:false, reason:'unknown_base_price'|'invalid_quantity'}}
 */
function computePrice({ basePrice, quantity = 1, rule } = {}) {
  const base = parseAmount(basePrice);
  if (base == null) return { ok: false, reason: 'unknown_base_price' };

  const qty = parseAmount(quantity);
  if (qty == null || qty <= 0) return { ok: false, reason: 'invalid_quantity' };

  const subtotal = round2(base * qty);
  const type = (rule && String(rule.type || '').trim()) || 'none';
  const value = parseAmount(rule && rule.value) || 0;

  let total = subtotal;
  switch (type) {
    case 'percentage_addition': total = subtotal * (1 + value / 100); break;
    case 'percentage_discount': total = subtotal * (1 - value / 100); break;
    case 'fixed_addition': total = subtotal + value; break;
    case 'fixed_discount': total = subtotal - value; break;
    case 'none': default: total = subtotal; break;
  }
  total = round2(total);
  return { ok: true, basePrice: base, quantity: qty, subtotal, adjustment: round2(total - subtotal), total, ruleType: type };
}

// Normalize the tenant's configured rules into an array (supports a single
// `calculationRule` object or a `pricingRules` array — general, tenant-owned).
function tenantRules(config = {}) {
  const list = [];
  if (Array.isArray(config.pricingRules)) list.push(...config.pricingRules);
  if (config.calculationRule && typeof config.calculationRule === 'object') list.push(config.calculationRule);
  return list.filter((r) => r && String(r.type || '').trim() && String(r.type) !== 'none');
}

const RULE_PHRASE = {
  percentage_addition: (v) => `يُضاف ${v}% على السعر الأساسي`,
  percentage_discount: (v) => `يُخصم ${v}% من السعر الأساسي`,
  fixed_addition: (v) => `يُضاف مبلغ ثابت ${v} على السعر الأساسي`,
  fixed_discount: (v) => `يُخصم مبلغ ثابت ${v} من السعر الأساسي`,
};

/**
 * Authoritative prompt block: states the tenant's configured pricing rule(s) so
 * the model applies the EXACT rule, computes from the product's listed base
 * price, asks ONE clarifying question when the package is ambiguous, and does
 * NOT escalate merely because a calculation is pending. Empty when the tenant
 * configured no rule (zero impact for those tenants).
 */
function buildCalculationBlock(config = {}) {
  const rules = tenantRules(config);
  if (!rules.length) return '';
  const lines = rules.map((r) => {
    const v = parseAmount(r.value);
    const phrase = RULE_PHRASE[r.type] ? RULE_PHRASE[r.type](v != null ? v : r.value) : `${r.type}: ${r.value}`;
    const label = String(r.label || '').trim();
    return `- ${label ? `${label}: ` : ''}${phrase}`;
  });
  return `\n\n🧮 حساب الأسعار (قاعدة هذا المتجر — طبّقها حرفياً على السعر الأساسي المذكور في المنتجات):
${lines.join('\n')}
- احسب من السعر الأساسي المعروف للمنتج/الباقة المذكورة في المحادثة. إن كان السعر الأساسي غير معروف، لا تخترع رقماً.
- إذا للمنتج أكثر من باقة والعميل لم يحدّد أيّها، اسأله سؤالاً توضيحياً واحداً فقط (أي باقة تقصد؟) — لا تصعّد ولا تحوّله لأحد لمجرد أن الحساب غير محسوم.
- إجراء عملية حسابية سعرية ليس سبباً للتصعيد إطلاقاً؛ أنت تجاوب عليها مباشرة.`;
}

// ── Reply-path resolution: bind "كم؟" to a product/variant + actually compute ──
// This is what makes the calculation DETERMINISTIC end-to-end: the reply path
// resolves the referenced product from conversation context (tenant data only),
// pulls the trusted base price + the tenant's rule, and calls computePrice()
// HERE — then the computed total is handed to the model as a fact.

const { isLaterMarker } = require('./conversation-state');

function normArabic(s) {
  return String(s == null ? '' : s)
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .trim();
}

const PRICE_Q_RE = /(كم|بكم|السعر|سعر|المجموع|الاجمالي|الإجمالي|التكلفه|التكلفة|كم يطلع|كم يصير|كم يكلف|كم صار)/;
function detectPriceQuestion(text) {
  return PRICE_Q_RE.test(normArabic(text));
}

// Customer messages only (newest first). Bot messages must NOT set the active
// product/variant/method — only what the CUSTOMER said drives resolution.
function customerTexts(history = [], latestUserText = '') {
  const fromHistory = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.role === 'user')
    .map((m) => String(m.content || ''));
  const latest = String(latestUserText || '');
  if (latest && fromHistory[fromHistory.length - 1] !== latest) fromHistory.push(latest);
  return fromHistory.reverse(); // newest first
}

function productsIn(products, text) {
  const t = normArabic(text);
  const list = Array.isArray(products) ? products : [];
  const hits = [];
  for (const p of list) {
    const name = normArabic(p && p.name);
    if (name && t.includes(name) && !hits.find((q) => normArabic(q.name) === name)) hits.push(p);
  }
  return hits;
}

/**
 * The ACTIVE product = the one in the most-recent CUSTOMER message that names a
 * product. Walking newest→oldest means a later switch (A → B) wins, and a bot
 * message repeating a name never changes it. Only when that same latest message
 * names more than one product is it ambiguous.
 * { status:'resolved'|'ambiguous'|'none' }.
 */
function resolveProductReference({ history, latestUserText, products } = {}) {
  for (const text of customerTexts(history, latestUserText)) {
    const hits = productsIn(products, text);
    if (hits.length === 1) return { status: 'resolved', product: hits[0] };
    if (hits.length > 1) return { status: 'ambiguous', candidates: hits.map((p) => p.name) };
  }
  return { status: 'none' };
}

// The variant the CUSTOMER chose. `texts` is newest-first, so a later choice
// (monthly → yearly) wins; a single message naming two variants is ambiguous;
// none chosen anywhere → ambiguous (ask which).
function resolveVariant(product, texts) {
  const variants = Array.isArray(product && product.variants) ? product.variants.filter((v) => v && (v.label || v.price)) : [];
  if (!variants.length) return { kind: 'no_variants' };
  for (const t of texts) {
    const nt = normArabic(t);
    const hits = variants.filter((v) => v.label && nt.includes(normArabic(v.label)));
    if (hits.length === 1) return { kind: 'chosen', variant: hits[0] };
    if (hits.length > 1) return { kind: 'ambiguous', variants: variants.map((v) => v.label) };
  }
  return { kind: 'ambiguous', variants: variants.map((v) => v.label) };
}

// ── Legacy merchant-instruction → structured pricing rule (P2-A) ──────
// A tenant may express a fee in free text (botInstructions) instead of a
// structured rule. Parse the CLEAR forms into the same structured shape. Only
// emit a rule when BOTH a typed amount AND a trigger are unambiguous — otherwise
// nothing (never invent a number or guess a trigger). Names are never hardcoded.
// Words that describe a fee but are NOT a payment-method name.
const TRIGGER_STOPWORDS = new Set(['ثابته', 'ثابت', 'متغيره', 'متغير', 'اضافيه', 'اضافي']);
function cleanTrigger(tok) {
  let t = String(tok || '').replace(/[،.؛!:؟%]+$/u, '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^ب[ـ]?\s*/, ''); // strip leading بـ
  return t;
}
function firstWordIsStopword(phrase) {
  const first = normArabic(String(phrase).trim().split(/\s+/)[0] || '');
  return TRIGGER_STOPWORDS.has(first);
}

// Extract the payment-method / condition (the "trigger") a fee is tied to.
// General forms, tried most-explicit first; supports multi-word method names.
// Numbers/percents are never part of a trigger. Names are never hardcoded.
function extractTrigger(seg) {
  const patterns = [
    /عند\s+الدفع\s+ب[ـ]?\s*([^\d،.؛!%]+?)(?:\s+(?:يزيد|زيد|عليه|عليها|رسوم|اضف|أضف|يضاف)|\s+\d|\s*$)/, // عند الدفع بـ X ...
    /طريقة(?:\s+الدفع)?\s+([^\d،.؛!%]+?)(?:\s+علي|\s+عليه|\s+عليها|\s*$)/,                          // طريقة (الدفع) X
    /عند\s+([^\d،.؛!%]+?)(?:\s+\d|\s*$)/,                                                            // ... عند Y
    /([^\d،.؛!%]+?)\s+علي(?:ه|ها)?\s+رسوم/,                                                          // X عليه رسوم ...
    /مع\s+([^\d،.؛!%]+?)\s*$/,                                                                       // ... مع X
    /رسوم\s+([^\d،.؛!%]+?)(?:\s+\d|\s*$)/,                                                           // رسوم X (method)
  ];
  for (let i = 0; i < patterns.length; i++) {
    const m = seg.match(patterns[i]);
    if (!m) continue;
    const cand = cleanTrigger(m[1]);
    if (!cand) continue;
    if (normArabic(cand) === 'الدفع') continue;              // "عند الدفع" alone isn't a method
    if (i === 5 && firstWordIsStopword(cand)) continue;      // "رسوم ثابتة ..." → not a method
    return cand;
  }
  return null;
}
const ADD_RE = /(زياد|اضاف|إضاف|رسوم|أضف|اضف|يضاف|يزيد|زيد|زد|رفع)/;
const DISC_RE = /(خصم|حسم|تخفيض)/;
function extractTypeValue(seg) {
  const pct = seg.match(/(\d+(?:\.\d+)?)\s*%/);
  if (pct) {
    if (DISC_RE.test(seg)) return { type: 'percentage_discount', value: Number(pct[1]) };
    if (ADD_RE.test(seg)) return { type: 'percentage_addition', value: Number(pct[1]) };
    return null; // % with no clear direction → ambiguous
  }
  const num = seg.match(/(\d+(?:\.\d+)?)/);
  if (num) {
    if (DISC_RE.test(seg)) return { type: 'fixed_discount', value: Number(num[1]) };
    if (ADD_RE.test(seg)) return { type: 'fixed_addition', value: Number(num[1]) };
  }
  return null;
}
function extractPricingRulesFromInstructions(instructions) {
  const text = toWestern(String(instructions || ''));
  if (!text.trim()) return [];
  const segments = text.split(/[\n.؛!]+/).map((s) => s.trim()).filter(Boolean);
  const rules = [];
  for (const seg of segments) {
    const tv = extractTypeValue(seg);
    const trigger = extractTrigger(seg);
    if (tv && trigger && Number.isFinite(tv.value) && tv.value > 0) {
      rules.push({ trigger, type: tv.type, value: tv.value, source: 'merchant_instruction' });
    }
  }
  return rules;
}

/**
 * Unified pricing-rule source (P2-A): STRUCTURED rules (config.pricingRules /
 * calculationRule) always win; legacy rules parsed from botInstructions fill in
 * only triggers a structured rule doesn't already cover. Non-destructive.
 */
function resolvePricingRules(config = {}) {
  const structured = tenantRules(config).map((r) => ({
    type: r.type,
    value: parseAmount(r.value),
    // A `label` is a display name, NOT a trigger. Only an explicit `trigger`
    // makes a rule payment-method-specific; otherwise it is a blanket rule that
    // applies whenever a price is asked (backward-compatible default).
    trigger: (r.trigger != null && String(r.trigger).trim() ? String(r.trigger) : null),
    label: r.label,
    source: 'structured',
  })).filter((r) => Number.isFinite(r.value));
  const seen = new Set(structured.map((r) => (r.trigger ? normArabic(r.trigger) : '__blanket__')));
  const legacy = extractPricingRulesFromInstructions(config.botInstructions);
  for (const r of legacy) {
    const key = r.trigger ? normArabic(r.trigger) : '__blanket__';
    if (!seen.has(key)) { structured.push({ ...r, label: r.trigger }); seen.add(key); }
  }
  return structured;
}

const PAY_INTENT_RE = /(ادفع|أدفع|الدفع|دفع|سداد|اسدد|تقسيط|طريقه|طريقة)/;

// Pick the rule matching the CUSTOMER's stated context. `texts` is newest-first,
// so the LATEST payment method the customer named wins (pay X → switch to Y → Y).
// A blanket (no-trigger) rule applies when no method matched; nothing relevant →
// none (base price); several methods with a pay intent but none named → ambiguous.
function resolveRule(rules, texts) {
  const triggered = rules.filter((r) => r.trigger && String(r.trigger).trim());
  const blanket = rules.filter((r) => !r.trigger || !String(r.trigger).trim());
  for (const t of texts) { // newest first
    const nt = normArabic(t);
    const hits = triggered.filter((r) => nt.includes(normArabic(r.trigger)));
    if (hits.length === 1) return { kind: 'one', rule: hits[0] };
    if (hits.length > 1) return { kind: 'ambiguous', rules: hits.map((r) => r.trigger) };
  }
  if (blanket.length === 1) return { kind: 'one', rule: blanket[0] };
  if (blanket.length > 1) return { kind: 'ambiguous', rules: blanket.map((r) => r.label || r.type) };
  const payIntent = texts.some((t) => PAY_INTENT_RE.test(normArabic(t)));
  if (triggered.length >= 2 && payIntent) return { kind: 'ambiguous', rules: triggered.map((r) => r.trigger) };
  return { kind: 'none', rule: null };
}

// ── Context Engine → pricing bridge (spec §15/§16) ────────────────────────
// The Context Engine already RESOLVED which product/variant/payment-method the
// customer means (across short replies, corrections and pronouns). Turn its
// active_entities into a preferred-resolution hint for the calc. The calc still
// reads the TRUSTED base price from config and does the arithmetic — the context
// only chooses WHICH item, never supplies a price (authority order §10).
const PRODUCT_ENTITY_TYPES = new Set(['product', 'subscription', 'service', 'item', 'package']);
const VARIANT_ENTITY_TYPES = new Set(['variant', 'plan', 'tier']);
function newestByType(entities, typeSet) {
  const list = (Array.isArray(entities) ? entities : []).filter((e) => e && typeSet.has(e.type) && (e.label || e.ref));
  if (!list.length) return null;
  let best = list[0];
  for (const e of list) {
    if (isLaterMarker(e.last_seen, best.last_seen)) best = e;
  }
  return best.label || best.ref;
}
function deriveResolvedPricingContext(state) {
  const entities = state && Array.isArray(state.active_entities) ? state.active_entities : [];
  return {
    activeProduct: newestByType(entities, PRODUCT_ENTITY_TYPES),
    activeVariant: newestByType(entities, VARIANT_ENTITY_TYPES),
    activePaymentMethod: newestByType(entities, new Set(['payment_method'])),
  };
}

// Find the config product whose name matches a resolved-context product string.
function matchConfigProduct(products, nameStr) {
  const t = normArabic(nameStr);
  if (!t) return null;
  const list = Array.isArray(products) ? products : [];
  return list.find((p) => { const n = normArabic(p && p.name); return n && (t.includes(n) || n.includes(t)); }) || null;
}
function matchVariant(product, variantStr) {
  const nv = normArabic(variantStr);
  if (!nv) return null;
  const variants = Array.isArray(product && product.variants) ? product.variants.filter((v) => v && (v.label || v.price)) : [];
  return variants.find((v) => v.label && (nv.includes(normArabic(v.label)) || normArabic(v.label).includes(nv))) || null;
}
function matchRuleByTrigger(rules, methodStr) {
  const nm = normArabic(methodStr);
  if (!nm) return null;
  const triggered = (rules || []).filter((r) => r.trigger && String(r.trigger).trim());
  return triggered.find((r) => nm.includes(normArabic(r.trigger)) || normArabic(r.trigger).includes(nm)) || null;
}

// Bug 3 — bind a bare variant mention ("الشهري"/"السنوي") to its PARENT product.
// Walks customer texts newest-first (so a correction wins), then the resolved
// context variant. Exactly one parent → resolved; several → ambiguous; none →
// no guess. Generic, tenant-driven — never invents a product.
function resolveProductByVariant({ products, texts, preferredVariant } = {}) {
  const list = Array.isArray(products) ? products : [];
  const matchesFor = (nl) => {
    if (!nl) return [];
    const out = [];
    for (const p of list) {
      const vs = Array.isArray(p.variants) ? p.variants.filter((v) => v && (v.label || v.price)) : [];
      for (const v of vs) {
        if (v.label && (nl.includes(normArabic(v.label)) || normArabic(v.label).includes(nl))) out.push({ product: p, variant: v });
      }
    }
    return out;
  };
  const verdict = (matches) => {
    const distinct = [...new Set(matches.map((m) => m.product))];
    if (distinct.length === 1) return { status: 'resolved', product: matches[0].product, variant: matches[0].variant };
    return { status: 'ambiguous', candidates: distinct.map((p) => p.name) };
  };
  for (const t of texts) { // newest-first
    const nt = normArabic(t);
    const matches = [];
    for (const p of list) {
      for (const v of (Array.isArray(p.variants) ? p.variants : [])) {
        if (v && v.label && nt.includes(normArabic(v.label))) matches.push({ product: p, variant: v });
      }
    }
    if (matches.length) return verdict(matches);
  }
  if (preferredVariant) {
    const m = matchesFor(normArabic(preferredVariant));
    if (m.length) return verdict(m);
  }
  return { status: 'none' };
}

/**
 * The reply-path entry point. Returns a discriminated result; when 'computed',
 * `computation` is the ACTUAL computePrice() output (deterministic, in code).
 * `resolvedContext` (optional, from the Context Engine) is the PREFERRED
 * resolution for product/variant/payment-method; every field falls back to the
 * existing regex resolution when absent or not matchable — so behaviour is
 * byte-identical when no context is supplied (backward compatible).
 */
function resolvePriceComputation({ history, latestUserText, config, resolvedContext } = {}) {
  const cfg = config || {};
  if (!detectPriceQuestion(latestUserText)) return { status: 'not_a_calc' };
  const rc = resolvedContext || {};
  const texts = customerTexts(history, latestUserText);

  // Product resolution, in precedence order:
  // 1) Regex over CUSTOMER texts. If the customer named MULTIPLE products it is
  //    genuinely AMBIGUOUS (bug 2) — this wins over any single guessed context.
  let product = null;
  let variant = null;
  const ref = resolveProductReference({ history, latestUserText, products: cfg.products });
  if (ref.status === 'ambiguous') return { status: 'ambiguous_product', candidates: ref.candidates };
  if (ref.status === 'resolved') product = ref.product;
  // 2) Context-resolved product (the customer never named one in text).
  if (!product && rc.activeProduct) product = matchConfigProduct(cfg.products, rc.activeProduct);
  // 3) Variant → parent product (bug 3): the customer named only a variant.
  if (!product) {
    const byVar = resolveProductByVariant({ products: cfg.products, texts, preferredVariant: rc.activeVariant });
    if (byVar.status === 'ambiguous') return { status: 'ambiguous_product', candidates: byVar.candidates };
    if (byVar.status === 'resolved') { product = byVar.product; variant = byVar.variant; }
  }
  if (!product) return { status: 'no_reference' };

  let basePrice = variant ? variant.price : product.price;
  if (!variant) {
    variant = rc.activeVariant ? matchVariant(product, rc.activeVariant) : null;
    if (variant) {
      basePrice = variant.price;
    } else {
      const v = resolveVariant(product, texts);
      if (v.kind === 'ambiguous') return { status: 'ambiguous_variant', product, variants: v.variants };
      if (v.kind === 'chosen') { variant = v.variant; basePrice = v.variant.price; }
    }
  }

  if (parseAmount(basePrice) == null) return { status: 'unknown_base', product };

  // Rule: prefer the resolved payment method; fall back to regex resolution.
  const rules = resolvePricingRules(cfg);
  let rule = rc.activePaymentMethod ? matchRuleByTrigger(rules, rc.activePaymentMethod) : null;
  if (!rule) {
    const rr = resolveRule(rules, texts);
    if (rr.kind === 'ambiguous') return { status: 'ambiguous_rule', product, rules: rr.rules };
    rule = rr.rule;
  }

  // Deterministic computation happens HERE, in code — not left to the LLM.
  const computation = computePrice({ basePrice, quantity: 1, rule });
  if (!computation.ok) return { status: 'unknown_base', product };
  return { status: 'computed', product, variant, rule, computation };
}

function buildPriceComputationBlock(resolution) {
  const r = resolution || {};
  switch (r.status) {
    case 'computed': {
      const label = r.rule && r.rule.label ? r.rule.label : (r.rule ? r.rule.type : 'بدون رسوم');
      const vlabel = r.variant && r.variant.label ? ` (${r.variant.label})` : '';
      return `\n\n💰 حساب فوري (احتُسب في النظام آلياً — حقيقة ثابتة، اذكر الرقم كما هو ولا تُعِد حسابه): ${r.product.name}${vlabel} → calculated_total=${r.computation.total} (السعر الأساسي ${r.computation.basePrice}${r.rule ? ` + قاعدة «${label}»` : ''}). أعطِ العميل هذا الرقم مباشرة.`;
    }
    case 'ambiguous_product':
      return `\n\n❓ العميل يسأل عن السعر لكن لم يحدّد أي منتج (${(r.candidates || []).join('، ')}). اسأله سؤالاً توضيحياً واحداً فقط ليحدّد المنتج. لا تصعّد ولا تحوّله لأحد.`;
    case 'ambiguous_variant':
      return `\n\n❓ العميل يسأل عن سعر «${r.product.name}» لكن لم يحدّد الباقة (${(r.variants || []).join('، ')}). اسأله سؤالاً توضيحياً واحداً فقط ليحدّد الباقة. لا تصعّد.`;
    case 'ambiguous_rule':
      return `\n\n❓ العميل يسأل عن السعر لكن طريقة الدفع/الرسوم غير محدّدة (${(r.rules || []).join('، ')}). اسأله سؤالاً توضيحياً واحداً فقط. لا تصعّد.`;
    case 'unknown_base':
      return `\n\n⚠️ السعر الأساسي لـ«${r.product ? r.product.name : 'المنتج'}» غير مسجّل في بيانات المتجر. لا تخترع رقماً؛ اعتذر بلطف واطلب التوضيح إن لزم. لا تصعّد لمجرد ذلك.`;
    default:
      return '';
  }
}

module.exports = {
  computePrice, parseAmount, buildCalculationBlock, tenantRules,
  detectPriceQuestion, resolveProductReference, resolvePriceComputation, buildPriceComputationBlock,
  extractPricingRulesFromInstructions, resolvePricingRules, deriveResolvedPricingContext,
};
