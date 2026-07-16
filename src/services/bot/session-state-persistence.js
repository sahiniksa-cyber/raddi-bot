'use strict';

function buildRuntimeAuthMetadata(state = {}) {
  const metadata = {
    ready: !!state.ready,
    qrVersion: state.qrVersion || 0,
    authFailureCount: state.authFailureCount || 0,
    heartbeatFailures: state.heartbeatFailures || 0,
  };
  if (state.lastDisconnect) metadata.lastDisconnect = state.lastDisconnect;
  return metadata;
}

function buildPersistSessionStateQuery({
  userId,
  phone,
  status,
  sessionPath,
  desiredState,
  runtimeAuthState,
  nowFields,
  lastError,
  reconnectCount,
}) {
  return {
    text: `INSERT INTO whatsapp_sessions (
         user_id, phone, status, session_path, desired_state, auth_state,
         last_qr_at, last_connected_at, last_disconnected_at, last_error, reconnect_count
       )
       VALUES (
         $1, $2, $3, $4, $5, $6::jsonb,
         CASE WHEN $7 THEN NOW() ELSE NULL END,
         CASE WHEN $8 THEN NOW() ELSE NULL END,
         CASE WHEN $9 THEN NOW() ELSE NULL END,
         $10, $11
       )
       ON CONFLICT (user_id) DO UPDATE SET
         phone = COALESCE(EXCLUDED.phone, whatsapp_sessions.phone),
         status = EXCLUDED.status,
         session_path = EXCLUDED.session_path,
         desired_state = EXCLUDED.desired_state,
         auth_state = jsonb_set(
           COALESCE(whatsapp_sessions.auth_state, '{}'::jsonb),
           '{runtime}',
           EXCLUDED.auth_state->'runtime',
           true
         ),
         last_qr_at = CASE WHEN $7 THEN NOW() ELSE whatsapp_sessions.last_qr_at END,
         last_connected_at = CASE WHEN $8 THEN NOW() ELSE whatsapp_sessions.last_connected_at END,
         last_disconnected_at = CASE WHEN $9 THEN NOW() ELSE whatsapp_sessions.last_disconnected_at END,
         last_error = EXCLUDED.last_error,
         reconnect_count = EXCLUDED.reconnect_count
       RETURNING desired_state, status, updated_at`,
    values: [
      userId,
      phone,
      status,
      sessionPath,
      desiredState,
      JSON.stringify({ runtime: runtimeAuthState }),
      nowFields.lastQr,
      nowFields.lastConnected,
      nowFields.lastDisconnected,
      lastError,
      reconnectCount,
    ],
  };
}

module.exports = {
  buildPersistSessionStateQuery,
  buildRuntimeAuthMetadata,
};
