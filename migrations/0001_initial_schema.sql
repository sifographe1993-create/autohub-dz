-- =============================================
-- AutoHub DZ - Migration initiale
-- =============================================

-- Table des utilisateurs (authentification)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  nom TEXT DEFAULT '',
  email TEXT DEFAULT '',
  role TEXT DEFAULT 'admin',
  active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_login DATETIME
);

-- Table des sessions
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Table des wilayas (58 wilayas d'Algérie)
CREATE TABLE IF NOT EXISTS wilayas (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE
);

-- Table des communes
CREATE TABLE IF NOT EXISTS communes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  wilaya_id INTEGER NOT NULL,
  FOREIGN KEY (wilaya_id) REFERENCES wilayas(id)
);
CREATE INDEX IF NOT EXISTS idx_communes_wilaya ON communes(wilaya_id);

-- Table des commandes
CREATE TABLE IF NOT EXISTS commandes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  prix REAL NOT NULL DEFAULT 0,
  telephone TEXT NOT NULL,
  produit TEXT NOT NULL,
  commune TEXT NOT NULL,
  adresse TEXT DEFAULT '',
  wilaya TEXT NOT NULL,
  livraison TEXT DEFAULT 'A domicile',
  statut TEXT DEFAULT 'EN ATTENTE',
  tracking TEXT DEFAULT '',
  transporteur TEXT DEFAULT '',
  situation TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_commandes_statut ON commandes(statut);
CREATE INDEX IF NOT EXISTS idx_commandes_tracking ON commandes(tracking);
CREATE INDEX IF NOT EXISTS idx_commandes_transporteur ON commandes(transporteur);

-- Table du suivi (commandes expédiées)
CREATE TABLE IF NOT EXISTS suivi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nom TEXT NOT NULL,
  prix REAL NOT NULL DEFAULT 0,
  telephone TEXT NOT NULL,
  produit TEXT NOT NULL,
  commune TEXT NOT NULL,
  adresse TEXT DEFAULT '',
  wilaya TEXT NOT NULL,
  livraison TEXT DEFAULT 'A domicile',
  statut TEXT DEFAULT 'EXPÉDIÉ',
  tracking TEXT NOT NULL,
  transporteur TEXT NOT NULL,
  situation TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_suivi_tracking ON suivi(tracking);
CREATE INDEX IF NOT EXISTS idx_suivi_statut ON suivi(statut);
CREATE INDEX IF NOT EXISTS idx_suivi_transporteur ON suivi(transporteur);

-- Table de configuration API
CREATE TABLE IF NOT EXISTS api_config (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table historique des actions
CREATE TABLE IF NOT EXISTS historique (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  commande_id INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_historique_date ON historique(created_at);
