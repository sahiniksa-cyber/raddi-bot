'use strict';

/**
 * Instruction Routing Layer — prohibition & tenant-policy prompt blocks (PURE).
 *
 * Render the structured config.prohibitions and config.tenantPolicies captured by
 * the router as explicit prompt facts, so operational rules the merchant added
 * actually shape replies instead of sitting unused (or leaking into the free-text
 * blob). Both are additive and empty when there is nothing to say.
 */

function lines(entries) {
  return (Array.isArray(entries) ? entries : [])
    .map((e) => String((e && e.text) || '').trim())
    .filter(Boolean);
}

function buildProhibitionsBlock(prohibitions) {
  const items = lines(prohibitions);
  if (!items.length) return '';
  return `\n\n🚫 ممنوعات صريحة (لا تفعل هذا إطلاقاً):\n${items.map((t) => `- ${t}`).join('\n')}`;
}

function buildTenantPoliciesBlock(tenantPolicies) {
  const items = lines(tenantPolicies);
  if (!items.length) return '';
  return `\n\n📋 سياسات المتجر (اذكرها بدقة كما هي):\n${items.map((t) => `- ${t}`).join('\n')}`;
}

module.exports = { buildProhibitionsBlock, buildTenantPoliciesBlock };
