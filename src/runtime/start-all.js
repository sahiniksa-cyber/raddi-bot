'use strict';

const { spawn } = require('child_process');

const processes = [
  { name: 'web', command: 'node', args: ['index.js'], required: true },
  { name: 'ai-worker', command: 'node', args: ['src/workers/ai-worker.js'], required: process.env.REQUIRE_WORKER === 'true' },
];

const children = new Map();
let shuttingDown = false;

function startProcess(definition) {
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
    console.error(`[start-all] ${definition.name} exited code=${code} signal=${signal || ''}`);
    if (definition.required && failed) {
      shutdown(code || 1);
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
  for (const definition of processes) startProcess(definition);
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
}

if (require.main === module) {
  main();
}

module.exports = { main, shutdown, startProcess };
