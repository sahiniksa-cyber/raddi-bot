'use strict';

// Process-level safety net for the multi-tenant platform. Node's default on an
// unhandled promise rejection is to CRASH — which on this single-process,
// many-merchant server means ONE merchant's stray async error takes EVERY
// merchant down at once. Per-message work is already isolated (BullMQ catches
// per-job errors), so the residual risk is stray rejections in fire-and-forget
// calls and event-handler callbacks. We log those loudly and keep serving.
//
// uncaughtException is more serious (a synchronous throw escaped all try/catch)
// — but for an always-on multi-tenant service, exiting means every merchant
// disconnects and a reconnect storm follows. Default: stay up and log. Ops can
// opt into fail-fast with PROCESS_EXIT_ON_UNCAUGHT=true (supervisor restarts).

function describe(err) {
  if (err instanceof Error) return err.stack || err.message;
  try { return JSON.stringify(err); } catch (_) { return String(err); }
}

function handleUnhandledRejection(reason, { processName = 'app', log = console.error, exit } = {}) {
  try {
    log(`${new Date().toISOString()} [${processName}] [FATAL-GUARD] unhandledRejection (kept alive): ${describe(reason)}`);
  } catch (_) { /* never throw from the guard */ }
  // Deliberately no exit — keep serving all other merchants.
  void exit;
}

function handleUncaughtException(err, {
  processName = 'app',
  log = console.error,
  exit = (code) => process.exit(code),
  exitOnUncaught = String(process.env.PROCESS_EXIT_ON_UNCAUGHT || 'false') === 'true',
} = {}) {
  try {
    log(`${new Date().toISOString()} [${processName}] [FATAL-GUARD] uncaughtException${exitOnUncaught ? ' (exiting)' : ' (kept alive)'}: ${describe(err)}`);
  } catch (_) { /* never throw from the guard */ }
  if (exitOnUncaught) {
    try { exit(1); } catch (_) {}
  }
}

function installProcessSafetyNet({ processName = 'app', proc = process, log = console.error } = {}) {
  proc.on('unhandledRejection', (reason) => handleUnhandledRejection(reason, { processName, log }));
  proc.on('uncaughtException', (err) => handleUncaughtException(err, { processName, log }));
}

module.exports = { handleUnhandledRejection, handleUncaughtException, installProcessSafetyNet };
