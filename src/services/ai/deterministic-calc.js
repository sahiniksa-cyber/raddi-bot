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

// Pull the first numeric value out of a number or a price string like "99 ريال"
// or "1,250 ر.س". Returns null when there is no number (never fabricates one).
function parseAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value == null) return null;
  const cleaned = String(value).replace(/[,٬]/g, '');
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

function conversationText(history = [], latestUserText = '') {
  const parts = (Array.isArray(history) ? history : []).map((m) => String(m && m.content || ''));
  parts.push(String(latestUserText || ''));
  return parts;
}

// Which of the tenant's products are referenced anywhere in the conversation?
function mentionedProducts(products, texts) {
  const normTexts = texts.map(normArabic);
  return (Array.isArray(products) ? products : []).filter((p) => {
    const name = normArabic(p && p.name);
    return name && normTexts.some((t) => t.includes(name));
  });
}

/**
 * Resolve the product the customer is asking the price of, from conversation
 * context + tenant products only. { status:'resolved'|'ambiguous'|'none' }.
 */
function resolveProductReference({ history, latestUserText, products } = {}) {
  const texts = conversationText(history, latestUserText);
  const hits = mentionedProducts(products, texts);
  const distinct = [];
  for (const p of hits) if (!distinct.find((q) => normArabic(q.name) === normArabic(p.name))) distinct.push(p);
  if (distinct.length === 1) return { status: 'resolved', product: distinct[0] };
  if (distinct.length > 1) return { status: 'ambiguous', candidates: distinct.map((p) => p.name) };
  return { status: 'none' };
}

// Pick the variant the customer chose (by label appearing in the conversation).
function resolveVariant(product, texts) {
  const variants = Array.isArray(product && product.variants) ? product.variants.filter((v) => v && (v.label || v.price)) : [];
  if (!variants.length) return { kind: 'no_variants' };
  const normTexts = texts.map(normArabic);
  const chosen = variants.filter((v) => {
    const label = normArabic(v.label);
    return label && normTexts.some((t) => t.includes(label));
  });
  if (chosen.length === 1) return { kind: 'chosen', variant: chosen[0] };
  return { kind: 'ambiguous', variants: variants.map((v) => v.label) };
}

// Pick the tenant rule to apply. One rule → it. Many → match by label token in
// the conversation; exactly one match → it; otherwise ambiguous.
function resolveRule(config, texts) {
  const rules = tenantRules(config);
  if (rules.length === 0) return { kind: 'none', rule: null };
  if (rules.length === 1) return { kind: 'one', rule: rules[0] };
  const normTexts = texts.map(normArabic);
  const matched = rules.filter((r) => {
    const label = normArabic(r.label);
    return label && normTexts.some((t) => t.includes(label));
  });
  if (matched.length === 1) return { kind: 'one', rule: matched[0] };
  return { kind: 'ambiguous', rules: rules.map((r) => r.label || r.type) };
}

/**
 * The reply-path entry point. Returns a discriminated result; when 'computed',
 * `computation` is the ACTUAL computePrice() output (deterministic, in code).
 */
function resolvePriceComputation({ history, latestUserText, config } = {}) {
  const cfg = config || {};
  if (!detectPriceQuestion(latestUserText)) return { status: 'not_a_calc' };

  const ref = resolveProductReference({ history, latestUserText, products: cfg.products });
  if (ref.status === 'none') return { status: 'no_reference' };
  if (ref.status === 'ambiguous') return { status: 'ambiguous_product', candidates: ref.candidates };

  const product = ref.product;
  const texts = conversationText(history, latestUserText);

  let basePrice = product.price;
  let variant = null;
  const v = resolveVariant(product, texts);
  if (v.kind === 'ambiguous') return { status: 'ambiguous_variant', product, variants: v.variants };
  if (v.kind === 'chosen') { variant = v.variant; basePrice = v.variant.price; }

  if (parseAmount(basePrice) == null) return { status: 'unknown_base', product };

  const rr = resolveRule(cfg, texts);
  if (rr.kind === 'ambiguous') return { status: 'ambiguous_rule', product, rules: rr.rules };

  // Deterministic computation happens HERE, in code — not left to the LLM.
  const computation = computePrice({ basePrice, quantity: 1, rule: rr.rule });
  if (!computation.ok) return { status: 'unknown_base', product };
  return { status: 'computed', product, variant, rule: rr.rule, computation };
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
};
