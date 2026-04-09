-- =============================================
-- Migration: Store sources + Phone verification tracking
-- =============================================

-- Table des sources de boutique (Shopify, WooCommerce, YouCan)
CREATE TABLE IF NOT EXISTS store_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  platform TEXT NOT NULL CHECK(platform IN ('shopify', 'woocommerce', 'youcan')),
  domain TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_store_sources_user ON store_sources(user_id);

-- Table de vérification des téléphones (historique livraisons/retours par numéro)
CREATE TABLE IF NOT EXISTS phone_verification (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telephone TEXT NOT NULL,
  delivered INTEGER DEFAULT 0,
  returned INTEGER DEFAULT 0,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_phone_verification_tel ON phone_verification(telephone);

-- Ajouter colonne source à commandes pour tracer l'origine
ALTER TABLE commandes ADD COLUMN source TEXT DEFAULT '';
