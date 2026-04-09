-- =============================================
-- Migration: Stop Desks (Offices) per Transporteur
-- =============================================

CREATE TABLE IF NOT EXISTS stop_desks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  wilaya_id INTEGER NOT NULL,
  transporteur TEXT NOT NULL,
  address TEXT DEFAULT '',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (wilaya_id) REFERENCES wilayas(id)
);

CREATE INDEX IF NOT EXISTS idx_stop_desks_wilaya ON stop_desks(wilaya_id);
CREATE INDEX IF NOT EXISTS idx_stop_desks_transporteur ON stop_desks(transporteur);

-- Seed some stop desks for major wilayas (example)
INSERT OR IGNORE INTO stop_desks (name, wilaya_id, transporteur, address) VALUES
-- Yalidine Hubs
('Hub Yalidine Alger Centre', 16, 'Yalidine', 'Didouche Mourad, Alger'),
('Hub Yalidine Birkhadem', 16, 'Yalidine', 'Les Vergers, Birkhadem'),
('Hub Yalidine Oran City', 31, 'Yalidine', 'Centre Ville, Oran'),
('Hub Yalidine Constantine Centre', 25, 'Yalidine', 'Belouizdad, Constantine'),
('Hub Yalidine Setif', 19, 'Yalidine', 'Zone Industrielle, Setif'),

-- ZR Express Hubs
('Agence ZR Alger Bab Ezzouar', 16, 'ZR Express', 'Quartier d''affaires, Bab Ezzouar'),
('Agence ZR Blida', 9, 'ZR Express', 'Blida Centre'),
('Agence ZR Oran Es Senia', 31, 'ZR Express', 'Es Senia, Oran'),
('Agence ZR Annaba', 23, 'ZR Express', 'Cours de la Revolution, Annaba');
