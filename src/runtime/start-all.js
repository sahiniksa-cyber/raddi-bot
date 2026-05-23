'use strict';

const { spawn } = require('child_process');
const { RETRY } = require('../../lib/constants');

const processes = [
  { name: 'web', command: 'node', args: ['src/server.js'], required: true },
  { name: 'ai-worker', command: 'node', args: ['src/workers/ai-worker.js'], required: false, restartable: true },
];

const children = new Map();
let shuttingDown = false;

const STABLE_RESET_MS = parseInt(process.env.PROC_STABLE_RESET_MS || '60000', 10);
const restartCounts = new Map();
const stabilityTimers = new Map();

function restartDelayMs(count) {
  const index = Math.min(Math.max(count - 1, 0), RETRY.DELAYS_MS.length - 1);
  return RETRY.DELAYS_MS[index] + Math.floor(Math.random() * RETRY.JITTER_MAX_MS);
}

function startProcess(definition) {
  console.log(`${new Date().toISOString()} [start-all] starting ${definition.name}...`);
  const child = spawn(definition.command, definition.args, {
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });

  children.set(definition.name, { child, definition });

  if (definition.restartable) {
    clearTimeout(stabilityTimers.get(definition.name));
    const timer = setTimeout(() => {
      const prev = restartCounts.get(definition.name) || 0;
      if (prev > 0) {
        restartCounts.set(definition.name, 0);
        console.log(`${new Date().toISOString()} [start-all] ${definition.name} stable for ${STABLE_RESET_MS / 1000}s, restart counter reset`);
      }
    }, STABLE_RESET_MS);
    if (typeof timer.unref === 'function') timer.unref();
    stabilityTimers.set(definition.name, timer);
  }

  child.on('exit', (code, signal) => {
    children.delete(definition.name);
    clearTimeout(stabilityTimers.get(definition.name));
    if (shuttingDown) return;

    const failed = code !== 0;
    console.error(`${new Date().toISOString()} [start-all] ${definition.name} exited code=${code} signal=${signal || ''}`);

    if (definition.required && failed) {
      shutdown(code || 1);
      return;
    }

    if (definition.restartable && failed) {
      const count = (restartCounts.get(definition.name) || 0) + 1;
      restartCounts.set(definition.name, count);
      const delay = restartDelayMs(count);
      console.log(`${new Date().toISOString()} [start-all] restarting ${definition.name} (attempt ${count}) in ${Math.round(delay / 1000)}s...`);
      setTimeout(() => startProcess(definition), delay);
    }
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  for (const { child } of children.values()) {
    if (!child.killed) child.kill('SIGTERM');
  }

  setTimeout(() => {
    for (const { child } of children.values()) {
      if (!child.killed) child.kill('SIGKILL');
    }
    process.exit(exitCode);
  }, 8000).unref();
}

function main() {
  console.log(`${new Date().toISOString()} [start-all] launching all processes...`);
  for (const definition of processes) startProcess(definition);
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

if (require.main === module) {
  main();
}

module.exports = { main, shutdown, startProcess };
