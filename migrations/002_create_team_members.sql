CREATE TABLE IF NOT EXISTS team_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_user_id INTEGER NOT NULL,
  nom TEXT NOT NULL,
  email TEXT,
  telephone TEXT,
  role TEXT NOT NULL DEFAULT 'confirmateur',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  can_access_platform INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_team_members_owner ON team_members(owner_user_id, created_at DESC);
