'use strict';

/**
 * Customer-Service Contract (PLATFORM-level, PURE, tenant-agnostic, no I/O).
 *
 * This module enforces the platform invariants that must hold for EVERY tenant,
 * above any merchant free-text. It is deliberately generic — no store name,
 * product, price, phone, or store-specific policy is hardcoded. Everything is
 * derived from the tenant's own config at runtime.
 *
 * Invariants enforced here:
 *   §1  No invented operational troubleshooting — a generic device/account
 *       "fix-it" step that the tenant never documented is stripped.
 *   §3  Decision precedence: a matching tenant escalation policy WINS (real
 *       escalation, one concise ack) over any self-generated troubleshooting.
 *   §4/§5  No fake escalation/review: a reply may claim a handoff/review/callback
 *       ONLY when a real escalation was actually enqueued. Otherwise the claim is
 *       stripped and replaced by an acknowledgement that promises nothing.
 *
 * SAFE BY DEFAULT: the reconciler runs unless SUPPORT_CONTRACT_ENABLED === 'false'
 * (an explicit kill-switch for rollback — the safe behavior never depends on a
 * flag being switched ON).
 */

const { classifyInstruction } = require('../instruction-routing/instruction-classifier');
const {
  normalizeArabic,
  contactStableId,
  contactHasDestination,
  extractTargetName,
  buildTrigger,
} = require('../instruction-routing/instruction-router');

function killed() {
  return process.env.SUPPORT_CONTRACT_ENABLED === 'false';
}

// ── Action-claim detection ─────────────────────────────────────────────────
// Natural-language phrases where the bot claims a handoff / review / callback /
// registration ACTUALLY happened. These are truthful ONLY when a real escalation
// was enqueued; otherwise they are a false promise (the exact production defect).
const ACTION_CLAIM_RES = [
  // transfer: أحوّلك / بحوّلك / حوّلت طلبك / نحوّلك
  /(?:ب|س|سوف|راح|رح)?\s*[أان]?حوّ?ل(?:ك|كم|نا|ه|ها|ت)?/u,
  // raise / send / notify a team: أرفع/بأرفع/رفعت/أرسل للإدارة/بلّغت/صعّدت
  /(?:ب|س|سوف|راح|رح)?\s*[أان]?(?:رفع|رسل|بلّ?غ|صعّ?د)(?:ت|ه|ها)?[^\n.؟!،]{0,20}(?:لل|ال|مع\s*ال)?(?:[إا]دار[ةه]|فريق|مختص|مسؤول|مسئول|دعم|قسم|مدير|مالك)/u,
  // review-then-return copout: بأراجع الإدارة / أراجع ... وأرجع لك
  /(?:ب|س|سوف|راح|رح)?\s*[أا]?راجع[^\n.؟!،]{0,25}(?:[إا]دار[ةه]|مختص|مسؤول|مسئول|دعم|أرجع\s*لك|ارجع\s*لك|أكلمك|اكلمك|أرد\s*عليك|ارد\s*عليك)/u,
  // register the request: بسجل طلبك / سجّلت طلبك / بأخذ بياناتك
  /(?:ب|س|سوف|راح|رح)?\s*[أان]?(?:سجّ?ل|أخذ|اخذ|آخذ)[^\n.؟!،]{0,15}(?:طلب|بيانات|معلومات)/u,
  // callback promise: يتواصل/بيتواصل معك / يرجع لك / يتم الرد عليك / بيردون عليك
  /(?:ب?ي|ن|بي)(?:تواصل|تواصلون|رجع|ردون|رد)[^\n.؟!،]{0,15}(?:معك|عليك|لك)/u,
  /يتم\s*(?:الرد|التواصل)\s*(?:عليك|معك)/u,
  // ask a specialist: بسأل المختص / أسأل المسؤول
  /(?:ب|س|سوف)?\s*[أا]?سأل[^\n.؟!،]{0,12}(?:المختص|مختص|المسؤول|مسؤول|الإدار[ةه]|الادار[ةه])/u,
];

function detectActionClaim(text) {
  const t = String(text || '');
  const kinds = [];
  ACTION_CLAIM_RES.forEach((re, i) => { if (re.test(t)) kinds.push(i); });
  return { claimed: kinds.length > 0, kinds };
}

// Segment splitter shared by the claim/troubleshooting strippers.
function toSegments(text) {
  return String(text || '')
    .split(/(?<=[.!؟\n،])\s*/)
    .map(s => s)
    .filter(s => s.trim().length);
}

function stripActionClaims(text) {
  const survivors = toSegments(text).filter(seg => !detectActionClaim(seg).claimed);
  return survivors.join(' ').replace(/\s{2,}/g, ' ').replace(/\s+([،.!؟])/g, '$1').trim();
}

// ── Generic (invented) troubleshooting detection ────────────────────────────
// Tenant-agnostic IT/account "fix-it" clichés a model reaches for when it has no
// real answer. They are only a problem when the tenant did NOT document them
// (see hasGroundingSupport) — a store that really tells customers "أعد تسجيل
// الدخول" keeps that step.
const GENERIC_TS_RES = [
  /(?:تأكد|تاكد|تحقق|راجع)\s+من\s+(?:اتصال|الاتصال|اتصالك)[^\n،.؟!]*?(?:الإنترنت|الانترنت|النت|الشبكة|الواي[\s-]?فاي)/u,
  /(?:اتصالك|اتصال)\s*(?:بالإنترنت|بالانترنت|بالنت|بالشبكة)/u,
  /(?:جرّب|جرب|أعد|اعد|حاول|قم\s*ب|عاود)\s*(?:إعادة\s*|اعاده\s*)?تسجيل\s*(?:الدخول|الخروج)/u,
  /(?:سجّل|سجل)\s*(?:الخروج|خروج)[^\n،.؟!]{0,15}(?:ثم|وبعدها|و)\s*(?:الدخول|ادخل|سجّل)/u,
  /(?:أعد|اعد|إعادة|اعاده)\s*(?:تشغيل|التشغيل)/u,
  /\brestart\b/iu,
  /(?:أعد|اعد|إعادة|اعاده)\s*(?:تثبيت|التثبيت)/u,
  /(?:حدّث|حدث|حمّل|حمل|نزّل|نزل)\s*(?:التطبيق|البرنامج|النظام|الابليكيشن)\s*(?:من\s*جديد|مره\s*ثانيه|مجدداً)?/u,
  /(?:امسح|مسح|احذف|تفريغ|نظّف|نظف)\s*(?:الكاش|الكاشي|ذاكرة\s*التخزين|بيانات\s*التصفح|الكوكيز)/u,
  /\bcache\b/iu,
  /(?:جرّب|جرب|استخدم|افتح)\s*(?:متصفح|جهاز|شبكة|بريد)\s*(?:آخر|اخر|ثاني|مختلف|أخرى|اخرى)/u,
  /(?:تحقق|تأكد|راجع)\s*من\s*(?:الإعدادات|الاعدادات|إعداداتك|اعداداتك)/u,
];

// Blocker 3 — a GENERAL procedural/operational detector, not a finite blacklist.
// The invariant: ANY customer-facing procedural instruction (an imperative action
// verb applied to a device/account/technical object) must have positive verified
// support. GENERIC_TS_RES above stays only as extra precise phrasings; the general
// (verb + tech-object) detector catches actions the model invents that no list
// anticipated ("عطّل الـVPN", "غيّر صلاحيات التطبيق", "أعد تعيين كلمة المرور"…).
const TATWEEL_RE = /ـ/g;
function norm(s) {
  return normalizeArabic(String(s || '')).replace(TATWEEL_RE, '').toLowerCase();
}

const PROCEDURAL_VERB_RE = /(?:عطل|فعل|غير|اعد|احذف|امسح|اضف|اضيف|ثبت|حمل|نزل|حدث|اضبط|ازل|نظف|صفر|افصل|اوقف|جرب|حاول|شغل|اقفل|اعاده|تاكد|تحقق|راجع|reset|restart|clear|disable|enable|reinstall|reboot)/;
const TECH_OBJECT_RE = /(?:vpn|في\s?بي\s?ان|التطبيق|تطبيق|البرنامج|الابليكيشن|الصلاحيات|صلاحيات|الاذونات|كلمه\s?المرور|كلمه\s?السر|الباسورد|الباسوورد|الحساب|التخزين|المساحه|الذاكره|الكاش|الكوكيز|الاعدادات|اعدادات|اعداداتك|الجهاز|الهاتف|الجوال|الشبكه|الاتصال|الانترنت|النت|الراوتر|الواي\s?فاي|المتصفح|البروكسي|النظام|تسجيل\s?الدخول|تسجيل\s?الخروج|الدخول|الخروج)/;

function splitClauses(s) {
  return String(s || '').split(/[\n\r؛•.!?،؟]+/).map(c => c.trim()).filter(Boolean);
}

// A clause is procedural when it applies a procedural verb to a technical object.
function detectProceduralSteps(text) {
  const out = [];
  for (const clause of splitClauses(text)) {
    const n = norm(clause);
    if (PROCEDURAL_VERB_RE.test(n) && TECH_OBJECT_RE.test(n)) out.push(clause);
  }
  return out;
}

function detectGenericTroubleshooting(text) {
  const t = String(text || '');
  const hits = [];
  for (const re of GENERIC_TS_RES) {
    const m = t.match(re);
    if (m && m[0].trim()) hits.push(m[0].trim());
  }
  for (const clause of detectProceduralSteps(t)) hits.push(clause);
  return [...new Set(hits)];
}

function extractTechObjects(normText) {
  const found = [];
  const re = new RegExp(TECH_OBJECT_RE.source, 'g');
  let m;
  while ((m = re.exec(normText)) !== null) {
    found.push(m[0].replace(/\s+/g, ' ').trim());
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return [...new Set(found)];
}

// Blocker 2 — grounding requires POSITIVE documented evidence. Prohibitions are
// excluded (see groundingParts); a NEGATED clause ("لا تطلب… / ممنوع تقول…") is
// dropped so a forbidden-wording example never grounds the action it forbids.
const NEGATION_RE = /(?:لا\s*ت|لا\s*يجوز|لا\s*تقم|ممنوع|تجنّب|تجنب|غير\s*مسموح|مثال\s*خاطئ|صيغة?\s*ممنوع|صيغه?\s*ممنوع)/u;
function positiveRawClauses(config = {}) {
  const out = [];
  for (const part of groundingParts(config)) {
    for (const clause of splitClauses(part)) {
      if (!NEGATION_RE.test(clause)) out.push(clause);
    }
  }
  return out;
}

// Blocker 2 — a SEMANTIC problem/malfunction intent detector, tenant-agnostic and
// NOT keyword-bound. A customer who says "الاشتراك وقف" / "ما تشتغل" / "ما عاد يفتح"
// is reporting a problem even without the words مشكلة/عطل. Patterns are matched
// against normalized text. Deliberately malfunction-focused so a plain question
// ("كم السعر؟") is NOT a problem.
const PROBLEM_INTENT_RE = new RegExp([
  'وقف', 'توقف', 'وقفت', 'متوقف', 'تعطل', 'معطل', 'عطلان', 'خلل', 'مشكل', 'مشاكل', 'شكو',
  'ما\\s*(?:يشتغل|تشتغل|اشتغل|يعمل|تعمل|يفتح|تفتح|ينفتح|يرسل|يستقبل|يحمل|ينزل|يتصل|يظهر|يستجيب|يرد|راضي|يقبل)',
  'مو\\s*(?:شغال|راضي|فاتح|ضابط)',
  'ما\\s*عاد\\s*(?:يفتح|يشتغل|يعمل|اقدر)',
  'مايشتغل', 'مايفتح',
  // inability = friction/problem ("ما أقدر أسجّل دخول")
  'ما\\s*اقدر', 'ما\\s*استطيع', 'مو\\s*قادر', 'مب\\s*قادر', 'ما\\s*قدرت', 'عاجز\\s*عن',
  'فشل', 'فشلت', '\\berror\\b', 'خطا', 'ايرور', 'مرفوض', 'رفض\\s*(?:الدفع|العمليه|الطلب)',
  'انقطع', 'ما\\s*(?:وصل|وصلني|استلمت|استلم)', 'ضايع', 'اختفي', 'ما\\s*يظهر',
  'يعلق', 'معلق', 'بطيء', '\\bhang\\b', '\\bcrash\\b', 'كراش', 'يطلع\\s*خطا',
  'شي\\s*غلط', 'في\\s*شي\\s*غلط', 'ما\\s*ضبط', 'ما\\s*يضبط', 'صار\\s*في\\s*شي',
].join('|'), 'u');

function detectProblemIntent(text) {
  return PROBLEM_INTENT_RE.test(norm(text));
}

// A directive contains problem-escalation vocabulary (merchant's own words).
const PROBLEM_SCOPE_RE = /(?:مشكل|مشاكل|عطل|خلل|شكو|عطلان|يواجه|تواجه|صعوبه|صعوبة|شكوى)/u;

// Generic SCOPE families (platform-level, tenant-agnostic) used to tell a SCOPED
// problem directive ("مشاكل الدفع") from a UNIVERSAL one ("أي مشكلة"). A scoped
// directive only escalates when the customer's message is BOTH in that scope AND a
// real problem — so an unrelated failure never triggers another scope's policy.
const SCOPE_FAMILY_RES = {
  PAYMENT: /دفع|سداد|فاتوره|فواتير|بطاقه|مدفوع|الدفعه|مبلغ|\bpay(?:ment)?\b|checkout/u,
  LOGIN: /تسجيل\s*الدخول|تسجيل\s*الخروج|سجل\s*(?:دخول|خروج)|اسجل\s*(?:دخول|خروج)|الدخول|ادخل|كلمه\s*(?:المرور|السر)|الباسورد|\blogin\b/u,
  ORDER: /الطلبات|طلبات|الطلب|طلبي|طلبيه|\border\b/u,
  SHIPPING: /شحن|الشحنه|شحنه|توصيل|التوصيل|مندوب|ما\s*وصل|ما\s*وصلت|لم\s*يصل|\bdelivery\b|\bshipment\b/u,
  ACCOUNT: /الحساب|حسابي|بروفايل|الملف\s*الشخصي|\baccount\b/u,
  SUBSCRIPTION: /اشتراك|الاشتراك|باقه|الباقه|التجديد|\bsubscription\b/u,
};

function matchesScopeFamily(text, key) {
  const re = SCOPE_FAMILY_RES[key];
  return Boolean(re) && re.test(norm(text));
}

// Cut a directive at its escalation verb so the TARGET ("… للدعم"/"لقسم الطلبات")
// is never mistaken for the scope. Scope is read from the CONDITION side only.
const ESC_VERB_CUT_RE = /(?:حوّل|حول|صعّد|صعد|بلّغ|بلغ|كلّم|كلم|رجّع|راجع|حوّله|حوله|صعده)/u;

// UNIVERSAL when no SPECIFIC scope family is named on the condition side (e.g.
// "أي مشكلة", "كل الأعطال", "أي عطل في الخدمة"). SCOPED when a specific family is
// named (payment/login/order/…). A specific scope wins even with a quantifier
// ("أي مشكلة في الدفع" = payment-scoped).
function classifyEscalationScope(line) {
  const scopeSource = norm(String(line || '').split(ESC_VERB_CUT_RE)[0] || line);
  const scopes = [];
  for (const key of Object.keys(SCOPE_FAMILY_RES)) {
    if (SCOPE_FAMILY_RES[key].test(scopeSource)) scopes.push(key);
  }
  return { universal: scopes.length === 0, scopes };
}

const GROUND_STOP = new Set([
  'من', 'في', 'على', 'الى', 'إلى', 'عن', 'مع', 'ثم', 'أو', 'او', 'ما', 'لا', 'إذا', 'اذا', 'لو', 'أي', 'اي',
  'هذا', 'هذه', 'ذلك', 'انت', 'أنت', 'مره', 'مرة', 'ثاني', 'ثانيه', 'جديد', 'وبعدها', 'بعدها', 'قم',
]);

function tokenize(text) {
  return normalizeArabic(String(text || ''))
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .map(w => w.replace(/^ال/, ''))
    .filter(w => w.length >= 4 && !GROUND_STOP.has(w));
}

function groundingParts(config = {}) {
  const parts = [];
  const push = v => { if (v) parts.push(String(v)); };
  push(config.botInstructions);
  push(config.welcomeMessage);
  push(config.storeName);
  (Array.isArray(config.products) ? config.products : []).forEach((p) => {
    push(p && p.name); push(p && p.description); push(p && p.longDescription);
    (Array.isArray(p && p.variants) ? p.variants : []).forEach(v => push(v && v.label));
  });
  const strOf = x => (x == null ? '' : (typeof x === 'string' ? x : (x.text || x.line || x.value || x.policy || JSON.stringify(x))));
  (Array.isArray(config.tenantPolicies) ? config.tenantPolicies : []).forEach(x => push(strOf(x)));
  (Array.isArray(config.policies) ? config.policies : []).forEach(x => push(strOf(x)));
  (Array.isArray(config.slaPolicies) ? config.slaPolicies : []).forEach(x => push(strOf(x)));
  (Array.isArray(config.knowledge) ? config.knowledge : []).forEach(x => push(strOf(x)));
  // Blocker 2 — prohibitions are NEVER grounding: they document what NOT to say/do.
  // Including them would let "لا تقل: جرب تسجيل الدخول" ground "جرب تسجيل الدخول".
  return parts;
}

// Action FAMILIES group synonyms and, crucially, SEPARATE antonyms so an opposite
// action on the same object ("فعّل الـVPN" vs "عطّل الـVPN") is never treated as
// grounding. Patterns are written in NORMALIZED form (norm() strips shadda/hamza/
// tatweel and lowercases). "أعد X" resolves by its object word (login/restart/
// reinstall/reset). Order matters: the specific "اعد …" phrases come before the
// bare enable/disable verbs.
const FAMILY_PATTERNS = [
  ['RELOGIN', /(?:اعد|جرب|حاول|عاود|اعاده)\s*(?:اعاده\s*)?تسجيل\s*(?:الدخول|الخروج)/u],
  ['RESTART', /(?:اعد|اعاده)\s*(?:تشغيل|التشغيل)|\brestart\b|\breboot\b/u],
  ['REINSTALL', /(?:اعد|اعاده)\s*(?:تثبيت|التثبيت)|\breinstall\b/u],
  ['RESET', /(?:اعد|اعاده)\s*(?:تعيين|التعيين|ضبط|الضبط)|صفر|\breset\b/u],
  ['ENABLE', /فعل|تفعيل|شغل|\benable\b|\bactivate\b/u],
  ['DISABLE', /عطل|اوقف|ايقاف|افصل|اقفل|تعطيل|\bdisable\b/u],
  ['ADD', /اضف|اضيف|اضافه|\badd\b/u],
  ['REMOVE', /احذف|امسح|ازل|حذف|مسح|ازاله|تفريغ|نظف|تنظيف|\bdelete\b|\bremove\b|\bclear\b/u],
  ['UPDATE', /حدث|تحديث|\bupdate\b/u],
  ['CHANGE', /غير|بدل|تغيير|\bchange\b/u],
  ['CHECK', /تاكد|تحقق|راجع|افحص|\bcheck\b|\bverify\b/u],
];

function actionFamilies(normText) {
  const fams = new Set();
  for (const [fam, re] of FAMILY_PATTERNS) if (re.test(normText)) fams.add(fam);
  return fams;
}

function proceduralVerbRoots(normText) {
  const roots = new Set();
  const re = new RegExp(PROCEDURAL_VERB_RE.source, 'gu');
  let m;
  while ((m = re.exec(normText)) !== null) {
    roots.add(m[0]);
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
  return roots;
}

// The comparable action key(s) of a clause: prefer the semantic family; fall back
// to the exact verb root when no family is recognized (so an unlisted verb still
// only grounds itself, never an antonym).
function actionKeys(normText) {
  const fams = actionFamilies(normText);
  return fams.size ? fams : proceduralVerbRoots(normText);
}

// Grounding = POSITIVE, ACTION-LEVEL evidence with matching action FAMILY. A
// procedural step is grounded ONLY when a positive (non-negated, non-prohibition)
// tenant clause applies the SAME action family to the SAME technical object. Naming
// the object ("صفحة تسجيل الدخول"), the opposite action ("فعّل" vs "عطّل"), a
// prohibition, or a negated example never grounds it. Family-based, so it also
// covers actions no fixed list anticipated.
function hasGroundingSupport(step, config = {}) {
  const rawClauses = positiveRawClauses(config);
  if (!rawClauses.length) return false;
  const s = norm(step);
  const objects = extractTechObjects(s);
  const stepKeys = actionKeys(s);
  const stepIsProcedural = objects.length > 0
    && (actionFamilies(s).size > 0 || PROCEDURAL_VERB_RE.test(s))
    && stepKeys.size > 0;

  if (stepIsProcedural) {
    return rawClauses.some((c) => {
      const cn = norm(c);
      if (!objects.some((o) => cn.includes(o))) return false;
      const ck = actionKeys(cn);
      for (const k of stepKeys) if (ck.has(k)) return true;
      return false;
    });
  }
  // Family fallback for a known troubleshooting phrase without an extractable
  // object (e.g. a bare English "restart"): require the same family, positively.
  const family = GENERIC_TS_RES.find((re) => re.test(step));
  if (family) return rawClauses.some((c) => family.test(c));
  // Non-procedural step → content-token overlap over the positive corpus.
  const tokens = tokenize(step);
  return tokens.length > 0 && rawClauses.map(norm).some((c) => tokens.some((tok) => c.includes(tok)));
}

function stripGenericTroubleshooting(text, config = {}) {
  let out = String(text || '');
  for (const step of detectGenericTroubleshooting(out)) {
    if (hasGroundingSupport(step, config)) continue; // documented → keep
    // remove the step, plus a leading connector "و" / trailing punctuation glue
    const esc = step.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\s*و?\\s*${esc}`, 'u'), ' ');
  }
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([،.!؟])/g, '$1')
    .replace(/^[\s،.!؟-]+/u, '')
    .replace(/(?:^|\s)و\s*(?=[،.]|$)/u, '')
    .trim();
}

// ── Runtime shadow-routing of LEGACY botInstructions (no DB migration) ───────
// Reuses the PURE classifier to surface an "escalate any problem" directive that
// a merchant only ever wrote in free text, turning it into structured rules the
// existing deterministic escalation engine can act on — WITHOUT rewriting the
// stored config. A DEFERRED directive ("escalate only if unresolved") is NOT
// promoted (that tenant wants an answer first). A target that resolves to no real
// contact is skipped (never an invented/silent promise).
const DEFERRAL_RE = /(?:فقط\s*)?(?:لو|إذا|اذا|إن|ان)\s*(?:ما|لم|لن)\b|بعد(?:\s*ما)?\b|only\s*if|إن\s*لم|ما\s*(?:انحل|تحل|انحلت|تنحل|تنحلّ|انحلّت)|لم\s*(?:تُحل|تحل|ينحل)|إلا\s*(?:إذا|اذا|بعد)|أولا|اولا|أولاً|اولاً/u;

const ESC_VERBS = new Set(['حول', 'حوله', 'حولها', 'حولهم', 'صعد', 'صعده', 'صعدها', 'بلغ', 'كلم', 'رجع', 'راجع', 'حولوا']);
const DIRECTIVE_STOP = new Set([
  'اي', 'أي', 'كل', 'جميع', 'كافه', 'كافة', 'في', 'من', 'الى', 'إلى', 'على', 'مع', 'او', 'أو', 'و',
  'اذا', 'إذا', 'لو', 'عند', 'التي', 'الذي', 'هذا', 'هذه', 'يواجه', 'يواجهه', 'تواجه', 'العميل', 'الزبون',
]);

function resolveShadowContact(config, targetName) {
  const contacts = Array.isArray(config && config.escalationContacts) ? config.escalationContacts : [];
  const strip = s => normalizeArabic(s).replace(/^ال/, '');
  const want = strip(targetName);
  if (!want) return null;
  const matches = contacts.filter(c => c && contactHasDestination(c) && strip(c.name) === want);
  return matches.length === 1 ? matches[0] : null;
}

function deriveEscalationRulesFromInstructions(config = {}) {
  const text = String((config && config.botInstructions) || '').trim();
  if (!text) return [];
  const rules = [];
  for (const seg of classifyInstruction(text)) {
    if (seg.category !== 'ESCALATION') continue;
    if (DEFERRAL_RE.test(seg.line)) continue; // "escalate only if unresolved" → not a precedence rule
    const targetName = extractTargetName(seg.line);
    if (!targetName) continue;
    const contact = resolveShadowContact(config, targetName);
    if (!contact) continue; // no real destination → never invent one
    const targetId = contactStableId(contact);
    const seen = new Set();
    const add = (trigger_type, trigger_value) => {
      const v = normalizeArabic(trigger_value).replace(/^ال/, '');
      if (!v || v.length < 4 || seen.has(v)) return;
      seen.add(v);
      rules.push({ trigger_type, trigger_value: v, target_contact_id: targetId, _shadow: true });
    };
    // A problem-escalation directive ("… مشكلة/عطل/شكوى … صعّد") is represented by
    // a SEMANTIC intent rule, never brittle content keywords. UNIVERSAL scope → a
    // global problem_intent; a SPECIFIC scope → a scoped_problem_intent that fires
    // only when the customer is BOTH in that scope AND reporting a real problem.
    if (PROBLEM_SCOPE_RE.test(seg.line)) {
      const { universal, scopes } = classifyEscalationScope(seg.line);
      if (universal) {
        rules.push({ trigger_type: 'problem_intent', trigger_value: '', target_contact_id: targetId, _shadow: true });
      } else {
        for (const sc of scopes) {
          rules.push({ trigger_type: 'scoped_problem_intent', trigger_value: sc, target_contact_id: targetId, _shadow: true });
        }
      }
      continue; // do NOT also emit brittle content-keyword rules for a problem directive
    }
    // Non-problem directive (e.g. "أسئلة الأسعار صعّدها لسعود") → topic/keyword.
    const t = buildTrigger(seg.line);
    if (t && (t.trigger_type === 'topic' || t.trigger_type === 'keyword')) add('keyword', t.trigger_value);
    const targetNorm = normalizeArabic(targetName).replace(/^ال/, '');
    normalizeArabic(seg.line)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map(w => w.replace(/^ال/, ''))
      .filter(w => w.length >= 4 && !DIRECTIVE_STOP.has(w) && !ESC_VERBS.has(w) && w !== targetNorm)
      .forEach(w => add('keyword', w));
  }
  return rules;
}

// ── Split legacy botInstructions for the prompt (§2/§10) ─────────────────────
// STYLE (and UNKNOWN, which is NEVER promoted to platform authority) → the
// subordinate persona block. Every operational category (knowledge, policy, SLA,
// escalation, action, prohibition) → an authoritative "tenant facts/rules" block.
// Nothing is dropped — the merchant blob is REORGANIZED by authority, not
// truncated away — so a merchant who put products/policies in free text keeps
// them as truth while the blob stops being the dominating prompt base.
const FACTS_CATEGORIES = new Set(['KNOWLEDGE', 'POLICY', 'SLA_TIME', 'ESCALATION', 'ACTION', 'PROHIBITION']);

function splitInstructionsForPrompt(text) {
  const persona = [];
  const facts = [];
  for (const seg of classifyInstruction(text)) {
    if (FACTS_CATEGORIES.has(seg.category)) facts.push(seg.line);
    else persona.push(seg.line); // STYLE + UNKNOWN → subordinate persona only
  }
  return { personaText: persona.join('\n').trim(), factsText: facts.join('\n').trim() };
}

// ── Concise, action-honest acknowledgements ─────────────────────────────────
// Blocker 5 — the ack must be tied ONLY to the action that actually happened
// (the request was raised to the team). It must NOT promise a contact time unless
// the tenant has a DOCUMENTED SLA window; then, and only then, we state that
// documented window. No "بأقرب وقت"/"بيتواصلون معك" invented promises.
function firstSlaWindow(config = {}) {
  const list = Array.isArray(config.slaPolicies) ? config.slaPolicies : [];
  for (const p of list) {
    const amount = p && (p.amount != null ? p.amount : p.value);
    const unit = p && (p.unit || p.unit_ar);
    if (Number.isFinite(Number(amount)) && Number(amount) > 0 && unit) {
      return { amount: Number(amount), unit: String(unit) };
    }
  }
  return null;
}

// Blocker 4 — platform safety fallbacks are TONE-NEUTRAL: no emoji, no warmth
// baked in. Any friendliness/emoji is the tenant's STYLE layer, applied later —
// never hardcoded into the safety contract.
function buildHandoffAck(config = {}) {
  const base = 'تم رفع طلبك للفريق المختص.';
  const sla = firstSlaWindow(config);
  return sla ? `${base} وسيتم الرد خلال ${sla.amount} ${sla.unit}.` : base;
}

function buildNeutralAck() {
  // Claims NO action. Tone-neutral (no emoji) — see buildHandoffAck note.
  return 'وصلتني رسالتك.';
}

/**
 * The decision contract, applied to a finalized draft.
 * @returns {{ reply:string, decision:string, diagnostics:string[] }}
 */
function reconcileSupportReply({ reply, config = {}, escalationEnqueued = false, escalationPolicyMatched = false, customerText = '' } = {}) {
  const original = String(reply || '');
  if (killed()) return { reply: original, decision: 'DISABLED', diagnostics: [] };

  const diagnostics = [];

  // §3 step 1 — a matching tenant escalation policy WINS: real escalation, one
  // concise ack, and NO self-generated troubleshooting reaches the customer.
  if (escalationPolicyMatched && escalationEnqueued) {
    return { reply: buildHandoffAck(config), decision: 'ESCALATE_REAL', diagnostics: ['escalation_policy_precedence'] };
  }

  let out = original;

  // §4/§5 — a handoff/review/callback claim is allowed ONLY with a real escalation.
  if (!escalationEnqueued && detectActionClaim(out).claimed) {
    out = stripActionClaims(out);
    diagnostics.push('claim_without_escalation');
  }

  // §1 — invented operational troubleshooting the tenant never documented.
  if (!escalationEnqueued) {
    const ungrounded = detectGenericTroubleshooting(out).filter(step => !hasGroundingSupport(step, config));
    if (ungrounded.length) {
      out = stripGenericTroubleshooting(out, config);
      diagnostics.push('ungrounded_troubleshooting_stripped');
    }
  }

  // Safety floor — a strip must never leave the customer with an empty reply.
  if (out.trim().length < 2) {
    out = buildNeutralAck();
    return { reply: out, decision: 'ACKNOWLEDGE_NO_ACTION', diagnostics };
  }

  if (diagnostics.length) {
    return { reply: out.trim(), decision: escalationEnqueued ? 'ESCALATE_REAL' : 'ANSWER_VERIFIED', diagnostics };
  }
  return { reply: original, decision: escalationEnqueued ? 'ESCALATE_REAL' : 'ANSWER_VERIFIED', diagnostics };
}

module.exports = {
  detectActionClaim,
  stripActionClaims,
  hasGroundingSupport,
  detectGenericTroubleshooting,
  stripGenericTroubleshooting,
  deriveEscalationRulesFromInstructions,
  reconcileSupportReply,
  buildHandoffAck,
  buildNeutralAck,
  splitInstructionsForPrompt,
  detectProblemIntent,
  matchesScopeFamily,
  classifyEscalationScope,
};
