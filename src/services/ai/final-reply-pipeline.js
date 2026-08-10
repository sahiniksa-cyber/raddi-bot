'use strict';

const {
  buildProductFactCatalog,
  resolveProductFocus,
} = require('../products/product-facts');
const {
  buildDeterministicCatalogReply,
  validateCommercialClaims,
} = require('./product-claim-validator');

const VALIDATOR_VERSION = 'product-tuples-v1';
const MAX_REPAIRS = 1;

function compactIssue(issue) {
  return {
    type: String(issue?.type || 'unsupported_product_claim').slice(0, 80),
    reason: String(issue?.reason || 'unknown').slice(0, 80),
    value: String(issue?.value || '').slice(0, 240),
    productId: issue?.productId ? String(issue.productId).slice(0, 120) : null,
  };
}

function runChecks(reply, { catalog, focus }) {
  return validateCommercialClaims(reply, { catalog, focus });
}

function priorProductIssues(reviewerAudit = {}) {
  return [
    ...(Array.isArray(reviewerAudit.deterministicIssuesBefore) ? reviewerAudit.deterministicIssuesBefore : []),
    ...(Array.isArray(reviewerAudit.deterministicIssuesAfter) ? reviewerAudit.deterministicIssuesAfter : []),
    ...(Array.isArray(reviewerAudit.initialIssues) ? reviewerAudit.initialIssues : []),
  ]
    .filter(issue => issue?.type === 'unsupported_product_claim')
    .map(compactIssue);
}

function finalizeReply({
  draft,
  history = [],
  customerText = '',
  config = {},
  catalogVersion = config.productCatalogVersion || 0,
  reviewerAudit = {},
  repairReplyBuilder = buildDeterministicCatalogReply,
} = {}) {
  const catalog = buildProductFactCatalog(config, { catalogVersion });
  let focus = resolveProductFocus({ catalog, history, customerText });
  if (focus.status === 'unknown' && catalog.products.length === 1) {
    focus = {
      status: 'resolved',
      source: 'single_catalog_product',
      productIds: [catalog.products[0].productId],
    };
  }
  const originalReply = String(draft || '').trim();
  const stages = [];

  const initial = runChecks(originalReply, { catalog, focus });
  const currentIssues = initial.issues.map(compactIssue);
  const carriedIssues = priorProductIssues(reviewerAudit);
  const initialIssues = [
    ...currentIssues,
    ...carriedIssues,
  ].filter((issue, index, all) => (
    all.findIndex(candidate =>
      candidate.type === issue.type
      && candidate.reason === issue.reason
      && candidate.value === issue.value
      && candidate.productId === issue.productId) === index
  ));
  stages.push({
    stage: 'draft_validation',
    valid: initial.valid,
    issueCount: currentIssues.length,
    priorIssueCount: carriedIssues.length,
  });

  if (initial.valid && (carriedIssues.length === 0 || initial.claims.length > 0)) {
    const repairedBeforeFinalStage = carriedIssues.length > 0;
    return {
      decision: 'validated',
      reply: originalReply,
      reason: repairedBeforeFinalStage ? 'validated_external_repair' : 'all_checks_passed',
      repairCount: 0,
      claims: initial.claims,
      focus,
      stages,
      audit: {
        validatorVersion: VALIDATOR_VERSION,
        catalogVersion: catalog.version,
        confidence: repairedBeforeFinalStage
          ? Math.min(0.95, Math.max(0, Number(reviewerAudit.confidence ?? 0.95)))
          : Math.min(1, Math.max(0, Number(reviewerAudit.confidence ?? 1))),
        unsupportedClaims: carriedIssues.map(issue => issue.value),
        initialIssues: carriedIssues,
        finalIssues: [],
      },
    };
  }

  let repaired;
  try {
    repaired = repairReplyBuilder({
      customerText,
      focus,
      catalog,
      draft: originalReply,
      issues: initialIssues,
    });
  } catch (error) {
    stages.push({
      stage: 'repair',
      attempted: true,
      succeeded: false,
      reason: 'repair_builder_failed',
    });
    return {
      decision: 'blocked',
      reply: '',
      reason: 'repair_builder_failed',
      repairCount: MAX_REPAIRS,
      claims: [],
      focus,
      stages,
      audit: {
        validatorVersion: VALIDATOR_VERSION,
        catalogVersion: catalog.version,
        confidence: 0,
        unsupportedClaims: initialIssues.map(issue => issue.value),
        initialIssues,
        finalIssues: initialIssues,
        error: String(error?.message || error).slice(0, 240),
      },
    };
  }

  const repairedReply = String(
    typeof repaired === 'string' ? repaired : repaired?.reply || '',
  ).trim();
  const repairDecision = typeof repaired === 'object' ? repaired?.decision : 'answer';
  stages.push({
    stage: 'repair',
    attempted: true,
    succeeded: Boolean(repairedReply),
    strategy: repairDecision === 'clarify' ? 'safe_clarification' : 'catalog_answer',
  });

  const final = runChecks(repairedReply, { catalog, focus });
  const finalIssues = final.issues.map(compactIssue);
  stages.push({
    stage: 'final_validation',
    valid: Boolean(repairedReply) && final.valid,
    issueCount: finalIssues.length,
  });

  const audit = {
    validatorVersion: VALIDATOR_VERSION,
    catalogVersion: catalog.version,
    confidence: Math.min(0.95, Math.max(0, Number(reviewerAudit.confidence ?? 0.95))),
    unsupportedClaims: initialIssues.map(issue => issue.value),
    initialIssues,
    finalIssues,
  };

  if (!repairedReply || !final.valid) {
    return {
      decision: 'blocked',
      reply: '',
      reason: !repairedReply ? 'empty_repair' : 'repair_failed_validation',
      repairCount: MAX_REPAIRS,
      claims: final.claims,
      focus,
      stages,
      audit,
    };
  }

  return {
    decision: 'validated',
    reply: repairedReply,
    reason: repairDecision === 'clarify' ? 'safe_product_clarification' : 'deterministic_product_repair',
    repairCount: MAX_REPAIRS,
    claims: final.claims,
    focus,
    stages,
    audit,
  };
}

module.exports = {
  MAX_REPAIRS,
  VALIDATOR_VERSION,
  finalizeReply,
};
