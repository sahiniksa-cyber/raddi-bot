'use strict';

require('dotenv').config({ quiet: true });

const db = require('../client');

const statements = [
  'CREATE EXTENSION IF NOT EXISTS pgcrypto',

  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    phone TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user',
    email_verified BOOLEAN NOT NULL DEFAULT TRUE,
    legacy_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT`,

  `CREATE TABLE IF NOT EXISTS bot_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    source TEXT NOT NULL DEFAULT 'app',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone TEXT,
    status TEXT NOT NULL DEFAULT 'stopped',
    session_path TEXT,
    auth_state JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_qr_at TIMESTAMPTZ,
    last_connected_at TIMESTAMPTZ,
    last_disconnected_at TIMESTAMPTZ,
    last_error TEXT,
    reconnect_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
  )`,

  `ALTER TABLE whatsapp_sessions
    ADD COLUMN IF NOT EXISTS desired_state TEXT NOT NULL DEFAULT 'stopped'`,

  `ALTER TABLE whatsapp_sessions
    ADD COLUMN IF NOT EXISTS connection_owner TEXT`,

  `ALTER TABLE whatsapp_sessions
    ADD COLUMN IF NOT EXISTS connection_lease_expires_at TIMESTAMPTZ`,

  `CREATE TABLE IF NOT EXISTS admin_api_keys (
    provider TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS conversations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, sender)
  )`,

  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS phone_number TEXT`,

  `CREATE TABLE IF NOT EXISTS messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sender TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content TEXT NOT NULL,
    provider_message_id TEXT,
    status TEXT NOT NULL DEFAULT 'stored',
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    queue_name TEXT NOT NULL,
    job_key TEXT,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
    message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_error TEXT,
    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS billing_accounts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform_access_status TEXT NOT NULL DEFAULT 'unpaid',
    activation_source TEXT NOT NULL DEFAULT 'none',
    message_price_halalas INTEGER NOT NULL DEFAULT 0,
    receivable_halalas INTEGER NOT NULL DEFAULT 0,
    auto_renew_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    provider_customer_id TEXT,
    internal_note TEXT NOT NULL DEFAULT '',
    access_activated_at TIMESTAMPTZ,
    access_suspended_at TIMESTAMPTZ,
    last_payment_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id)
  )`,

  `CREATE TABLE IF NOT EXISTS billing_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL DEFAULT 'manual',
    provider_payment_id TEXT,
    amount_halalas INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'SAR',
    status TEXT NOT NULL DEFAULT 'pending',
    method TEXT NOT NULL DEFAULT 'manual',
    activation_type TEXT NOT NULL DEFAULT 'paid',
    raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS billing_payment_methods (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_method_id TEXT NOT NULL,
    brand TEXT,
    last4 TEXT,
    exp_month INTEGER,
    exp_year INTEGER,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(provider, provider_method_id)
  )`,

  `CREATE TABLE IF NOT EXISTS billing_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS app_sessions (
    sid TEXT PRIMARY KEY,
    sess JSONB NOT NULL,
    expire TIMESTAMPTZ NOT NULL
  )`,

  // Audit trail for powerful admin actions on a specific merchant's bot
  // (restart/stop/clear-session/release-lease/top-up). admin_user_id and
  // target_user_id are SET NULL on user delete so the audit row survives.
  `CREATE TABLE IF NOT EXISTS admin_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    result TEXT NOT NULL DEFAULT 'ok',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_admin_audit_log_target_created
    ON admin_audit_log(target_user_id, created_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_bot_configs_user_id
    ON bot_configs(user_id)`,

  `CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_status
    ON whatsapp_sessions(status)`,

  `CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_desired_state
    ON whatsapp_sessions(desired_state)`,

  `CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_connection_lease
    ON whatsapp_sessions(connection_owner, connection_lease_expires_at)`,

  `CREATE INDEX IF NOT EXISTS idx_conversations_user_last_message
    ON conversations(user_id, last_message_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
    ON messages(conversation_id, created_at ASC)`,

  `CREATE INDEX IF NOT EXISTS idx_messages_user_sender_created
    ON messages(user_id, sender, created_at DESC)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_provider_message_unique
    ON messages(user_id, provider_message_id)
    WHERE provider_message_id IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS idx_jobs_queue_status_available
    ON jobs(queue_name, status, available_at)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_queue_job_key_unique
    ON jobs(queue_name, job_key)
    WHERE job_key IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS idx_billing_accounts_status
    ON billing_accounts(platform_access_status)`,

  `CREATE INDEX IF NOT EXISTS idx_billing_payments_user_created
    ON billing_payments(user_id, created_at DESC)`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payments_provider_payment_unique
    ON billing_payments(provider, provider_payment_id)
    WHERE provider_payment_id IS NOT NULL`,

  `CREATE INDEX IF NOT EXISTS idx_billing_events_user_created
    ON billing_events(user_id, created_at DESC)`,

  `ALTER TABLE billing_accounts
    ADD COLUMN IF NOT EXISTS access_expires_at TIMESTAMPTZ`,

  `ALTER TABLE billing_accounts
     ADD COLUMN IF NOT EXISTS messages_remaining INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS quota_expires_at TIMESTAMPTZ NULL,
     ADD COLUMN IF NOT EXISTS expire_resets_quota BOOLEAN NOT NULL DEFAULT TRUE,
     ADD COLUMN IF NOT EXISTS last_topup_amount INTEGER NOT NULL DEFAULT 0,
     ADD COLUMN IF NOT EXISTS last_topup_at TIMESTAMPTZ NULL`,

  `CREATE INDEX IF NOT EXISTS idx_billing_accounts_quota
     ON billing_accounts(user_id, messages_remaining)
     WHERE messages_remaining > 0`,

  `CREATE TABLE IF NOT EXISTS coupons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    type TEXT NOT NULL DEFAULT 'free_activation',
    discount_percent INT DEFAULT 0,
    max_uses INT DEFAULT 1,
    uses_count INT DEFAULT 0,
    active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE TABLE IF NOT EXISTS ai_usage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd NUMERIC(12, 8) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_ai_usage_user_created
    ON ai_usage(user_id, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS health_incidents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    component TEXT NOT NULL,
    scope TEXT NOT NULL DEFAULT 'global',
    severity TEXT NOT NULL DEFAULT 'critical',
    status TEXT NOT NULL DEFAULT 'open',
    detail TEXT NOT NULL DEFAULT '',
    notified_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_health_incidents_open_unique
    ON health_incidents(component, scope)
    WHERE status = 'open'`,

  `CREATE INDEX IF NOT EXISTS idx_health_incidents_opened
    ON health_incidents(opened_at DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_app_sessions_expire
    ON app_sessions(expire)`,

  `CREATE OR REPLACE FUNCTION set_updated_at()
  RETURNS TRIGGER AS $$
  BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql`,

  `DROP TRIGGER IF EXISTS trg_users_updated_at ON users`,
  `CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `DROP TRIGGER IF EXISTS trg_bot_configs_updated_at ON bot_configs`,
  `CREATE TRIGGER trg_bot_configs_updated_at
    BEFORE UPDATE ON bot_configs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `DROP TRIGGER IF EXISTS trg_whatsapp_sessions_updated_at ON whatsapp_sessions`,
  `CREATE TRIGGER trg_whatsapp_sessions_updated_at
    BEFORE UPDATE ON whatsapp_sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `DROP TRIGGER IF EXISTS trg_conversations_updated_at ON conversations`,
  `CREATE TRIGGER trg_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs`,
  `CREATE TRIGGER trg_jobs_updated_at
    BEFORE UPDATE ON jobs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `DROP TRIGGER IF EXISTS trg_billing_accounts_updated_at ON billing_accounts`,
  `CREATE TRIGGER trg_billing_accounts_updated_at
    BEFORE UPDATE ON billing_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `DROP TRIGGER IF EXISTS trg_billing_payments_updated_at ON billing_payments`,
  `CREATE TRIGGER trg_billing_payments_updated_at
    BEFORE UPDATE ON billing_payments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `DROP TRIGGER IF EXISTS trg_billing_payment_methods_updated_at ON billing_payment_methods`,
  `CREATE TRIGGER trg_billing_payment_methods_updated_at
    BEFORE UPDATE ON billing_payment_methods
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `DROP TRIGGER IF EXISTS trg_admin_api_keys_updated_at ON admin_api_keys`,
  `CREATE TRIGGER trg_admin_api_keys_updated_at
    BEFORE UPDATE ON admin_api_keys
    FOR EACH ROW EXECUTE FUNCTION set_updated_at()`,

  `CREATE TABLE IF NOT EXISTS escalation_log (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    contact_target TEXT NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS escalation_log_dedup_idx
    ON escalation_log (user_id, conversation_id, contact_target, sent_at DESC)`,

  // ── Added 2026-06-30: WhatsApp prompt-edit via the escalation group. Stores
  //    each edit request (pending → applied/rejected/expired) plus before/after
  //    instructions so the change is auditable and undo-able later.
  `CREATE TABLE IF NOT EXISTS prompt_edit_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_jid TEXT NOT NULL,
    requester_jid TEXT,
    request_text TEXT NOT NULL,
    current_instructions TEXT,
    proposed_instructions TEXT NOT NULL,
    change_summary TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMPTZ
  )`,

  `CREATE INDEX IF NOT EXISTS idx_prompt_edits_user_status
    ON prompt_edit_requests (user_id, source_jid, status, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS pre_activations (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    duration_days INTEGER NOT NULL CHECK (duration_days > 0),
    note TEXT,
    created_by_admin TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at TIMESTAMPTZ,
    used_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
  )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS pre_activations_email_unused_idx
    ON pre_activations (LOWER(email))
    WHERE used_at IS NULL`,

  `CREATE INDEX IF NOT EXISTS pre_activations_created_at_idx
    ON pre_activations (created_at DESC)`,

  // Pre-activation upgrades (2026-06-14): grant a real message quota on signup,
  // and allow PERMANENT activation (duration_days NULL = no time limit).
  `ALTER TABLE pre_activations ADD COLUMN IF NOT EXISTS messages INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE pre_activations DROP CONSTRAINT IF EXISTS pre_activations_duration_days_check`,
  `ALTER TABLE pre_activations ALTER COLUMN duration_days DROP NOT NULL`,

  // ── Added 2026-05-28: escalation mute window + admin key encryption fields
  //    + billing webhook verification fields. Needed by Agents 2 and 4.
  `ALTER TABLE conversations ADD COLUMN IF NOT EXISTS escalated_until TIMESTAMPTZ`,

  `ALTER TABLE admin_api_keys ADD COLUMN IF NOT EXISTS api_key_encrypted TEXT`,
  `ALTER TABLE admin_api_keys ADD COLUMN IF NOT EXISTS api_key_iv TEXT`,
  `ALTER TABLE admin_api_keys ADD COLUMN IF NOT EXISTS api_key_tag TEXT`,
  `ALTER TABLE admin_api_keys ADD COLUMN IF NOT EXISTS api_key_format TEXT DEFAULT 'plaintext'`,

  `ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS webhook_verified_at TIMESTAMPTZ`,
  `ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS webhook_signature TEXT`,

  // ── Added 2026-05-28: customer_profiles table for per-conversation memory
  //    (P2 from inspection report). Populated by profile-extractor worker;
  //    consumed by AI worker / ai-client to enrich the system prompt.
  `CREATE TABLE IF NOT EXISTS customer_profiles (
    conversation_id UUID PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    email TEXT,
    phone TEXT,
    last_order_ref TEXT,
    preferences JSONB DEFAULT '{}',
    open_question TEXT,
    notes TEXT,
    message_count_at_last_extract INTEGER DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`,

  `CREATE INDEX IF NOT EXISTS idx_customer_profiles_user
    ON customer_profiles(user_id)`,

  // ── Per-customer API keys that override the admin defaults for a user.
  //    Encrypted at rest (AES-256-GCM) when SECRETS_KEY is set; falls back
  //    to inline plaintext in dev (still in api_key_encrypted column —
  //    no separate plaintext column to keep the surface area minimal).
  `CREATE TABLE IF NOT EXISTS customer_api_keys (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    api_key_encrypted TEXT,
    api_key_iv TEXT,
    api_key_tag TEXT,
    api_key_format TEXT DEFAULT 'aes-256-gcm',
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, provider)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_customer_api_keys_user
    ON customer_api_keys(user_id)`,

  // ── Added 2026-06-09: WhatsApp message ID for the outbound replies we send.
  //    Baileys assigns its own key.id on sendMessage; we record it so the
  //    getMessage(key) callback can return the original text when a peer asks
  //    for a retry receipt. Without this, the peer rebuilds its Signal session
  //    and every in-flight message decrypts to "Bad MAC".
  //    UNIQUE on (user_id, whatsapp_message_id) is load-bearing: it guarantees
  //    the retry-receipt lookup can never return a row from a DIFFERENT
  //    conversation that happened to share key.id. Returning the wrong
  //    plaintext to a peer's retry would corrupt its ratchet permanently.
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS whatsapp_message_id TEXT`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_whatsapp_id_unique
    ON messages(user_id, whatsapp_message_id)
    WHERE whatsapp_message_id IS NOT NULL`,

  // ── Added 2026-06-10: true sent-message counter. The dashboard used to
  //    derive used = last_topup_amount - messages_remaining, which freezes at 0
  //    whenever topups accumulate (remaining > last topup). Track usage
  //    directly; decrementMessageQuota increments it in the same UPDATE.
  `ALTER TABLE billing_accounts
    ADD COLUMN IF NOT EXISTS messages_used INTEGER NOT NULL DEFAULT 0`,

  // One-time backfill: seed the tracked counter with the value the dashboard
  // currently derives, so the visible number never jumps backward. Safe to
  // re-run (only touches rows still at the default 0).
  `UPDATE billing_accounts
      SET messages_used = GREATEST(0, last_topup_amount - messages_remaining)
    WHERE messages_used = 0 AND last_topup_amount > messages_remaining`,

  // ── Added 2026-06-10: phase-1 self-learning. Q→A pairs harvested from the
  //    owner's manual replies only (status='sent_by_human'); injected into the
  //    AI knowledge block. UNIQUE(user_id, normalized_question) is the dedup.
  `CREATE TABLE IF NOT EXISTS learned_replies (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    normalized_question TEXT NOT NULL,
    source_conversation_id UUID,
    source_message_id UUID,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, normalized_question)
  )`,

  `CREATE INDEX IF NOT EXISTS learned_replies_user_status_idx
    ON learned_replies (user_id, status)`,

  // ── Added 2026-06-11: two-way escalation bridge. Every bot→team message
  //    (escalation or customer-forward) is recorded by its WhatsApp message id
  //    so a team member's quote-reply can be routed back to the right customer.
  `CREATE TABLE IF NOT EXISTS escalation_threads (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    whatsapp_message_id TEXT NOT NULL,
    target_jid TEXT NOT NULL,
    customer_sender TEXT NOT NULL,
    conversation_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, whatsapp_message_id)
  )`,

  `CREATE INDEX IF NOT EXISTS escalation_threads_customer_idx
    ON escalation_threads (user_id, customer_sender, created_at DESC)`,

  // ── Added 2026-06-12: a relayed team answer CLOSES the thread (hand-back
  //    to the AI). NULL = still waiting for the team's quote-reply.
  `ALTER TABLE escalation_threads ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`,

  // ── Added 2026-06-15: the platform key is OpenAI and the model picker is
  //    admin-only, so legacy accounts saved on Gemini (the old default) gave
  //    erratic replies and merchants couldn't change them. Move every account
  //    still on Gemini (or with no model) to gpt-4o. Idempotent: after the
  //    first run no rows match, and explicit non-Gemini models are left alone.
  `UPDATE bot_configs
      SET config = jsonb_set(config, '{model}', '"gpt-4o"'::jsonb),
          updated_at = NOW()
    WHERE COALESCE(config->>'model', '') = ''
       OR config->>'model' LIKE 'google/%'
       OR config->>'model' LIKE 'gemini%'`,

  // ── Added 2026-06-20: platform-wide admin-controlled settings store.
  //    Generic key-value table; values are JSONB so any JSON-serialisable
  //    shape can be stored without schema changes.
  `CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── Added 2026-06-20: atomic once-per-conversation guard for the platform
  //    quota-stop notice. A plain SELECT-then-INSERT in ai-worker races under
  //    concurrency (recovery re-enqueue / BullMQ retry) and double-sends the
  //    stop message. This partial unique index lets the INSERT use
  //    ON CONFLICT DO NOTHING so the DB — not a racy SELECT — guarantees at most
  //    one quota_stop row per (user, conversation). Safe to add: a brand-new
  //    feature, so no existing quota_stop rows can violate it.
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_quota_stop_notice_per_conversation
    ON messages (user_id, conversation_id)
    WHERE (raw_payload->>'kind') = 'quota_stop'`,
];

async function migrate() {
  if (!db.isConfigured()) {
    throw new Error('DATABASE_URL is required to run database migrations');
  }

  await db.transaction(async (client) => {
    for (const statement of statements) {
      await client.query(statement);
    }
  });
}

if (require.main === module) {
  migrate()
    .then(async () => {
      console.log('Database migration completed');
      await db.close();
    })
    .catch(async (err) => {
      console.error('Database migration failed:', err.message);
      await db.close().catch(() => {});
      process.exit(1);
    });
}

module.exports = { migrate, statements };
