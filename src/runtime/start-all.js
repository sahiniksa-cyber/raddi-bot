'use strict';

const { spawn } = require('child_process');

const processes = [
  { name: 'web', command: 'node', args: ['src/server.js'], required: true },
  { name: 'ai-worker', command: 'node', args: ['src/workers/ai-worker.js'], required: false, restartable: true },
];

const children = new Map();
let shuttingDown = false;

const MAX_RESTART_ATTEMPTS = 5;
const RESTART_DELAY_MS = 5000;
const restartCounts = new Map();

function startProcess(definition) {
  console.log(`${new Date().toISOString()} [start-all] starting ${definition.name}...`);
  const child = spawn(definition.command, definition.args, {
    stdio: 'inherit',
    env: process.env,
    shell: false,
  });

  children.set(definition.name, { child, definition });

  child.on('exit', (code, signal) => {
    children.delete(definition.name);
    if (shuttingDown) return;

    const failed = code !== 0;
    console.error(`${new Date().toISOString()} [start-all] ${definition.name} exited code=${code} signal=${signal || ''}`);

    if (definition.required && failed) {
      shutdown(code || 1);
      return;
    }

    // Auto-restart non-required processes
    if (definition.restartable && failed) {
      const count = (restartCounts.get(definition.name) || 0) + 1;
      restartCounts.set(definition.name, count);
      if (count <= MAX_RESTART_ATTEMPTS) {
        console.log(`${new Date().toISOString()} [start-all] restarting ${definition.name} (attempt ${count}/${MAX_RESTART_ATTEMPTS}) in ${RESTART_DELAY_MS}ms...`);
        setTimeout(() => startProcess(definition), RESTART_DELAY_MS);
      } else {
        console.error(`${new Date().toISOString()} [start-all] ${definition.name} exceeded max restart attempts, giving up`);
      }
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
