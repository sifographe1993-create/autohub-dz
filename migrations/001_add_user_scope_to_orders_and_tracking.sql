-- Multi-tenant scope for commandes/suivi
-- Run this migration before relying on strict per-user isolation.

ALTER TABLE commandes ADD COLUMN user_id INTEGER;
ALTER TABLE suivi ADD COLUMN user_id INTEGER;

-- Backfill existing rows with admin ownership by default.
-- Adjust this strategy if you have a different tenant mapping.
UPDATE commandes
SET user_id = (
  SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1
)
WHERE user_id IS NULL;

UPDATE suivi
SET user_id = (
  SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1
)
WHERE user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_commandes_user_id_created_at ON commandes(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suivi_user_id_created_at ON suivi(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suivi_tracking_user_id ON suivi(tracking, user_id);
