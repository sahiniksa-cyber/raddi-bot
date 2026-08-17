'use strict';

// Pure classification of the *real* connection state a store's WhatsApp session
// is in, from durable, signal-based facts — never from intent (desiredState).
//
// This is the single source of truth shared by (a) the dashboard status badge,
// so it stops showing "شغّال" just because desiredState==='running', and (b) the
// disconnect-alert gate, so an alert / QR prompt fires ONLY when the session
// genuinely cannot be restored and a fresh pairing is required.
//
// Deliberately NO timeouts here: a transient drop (network / restart / 428 / 440)
// stays RECONNECTING|DISCONNECTED and is left to the existing self-heal. The one
// terminal, unrecoverable signal is loggedOut (401) — the device was unlinked and
// the auth state is wiped, so only then is a new QR actually required.

const CONNECTION_TRUTH = Object.freeze({
  CONNECTED: 'CONNECTED',
  CONNECTING: 'CONNECTING',
  RECONNECTING: 'RECONNECTING',
  DISCONNECTED: 'DISCONNECTED',
  QR_REQUIRED: 'QR_REQUIRED',
  ERROR: 'ERROR',
  STOPPED: 'STOPPED',
});

function isTerminalLoggedOut(lastDisconnect) {
  if (!lastDisconnect) return false;
  const reason = String(lastDisconnect.reason || '').toLowerCase();
  return reason === 'loggedout' || lastDisconnect.statusCode === 401;
}

function classifyConnectionTruth({ status, desiredState, lastDisconnect } = {}) {
  const s = String(status || '').toLowerCase();
  const running = desiredState === 'running';

  if (s === 'connected') return CONNECTION_TRUTH.CONNECTED;
  // A session actively producing a QR always needs a scan, regardless of intent.
  if (s === 'qr_ready' || s === 'waiting_qr') return CONNECTION_TRUTH.QR_REQUIRED;
  if (s === 'connecting') return CONNECTION_TRUTH.CONNECTING;
  if (s === 'reconnecting') return CONNECTION_TRUTH.RECONNECTING;
  if (s === 'error') return CONNECTION_TRUTH.ERROR;

  if (s === 'stopped' || s === 'disconnected') {
    if (!running) return CONNECTION_TRUTH.STOPPED;
    // Should be running but the socket is down. Only a wiped-auth logout means a
    // new pairing is genuinely required; everything else is left to self-heal.
    if (isTerminalLoggedOut(lastDisconnect)) return CONNECTION_TRUTH.QR_REQUIRED;
    return CONNECTION_TRUTH.DISCONNECTED;
  }

  // Unknown/unstarted status: reflect intent without ever claiming CONNECTED.
  return running ? CONNECTION_TRUTH.DISCONNECTED : CONNECTION_TRUTH.STOPPED;
}

function isQrRequired(truth) {
  return truth === CONNECTION_TRUTH.QR_REQUIRED;
}

module.exports = { classifyConnectionTruth, isQrRequired, CONNECTION_TRUTH };
