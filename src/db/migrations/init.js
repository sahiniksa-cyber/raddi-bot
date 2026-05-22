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
