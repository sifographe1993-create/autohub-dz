-- =============================================
-- Migration: Custom Delivery Companies
-- =============================================

CREATE TABLE IF NOT EXISTS delivery_companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  api_type TEXT DEFAULT 'rest' CHECK(api_type IN ('rest', 'custom', 'manual')),
  api_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  api_token TEXT DEFAULT '',
  active INTEGER DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_delivery_companies_user ON delivery_companies(user_id);
