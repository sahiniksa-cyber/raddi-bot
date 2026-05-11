'use strict';

require('dotenv').config({ quiet: true });

const { Pool } = require('pg');

const DEFAULT_STATEMENT_TIMEOUT_MS = parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '30000', 10);
const DEFAULT_IDLE_TIMEOUT_MS = parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10);
const DEFAULT_CONNECTION_TIMEOUT_MS = parseInt(process.env.PG_CONNECTION_TIMEOUT_MS || '10000', 10);
const DEFAULT_MAX_CONNECTIONS = parseInt(process.env.PG_POOL_MAX || '10', 10);

function getDatabaseUrl() {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.PG_URL ||
    ''
  ).trim();
}

function shouldUseSsl(databaseUrl) {
  if (process.env.PGSSL === 'false') return false;
  if (process.env.PGSSLMODE === 'disable') return false;
  if (process.env.NODE_ENV === 'production') return true;
  return /railway|render|neon|supabase|amazonaws|azure|gcp/i.test(databaseUrl);
}

let pool = null;

function createPool() {
  const connectionString = getDatabaseUrl();
  if (!connectionString) {
    const err = new Error('DATABASE_URL is not configured');
    err.code = 'DB_NOT_CONFIGURED';
    throw err;
  }

  return new Pool({
    connectionString,
    max: DEFAULT_MAX_CONNECTIONS,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DEFAULT_CONNECTION_TIMEOUT_MS,
    statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
    ssl: shouldUseSsl(connectionString) ? { rejectUnauthorized: false } : false,
  });
}

function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

function isConfigured() {
  return !!getDatabaseUrl();
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function withClient(fn) {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function transaction(fn) {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

async function ping() {
  const result = await query('SELECT NOW() AS now');
  return result.rows[0];
}

async function close() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

module.exports = {
  close,
  getDatabaseUrl,
  getPool,
  isConfigured,
  ping,
  query,
  transaction,
  withClient,
};
