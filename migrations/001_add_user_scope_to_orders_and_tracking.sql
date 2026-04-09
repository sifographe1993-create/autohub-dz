-- Multi-tenant scope for commandes/suivi
-- user_id columns already exist in schema, skipping ALTER TABLE
-- Only creating indexes and backfilling NULL values

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
