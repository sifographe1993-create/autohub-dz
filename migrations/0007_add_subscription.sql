-- =============================================
-- Migration: Add subscription column to users + whatsapp_sent to commandes
-- =============================================

-- Columns already exist in schema, skipping ALTER TABLE to avoid duplicate errors
-- ALTER TABLE users ADD COLUMN subscription TEXT DEFAULT 'starter';
-- ALTER TABLE commandes ADD COLUMN whatsapp_sent INTEGER DEFAULT 0;
SELECT 1; -- no-op placeholder
