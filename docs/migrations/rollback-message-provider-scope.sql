-- Revert only after proving there are no equal provider ids across channels
-- for the same tenant. The old index is intentionally stricter.
DROP INDEX IF EXISTS idx_messages_scope_provider_message_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_provider_message_unique
  ON messages(user_id, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
