-- =============================================
-- Migration: Registration fields + User-linked transporteurs
-- =============================================

-- Add new fields to users table for registration
ALTER TABLE users ADD COLUMN prenom TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN telephone TEXT DEFAULT '';
ALTER TABLE users ADD COLUMN store_name TEXT DEFAULT '';

-- Table de liaison utilisateur <-> transporteurs
-- Chaque client ne voit que les transporteurs qui lui sont affectés
CREATE TABLE IF NOT EXISTS user_transporteurs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  transporteur TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, transporteur)
);
CREATE INDEX IF NOT EXISTS idx_user_transporteurs_user ON user_transporteurs(user_id);
