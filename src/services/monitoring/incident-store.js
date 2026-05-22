'use strict';

const db = require('../../db/client');

// Returns true only when THIS process inserted a fresh open incident. The partial unique
// index lets the DB act as a cross-replica lock so alerts dispatch exactly once.
async function recordIncidentOpen(database, incident) {
  if (!database.isConfigured?.()) return false;
  const result = await database.query(
    `INSERT INTO health_incidents (component, scope, severity, status, detail)
     VALUES ($1, $2, $3, 'open', $4)
     ON CONFLICT (component, scope) WHERE status = 'open'
     DO NOTHING
     RETURNING id`,
    [incident.component, incident.scope || 'global', incident.severity || 'critical', incident.detail || ''],
  );
  return result.rowCount > 0;
}

// Returns true only when THIS process flipped an open incident to resolved.
async function recordIncidentResolved(database, incident) {
  if (!database.isConfigured?.()) return false;
  const result = await database.query(
    `UPDATE health_incidents
     SET status = 'resolved', resolved_at = NOW(), updated_at = NOW(), detail = $3
     WHERE component = $1 AND scope = $2 AND status = 'open'`,
    [incident.component, incident.scope || 'global', incident.detail || ''],
  );
  return result.rowCount > 0;
}

async function markIncidentChannels(database, incident, channels = []) {
  if (!database.isConfigured?.() || !channels.length) return;
  await database.query(
    `UPDATE health_incidents
     SET notified_channels = $3::jsonb, updated_at = NOW()
     WHERE component = $1 AND scope = $2 AND status = 'open'`,
    [incident.component, incident.scope || 'global', JSON.stringify(channels)],
  );
}

async function listRecentIncidents(database = db, limit = 30) {
  if (!database.isConfigured?.()) return [];
  const result = await database.query(
    `SELECT component, scope, severity, status, detail, notified_channels, opened_at, resolved_at
     FROM health_incidents
     ORDER BY opened_at DESC
     LIMIT $1`,
    [Math.max(1, Math.min(200, limit))],
  );
  return result.rows;
}

module.exports = { recordIncidentOpen, recordIncidentResolved, markIncidentChannels, listRecentIncidents };
