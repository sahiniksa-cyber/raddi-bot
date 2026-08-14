'use strict';

/**
 * Instruction Routing Layer — classifier (PURE, no I/O).
 *
 * Every merchant edit (from WhatsApp or the dashboard) is classified into one of
 * seven generic, tenant-agnostic buckets so it can be routed to its correct
 * STRUCTURED home instead of being dumped as free text into the prompt:
 *
 *   STYLE       → persona/style (the ONLY thing that stays in botInstructions)
 *   KNOWLEDGE   → products / knowledge base
 *   POLICY      → structured tenant policy (refund/shipping/payment rules)
 *   SLA_TIME    → computable time policy (not a sentence the LLM parrots)
 *   ESCALATION  → escalationContacts + a structured routing rule
 *   ACTION      → action policy (never "done" until a real tool succeeds)
 *   PROHIBITION → avoid-phrases / prohibition policy
 *
 * Only STYLE is non-operational (belongs in the persona prompt). Everything else
 * is operational and must live in structured config, not the free-text blob.
 *
 * This is the canonical runtime classifier; the read-only leak detector uses the
 * same category vocabulary.
 */

const CATEGORIES = Object.freeze([
  'STYLE', 'KNOWLEDGE', 'POLICY', 'SLA_TIME', 'ESCALATION', 'ACTION', 'PROHIBITION',
]);

const OPERATIONAL = new Set(['KNOWLEDGE', 'POLICY', 'SLA_TIME', 'ESCALATION', 'ACTION', 'PROHIBITION']);

const SEVERITY = {
  ESCALATION: 'high', ACTION: 'high', SLA_TIME: 'high',
  PROHIBITION: 'medium', POLICY: 'medium', KNOWLEDGE: 'low', STYLE: 'none',
  UNKNOWN: 'low',
};

const TARGET = {
  STYLE: 'persona/style (botInstructions — bounded)',
  KNOWLEDGE: 'products / knowledge base',
  POLICY: 'structured tenant policy',
  SLA_TIME: 'computable SLA time policy',
  ESCALATION: 'escalationContacts + routing rule (condition → real target)',
  ACTION: 'action policy (requires a successful tool/action)',
  PROHIBITION: 'replyStyle.avoidPhrases / prohibition policy',
  UNKNOWN: 'needs review / clarification (never botInstructions)',
};

const RE = {
  escVerb: /(?:حوّل|حول|صعّد|صعد|بلّغ|بلغ|كلّم|كلم|رجّع|راجع|حوّله|حوله|صعده|اتصل|تواصل)/,
  escTarget: /(?:موظف|مختص|مسؤول|المدير|المالك|الدعم|الفريق|خدمة العملاء|القسم|الرقم|واتساب|\+?\d[\d\s-]{6,})/,
  cond: /(?:إذا|اذا|لو|عند|في\s*حال|متى|حينما)/,
  actionVerb: /(?:ألغِ|ألغ|الغِ|الغاء|إلغاء|عدّل|عدّله|عدل|أرسل|ارسل|سجّل|سجل|احجز|غيّر|غيِّر|غير\s+ال\S+|استرجع|افتح\s*تذكرة|ارفع\s*(?:طلب|تذكرة)|نفّذ|نفذ|فعّل|فعل)/,
  sla: /(?:خلال\s*\d+\s*(?:ساعة|ساعه|ساعات|يوم|أيام|ايام|دقيقة|دقائق|أسبوع|اسبوع))|(?:\d+\s*(?:ساعة|ساعه|ساعات|يوم|أيام|ايام)\b)|(?:يوم\s*عمل)|(?:خلال\s*يوم)/,
  prohibition: /(?:ممنوع|لا\s*ترد|لا\s*تعطي|لا\s*تذكر|لا\s*تقل|لا\s*تعد|تجنّب|تجنب|ما\s*تسوي|لا\s*تسمح|لا\s*تفتح|لا\s*تخبر)/,
  policyKw: /(?:سياسة|شروط|استرجاع|استبدال|ضمان|شحن|توصيل|الدفع|دفع|خصم|كوبون|عرض|فاتورة|استرداد)/,
  knowledge: /(?:سعر|السعر|ريال|متوفر|المنتج|الكمية|مقاس|لون|الموديل|الماركة)/,
  style: /(?:نبرة|لهجة|أسلوب|اسلوب|رحّب|رحب|اختصر|إيموجي|ايموجي|emoji|شخصيت|بلطف|ودود|مهذب|مختصر|لا\s*تطوّل|تكلم|صياغة)/,
};

function mk(category, confidence, line) {
  return {
    category,
    confidence,
    severity: SEVERITY[category],
    target: TARGET[category],
    isOperational: OPERATIONAL.has(category),
    line,
  };
}

/**
 * Classify a single instruction line. Priority order puts the most operationally
 * risky categories first so a line that both routes and mentions a policy is
 * flagged as ESCALATION/ACTION. Prohibition is checked before Action ("ممنوع" is
 * an unambiguous signal that outranks any action verb in the same sentence).
 * Returns null for empty/trivial lines.
 */
function classifyInstructionLine(rawLine) {
  const line = String(rawLine == null ? '' : rawLine).trim();
  if (line.length < 3) return null;

  if (RE.escVerb.test(line)) {
    const conf = RE.escTarget.test(line) ? 0.9 : RE.cond.test(line) ? 0.8 : 0.65;
    return mk('ESCALATION', conf, line);
  }
  if (RE.prohibition.test(line)) return mk('PROHIBITION', 0.75, line);
  if (RE.actionVerb.test(line)) return mk('ACTION', 0.8, line);
  if (RE.sla.test(line)) return mk('SLA_TIME', 0.85, line);
  if (RE.policyKw.test(line)) return mk('POLICY', RE.cond.test(line) ? 0.7 : 0.55, line);
  if (RE.knowledge.test(line)) return mk('KNOWLEDGE', 0.5, line);
  if (RE.style.test(line)) return mk('STYLE', 0.6, line);
  // Unclassified content is UNKNOWN — NEVER silently treated as persona/style.
  // The router turns it into a clarification request rather than leaking it into
  // botInstructions.
  return mk('UNKNOWN', 0.3, line);
}

function splitSegments(text) {
  return String(text == null ? '' : text)
    .split(/[\n\r؛•]+|(?:[.!؟،]\s)/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Classify a whole merchant edit into per-segment routing decisions, so a mixed
 * instruction ("be brief, and transfer refund questions to Saud") splits into a
 * STYLE segment and an ESCALATION segment that route to different homes.
 */
function classifyInstruction(text) {
  return splitSegments(text).map(classifyInstructionLine).filter(Boolean);
}

module.exports = {
  CATEGORIES,
  SEVERITY,
  TARGET,
  classifyInstructionLine,
  classifyInstruction,
  splitSegments,
};
