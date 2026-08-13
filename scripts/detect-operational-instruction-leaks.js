'use strict';

/**
 * READ-ONLY detector: how much OPERATIONAL instruction has leaked into the
 * free-text config fields (botInstructions, escalationConditions) across ALL
 * tenants. It classifies each line into the platform's instruction categories
 * (Style / Knowledge / Policy / SLA-Time / Escalation / Action / Prohibition)
 * and proposes its structured home — WITHOUT changing any config and WITHOUT any
 * migration. Output is a report for human review before anything is converted.
 *
 * SAFETY: read-only. Requires an explicit LEAK_SCAN_DATABASE_URL (never the app's
 * DATABASE_URL) and LEAK_SCAN_CONFIRM=1. Runs the query in a READ ONLY
 * transaction as belt-and-suspenders. Does exactly one SELECT; no writes ever.
 *
 * Usage:
 *   LEAK_SCAN_CONFIRM=1 LEAK_SCAN_DATABASE_URL=postgres://... \
 *   node scripts/detect-operational-instruction-leaks.js [--json report.json]
 *
 * The classifier (classifyInstructionLine) is pure and unit-tested separately.
 */

// ── Pure classifier (no I/O) ───────────────────────────────────────────────

const CATEGORY_TARGET = {
  ESCALATION: 'escalationContacts + قاعدة تصعيد (شرط → جهة حقيقية)',
  ACTION: 'Action policy (لا يُعدّ منفَّذاً إلا بعد Tool/Action ناجح)',
  SLA_TIME: 'سياسة SLA زمنية قابلة للحساب',
  PROHIBITION: 'replyStyle.avoidPhrases / سياسة منع منظّمة',
  POLICY: 'سياسة متجر منظّمة (Knowledge/Policy)',
  KNOWLEDGE: 'products / قاعدة معرفة منظّمة',
  STYLE: 'يبقى في الأسلوب/الشخصية (ليس تسريباً)',
  UNKNOWN: 'مراجعة يدوية',
};

const SEVERITY = {
  ESCALATION: 'high', ACTION: 'high', SLA_TIME: 'high',
  PROHIBITION: 'medium', POLICY: 'medium',
  KNOWLEDGE: 'low', STYLE: 'none', UNKNOWN: 'low',
};

const RE = {
  escVerb: /(?:حوّل|حول|صعّد|صعد|بلّغ|بلغ|كلّم|كلم|رجّع|راجع|حوّله|حوله|صعده|اتصل|تواصل)/,
  escTarget: /(?:موظف|مختص|مسؤول|المدير|المالك|الدعم|الفريق|خدمة العملاء|القسم|الرقم|واتساب|\+?\d[\d\s-]{6,})/,
  cond: /(?:إذا|اذا|لو|عند|في\s*حال|متى|حينما)/,
  // NOTE: bare "غير" (= not/other) is intentionally excluded; only the "change"
  // sense (غيّر, or غير + a definite noun) counts as an action, so "سعر غير مؤكد"
  // is not misread as an action.
  actionVerb: /(?:ألغِ|ألغ|الغِ|الغاء|إلغاء|عدّل|عدّله|عدل|أرسل|ارسل|سجّل|سجل|احجز|غيّر|غيِّر|غير\s+ال\S+|استرجع|افتح\s*تذكرة|ارفع\s*(?:طلب|تذكرة)|نفّذ|نفذ|فعّل|فعل)/,
  sla: /(?:خلال\s*\d+\s*(?:ساعة|ساعه|ساعات|يوم|أيام|ايام|دقيقة|دقائق|أسبوع|اسبوع))|(?:\d+\s*(?:ساعة|ساعه|ساعات|يوم|أيام|ايام)\b)|(?:يوم\s*عمل)|(?:خلال\s*يوم)/,
  prohibition: /(?:ممنوع|لا\s*ترد|لا\s*تعطي|لا\s*تذكر|لا\s*تقل|لا\s*تعد|تجنّب|تجنب|ما\s*تسوي|لا\s*تسمح|لا\s*تفتح|لا\s*تخبر)/,
  policyKw: /(?:سياسة|شروط|استرجاع|استبدال|ضمان|شحن|توصيل|الدفع|دفع|خصم|كوبون|عرض|فاتورة|استرداد)/,
  knowledge: /(?:سعر|السعر|ريال|متوفر|المنتج|الكمية|مقاس|لون|الموديل|الماركة)/,
  style: /(?:نبرة|لهجة|أسلوب|اسلوب|رحّب|رحب|اختصر|إيموجي|ايموجي|emoji|شخصيت|بلطف|ودود|مهذب|مختصر|لا\s*تطوّل|تكلم|صياغة)/,
};

function mk(category, confidence, line, field) {
  return {
    category,
    confidence,
    severity: SEVERITY[category],
    proposedTarget: CATEGORY_TARGET[category],
    isLeak: category !== 'STYLE' && category !== 'UNKNOWN',
    line,
    field,
  };
}

/**
 * Classify a single free-text instruction line. Returns null for empty/trivial
 * lines. Priority order puts the most operationally risky categories first so a
 * line that both routes and mentions a policy is flagged as ESCALATION/ACTION.
 */
function classifyInstructionLine(rawLine, { field = 'botInstructions' } = {}) {
  const line = String(rawLine == null ? '' : rawLine).trim();
  if (line.length < 3) return null;

  // The routing verbs (حوّل/صعّد/بلّغ/كلّم…) are inherently escalation intent, even
  // when the target is a bare name (e.g. "حوّل لسعود") that no structured field
  // recognises yet — which is precisely the leak we must catch. Confidence scales
  // with whether a structured target or a condition is also present.
  if (RE.escVerb.test(line)) {
    const conf = RE.escTarget.test(line) ? 0.9 : RE.cond.test(line) ? 0.8 : 0.65;
    return mk('ESCALATION', conf, line, field);
  }
  // Prohibition is checked before Action: "ممنوع ..." is a strong, unambiguous
  // signal and outranks any action verb that may also appear in the sentence.
  if (RE.prohibition.test(line)) return mk('PROHIBITION', 0.75, line, field);
  if (RE.actionVerb.test(line)) return mk('ACTION', 0.8, line, field);
  if (RE.sla.test(line)) return mk('SLA_TIME', 0.85, line, field);
  if (RE.policyKw.test(line)) return mk('POLICY', RE.cond.test(line) ? 0.7 : 0.55, line, field);
  if (RE.knowledge.test(line)) return mk('KNOWLEDGE', 0.5, line, field);
  if (RE.style.test(line)) return mk('STYLE', 0.6, line, field);
  // The escalationConditions field is operational by definition: an unclassified
  // line there is still an escalation-policy candidate, not benign style.
  if (field === 'escalationConditions') return mk('ESCALATION', 0.5, line, field);
  return { category: 'UNKNOWN', confidence: 0.3, severity: SEVERITY.UNKNOWN, proposedTarget: CATEGORY_TARGET.UNKNOWN, isLeak: false, line, field };
}

function splitLines(text) {
  return String(text == null ? '' : text)
    .split(/[\n\r؛•]+|(?:[.!؟]\s)/)
    .map(s => s.trim())
    .filter(Boolean);
}

function scanConfig(config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const out = [];
  for (const field of ['botInstructions', 'escalationConditions']) {
    for (const line of splitLines(cfg[field])) {
      const r = classifyInstructionLine(line, { field });
      if (r) out.push(r);
    }
  }
  return out;
}

module.exports = { classifyInstructionLine, scanConfig, splitLines, CATEGORY_TARGET, SEVERITY };

// ── Runner (only when executed directly) ───────────────────────────────────

async function main() {
  const { Pool } = require('pg');
  const url = process.env.LEAK_SCAN_DATABASE_URL;
  if (process.env.LEAK_SCAN_CONFIRM !== '1') { console.error('Refusing to run: set LEAK_SCAN_CONFIRM=1 (read-only scan).'); process.exit(2); }
  if (!url) { console.error('Refusing to run: set LEAK_SCAN_DATABASE_URL (NOT the app DATABASE_URL).'); process.exit(2); }

  const jsonIdx = process.argv.indexOf('--json');
  const jsonPath = jsonIdx > -1 ? process.argv[jsonIdx + 1] : null;

  const pool = new Pool({ connectionString: url, ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  let rows;
  try {
    await client.query('BEGIN TRANSACTION READ ONLY'); // hard guarantee: no writes
    const res = await client.query('SELECT user_id, config FROM bot_configs');
    rows = res.rows;
    await client.query('COMMIT');
  } finally {
    client.release();
    await pool.end();
  }

  const perTenant = [];
  const totals = {}; // category -> count
  let tenantsWithLeaks = 0;
  for (const row of rows) {
    const findings = scanConfig(row.config).filter(f => f.isLeak);
    if (!findings.length) continue;
    tenantsWithLeaks += 1;
    for (const f of findings) totals[f.category] = (totals[f.category] || 0) + 1;
    perTenant.push({ userId: row.user_id, findings });
  }

  // ── Report ──
  console.log(`Operational-instruction leak scan (READ-ONLY)`);
  console.log(`  tenants scanned: ${rows.length}`);
  console.log(`  tenants with leaks: ${tenantsWithLeaks}`);
  console.log(`  leak lines by category:`);
  for (const cat of ['ESCALATION', 'ACTION', 'SLA_TIME', 'PROHIBITION', 'POLICY', 'KNOWLEDGE']) {
    if (totals[cat]) console.log(`     ${cat.padEnd(12)} ${totals[cat]}  [${SEVERITY[cat]}] → ${CATEGORY_TARGET[cat]}`);
  }
  console.log('');
  for (const t of perTenant) {
    console.log(`tenant ${t.userId} — ${t.findings.length} leak line(s):`);
    for (const f of t.findings) {
      const snippet = f.line.length > 90 ? f.line.slice(0, 87) + '…' : f.line;
      console.log(`  [${f.category} ${f.severity} conf=${f.confidence}] (${f.field}) "${snippet}"`);
      console.log(`       → ${f.proposedTarget}`);
    }
  }

  if (jsonPath) {
    const fs = require('fs');
    fs.writeFileSync(jsonPath, JSON.stringify({ scannedTenants: rows.length, tenantsWithLeaks, totals, perTenant }, null, 2));
    console.log(`\nJSON report written to ${jsonPath}`);
  }
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
