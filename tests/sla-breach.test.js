'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSlaDurationMs,
  computeSlaBreach,
  buildSlaBreachBlock,
} = require('../src/services/instruction-routing/sla-breach');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

// ── parseSlaDurationMs ────────────────────────────────────────────────
test('parseSlaDurationMs: hours (all Arabic spellings)', () => {
  assert.equal(parseSlaDurationMs({ amount: 12, unit: 'ساعة' }), 12 * HOUR);
  assert.equal(parseSlaDurationMs({ amount: 12, unit: 'ساعه' }), 12 * HOUR);
  assert.equal(parseSlaDurationMs({ amount: 3, unit: 'ساعات' }), 3 * HOUR);
});

test('parseSlaDurationMs: minutes / days / weeks', () => {
  assert.equal(parseSlaDurationMs({ amount: 30, unit: 'دقيقة' }), 30 * 60 * 1000);
  assert.equal(parseSlaDurationMs({ amount: 2, unit: 'يوم' }), 2 * DAY);
  assert.equal(parseSlaDurationMs({ amount: 3, unit: 'أيام' }), 3 * DAY);
  assert.equal(parseSlaDurationMs({ amount: 1, unit: 'أسبوع' }), 7 * DAY);
});

test('parseSlaDurationMs: falls back to source_text when amount/unit missing', () => {
  assert.equal(parseSlaDurationMs({ source_text: 'التفعيل يأخذ حتى 12 ساعة' }), 12 * HOUR);
});

test('parseSlaDurationMs: returns null when nothing parseable', () => {
  assert.equal(parseSlaDurationMs({ source_text: 'نرد بأسرع وقت' }), null);
  assert.equal(parseSlaDurationMs({}), null);
  assert.equal(parseSlaDurationMs(null), null);
});

// ── computeSlaBreach ──────────────────────────────────────────────────
const T0 = Date.parse('2026-08-15T00:00:00Z');

test('no anchor timestamp → not computable, not breached (never fabricate)', () => {
  const r = computeSlaBreach({ since: null, now: T0, slaPolicies: [{ amount: 12, unit: 'ساعة' }] });
  assert.equal(r.computable, false);
  assert.equal(r.sla_breached, false);
});

test('no SLA policies → not computable', () => {
  const r = computeSlaBreach({ since: new Date(T0 - 25 * HOUR), now: T0, slaPolicies: [] });
  assert.equal(r.computable, false);
  assert.equal(r.sla_breached, false);
});

test('only unparseable policies → not computable', () => {
  const r = computeSlaBreach({ since: new Date(T0 - 25 * HOUR), now: T0, slaPolicies: [{ source_text: 'بأسرع وقت' }] });
  assert.equal(r.computable, false);
});

test('within the SLA window → computable but not breached', () => {
  const r = computeSlaBreach({ since: new Date(T0 - 3 * HOUR), now: T0, slaPolicies: [{ amount: 12, unit: 'ساعة' }] });
  assert.equal(r.computable, true);
  assert.equal(r.sla_breached, false);
  assert.equal(r.elapsed_ms, 3 * HOUR);
});

test('single policy breached (12h SLA, 25h elapsed) → breached with real deadline', () => {
  const since = new Date(T0 - 25 * HOUR);
  const r = computeSlaBreach({ since, now: T0, slaPolicies: [{ amount: 12, unit: 'ساعة', source_text: 'التفعيل حتى 12 ساعة' }] });
  assert.equal(r.computable, true);
  assert.equal(r.sla_breached, true);
  assert.equal(r.elapsed_ms, 25 * HOUR);
  assert.equal(r.expected_sla_ms, 12 * HOUR);
  assert.equal(new Date(r.sla_deadline).getTime(), since.getTime() + 12 * HOUR);
  assert.equal(new Date(r.created_at).getTime(), since.getTime());
});

test('multiple policies ALL breached → breached (deadline = longest window)', () => {
  const since = new Date(T0 - 5 * DAY);
  const r = computeSlaBreach({ since, now: T0, slaPolicies: [{ amount: 12, unit: 'ساعة' }, { amount: 3, unit: 'أيام' }] });
  assert.equal(r.sla_breached, true);
  assert.equal(r.expected_sla_ms, 3 * DAY);
});

test('multiple policies, only one breached → NOT breached (conservative, no false "late")', () => {
  const since = new Date(T0 - 25 * HOUR); // > 12h but < 3d
  const r = computeSlaBreach({ since, now: T0, slaPolicies: [{ amount: 12, unit: 'ساعة' }, { amount: 3, unit: 'أيام' }] });
  assert.equal(r.computable, true);
  assert.equal(r.sla_breached, false);
});

// ── buildSlaBreachBlock ───────────────────────────────────────────────
test('buildSlaBreachBlock: empty when not breached', () => {
  assert.equal(buildSlaBreachBlock({ computable: true, sla_breached: false }), '');
  assert.equal(buildSlaBreachBlock({ computable: false, sla_breached: false }), '');
  assert.equal(buildSlaBreachBlock(null), '');
});

test('buildSlaBreachBlock: breached block is authoritative and forbids repeating the ETA', () => {
  const since = new Date(T0 - 25 * HOUR);
  const model = computeSlaBreach({ since, now: T0, slaPolicies: [{ amount: 12, unit: 'ساعة' }] });
  const block = buildSlaBreachBlock(model);
  assert.match(block, /SLA/);
  // Must instruct NOT to repeat the original ETA as if still in the future.
  assert.match(block, /لا تكرر|لا تعِد|تجاوز|انقضت|مضى/);
});
