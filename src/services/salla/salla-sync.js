'use strict';

/**
 * Initial background sync — after a merchant authorizes, pull the whole store
 * (customers → orders → carts) via the Admin API, resolve identities, mirror the
 * records, and compute metrics. Progress is tracked in `salla_sync_jobs` for the
 * "8,420 / 12,300" UI. Runs OUTSIDE the OAuth webhook (never inside the request).
 *
 * All collaborators injectable; orchestration is unit-tested with fake iterators.
 */

const db = require('../../db/client');
const defaultApi = require('./salla-api');
const defaultIngest = require('./salla-ingest');
const defaultOauth = require('./salla-oauth');

const PROGRESS_EVERY = 25;

async function createJob(database, userId, merchantId) {
  const r = await database.query(
    `INSERT INTO salla_sync_jobs (user_id, merchant_id, status, phase, started_at)
     VALUES ($1,$2,'running','customers',NOW()) RETURNING id`,
    [userId, merchantId],
  );
  return r.rows[0] ? r.rows[0].id : null;
}
async function setProgress(database, jobId, fields) {
  if (!jobId) return;
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await database.query(`UPDATE salla_sync_jobs SET ${set} WHERE id = $1`, [jobId, ...cols.map((c) => fields[c])]);
}
async function finishJob(database, jobId, status, error) {
  if (!jobId) return;
  await database.query(
    `UPDATE salla_sync_jobs SET status=$2, last_error=$3, completed_at=NOW() WHERE id=$1`,
    [jobId, status, error || null],
  );
}

async function runInitialSync(userId, merchantId, deps = {}) {
  const database = deps.database || db;
  const api = deps.api || defaultApi;
  const ingestSvc = deps.ingest || defaultIngest;
  const oauth = deps.oauth || defaultOauth;

  const token = deps.token || await oauth.getValidToken(merchantId, deps);
  if (!token) { const e = new Error('salla_no_token'); e.code = 'SALLA_NO_TOKEN'; throw e; }

  const jobId = await createJob(database, userId, merchantId);
  const ingestDeps = { ...deps, database };
  const counts = { customers: 0, orders: 0, carts: 0 };
  try {
    await setProgress(database, jobId, { phase: 'customers' });
    for await (const c of api.iterateCustomers({ token }, deps)) {
      await ingestSvc.ingestCustomer(userId, c, ingestDeps);
      counts.customers += 1;
      if (counts.customers % PROGRESS_EVERY === 0) await setProgress(database, jobId, { customers_done: counts.customers });
    }
    await setProgress(database, jobId, { customers_done: counts.customers, phase: 'orders' });

    for await (const o of api.iterateOrders({ token }, deps)) {
      await ingestSvc.ingestOrder(userId, o, ingestDeps);
      counts.orders += 1;
      if (counts.orders % PROGRESS_EVERY === 0) await setProgress(database, jobId, { orders_done: counts.orders });
    }
    await setProgress(database, jobId, { orders_done: counts.orders, phase: 'carts' });

    for await (const cart of api.iterateAbandonedCarts({ token }, deps)) {
      await ingestSvc.ingestCart(userId, cart, 'abandoned', ingestDeps);
      counts.carts += 1;
      if (counts.carts % PROGRESS_EVERY === 0) await setProgress(database, jobId, { carts_done: counts.carts });
    }
    await setProgress(database, jobId, { carts_done: counts.carts });

    await finishJob(database, jobId, 'completed');
  } catch (e) {
    await finishJob(database, jobId, 'failed', e.message);
    throw e;
  }
  return { jobId, ...counts };
}

module.exports = { runInitialSync, createJob, setProgress, finishJob };
