-- =============================================
-- Migration: WooCommerce API Integration
-- =============================================

-- Add WooCommerce OAuth credentials to store_sources
ALTER TABLE store_sources ADD COLUMN consumer_key TEXT DEFAULT '';
ALTER TABLE store_sources ADD COLUMN consumer_secret TEXT DEFAULT '';
ALTER TABLE store_sources ADD COLUMN woo_user_id TEXT DEFAULT '';
ALTER TABLE store_sources ADD COLUMN connected_at DATETIME;
