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

module.exports = { computePrice, parseAmount, buildCalculationBlock, tenantRules };
