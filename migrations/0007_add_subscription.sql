-- =============================================
-- Migration: Add subscription column to users + whatsapp_sent to commandes
-- =============================================

ALTER TABLE users ADD COLUMN subscription TEXT DEFAULT 'starter';
ALTER TABLE commandes ADD COLUMN whatsapp_sent INTEGER DEFAULT 0;
