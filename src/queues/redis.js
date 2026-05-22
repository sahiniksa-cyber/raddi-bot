'use strict';

require('dotenv').config({ quiet: true });

const IORedis = require('ioredis');

function getRedisUrl() {
  return (
    process.env.REDIS_URL ||
    process.env.REDIS_PRIVATE_URL ||
    process.env.RAILWAY_REDIS_URL ||
    ''
  ).trim();
}

function redisOptions(overrides = {}) {
  return {
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    connectTimeout: parseInt(process.env.REDIS_CONNECT_TIMEOUT_MS || '10000', 10),
    ...overrides,
  };
}

function createRedisConnection(overrides = {}) {
  const redisUrl = getRedisUrl();
  if (!redisUrl) {
    const err = new Error('REDIS_URL is not configured');
    err.code = 'REDIS_NOT_CONFIGURED';
    throw err;
  }
  return new IORedis(redisUrl, redisOptions(overrides));
}

async function ping() {
  const connection = createRedisConnection();
  try {
    await connection.connect();
    return await connection.ping();
  } finally {
    connection.disconnect();
  }
}

// A long-lived connection reused by the health monitor so it doesn't open and tear down
// a fresh TCP/TLS connection on every tick.
let sharedConnection = null;
async function pingShared() {
  if (!getRedisUrl()) {
    const err = new Error('REDIS_URL is not configured');
    err.code = 'REDIS_NOT_CONFIGURED';
    throw err;
  }
  if (!sharedConnection) sharedConnection = createRedisConnection();
  return sharedConnection.ping();
}

async function closeShared() {
  if (!sharedConnection) return;
  const connection = sharedConnection;
  sharedConnection = null;
  try { await connection.quit(); } catch (_) { connection.disconnect(); }
}

module.exports = {
  closeShared,
  createRedisConnection,
  getRedisUrl,
  ping,
  pingShared,
  redisOptions,
};
