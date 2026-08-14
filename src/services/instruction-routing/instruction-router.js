'use strict';

/**
 * Instruction Routing Layer — router (PURE, no I/O).
 *
 * Given a classified instruction segment and the tenant config, decide WHERE it
 * belongs (the structured sink) instead of dumping operational text into the
 * free-text prompt. The load-bearing case is ESCALATION: an escalation to a
 * target that cannot be resolved to a real destination must NOT be stored
 * silently (the old bug where the bot promised a transfer nobody received) — it
 * asks the merchant to finish setting up the target.
 */

// ل-prefixed words that are NOT an escalation target ("if", "but", "we have"...).
const L_STOPWORDS = new Set([
  'لو', 'لكن', 'لا', 'لم', 'لن', 'لماذا', 'لدينا', 'لديك', 'له', 'لها', 'لهم', 'لك', 'لي', 'لنا',
]);
const PREPOSITIONS = new Set(['إلى', 'الى', 'الي']);

function normalizeArabic(s) {
  return String(s == null ? '' : s)
    .replace(/[ً-ْٰ]/g, '')
    .replace(/[إأآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .trim();
}

function contactHasDestination(contact) {
  if (!contact || typeof contact !== 'object') return false;
  return Boolean(
    String(contact.target || '').trim()
    || String(contact.jid || '').trim()
    || String(contact.groupJid || '').trim()
    || String(contact.phone || '').trim(),
  );
}

function cleanTarget(token) {
  return String(token || '').replace(/[،.؟!:]+$/u, '').trim();
}

// Extract the escalation target name. Two Arabic forms: an explicit preposition
// ("إلى سعود" → next token) or the attached ل-prefix ("لسعود" → "سعود", "للفريق"
// → "فريق"). ل-stopwords ("لو", "لكن"...) and ال-words are skipped. A missing
// target is the signal to ask the merchant who to escalate to (clarify).
function extractTargetName(line) {
  const tokens = String(line || '').split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (PREPOSITIONS.has(tokens[i]) && tokens[i + 1]) {
      const name = cleanTarget(tokens[i + 1]);
      if (name) return name;
    }
  }
  for (const t of tokens) {
    if (t.length >= 3 && t[0] === 'ل' && !t.startsWith('لا') && !L_STOPWORDS.has(t)) {
      let name = t.slice(1);
      if (name.startsWith('ل')) name = name.slice(1); // "للفريق" → "فريق"
      name = cleanTarget(name);
      if (name) return name;
    }
  }
  return null;
}

function extractCondition(line) {
  const m = String(line || '').match(/(?:إذا|اذا|لو|عند|في\s*حال|متى|حينما)\s+(.+?)(?:\s+(?:حوّل|حول|صعّد|صعد|بلّغ|بلغ|كلّم|كلم|رجّع|راجع)|$)/);
  return m ? m[1].trim() : '';
}

function resolveContactByName(config, targetName) {
  const contacts = Array.isArray(config && config.escalationContacts) ? config.escalationContacts : [];
  const t = normalizeArabic(targetName);
  if (!t) return null;
  return contacts.find((c) => {
    const n = normalizeArabic(c && c.name);
    return n && (n.includes(t) || t.includes(n));
  }) || null;
}

function routeEscalation(segment, config) {
  const line = segment.line;
  const condition = extractCondition(line);
  const targetName = extractTargetName(line);
  if (!targetName) {
    return { sink: 'escalation', op: 'needs_clarification', reason: 'no_target', condition };
  }
  const contact = resolveContactByName(config, targetName);
  if (contact && contactHasDestination(contact)) {
    return { sink: 'escalationRule', op: 'add', targetName, condition, resolved: true };
  }
  // Named but no real destination on file → do NOT store silently and do NOT let
  // the bot promise a transfer; ask the merchant to complete the target setup.
  return { sink: 'escalation', op: 'needs_target_setup', targetName, condition, resolved: false };
}

function extractDuration(line) {
  const m = String(line || '').match(/(\d+)\s*(ساعة|ساعه|ساعات|يوم|أيام|ايام|دقيقة|دقائق|أسبوع|اسبوع)/);
  if (!m) return { amount: null, unit: null };
  return { amount: parseInt(m[1], 10), unit: m[2] };
}

/**
 * Decide the structured destination for a classified segment. Returns null for a
 * null/empty segment. STYLE is the only thing that stays in botInstructions.
 */
function routeInstruction(segment, config = {}) {
  if (!segment || !segment.category) return null;
  switch (segment.category) {
    case 'STYLE':
      return { sink: 'botInstructions', op: 'append_persona', line: segment.line };
    case 'KNOWLEDGE':
      return { sink: 'products', op: 'suggest', line: segment.line };
    case 'POLICY':
      return { sink: 'policy', op: 'add', line: segment.line };
    case 'SLA_TIME':
      return { sink: 'slaPolicy', op: 'add', duration: extractDuration(segment.line), line: segment.line };
    case 'PROHIBITION':
      return { sink: 'avoidPhrases', op: 'add', line: segment.line };
    case 'ACTION':
      // No action-execution layer exists yet; flag that it needs a real tool and
      // must never be reported as done from prose alone.
      return { sink: 'actionPolicy', op: 'add', requiresTool: true, line: segment.line };
    case 'ESCALATION':
      return routeEscalation(segment, config);
    default:
      return { sink: 'botInstructions', op: 'append_persona', line: segment.line };
  }
}

module.exports = {
  routeInstruction,
  routeEscalation,
  extractTargetName,
  extractCondition,
  extractDuration,
  contactHasDestination,
  resolveContactByName,
};
