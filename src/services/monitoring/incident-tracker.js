'use strict';

/**
 * Pure incident-state diffing. Given the previous component states and the latest
 * health checks, returns which incidents newly opened and which newly resolved.
 * Transient blips are NOT debounced here — checks decide their own ok/down threshold.
 */
function normalizeCheck(check = {}) {
  return {
    key: String(check.key || check.component || 'unknown'),
    component: String(check.component || check.key || 'unknown'),
    scope: String(check.scope || 'global'),
    severity: check.severity === 'warning' ? 'warning' : 'critical',
    ok: check.ok !== false,
    detail: String(check.detail || ''),
  };
}

function diffHealth(previous = {}, checks = []) {
  const current = {};
  const opened = [];
  const resolved = [];

  for (const raw of checks) {
    const check = normalizeCheck(raw);
    current[check.key] = check;
    const prev = previous[check.key];
    const wasDown = prev ? prev.ok === false : false;

    if (!check.ok && !wasDown) opened.push(check);
    else if (check.ok && wasDown) resolved.push(check);
  }

  // A component that vanished from the checks while it was down is treated as resolved
  // so it doesn't linger as a permanently open incident.
  for (const key of Object.keys(previous)) {
    if (!(key in current) && previous[key].ok === false) {
      resolved.push({ ...previous[key], ok: true, detail: 'لم يعد قيد المراقبة' });
    }
  }

  return { current, opened, resolved };
}

function summarizeHealth(checks = []) {
  const normalized = checks.map(normalizeCheck);
  const down = normalized.filter(check => !check.ok);
  const criticalDown = down.filter(check => check.severity === 'critical');
  return {
    ok: down.length === 0,
    healthy: normalized.length - down.length,
    total: normalized.length,
    downCount: down.length,
    criticalDownCount: criticalDown.length,
    checks: normalized,
  };
}

module.exports = { diffHealth, summarizeHealth, normalizeCheck };
