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

module.exports = {
  createRedisConnection,
  getRedisUrl,
  ping,
  redisOptions,
};
