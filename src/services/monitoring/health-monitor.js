'use strict';

const db = require('../../db/client');
const redis = require('../../queues/redis');
const { collectHealthChecks } = require('./health-checks');
const { diffHealth, summarizeHealth } = require('./incident-tracker');
const { recordIncidentOpen, recordIncidentResolved, markIncidentChannels } = require('./incident-store');

class HealthMonitor {
  constructor({
    database = db,
    redisModule = redis,
    getQueues = null,
    dispatcher = null,
    logger = console,
    intervalMs = parseInt(process.env.MONITOR_INTERVAL_MS || '60000', 10),
    thresholds = {},
    persist = true,
    alertRetry = null,
  } = {}) {
    this.database = database;
    this.redisModule = redisModule;
    this.getQueues = getQueues;
    this.dispatcher = dispatcher;
    this.logger = logger;
    this.intervalMs = intervalMs;
    this.thresholds = thresholds;
    this.persist = persist;
    // Optional per-tick hook to re-attempt alerts whose first send failed. Reuses
    // this existing periodic loop instead of adding a separate timer/queue.
    this.alertRetry = typeof alertRetry === 'function' ? alertRetry : null;
    this._previous = {};
    this._snapshot = { ok: true, checks: [], at: null };
    this._timer = null;
    this._firstRunTimer = null;
    this._running = false;
  }

  async runOnce() {
    const checks = await collectHealthChecks({
      database: this.database,
      redisModule: this.redisModule,
      getQueues: this.getQueues,
      thresholds: this.thresholds,
    });

    // When the DB is down we cannot evaluate WhatsApp sessions, so they drop out of the
    // check set. Carry their last-known state forward so we don't emit false "recovered"
    // alerts for sessions we simply can't see right now.
    if (checks.find(check => check.key === 'database')?.ok === false) {
      const seen = new Set(checks.map(check => check.key));
      for (const [key, prev] of Object.entries(this._previous)) {
        if (key.startsWith('whatsapp:') && !seen.has(key)) checks.push({ ...prev });
      }
    }

    const { current, opened, resolved } = diffHealth(this._previous, checks);
    this._previous = current;
    this._snapshot = { ...summarizeHealth(checks), at: new Date().toISOString() };

    for (const incident of opened) await this._handle('open', incident);
    for (const incident of resolved) await this._handle('resolved', incident);

    // Re-attempt any alerts whose first send failed (best-effort; never breaks a tick).
    if (this.alertRetry) {
      try { await this.alertRetry(); } catch (err) {
        this.logger.warn?.('monitor', `alert retry sweep failed: ${err.message}`);
      }
    }

    return { checks, opened, resolved };
  }

  async _handle(kind, incident) {
    const label = kind === 'resolved' ? 'RESOLVED' : 'OPEN';
    this.logger.warn?.('monitor', `[${label}] ${incident.component} (${incident.scope}): ${incident.detail}`);

    // Persist first so the DB row acts as a cross-replica lock: only the process that
    // actually opened/resolved the incident dispatches alerts (prevents duplicate alerts).
    if (this.persist) {
      try {
        const won = kind === 'open'
          ? await recordIncidentOpen(this.database, incident)
          : await recordIncidentResolved(this.database, incident);
        if (!won) return;
      } catch (err) {
        this.logger.warn?.('monitor', `failed to persist incident: ${err.message}`);
      }
    }

    let channels = [];
    if (this.dispatcher) {
      channels = await this.dispatcher.dispatch({ kind, incident }).catch(() => []);
    }

    if (this.persist && kind === 'open' && channels.length) {
      await markIncidentChannels(this.database, incident, channels).catch(() => {});
    }
  }

  start() {
    if (this._timer) return this;
    this._running = true;
    const tick = () => {
      this.runOnce().catch((err) => {
        this.logger.error?.('monitor', `health monitor tick failed: ${err.message}`);
      });
    };
    // Run the first pass shortly after boot, then on a fixed interval.
    this._timer = setInterval(tick, this.intervalMs);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    this._firstRunTimer = setTimeout(tick, parseInt(process.env.MONITOR_FIRST_RUN_DELAY_MS || '15000', 10));
    if (typeof this._firstRunTimer.unref === 'function') this._firstRunTimer.unref();
    return this;
  }

  stop() {
    this._running = false;
    if (this._timer) clearInterval(this._timer);
    if (this._firstRunTimer) clearTimeout(this._firstRunTimer);
    this._timer = null;
    this._firstRunTimer = null;
  }

  getSnapshot() {
    return this._snapshot;
  }
}

let activeMonitor = null;
function setActiveMonitor(monitor) { activeMonitor = monitor; }
function getActiveMonitor() { return activeMonitor; }

module.exports = { HealthMonitor, setActiveMonitor, getActiveMonitor };
