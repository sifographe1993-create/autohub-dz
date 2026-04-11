import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { D1Database } from '@cloudflare/workers-types'

type Bindings = { DB: D1Database }
type Variables = { userId: number; userName: string; userRole: string; userSubscription: string; userEmail: string }

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('/api/*', cors())

// ========================
// LISTE DES 5 TRANSPORTEURS EXCLUSIFS
// ========================
const TRANSPORTEURS = [
  'Yalidine',
  'ZR Express',
  'Ecotrack pdex',
  'DHD',
  'NOEST'
]

// ========================
// HASH PASSWORD (Web Crypto API compatible CF Workers)
// ========================
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(password + 'autohub-dz-salt-2026')
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function generateToken(): Promise<string> {
  const arr = new Uint8Array(32)
  crypto.getRandomValues(arr)
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('')
}

const tableColumnCache = new Map<string, boolean>()
async function hasTableColumn(db: D1Database, table: string, column: string): Promise<boolean> {
  const key = `${table}.${column}`
  if (tableColumnCache.has(key)) return tableColumnCache.get(key) as boolean
  const { results } = await db.prepare(`PRAGMA table_info(${table})`).all()
  const exists = (results || []).some((r: any) => r.name === column)
  tableColumnCache.set(key, exists)
  return exists
}

function normalizeStatusWorker(status: string): string {
  return String(status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9\s]/g, '').trim().toLowerCase()
}

function isConfirmedStatus(status: string): boolean {
  const s = String(status || '').toLowerCase()
  // Check normalized form first
  if (normalizeStatusWorker(status).includes('confirme')) return true
  // Also check raw lowercase for Mojibake-corrupted strings
  if (s.includes('confirme') || s.includes('confirm')) return true
  // Check if status contains the confirmed emoji marker
  if (s.includes('\u2705')) return true
  return false
}

async function ensureTeamMembersTable(db: D1Database) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS team_members (
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
    )`
  ).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_team_members_owner ON team_members(owner_user_id, created_at DESC)').run()
}

async function ensureAdvancedInventoryTables(db: D1Database) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS stock_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      nom TEXT NOT NULL,
      categorie TEXT DEFAULT '',
      sous_categorie TEXT DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      unit_cost REAL NOT NULL DEFAULT 0,
      unit_price REAL NOT NULL DEFAULT 0,
      supplier_name TEXT DEFAULT '',
      lead_time_days INTEGER NOT NULL DEFAULT 7,
      safety_stock INTEGER NOT NULL DEFAULT 5,
      reorder_qty INTEGER NOT NULL DEFAULT 20,
      stock_on_hand INTEGER NOT NULL DEFAULT 0,
      stock_reserved INTEGER NOT NULL DEFAULT 0,
      stock_in_transit INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ).run()
  await db.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_items_user_sku ON stock_items(user_id, sku)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_stock_items_user_category ON stock_items(user_id, categorie, sous_categorie)').run()
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      stock_item_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      unit_cost REAL DEFAULT 0,
      reference_type TEXT DEFAULT '',
      reference_id TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_stock_movements_item_date ON stock_movements(stock_item_id, created_at DESC)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_stock_movements_user_date ON stock_movements(user_id, created_at DESC)').run()
}

async function ensurePaymentRequestsTable(db: D1Database) {
  await db.prepare(
    `CREATE TABLE IF NOT EXISTS payment_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      plan TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'DZD',
      payment_method TEXT NOT NULL,
      proof_reference TEXT DEFAULT '',
      proof_notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      admin_notes TEXT DEFAULT '',
      reviewed_by INTEGER,
      reviewed_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`
  ).run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_payment_requests_user ON payment_requests(user_id, created_at DESC)').run()
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status, created_at DESC)').run()
}


function getMonthlyOrderLimit(subscription: string): number {
  const s = (subscription || 'starter').toLowerCase()
  if (s === 'pro') return 1500
  if (s === 'business') return 7000
  return 500
}

async function getMonthlyOrderUsage(db: D1Database, userId: number, hasCmdUserId: boolean, hasSuiviUserId: boolean): Promise<number> {
  const monthStart = new Date()
  monthStart.setDate(1)
  monthStart.setHours(0, 0, 0, 0)
  const monthStartSql = monthStart.toISOString().slice(0, 19).replace('T', ' ')
  const cmdRow = hasCmdUserId
    ? await db.prepare('SELECT COUNT(*) as c FROM commandes WHERE user_id = ? AND created_at >= ?').bind(userId, monthStartSql).first() as any
    : await db.prepare('SELECT COUNT(*) as c FROM commandes WHERE created_at >= ?').bind(monthStartSql).first() as any
  const suiviRow = hasSuiviUserId
    ? await db.prepare('SELECT COUNT(*) as c FROM suivi WHERE user_id = ? AND created_at >= ?').bind(userId, monthStartSql).first() as any
    : await db.prepare('SELECT COUNT(*) as c FROM suivi WHERE created_at >= ?').bind(monthStartSql).first() as any
  return Number(cmdRow?.c || 0) + Number(suiviRow?.c || 0)
}

function pickHistoryDate(h: any): string {
  const candidates = [
    h?.event_date,
    h?.status_date,
    h?.changed_at,
    h?.history_date,
    h?.scan_date,
    h?.operation_date,
    h?.event_time,
    h?.eventTime,
    h?.event_datetime,
    h?.eventDate,
    h?.datetime,
    h?.date_time,
    h?.created,
    h?.created_on,
    h?.createdOn,
    h?.timestamp,
    h?.created_at,
    h?.updated_at,
    h?.createdAt,
    h?.updatedAt,
    h?.date,
    h?.time
  ]
  for (const value of candidates) {
    if (value === null || value === undefined) continue
    const text = String(value).trim()
    if (!text || text.toLowerCase() === 'undefined' || text.toLowerCase() === 'null' || text.toLowerCase() === 'nan') continue
    return text
  }
  return ''
}

// ========================
// AUTH MIDDLEWARE
// ========================
app.use('/api/*', async (c, next) => {
  const path = new URL(c.req.url).pathname
  const publicRoutes = ['/api/auth/login', '/api/auth/register', '/api/auth/check', '/api/auth/google-url', '/api/auth/google-callback', '/api/transporteurs', '/api/webhook', '/api/woo/callback', '/api/woo/return']
  if (publicRoutes.includes(path)) return next()

  const token = getCookie(c, 'session_token') || c.req.header('Authorization')?.replace('Bearer ', '')
  if (!token) return c.json({ error: 'Non authentifiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', code: 'AUTH_REQUIRED' }, 401)

  const session = await c.env.DB.prepare(
    "SELECT s.user_id, u.username, u.nom, u.prenom, u.role, u.subscription, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).bind(token).first() as any

  if (!session) {
    deleteCookie(c, 'session_token')
    return c.json({ error: 'Session expirÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e', code: 'AUTH_REQUIRED' }, 401)
  }

  c.set('userId', session.user_id)
  c.set('userName', session.prenom || session.nom || session.username)
  c.set('userRole', session.role || 'client')
  c.set('userSubscription', session.subscription || 'starter')
  c.set('userEmail', session.email || '')
  return next()
})

// ========================
// AUTH ROUTES
// ========================
app.post('/api/auth/login', async (c) => {
  const { username, password } = await c.req.json()
  if (!username || !password) return c.json({ error: 'Identifiants requis' }, 400)

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE (username = ? OR email = ?) AND active = 1').bind(username, username).first() as any
  if (!user) return c.json({ error: 'Identifiants incorrects' }, 401)

  const hashedInput = await hashPassword(password)

  if (user.password_hash.length < 64) {
    if (user.password_hash !== password) return c.json({ error: 'Identifiants incorrects' }, 401)
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hashedInput, user.id).run()
  } else {
    if (user.password_hash !== hashedInput) return c.json({ error: 'Identifiants incorrects' }, 401)
  }

  await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? OR expires_at < datetime('now')").bind(user.id).run()

  const token = await generateToken()
  await c.env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
  ).bind(token, user.id).run()

  await c.env.DB.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run()

  setCookie(c, 'session_token', token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 30
  })

  return c.json({ success: true, user: { id: user.id, username: user.username, nom: user.nom, prenom: user.prenom, role: user.role, subscription: user.subscription || 'starter', store_name: user.store_name } })
})

// ========================
// REGISTRATION ROUTE
// ========================
app.post('/api/auth/register', async (c) => {
  const { prenom, email, telephone, store_name, password, confirm_password } = await c.req.json()

  // Validation stricte des champs requis
  if (!prenom || !email || !telephone || !store_name || !password || !confirm_password) {
    return c.json({ error: 'Tous les champs sont obligatoires' }, 400)
  }

  // Validation prÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©nom
  if (prenom.trim().length < 2) {
    return c.json({ error: 'Le prÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©nom doit contenir au moins 2 caractÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨res' }, 400)
  }

  // Validation email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return c.json({ error: 'Adresse email invalide' }, 400)
  }

  // Validation tÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©lÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©phone algÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rien (05xx, 06xx, 07xx)
  const phoneClean = telephone.replace(/[\s\-\.]/g, '')
  const phoneRegex = /^(0[567]\d{8}|\+213[567]\d{8})$/
  if (!phoneRegex.test(phoneClean)) {
    return c.json({ error: 'NumÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©ro de tÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©lÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©phone invalide (format: 05xxxxxxxx, 06xxxxxxxx, 07xxxxxxxx)' }, 400)
  }

  // Validation store name
  if (store_name.trim().length < 2) {
    return c.json({ error: 'Le nom du magasin doit contenir au moins 2 caractÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨res' }, 400)
  }

  // Validation mot de passe
  if (password.length < 6) {
    return c.json({ error: 'Le mot de passe doit contenir au moins 6 caractÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨res' }, 400)
  }

  if (password !== confirm_password) {
    return c.json({ error: 'Les mots de passe ne correspondent pas' }, 400)
  }

  // VÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rifier si l'email existe dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â 
  const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first()
  if (existingUser) {
    return c.json({ error: 'Cette adresse email est dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  utilisÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e' }, 400)
  }

  // VÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rifier si le tÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©lÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©phone existe dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â 
  const existingPhone = await c.env.DB.prepare('SELECT id FROM users WHERE telephone = ?').bind(phoneClean).first()
  if (existingPhone) {
    return c.json({ error: 'Ce numÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©ro de tÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©lÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©phone est dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©jÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  utilisÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©' }, 400)
  }

  // Hacher le mot de passe
  const hashedPassword = await hashPassword(password)

  // CrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©er le username ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  partir de l'email (partie avant @)
  const username = email.trim().toLowerCase().split('@')[0] + '_' + Date.now().toString(36)

  // InsÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rer l'utilisateur avec abonnement par dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©faut
  const result = await c.env.DB.prepare(
    `INSERT INTO users (username, password_hash, prenom, nom, email, telephone, store_name, role, active, subscription)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'client', 1, 'starter')`
  ).bind(username, hashedPassword, prenom.trim(), prenom.trim(), email.trim().toLowerCase(), phoneClean, store_name.trim()).run()

  const userId = result.meta.last_row_id

  // Par dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©faut, assigner tous les transporteurs disponibles au nouveau client
  for (const t of TRANSPORTEURS) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO user_transporteurs (user_id, transporteur) VALUES (?, ?)').bind(userId, t).run()
  }

  // CrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©er la session automatiquement (auto-login)
  const token = await generateToken()
  await c.env.DB.prepare(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
  ).bind(token, userId).run()

  setCookie(c, 'session_token', token, {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    maxAge: 60 * 60 * 24 * 30
  })

  return c.json({
    success: true,
    user: { id: userId, username, prenom: prenom.trim(), email: email.trim().toLowerCase(), store_name: store_name.trim(), role: 'client' }
  })
})

// ========================
// GOOGLE OAUTH ROUTES
// ========================
app.get('/api/auth/google-url', async (c) => {
  // Return Google OAuth authorization URL
  // Requires GOOGLE_CLIENT_ID in environment/secrets
  const clientId = (c.env as any).GOOGLE_CLIENT_ID
  if (!clientId) {
    return c.json({ error: 'Google OAuth non configure. Ajoutez GOOGLE_CLIENT_ID dans les secrets.' }, 400)
  }
  const origin = new URL(c.req.url).origin
  const redirectUri = `${origin}/api/auth/google-callback`
  const scope = encodeURIComponent('openid email profile')
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent`
  return c.json({ url })
})

app.get('/api/auth/google-callback', async (c) => {
  const code = c.req.query('code')
  if (!code) return c.redirect('/register?error=google_auth_failed')

  const clientId = (c.env as any).GOOGLE_CLIENT_ID
  const clientSecret = (c.env as any).GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) return c.redirect('/register?error=google_not_configured')

  try {
    const origin = new URL(c.req.url).origin
    const redirectUri = `${origin}/api/auth/google-callback`

    // Exchange code for tokens
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code'
      })
    })
    const tokenData: any = await tokenResp.json()
    if (!tokenData.access_token) return c.redirect('/register?error=google_token_failed')

    // Get user info from Google
    const userResp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
    })
    const googleUser: any = await userResp.json()
    if (!googleUser.email) return c.redirect('/register?error=google_email_missing')

    const email = googleUser.email.toLowerCase()
    const prenom = googleUser.given_name || googleUser.name || email.split('@')[0]

    // Check if user exists
    let user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first() as any

    if (!user) {
      // Auto-register with Google
      const username = email.split('@')[0] + '_g_' + Date.now().toString(36)
      const hashedPassword = await hashPassword(crypto.randomUUID())
      await c.env.DB.prepare(
        `INSERT INTO users (username, password_hash, prenom, nom, email, telephone, store_name, role, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'client', 1)`
      ).bind(username, hashedPassword, prenom, prenom, email, '', prenom + ' Store').run()
      user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first() as any

      // Assign default transporteurs
      for (const t of TRANSPORTEURS) {
        await c.env.DB.prepare('INSERT OR IGNORE INTO user_transporteurs (user_id, transporteur) VALUES (?, ?)').bind(user.id, t).run()
      }
    }

    // Create session
    await c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? OR expires_at < datetime('now')").bind(user.id).run()
    const token = await generateToken()
    await c.env.DB.prepare(
      "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
    ).bind(token, user.id).run()
    await c.env.DB.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run()

    setCookie(c, 'session_token', token, {
      path: '/', httpOnly: true, secure: true, sameSite: 'Lax', maxAge: 60 * 60 * 24 * 30
    })

    return c.redirect('/app')
  } catch (e: any) {
    return c.redirect('/register?error=' + encodeURIComponent(e.message || 'google_error'))
  }
})

app.post('/api/auth/logout', async (c) => {
  const token = getCookie(c, 'session_token')
  if (token) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run()
  }
  deleteCookie(c, 'session_token')
  return c.json({ success: true })
})

app.get('/api/auth/check', async (c) => {
  const token = getCookie(c, 'session_token')
  if (!token) return c.json({ authenticated: false })
  const session = await c.env.DB.prepare(
    "SELECT s.user_id, u.username, u.nom, u.prenom, u.role, u.store_name, u.subscription, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).bind(token).first() as any
  if (!session) return c.json({ authenticated: false })
  return c.json({ authenticated: true, user: { id: session.user_id, username: session.username, nom: session.nom, prenom: session.prenom, role: session.role, subscription: session.subscription || 'starter', store_name: session.store_name, email: session.email || '' } })
})

app.put('/api/auth/password', async (c) => {
  const { current_password, new_password } = await c.req.json()
  if (!current_password || !new_password) return c.json({ error: 'Champs requis' }, 400)
  if (new_password.length < 6) return c.json({ error: 'Minimum 6 caractÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨res' }, 400)

  const userId = c.get('userId')
  const user = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(userId).first() as any
  const hashedCurrent = await hashPassword(current_password)
  if (user.password_hash !== hashedCurrent) return c.json({ error: 'Mot de passe actuel incorrect' }, 401)

  const hashedNew = await hashPassword(new_password)
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hashedNew, userId).run()
  return c.json({ success: true })
})

// ========================
// ADMIN - GESTION UTILISATEURS (role admin uniquement)
// ========================
app.use('/api/admin/*', async (c, next) => {
  if (c.get('userRole') !== 'admin') {
    return c.json({ error: 'AccÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨s rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©servÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© aux administrateurs', code: 'FORBIDDEN' }, 403)
  }
  return next()
})

app.get('/api/admin/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, username, email, prenom, nom, telephone, store_name, role, active, created_at, last_login
     FROM users ORDER BY id DESC`
  ).all()
  return c.json(results)
})

app.put('/api/admin/users/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const adminId = c.get('userId')
  const body = await c.req.json()
  const role = body.role as string | undefined
  const active = body.active as number | undefined

  if (role === undefined && active === undefined) {
    return c.json({ error: 'Aucune modification' }, 400)
  }
  if (role !== undefined && role !== 'admin' && role !== 'client' && role !== 'employe') {
    return c.json({ error: 'RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´le invalide' }, 400)
  }
  if (active !== undefined && active !== 0 && active !== 1) {
    return c.json({ error: 'Statut actif invalide' }, 400)
  }

  const target = await c.env.DB.prepare('SELECT id, role, active FROM users WHERE id = ?').bind(id).first() as any
  if (!target) return c.json({ error: 'Utilisateur introuvable' }, 404)

  if (id === adminId && (role === 'client' || role === 'employe' || active === 0)) {
    return c.json({ error: 'Vous ne pouvez pas rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©trograder ou dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©sactiver votre propre compte' }, 400)
  }

  const demoteAdmin = target.role === 'admin' && (role === 'client' || role === 'employe')
  const deactivateAdmin = target.role === 'admin' && active === 0
  if (demoteAdmin || deactivateAdmin) {
    const cntRow = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' AND active = 1").first() as any
    if (Number(cntRow?.c || 0) <= 1) {
      return c.json({ error: 'Impossible : au moins un administrateur actif doit rester' }, 400)
    }
  }

  const updates: string[] = []
  const values: any[] = []
  if (role !== undefined) { updates.push('role = ?'); values.push(role) }
  if (active !== undefined) { updates.push('active = ?'); values.push(active) }
  if (body.subscription !== undefined) { updates.push('subscription = ?'); values.push(body.subscription) }
  values.push(id)
  await c.env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run()

  await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind(
    'ADMIN_USER',
    JSON.stringify({ admin_id: adminId, target_id: id, role: role ?? null, active: active ?? null }),
    null
  ).run()

  return c.json({ success: true })
})

// ========================
// TRANSPORTEURS - FiltrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©s par utilisateur
// ========================
app.get('/api/transporteurs', async (c) => {
  // Si utilisateur authentifiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©, retourner seulement ses transporteurs liÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©s
  const token = getCookie(c, 'session_token') || c.req.header('Authorization')?.replace('Bearer ', '')
  if (token) {
    const session = await c.env.DB.prepare(
      "SELECT s.user_id FROM sessions s WHERE s.token = ? AND s.expires_at > datetime('now')"
    ).bind(token).first() as any
    if (session) {
      const { results } = await c.env.DB.prepare(
        'SELECT transporteur FROM user_transporteurs WHERE user_id = ? ORDER BY transporteur'
      ).bind(session.user_id).all()
      if (results && results.length > 0) {
        return c.json(results.map((r: any) => r.transporteur))
      }
    }
  }
  // Fallback : liste complÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨te pour les non-authentifiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©s
  return c.json(TRANSPORTEURS)
})

// ========================
// USER TRANSPORTEURS MANAGEMENT (Admin)
// ========================
app.get('/api/user-transporteurs', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(
    'SELECT transporteur FROM user_transporteurs WHERE user_id = ? ORDER BY transporteur'
  ).bind(userId).all()
  return c.json(results?.map((r: any) => r.transporteur) || [])
})

app.put('/api/user-transporteurs', async (c) => {
  const userId = c.get('userId')
  const { transporteurs } = await c.req.json()
  if (!Array.isArray(transporteurs)) return c.json({ error: 'Format invalide' }, 400)

  // Valider que chaque transporteur est dans la liste autorisÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e
  const validTransporteurs = transporteurs.filter(t => TRANSPORTEURS.includes(t))

  // Supprimer les anciens liens
  await c.env.DB.prepare('DELETE FROM user_transporteurs WHERE user_id = ?').bind(userId).run()

  // InsÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rer les nouveaux
  for (const t of validTransporteurs) {
    await c.env.DB.prepare('INSERT INTO user_transporteurs (user_id, transporteur) VALUES (?, ?)').bind(userId, t).run()
  }

  return c.json({ success: true, transporteurs: validTransporteurs })
})

// ========================
// TEAM MEMBERS (confirmateurs/livreurs)
// ========================
app.get('/api/team-members', async (c) => {
  const userId = c.get('userId')
  await ensureTeamMembersTable(c.env.DB)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM team_members WHERE owner_user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()
  return c.json(results || [])
})

app.post('/api/team-members', async (c) => {
  const userId = c.get('userId')
  await ensureTeamMembersTable(c.env.DB)
  const body = await c.req.json()
  const nom = (body.nom || '').trim()
  const email = (body.email || '').trim()
  const telephone = (body.telephone || '').trim()
  const role = String(body.role || '').trim().toLowerCase()
  const password = String(body.password || '')
  const passwordConfirm = String(body.password_confirm || '')
  const permissions = Array.isArray(body.permissions) ? body.permissions : []
  const canAccess = body.can_access_platform ? 1 : 0
  const active = body.active === 0 ? 0 : 1
  if (!nom) return c.json({ error: 'Nom requis' }, 400)
  if (!email) return c.json({ error: 'Email requis' }, 400)
  if (!['confirmateur', 'livreur', 'manager'].includes(role)) return c.json({ error: 'Role requis ou invalide' }, 400)
  if (!password || password.length < 6) return c.json({ error: 'Mot de passe requis (minimum 6 caracteres)' }, 400)
  if (password !== passwordConfirm) return c.json({ error: 'Confirmation mot de passe incorrecte' }, 400)
  const result = await c.env.DB.prepare(
    `INSERT INTO team_members (owner_user_id, nom, email, telephone, role, permissions_json, can_access_platform, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(userId, nom, email, telephone, role, JSON.stringify(permissions), canAccess, active).run()
  const passwordHash = await hashPassword(password)
  const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.toLowerCase()).first() as any
  if (existingUser?.id) {
    await c.env.DB.prepare('UPDATE users SET role = ?, active = ?, password_hash = ? WHERE id = ?')
      .bind('employe', active, passwordHash, existingUser.id).run()
  } else {
    const username = (email.split('@')[0] || 'employe') + '_e_' + Date.now().toString(36)
    await c.env.DB.prepare(
      `INSERT INTO users (username, password_hash, prenom, nom, email, telephone, store_name, role, active, subscription)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'employe', ?, 'starter')`
    ).bind(username, passwordHash, nom, nom, email.toLowerCase(), telephone || '', 'Equipe ' + userId, active).run()
  }
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.put('/api/team-members/:id', async (c) => {
  const userId = c.get('userId')
  await ensureTeamMembersTable(c.env.DB)
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const updates: string[] = []
  const values: any[] = []
  if (body.nom !== undefined) { updates.push('nom = ?'); values.push(String(body.nom).trim()) }
  if (body.email !== undefined) { updates.push('email = ?'); values.push(String(body.email).trim()) }
  if (body.telephone !== undefined) { updates.push('telephone = ?'); values.push(String(body.telephone).trim()) }
  if (body.role !== undefined) {
    const role = String(body.role).trim().toLowerCase()
    if (!['confirmateur', 'livreur', 'manager'].includes(role)) return c.json({ error: 'Role invalide' }, 400)
    updates.push('role = ?')
    values.push(role)
  }
  if (body.permissions !== undefined) {
    updates.push('permissions_json = ?')
    values.push(JSON.stringify(Array.isArray(body.permissions) ? body.permissions : []))
  }
  if (body.can_access_platform !== undefined) { updates.push('can_access_platform = ?'); values.push(body.can_access_platform ? 1 : 0) }
  if (body.active !== undefined) { updates.push('active = ?'); values.push(body.active ? 1 : 0) }
  const hasPasswordUpdate = body.password !== undefined
  if (updates.length === 0 && !hasPasswordUpdate) return c.json({ error: 'Aucune modification' }, 400)
  if (updates.length > 0) {
    updates.push('updated_at = CURRENT_TIMESTAMP')
    values.push(id, userId)
    const result = await c.env.DB.prepare(`UPDATE team_members SET ${updates.join(', ')} WHERE id = ? AND owner_user_id = ?`).bind(...values).run()
    if ((result.meta?.changes || 0) === 0) return c.json({ error: 'Membre introuvable' }, 404)
  } else {
    const exists = await c.env.DB.prepare('SELECT id FROM team_members WHERE id = ? AND owner_user_id = ?').bind(id, userId).first()
    if (!exists) return c.json({ error: 'Membre introuvable' }, 404)
  }
  const updated = await c.env.DB.prepare('SELECT email, nom, telephone, active FROM team_members WHERE id = ? AND owner_user_id = ?')
    .bind(id, userId).first() as any
  if (updated?.email) {
    const newPassword = body.password !== undefined ? String(body.password) : ''
    const passwordHash = newPassword ? await hashPassword(newPassword) : null
    if (newPassword && newPassword.length < 6) return c.json({ error: 'Mot de passe minimum 6 caracteres' }, 400)
    if (body.password !== undefined && String(body.password_confirm || '') !== newPassword) return c.json({ error: 'Confirmation mot de passe incorrecte' }, 400)
    if (passwordHash) {
      await c.env.DB.prepare('UPDATE users SET role = ?, active = ?, password_hash = ?, telephone = ?, nom = ?, prenom = ? WHERE email = ?')
        .bind('employe', updated.active ? 1 : 0, passwordHash, updated.telephone || '', updated.nom || '', updated.nom || '', String(updated.email).toLowerCase()).run()
    } else {
      await c.env.DB.prepare('UPDATE users SET role = ?, active = ?, telephone = ?, nom = ?, prenom = ? WHERE email = ?')
        .bind('employe', updated.active ? 1 : 0, updated.telephone || '', updated.nom || '', updated.nom || '', String(updated.email).toLowerCase()).run()
    }
  }
  return c.json({ success: true })
})

app.delete('/api/team-members/:id', async (c) => {
  const userId = c.get('userId')
  await ensureTeamMembersTable(c.env.DB)
  const id = Number(c.req.param('id'))
  const result = await c.env.DB.prepare('DELETE FROM team_members WHERE id = ? AND owner_user_id = ?').bind(id, userId).run()
  if ((result.meta?.changes || 0) === 0) return c.json({ error: 'Membre introuvable' }, 404)
  return c.json({ success: true })
})

app.get('/api/team-members/me', async (c) => {
  const role = (c.get('userRole') || '').toLowerCase()
  if (role !== 'employe') {
    return c.json({ allowed: true, role: 'default', permissions: ['*'] })
  }
  const email = (c.get('userEmail') || '').toLowerCase().trim()
  if (!email) return c.json({ allowed: false, reason: 'EMAIL_MISSING' }, 403)
  await ensureTeamMembersTable(c.env.DB)
  const row = await c.env.DB.prepare(
    'SELECT * FROM team_members WHERE LOWER(email) = ? ORDER BY updated_at DESC, id DESC LIMIT 1'
  ).bind(email).first() as any
  if (!row) return c.json({ allowed: false, reason: 'MEMBER_NOT_FOUND' }, 403)
  if (!row.active) return c.json({ allowed: false, reason: 'MEMBER_INACTIVE' }, 403)
  if (!row.can_access_platform) return c.json({ allowed: false, reason: 'PLATFORM_ACCESS_DISABLED' }, 403)
  let permissions: string[] = []
  try { permissions = JSON.parse(row.permissions_json || '[]') } catch { permissions = [] }
  return c.json({ allowed: true, role: row.role || 'confirmateur', permissions, member: { id: row.id, nom: row.nom } })
})

// ========================
// WILAYAS & COMMUNES
// ========================
app.get('/api/wilayas', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, name, code FROM wilayas ORDER BY id').all()
  return c.json(results)
})

app.get('/api/communes/:wilayaId', async (c) => {
  const wid = c.req.param('wilayaId')
  const { results } = await c.env.DB.prepare('SELECT id, name FROM communes WHERE wilaya_id = ? ORDER BY name').bind(wid).all()
  return c.json(results)
})

app.get('/api/stop-desks/:wilayaId', async (c) => {
  const wid = c.req.param('wilayaId')
  const transporteur = (c.req.query('transporteur') || '').toLowerCase()

  const wilaya = await c.env.DB.prepare('SELECT name FROM wilayas WHERE id = ?').bind(wid).first() as any
  if (!wilaya) return c.json([])
  const wilayaName = wilaya.name

  const { results: configsRecords } = await c.env.DB.prepare("SELECT provider, config_json FROM api_config WHERE active = 1").all()
  const apiConfigs: Record<string, any> = {}
  for (const row of (configsRecords || [])) {
    apiConfigs[(row as any).provider] = JSON.parse((row as any).config_json)
  }

  try {
    if (transporteur.includes('zr') || transporteur.includes('express')) {
      const config = apiConfigs['zr_express']
      if (config?.api_key && config?.tenant) {
        const wilayaResp = await fetch('https://api.zrexpress.app/api/v1/territories/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.api_key, 'X-Tenant': config.tenant },
          body: JSON.stringify({ keyword: wilayaName, pageNumber: 1, pageSize: 50 })
        })
        if (wilayaResp.ok) {
          const wilayaData: any = await wilayaResp.json()
          let zrWilayaId = null
          if (wilayaData?.items) {
            for (const t of wilayaData.items) {
              if (t.level === 'wilaya' && t.name.toLowerCase().includes(wilayaName.toLowerCase())) { zrWilayaId = t.id; break }
            }
          }
          if (zrWilayaId) {
            const ppResp = await fetch('https://api.zrexpress.app/api/v1/pickup-points/search', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.api_key, 'X-Tenant': config.tenant },
              body: JSON.stringify({ territoryId: zrWilayaId, pageNumber: 1, pageSize: 100 })
            })
            if (ppResp.ok) {
              const ppData: any = await ppResp.json()
              if (ppData?.items && Array.isArray(ppData.items) && ppData.items.length > 0) {
                return c.json(ppData.items.map((pp: any) => ({
                  name: pp.name || pp.address || 'Point relais',
                  address: pp.address || ''
                })))
              }
            }
          }
        }
      }
    }

    else if (transporteur.includes('yalidine')) {
      const config = apiConfigs['yalidine']
      if (config?.api_id && config?.api_token) {
        const resp = await fetch('https://api.yalidine.com/v1/centers/?wilaya_name=' + encodeURIComponent(wilayaName) + '&is_stopdesk=true', {
          headers: { 'X-API-ID': config.api_id, 'X-API-TOKEN': config.api_token }
        })
        if (resp.ok) {
          const data: any = await resp.json()
          const centers = data?.data || data || []
          if (Array.isArray(centers) && centers.length > 0) {
            return c.json(centers.map((center: any) => ({
              name: center.center_name || center.name || 'Centre Yalidine',
              address: center.address || '',
              commune: center.commune_name || ''
            })))
          }
        }
      }
    }

    else if (transporteur.includes('ecotrack') || transporteur.includes('pdex')) {
      const config = apiConfigs['ecotrack_pdex']
      if (config?.token) {
        const resp = await fetch('https://pdex.ecotrack.dz/api/v1/stop-desks?wilaya=' + encodeURIComponent(wilayaName), {
          headers: { 'Authorization': 'Bearer ' + config.token, 'Accept': 'application/json' }
        })
        if (resp.ok) {
          const data: any = await resp.json()
          const desks = data?.data || data || []
          if (Array.isArray(desks) && desks.length > 0) {
            return c.json(desks.map((d: any) => ({
              name: d.name || d.desk_name || 'Stop Desk',
              address: d.address || ''
            })))
          }
        }
      }
    }

    // Fallback : table locale
    const { results } = await c.env.DB.prepare(
      'SELECT name FROM stop_desks WHERE wilaya_id = ? AND transporteur LIKE ? ORDER BY name'
    ).bind(wid, '%' + transporteur + '%').all()
    if (results && results.length > 0) return c.json(results)

    return c.json([])

  } catch (e: any) {
    console.error('Stop desks error:', e.message)
    const { results } = await c.env.DB.prepare(
      'SELECT name FROM stop_desks WHERE wilaya_id = ? ORDER BY name'
    ).bind(wid).all()
    return c.json(results || [])
  }
})

// ========================
// COMMANDES CRUD
// ========================
app.get('/api/commandes', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
  const adminFilterUserId = c.req.query('user_id')
  const statut = c.req.query('statut')
  let query = 'SELECT * FROM commandes WHERE 1=1'
  const params: any[] = []
  if (hasUserIdColumn) {
    if (isAdmin && adminFilterUserId) { query += ' AND user_id = ?'; params.push(Number(adminFilterUserId)) }
    else if (!isAdmin) { query += ' AND user_id = ?'; params.push(userId) }
  }
  if (statut) { query += ' AND statut = ?'; params.push(statut) }
  query += ' ORDER BY created_at DESC'
  const stmt = params.length ? c.env.DB.prepare(query).bind(...params) : c.env.DB.prepare(query)
  const { results } = await stmt.all()
  return c.json(results)
})

app.post('/api/commandes', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
  const hasSuiviUserId = await hasTableColumn(c.env.DB, 'suivi', 'user_id')
  if (!isAdmin) {
    const user = await c.env.DB.prepare('SELECT subscription FROM users WHERE id = ?').bind(userId).first() as any
    const limit = getMonthlyOrderLimit(user?.subscription || 'starter')
    const used = await getMonthlyOrderUsage(c.env.DB, userId, hasUserIdColumn, hasSuiviUserId)
    if (used >= limit) {
      return c.json({ error: `Limite mensuelle atteinte (${limit} commandes)`, code: 'QUOTA_EXCEEDED', orders_limit: limit, orders_used: used }, 403)
    }
  }
  const body = await c.req.json()
  const { nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, transporteur, notes } = body
  if (!nom || !telephone || !produit || !wilaya || !commune) {
    return c.json({ error: 'Champs obligatoires manquants' }, 400)
  }
  const result = hasUserIdColumn
    ? await c.env.DB.prepare(
      `INSERT INTO commandes (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, transporteur, notes, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(nom, prix || 0, telephone, produit, commune, adresse || '', wilaya, livraison || 'A domicile', statut || 'Nouvelle', transporteur || '', notes || '', userId).run()
    : await c.env.DB.prepare(
      `INSERT INTO commandes (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, transporteur, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(nom, prix || 0, telephone, produit, commune, adresse || '', wilaya, livraison || 'A domicile', statut || 'Nouvelle', transporteur || '', notes || '').run()
  await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind('CREATION', `Nouvelle commande enregistree pour ${nom}`, result.meta.last_row_id).run()
  return c.json({ id: result.meta.last_row_id, success: true })
})

app.put('/api/commandes/:id', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields = ['nom', 'prix', 'telephone', 'produit', 'commune', 'adresse', 'wilaya', 'livraison', 'statut', 'transporteur', 'tracking', 'situation', 'notes', 'source']
  const updates: string[] = []
  const values: any[] = []
  for (const f of fields) {
    if (body[f] !== undefined) { updates.push(`${f} = ?`); values.push(body[f]) }
  }
  if (updates.length === 0) return c.json({ error: 'Rien a mettre a jour' }, 400)
  updates.push('updated_at = CURRENT_TIMESTAMP')
  let sql = `UPDATE commandes SET ${updates.join(', ')} WHERE id = ?`
  values.push(id)
  if (!isAdmin && hasUserIdColumn) { sql += ' AND user_id = ?'; values.push(userId) }
  const result = await c.env.DB.prepare(sql).bind(...values).run()
  if ((result.meta?.changes || 0) === 0) return c.json({ error: 'Commande introuvable ou non autorisee' }, 404)
  await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind('MODIFICATION', JSON.stringify(body), id).run()
  return c.json({ success: true })
})

app.delete('/api/commandes/:id', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
  const id = c.req.param('id')
  let sql = 'DELETE FROM commandes WHERE id = ?'
  const params: any[] = [id]
  if (!isAdmin && hasUserIdColumn) { sql += ' AND user_id = ?'; params.push(userId) }
  const result = await c.env.DB.prepare(sql).bind(...params).run()
  if ((result.meta?.changes || 0) === 0) return c.json({ error: 'Commande introuvable ou non autorisee' }, 404)
  return c.json({ success: true })
})

// ========================
// ENVOI VERS TRANSPORTEURS
// ========================
app.post('/api/envoyer/:id', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasCmdUserId = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
  const hasSuiviUserId = await hasTableColumn(c.env.DB, 'suivi', 'user_id')
  const id = c.req.param('id')
  let selectSql = 'SELECT * FROM commandes WHERE id = ?'
  const selectParams: any[] = [id]
  if (!isAdmin && hasCmdUserId) { selectSql += ' AND user_id = ?'; selectParams.push(userId) }
  const { results } = await c.env.DB.prepare(selectSql).bind(...selectParams).all()
  if (!results || results.length === 0) return c.json({ error: 'Commande introuvable' }, 404)
  const cmd = results[0] as any
  if (!isConfirmedStatus(cmd.statut)) return c.json({ error: 'Seules les commandes confirmees peuvent etre envoyees' }, 400)
  if (cmd.tracking) return c.json({ error: 'Commande deja expediee' }, 400)

  const transporteur = (cmd.transporteur || '').toLowerCase()
  let providerKey = ''
  if (transporteur.includes('yalidine')) providerKey = 'yalidine'
  else if (transporteur.includes('zr') || (transporteur.includes('express') && transporteur.includes('zr'))) providerKey = 'zr_express'
  else if (transporteur.includes('ecotrack') || transporteur.includes('pdex')) providerKey = 'ecotrack_pdex'
  else if (transporteur.includes('dhd')) providerKey = 'dhd'
  else if (transporteur.includes('noest')) providerKey = 'noest'
  else {
    providerKey = transporteur.replace(/[^a-z0-9]/g, '_')
  }

  const { results: configs } = await c.env.DB.prepare('SELECT * FROM api_config WHERE provider = ? AND active = 1').bind(providerKey).all()
  const config = configs && configs.length > 0 ? JSON.parse((configs[0] as any).config_json) : null

  let tracking = ''
  let error = ''

  try {
    if (providerKey === 'yalidine' && config?.api_id && config?.api_token) {
      const isStop = cmd.livraison?.toLowerCase().includes('stop')
      const data = [{
        order_id: `CMD-${id}-${Date.now()}`, firstname: cmd.nom, familyname: '',
        contact_phone: cmd.telephone, address: cmd.adresse, to_wilaya_name: cmd.wilaya,
        to_commune_name: cmd.commune, product_list: cmd.produit, price: cmd.prix,
        is_stopdesk: isStop, has_exchange: 0, freeshipping: 0
      }]
      const resp = await fetch('https://api.yalidine.com/v1/parcels/', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-ID': config.api_id, 'X-API-TOKEN': config.api_token },
        body: JSON.stringify(data)
      })
      if (resp.ok) {
        const result: any = await resp.json()
        const parcel = result[Object.keys(result)[0]]
        if (parcel?.success && parcel?.tracking) { tracking = parcel.tracking }
        else { error = parcel?.message || 'Refuse par Yalidine' }
      } else { error = `HTTP ${resp.status}` }

    } else if (providerKey === 'zr_express' && config?.api_key && config?.tenant) {
      let phone = cmd.telephone.replace(/^'/, '').replace(/^0/, '+213')
      if (!phone.startsWith('+213')) phone = '+213' + phone
      const isStop = cmd.livraison?.toLowerCase().includes('stop')
      const payload: any = {
        customer: { customerId: crypto.randomUUID(), name: cmd.nom, phone: { number1: phone } },
        deliveryAddress: { street: cmd.adresse },
        orderedProducts: [{ productName: cmd.produit, unitPrice: Number(cmd.prix), quantity: 1, stockType: 'none' }],
        amount: Number(cmd.prix), description: cmd.produit, deliveryType: isStop ? 'pickup-point' : 'home'
      }
      const wilayaResp = await fetch('https://api.zrexpress.app/api/v1/territories/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.api_key, 'X-Tenant': config.tenant },
        body: JSON.stringify({ keyword: cmd.wilaya, pageNumber: 1, pageSize: 50 })
      })
      const wilayaData: any = await wilayaResp.json()
      let cityId = null
      if (wilayaData?.items) {
        for (const t of wilayaData.items) { if (t.level === 'wilaya' && t.name.toLowerCase().includes(cmd.wilaya.toLowerCase())) { cityId = t.id; break } }
      }
      if (!cityId) { error = 'Wilaya introuvable ZR' } else {
        if (!isStop) {
          const communeResp = await fetch('https://api.zrexpress.app/api/v1/territories/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.api_key, 'X-Tenant': config.tenant },
            body: JSON.stringify({ keyword: cmd.commune, pageNumber: 1, pageSize: 50 })
          })
          const communeData: any = await communeResp.json()
          let districtId = null
          if (communeData?.items) { for (const t of communeData.items) { if (t.level === 'commune') { districtId = t.id; break } } }
          payload.deliveryAddress.cityTerritoryId = cityId
          payload.deliveryAddress.districtTerritoryId = districtId || cityId
        } else {
          payload.deliveryAddress.cityTerritoryId = cityId
          payload.deliveryAddress.districtTerritoryId = cityId
        }
        const resp = await fetch('https://api.zrexpress.app/api/v1/parcels', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Api-Key': config.api_key, 'X-Tenant': config.tenant },
          body: JSON.stringify(payload)
        })
        if (resp.ok) {
          const result: any = await resp.json()
          tracking = result.trackingNumber || result?.parcel?.trackingNumber || result.id || ''
        } else { error = `HTTP ${resp.status}` }
      }

    } else if (providerKey === 'ecotrack_pdex' && config?.token) {
      const phone = cmd.telephone.replace(/^'/, '').replace(/^0/, '')
      const wilayaCodes: Record<string, string> = {
        'Adrar': '1', 'Chlef': '2', 'Laghouat': '3', 'Oum El Bouaghi': '4', 'Batna': '5', 'Bejaia': '6', 'Biskra': '7', 'Bechar': '8',
        'Blida': '9', 'Bouira': '10', 'Tamanrasset': '11', 'Tebessa': '12', 'Tlemcen': '13', 'Tiaret': '14', 'Tizi Ouzou': '15', 'Alger': '16',
        'Djelfa': '17', 'Jijel': '18', 'Setif': '19', 'Saida': '20', 'Skikda': '21', 'Sidi Bel Abbes': '22', 'Annaba': '23', 'Guelma': '24',
        'Constantine': '25', 'Medea': '26', 'Mostaganem': '27', 'Msila': '28', 'Mascara': '29', 'Ouargla': '30', 'Oran': '31', 'El Bayadh': '32',
        'Illizi': '33', 'Bordj Bou Arreridj': '34', 'Boumerdes': '35', 'El Tarf': '36', 'Tindouf': '37', 'Tissemsilt': '38', 'El Oued': '39',
        'Khenchela': '40', 'Souk Ahras': '41', 'Tipaza': '42', 'Mila': '43', 'Ain Defla': '44', 'Naama': '45', 'Ain Temouchent': '46',
        'Ghardaia': '47', 'Relizane': '48', 'Timimoun': '49', 'Bordj Badji Mokhtar': '50', 'Ouled Djellal': '51', 'Beni Abbes': '52',
        'In Salah': '53', 'In Guezzam': '54', 'Touggourt': '55', 'Djanet': '56', 'El Meghaier': '57', 'El Meniaa': '58'
      }
      const params = new URLSearchParams({
        nom_client: cmd.nom, telephone: phone, adresse: cmd.adresse, commune: cmd.commune,
        code_wilaya: wilayaCodes[cmd.wilaya] || '16', montant: String(cmd.prix),
        produit: cmd.produit, type: '1', stop_desk: cmd.livraison?.toLowerCase().includes('stop') ? '1' : '0'
      })
      const resp = await fetch(`https://pdex.ecotrack.dz/api/v1/create/order?${params}`, {
        method: 'POST', headers: { 'Authorization': `Bearer ${config.token}`, 'Accept': 'application/json' }
      })
      if (resp.ok) {
        const result: any = await resp.json()
        tracking = result.tracking || result?.data?.tracking || 'PDEX-OK'
      } else { error = `HTTP ${resp.status}` }

    } else if (providerKey === 'dhd' && config?.token) {
      const resp = await fetch(`${config.base_url || 'https://api.dhd-dz.com/api/v1'}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
        body: JSON.stringify({
          client_name: cmd.nom, client_phone: cmd.telephone, address: cmd.adresse,
          wilaya: cmd.wilaya, commune: cmd.commune, price: cmd.prix,
          product: cmd.produit, type: cmd.livraison?.toLowerCase().includes('stop') ? 'stopdesk' : 'domicile'
        })
      })
      if (resp.ok) {
        const result: any = await resp.json()
        tracking = result.tracking || result?.data?.tracking || ''
      } else { error = `HTTP ${resp.status}` }

    } else if (providerKey === 'noest' && config?.token) {
      const resp = await fetch(`${config.base_url || 'https://api.noest-dz.com/api/v1'}/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.token}` },
        body: JSON.stringify({
          client_name: cmd.nom, client_phone: cmd.telephone, address: cmd.adresse,
          wilaya: cmd.wilaya, commune: cmd.commune, price: cmd.prix,
          product: cmd.produit, type: cmd.livraison?.toLowerCase().includes('stop') ? 'stopdesk' : 'domicile'
        })
      })
      if (resp.ok) {
        const result: any = await resp.json()
        tracking = result.tracking || result?.data?.tracking || ''
      } else { error = `HTTP ${resp.status}` }

    } else if (!config || (!config.token && !config.api_key && !config.api_id)) {
      tracking = `MAN-${cmd.transporteur?.replace(/\s/g, '').substring(0, 4).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`
    } else {
      error = `API non implementee pour ${cmd.transporteur}. Configurez le transporteur ou desactivez-le.`
    }
  } catch (e: any) { error = e.message || 'Erreur inconnue' }

  if (tracking) {
    if (hasCmdUserId && hasSuiviUserId) {
      await c.env.DB.prepare(
        `INSERT INTO suivi (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, tracking, transporteur, notes, created_at, user_id)
         SELECT nom, prix, telephone, produit, commune, adresse, wilaya, livraison, 'EXPEDIE', ?, transporteur, notes, created_at, user_id FROM commandes WHERE id = ?`
      ).bind(tracking, id).run()
    } else {
      await c.env.DB.prepare(
        `INSERT INTO suivi (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, tracking, transporteur, notes, created_at)
         SELECT nom, prix, telephone, produit, commune, adresse, wilaya, livraison, 'EXPEDIE', ?, transporteur, notes, created_at FROM commandes WHERE id = ?`
      ).bind(tracking, id).run()
    }
    await diminuerStock(c.env.DB, cmd.produit)
    let deleteSql = 'DELETE FROM commandes WHERE id = ?'
    const deleteParams: any[] = [id]
    if (!isAdmin && hasCmdUserId) { deleteSql += ' AND user_id = ?'; deleteParams.push(userId) }
    await c.env.DB.prepare(deleteSql).bind(...deleteParams).run()
    await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind('EXPEDIE', `Tracking: ${tracking} via ${cmd.transporteur}`, id).run()
    return c.json({ success: true, tracking })
  } else {
    await c.env.DB.prepare('UPDATE commandes SET statut = ? WHERE id = ?').bind(`ERREUR: ${error}`, id).run()
    return c.json({ error }, 500)
  }
})

app.post('/api/envoyer-tous', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
  let query = "SELECT id FROM commandes WHERE (LOWER(statut) LIKE '%confirm%' OR LOWER(statut) LIKE '%confirme%') AND (tracking IS NULL OR tracking = '')"
  const params: any[] = []
  if (!isAdmin && hasUserIdColumn) { query += ' AND user_id = ?'; params.push(userId) }
  const stmt = params.length ? c.env.DB.prepare(query).bind(...params) : c.env.DB.prepare(query)
  const { results } = await stmt.all()
  const sent: any[] = []
  const errors: any[] = []
  for (const cmd of (results || [])) {
    try {
      const resp = await fetch(`${new URL(c.req.url).origin}/api/envoyer/${(cmd as any).id}`, {
        method: 'POST',
        headers: { 'Cookie': `session_token=${getCookie(c, 'session_token')}` }
      })
      const data: any = await resp.json()
      if (data.success) sent.push({ id: (cmd as any).id, tracking: data.tracking })
      else errors.push({ id: (cmd as any).id, error: data.error })
    } catch (e: any) { errors.push({ id: (cmd as any).id, error: e.message }) }
  }
  return c.json({ sent: sent.length, errors: errors.length, details: { sent, errors } })
})

// ========================
// SUIVI
// ========================
app.get('/api/suivi', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'suivi', 'user_id')
  const adminFilterUserId = c.req.query('user_id')
  const statut = c.req.query('statut')
  const transporteur = c.req.query('transporteur')
  let query = 'SELECT * FROM suivi WHERE 1=1'
  const params: any[] = []
  if (hasUserIdColumn) {
    if (isAdmin && adminFilterUserId) { query += ' AND user_id = ?'; params.push(Number(adminFilterUserId)) }
    else if (!isAdmin) { query += ' AND user_id = ?'; params.push(userId) }
  }
  if (statut) { query += ' AND statut = ?'; params.push(statut) }
  if (transporteur) { query += ' AND transporteur LIKE ?'; params.push(`%${transporteur}%`) }
  query += ' ORDER BY created_at DESC'
  const stmt = params.length ? c.env.DB.prepare(query).bind(...params) : c.env.DB.prepare(query)
  const { results } = await stmt.all()
  return c.json(results)
})

app.get('/api/suivi/historique/:tracking', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'suivi', 'user_id')
  const tracking = c.req.param('tracking')
  const trans = (c.req.query('trans') || '').toLowerCase()
  if (!tracking || tracking === 'undefined') return c.json({ history: [] })
  if (!isAdmin && hasUserIdColumn) {
    const row = await c.env.DB.prepare('SELECT id FROM suivi WHERE tracking = ? AND user_id = ?').bind(tracking, userId).first()
    if (!row) return c.json({ history: [] })
  }

  const { results: configsRecords } = await c.env.DB.prepare("SELECT provider, config_json FROM api_config WHERE active = 1").all()
  const apiConfigs: Record<string, any> = {}
  for (const row of (configsRecords || [])) {
    apiConfigs[(row as any).provider] = JSON.parse((row as any).config_json)
  }

  try {
    if ((trans.includes('zr') || trans.includes('express')) && apiConfigs['zr_express']) {
      const config = apiConfigs['zr_express']
      const resp = await fetch(`https://api.zrexpress.app/api/v1/parcels/${tracking}`, {
        headers: { 'X-Api-Key': config.api_key, 'X-Tenant': config.tenant }
      })
      if (resp.ok) {
        const data: any = await resp.json()
        if (data.history && Array.isArray(data.history)) {
          return c.json({
            history: data.history.map((h: any) => ({
              date: pickHistoryDate(h),
              status: h.state?.name || h.state,
              situation: h.situation?.name || h.situation || ''
            }))
          })
        } else if (data.state) {
          return c.json({ history: [{ date: data.updated_at || '', status: data.state?.name || data.state, situation: data.situation?.name || '' }] })
        }
      }
    }
    else if (trans.includes('yalidine') && apiConfigs['yalidine']) {
      const config = apiConfigs['yalidine']
      const resp = await fetch(`https://api.yalidine.com/v1/histories/?tracking=${tracking}`, {
        headers: { 'X-API-ID': config.api_id, 'X-API-TOKEN': config.api_token }
      })
      if (resp.ok) {
        const data: any = await resp.json()
        let items = data?.data || data?.[tracking] || []
        if (Array.isArray(items)) {
          return c.json({
            history: items.map((h: any) => ({
              date: pickHistoryDate(h),
              status: h.status || h.status_id,
              situation: h.commune_name || h.center_name || ''
            }))
          })
        }
      }
    }
    return c.json({ history: [] })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.post('/api/actualiser-statuts', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'suivi', 'user_id')
  const { results: configsRecords } = await c.env.DB.prepare("SELECT provider, config_json FROM api_config WHERE active = 1").all()
  const apiConfigs: Record<string, any> = {}
  for (const row of (configsRecords || [])) {
    apiConfigs[(row as any).provider] = JSON.parse((row as any).config_json)
  }

  // SÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©lectionner uniquement les colis non terminaux pour ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©viter de surcharger les APIs
  let selectSuiviSql = "SELECT * FROM suivi WHERE tracking IS NOT NULL AND tracking != '' AND tracking NOT LIKE 'MAN-%' AND statut NOT LIKE '%LIVRE%' AND statut NOT LIKE '%RETOUR%' AND statut NOT LIKE '%ECHEC%' AND statut NOT LIKE 'Annule'"
  const selectSuiviParams: any[] = []
  if (!isAdmin && hasUserIdColumn) { selectSuiviSql += ' AND user_id = ?'; selectSuiviParams.push(userId) }
  const selectSuiviStmt = selectSuiviParams.length ? c.env.DB.prepare(selectSuiviSql).bind(...selectSuiviParams) : c.env.DB.prepare(selectSuiviSql)
  const { results: suivis } = await selectSuiviStmt.all()

  let updated = 0, errors = 0
  for (const s of (suivis || [])) {
    const item = s as any
    const trans = (item.transporteur || '').toLowerCase()
    const oldStatut = (item.statut || '').toUpperCase()

    try {
      let tracking = item.tracking
      let newStatut = ''
      let situationText = ''

      if ((trans.includes('zr') || trans.includes('express')) && apiConfigs['zr_express']) {
        const config = apiConfigs['zr_express']
        const resp = await fetch(`https://api.zrexpress.app/api/v1/parcels/${tracking}`, {
          headers: { 'X-Api-Key': config.api_key, 'X-Tenant': config.tenant }
        })
        if (resp.ok) {
          const data: any = await resp.json()
          let stateName = typeof data.state === 'object' ? data.state?.name || '' : String(data.state || '')
          newStatut = traduireStatutZR(stateName)
          if (data.situation && typeof data.situation === 'object') {
            situationText = data.situation.name || data.situation.description || ''
            if (data.situation.metadata?.comment) situationText += ` (${data.situation.metadata.comment})`
          }
        } else { errors++; continue; }
      }
      else if (trans.includes('yalidine') && apiConfigs['yalidine']) {
        const config = apiConfigs['yalidine']
        // Utiliser l'API histories plus fiable pour rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©cupÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rer le dernier statut
        const resp = await fetch(`https://api.yalidine.com/v1/histories/?tracking=${tracking}`, {
          headers: { 'X-API-ID': config.api_id, 'X-API-TOKEN': config.api_token }
        })

        if (resp.ok) {
          const data: any = await resp.json()
          let parcel = null
          if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
            // L'API Yalidine renvoie l'historique du plus rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©cent au plus ancien, donc l'index 0 est le statut actuel
            parcel = data.data[0]
          } else if (data?.[tracking] && Array.isArray(data[tracking]) && data[tracking].length > 0) {
            parcel = data[tracking][0]
          }

          if (parcel && typeof parcel === 'object' && (parcel.status_id !== undefined || parcel.status !== undefined)) {
            const rawStatus = parcel.status_id || parcel.status
            let mappedStatut = traduireStatutYalidine(rawStatus)

            // Map specific statuses manually
            if (String(rawStatus) === '8' || String(rawStatus).toLowerCase().includes('vers wilaya') || String(parcel.status).toLowerCase().includes('vers wilaya')) mappedStatut = 'Vers Wilaya'
            if (String(rawStatus) === '13' || String(rawStatus).toLowerCase().includes('tentative') || String(parcel.status).toLowerCase().includes('tentative')) mappedStatut = 'Tentative ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©chouÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e'

            newStatut = mappedStatut
            situationText = parcel.status || ''
            if (parcel.commune_name) situationText += ` - ${parcel.commune_name}`
          } else {
            // Pour le debugging en cas de format inattendu
            await c.env.DB.prepare('UPDATE suivi SET situation = ? WHERE id = ?').bind('ERR FORMAT: ' + JSON.stringify(data).substring(0, 100), item.id).run()
            errors++; continue;
          }
        } else {
          // HTTP Error
          const errText = await resp.text()
          await c.env.DB.prepare('UPDATE suivi SET situation = ? WHERE id = ?').bind(`HTTP ${resp.status}: ` + errText.substring(0, 50), item.id).run()
          errors++; continue;
        }
      }
      else {
        continue;
      }

      if (newStatut && newStatut !== oldStatut && newStatut !== 'UNDEFINED') {
        await c.env.DB.prepare('UPDATE suivi SET statut = ?, situation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(newStatut, situationText, item.id).run()

        const tel = (item.telephone || '').replace(/[\s\-\.\']/g, '')
        if (tel) {
          const isNewDelivered = newStatut.toUpperCase().includes('LIVRE') && !oldStatut.includes('LIVRE')
          const isNewReturned = (newStatut.toUpperCase().includes('RETOURNE') || newStatut.toUpperCase().includes('RETOUR BUREAU')) && !oldStatut.includes('RETOURNE')
          if (isNewDelivered || isNewReturned) {
            await c.env.DB.prepare(
              `INSERT INTO phone_verification (telephone, delivered, returned) VALUES (?, ?, ?)
               ON CONFLICT(telephone) DO UPDATE SET
               delivered = delivered + ?, returned = returned + ?, updated_at = CURRENT_TIMESTAMP`
            ).bind(tel, isNewDelivered ? 1 : 0, isNewReturned ? 1 : 0, isNewDelivered ? 1 : 0, isNewReturned ? 1 : 0).run()
          }
        }
        await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind(
          'API_SYNC', `Synchronisation manuelle API: ${newStatut} (${situationText || 'aucun dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©tail'})`, null
        ).run()
        updated++
      }
    } catch (e: any) {
      await c.env.DB.prepare('UPDATE suivi SET situation = ? WHERE id = ?').bind('Exception: ' + e.message, item.id).run()
      errors++
    }
  }
  return c.json({ updated, errors })
})

// ========================
// STOCK
// ========================
app.get('/api/stock', async (c) => {
  const userId = c.get('userId')
  await ensureAdvancedInventoryTables(c.env.DB)
  const { results } = await c.env.DB.prepare(
    `SELECT id, sku, nom, categorie, sous_categorie, unit_cost, unit_price, supplier_name, lead_time_days, safety_stock, reorder_qty,
            stock_on_hand, stock_reserved, stock_in_transit,
            (stock_on_hand - stock_reserved) as stock_available, updated_at
     FROM stock_items
     WHERE user_id = ? AND active = 1
     ORDER BY updated_at DESC, id DESC`
  ).bind(userId).all()
  return c.json(results)
})

app.post('/api/stock', async (c) => {
  const userId = c.get('userId')
  await ensureAdvancedInventoryTables(c.env.DB)
  const body = await c.req.json()
  const sku = String(body.sku || '').trim().toUpperCase()
  const nom = String(body.nom || '').trim()
  const categorie = String(body.categorie || '').trim()
  const sousCategorie = String(body.sous_categorie || '').trim()
  const unitCost = Math.max(0, Number(body.unit_cost || 0))
  const unitPrice = Math.max(0, Number(body.unit_price || 0))
  const supplierName = String(body.supplier_name || '').trim()
  const leadTimeDays = Math.max(1, Number(body.lead_time_days || 7))
  const safetyStock = Math.max(0, Number(body.safety_stock || 5))
  const reorderQty = Math.max(1, Number(body.reorder_qty || 20))
  const stockOnHand = Math.max(0, Number(body.stock_on_hand || 0))
  const stockReserved = Math.max(0, Number(body.stock_reserved || 0))
  const stockInTransit = Math.max(0, Number(body.stock_in_transit || 0))

  if (!sku || sku.length < 2) return c.json({ error: 'SKU invalide' }, 400)
  if (!nom || nom.length < 2) return c.json({ error: 'Nom produit invalide' }, 400)

  const result = await c.env.DB.prepare(
    `INSERT INTO stock_items (
      user_id, sku, nom, categorie, sous_categorie, unit_cost, unit_price, supplier_name,
      lead_time_days, safety_stock, reorder_qty, stock_on_hand, stock_reserved, stock_in_transit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    userId, sku, nom, categorie, sousCategorie, unitCost, unitPrice, supplierName,
    leadTimeDays, safetyStock, reorderQty, stockOnHand, stockReserved, stockInTransit
  ).run()

  if (stockOnHand > 0) {
    await c.env.DB.prepare(
      `INSERT INTO stock_movements (user_id, stock_item_id, movement_type, quantity, unit_cost, reference_type, notes)
       VALUES (?, ?, 'inbound', ?, ?, 'manual', ?)`
    ).bind(userId, result.meta.last_row_id, stockOnHand, unitCost, 'Initial stock entry').run()
  }
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.get('/api/stock/audit', async (c) => {
  const userId = c.get('userId')
  await ensureAdvancedInventoryTables(c.env.DB)
  const hasUserIdColumn = await hasTableColumn(c.env.DB, 'suivi', 'user_id')

  const { results: itemsRaw } = await c.env.DB.prepare(
    `SELECT id, sku, nom, categorie, sous_categorie, unit_cost, lead_time_days, safety_stock, reorder_qty,
            stock_on_hand, stock_reserved, stock_in_transit, active
     FROM stock_items
     WHERE user_id = ? AND active = 1
     ORDER BY updated_at DESC`
  ).bind(userId).all()
  const items = (itemsRaw || []) as any[]

  const salesScope = hasUserIdColumn ? ' AND user_id = ?' : ''
  const salesStmt90 = hasUserIdColumn
    ? c.env.DB.prepare(`SELECT produit, COUNT(*) as sold_90d FROM suivi WHERE UPPER(statut) LIKE '%LIVR%' AND created_at >= datetime('now', '-90 day')${salesScope} GROUP BY produit`).bind(userId)
    : c.env.DB.prepare(`SELECT produit, COUNT(*) as sold_90d FROM suivi WHERE UPPER(statut) LIKE '%LIVR%' AND created_at >= datetime('now', '-90 day') GROUP BY produit`)
  const salesStmt30 = hasUserIdColumn
    ? c.env.DB.prepare(`SELECT produit, COUNT(*) as sold_30d FROM suivi WHERE UPPER(statut) LIKE '%LIVR%' AND created_at >= datetime('now', '-30 day')${salesScope} GROUP BY produit`).bind(userId)
    : c.env.DB.prepare(`SELECT produit, COUNT(*) as sold_30d FROM suivi WHERE UPPER(statut) LIKE '%LIVR%' AND created_at >= datetime('now', '-30 day') GROUP BY produit`)

  const [{ results: sold90Raw }, { results: sold30Raw }] = await Promise.all([salesStmt90.all(), salesStmt30.all()])
  const sold90 = new Map<string, number>((sold90Raw || []).map((r: any) => [String(r.produit || '').trim().toLowerCase(), Number(r.sold_90d || 0)]))
  const sold30 = new Map<string, number>((sold30Raw || []).map((r: any) => [String(r.produit || '').trim().toLowerCase(), Number(r.sold_30d || 0)]))

  const obsolete: any[] = []
  const slowMoving: any[] = []
  const reorder: any[] = []
  const duplicates: any[] = []
  const catStats = new Map<string, { skus: number; on_hand: number; est_value: number }>()
  const skuNames = new Map<string, string[]>()

  for (const item of items) {
    const key = String(item.nom || '').trim().toLowerCase()
    if (key) {
      const list = skuNames.get(key) || []
      list.push(item.sku)
      skuNames.set(key, list)
    }

    const sales90 = sold90.get(key) || 0
    const sales30 = sold30.get(key) || 0
    const onHand = Number(item.stock_on_hand || 0)
    const reserved = Number(item.stock_reserved || 0)
    const available = Math.max(0, onHand - reserved)
    const avgDaily = sales30 / 30
    const lead = Math.max(1, Number(item.lead_time_days || 7))
    const safety = Math.max(0, Number(item.safety_stock || 0))
    const reorderPoint = Math.ceil(avgDaily * lead + safety)
    const reorderQty = Math.max(1, Number(item.reorder_qty || 1))
    const stockDaysCover = avgDaily > 0 ? Math.floor(available / avgDaily) : 999
    const category = String(item.categorie || 'Non classe').trim() || 'Non classe'
    const estValue = onHand * Number(item.unit_cost || 0)

    const cs = catStats.get(category) || { skus: 0, on_hand: 0, est_value: 0 }
    cs.skus += 1
    cs.on_hand += onHand
    cs.est_value += estValue
    catStats.set(category, cs)

    if (sales90 === 0 && onHand > 0) {
      obsolete.push({ sku: item.sku, nom: item.nom, on_hand: onHand, est_value: estValue })
    } else if (sales90 > 0 && sales90 <= 2) {
      slowMoving.push({ sku: item.sku, nom: item.nom, sold_90d: sales90, on_hand: onHand, days_cover: stockDaysCover })
    }

    if (available <= reorderPoint) {
      reorder.push({
        sku: item.sku,
        nom: item.nom,
        available,
        reorder_point: reorderPoint,
        suggested_qty: reorderQty,
        lead_time_days: lead
      })
    }
  }

  for (const [nom, skus] of skuNames.entries()) {
    if (skus.length > 1) duplicates.push({ nom, skus, count: skus.length })
  }

  const categories = Array.from(catStats.entries())
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.est_value - a.est_value)

  return c.json({
    summary: {
      total_skus: items.length,
      obsolete_count: obsolete.length,
      slow_count: slowMoving.length,
      reorder_count: reorder.length,
      duplicate_count: duplicates.length
    },
    obsolete: obsolete.slice(0, 20),
    slow_moving: slowMoving.slice(0, 20),
    reorder: reorder.slice(0, 20),
    duplicates: duplicates.slice(0, 20),
    categories
  })
})

app.put('/api/stock/:id', async (c) => {
  const userId = c.get('userId')
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  await ensureAdvancedInventoryTables(c.env.DB)
  const updates: string[] = []
  const values: any[] = []
  if (body.stock_on_hand !== undefined) { updates.push('stock_on_hand = ?'); values.push(Math.max(0, Number(body.stock_on_hand || 0))) }
  if (body.stock_reserved !== undefined) { updates.push('stock_reserved = ?'); values.push(Math.max(0, Number(body.stock_reserved || 0))) }
  if (body.stock_in_transit !== undefined) { updates.push('stock_in_transit = ?'); values.push(Math.max(0, Number(body.stock_in_transit || 0))) }
  if (body.safety_stock !== undefined) { updates.push('safety_stock = ?'); values.push(Math.max(0, Number(body.safety_stock || 0))) }
  if (body.reorder_qty !== undefined) { updates.push('reorder_qty = ?'); values.push(Math.max(1, Number(body.reorder_qty || 1))) }
  if (body.lead_time_days !== undefined) { updates.push('lead_time_days = ?'); values.push(Math.max(1, Number(body.lead_time_days || 1))) }
  if (body.unit_cost !== undefined) { updates.push('unit_cost = ?'); values.push(Math.max(0, Number(body.unit_cost || 0))) }
  if (updates.length === 0) return c.json({ error: 'Aucune modification' }, 400)
  updates.push('updated_at = CURRENT_TIMESTAMP')
  values.push(id, userId)
  const result = await c.env.DB.prepare(
    `UPDATE stock_items SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`
  ).bind(...values).run()
  if ((result.meta?.changes || 0) === 0) return c.json({ error: 'Article introuvable' }, 404)
  return c.json({ success: true })
})

app.post('/api/stock/:id/entry', async (c) => {
  const userId = c.get('userId')
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  await ensureAdvancedInventoryTables(c.env.DB)
  const qty = Math.max(1, Number(body.quantity || 0))
  const unitCost = Math.max(0, Number(body.unit_cost || 0))
  const notes = String(body.notes || '').trim()
  if (!Number.isFinite(qty) || qty <= 0) return c.json({ error: 'Quantite invalide' }, 400)

  const row = await c.env.DB.prepare(
    'SELECT id, stock_on_hand FROM stock_items WHERE id = ? AND user_id = ?'
  ).bind(id, userId).first() as any
  if (!row) return c.json({ error: 'Article introuvable' }, 404)

  await c.env.DB.prepare(
    'UPDATE stock_items SET stock_on_hand = stock_on_hand + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
  ).bind(qty, id, userId).run()
  await c.env.DB.prepare(
    `INSERT INTO stock_movements (user_id, stock_item_id, movement_type, quantity, unit_cost, reference_type, notes)
     VALUES (?, ?, 'inbound', ?, ?, 'manual', ?)`
  ).bind(userId, id, qty, unitCost, notes || 'Stock entry').run()

  return c.json({ success: true })
})

// ========================
// DASHBOARD STATS
// ========================
app.get('/api/stats', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasCmdUserId = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
  const hasSuiviUserId = await hasTableColumn(c.env.DB, 'suivi', 'user_id')
  await ensureAdvancedInventoryTables(c.env.DB)
  const cmdScope = !isAdmin && hasCmdUserId ? ' WHERE user_id = ?' : ''
  const suiviScope = !isAdmin && hasSuiviUserId ? ' WHERE user_id = ?' : ''
  const suiviAndScope = !isAdmin && hasSuiviUserId ? ' AND user_id = ?' : ''
  const cmdParams = !isAdmin && hasCmdUserId ? [userId] : []
  const suiviParams = !isAdmin && hasSuiviUserId ? [userId] : []
  const suiviAndParams = !isAdmin && hasSuiviUserId ? [userId] : []
  const [cmdCount, suiviCount, livreCount, retourCount, caTotal, stockAlerts, aPreparer, aExpedier, margeParProduit] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) as c FROM commandes${cmdScope}`).bind(...cmdParams).first(),
    c.env.DB.prepare(`SELECT COUNT(*) as c FROM suivi${suiviScope}`).bind(...suiviParams).first(),
    c.env.DB.prepare(`SELECT COUNT(*) as c FROM suivi WHERE UPPER(statut) LIKE '%LIVR%'${suiviAndScope}`).bind(...suiviAndParams).first(),
    c.env.DB.prepare(`SELECT COUNT(*) as c FROM suivi WHERE statut LIKE '%RETOURNE%'${suiviAndScope}`).bind(...suiviAndParams).first(),
    c.env.DB.prepare(`SELECT SUM(prix) as total FROM suivi WHERE UPPER(statut) LIKE '%LIVR%'${suiviAndScope}`).bind(...suiviAndParams).first(),
    c.env.DB.prepare('SELECT COUNT(*) as c FROM stock_items WHERE user_id = ? AND active = 1 AND (stock_on_hand - stock_reserved) <= safety_stock').bind(userId).first(),
    c.env.DB.prepare(`SELECT COUNT(*) as c FROM commandes WHERE (UPPER(statut) IN ('EN ATTENTE','CONFIRME') OR UPPER(statut) LIKE 'CONFIRM%')${!isAdmin && hasCmdUserId ? ' AND user_id = ?' : ''}`).bind(...cmdParams).first(),
    c.env.DB.prepare(`SELECT COUNT(*) as c FROM suivi WHERE (UPPER(statut) LIKE '%EXPEDIE%' OR UPPER(statut) LIKE '%EN LIVRAISON%')${suiviAndScope}`).bind(...suiviAndParams).first(),
    c.env.DB.prepare(
      `SELECT
          produit,
          COUNT(*) as ventes,
          SUM(prix) as ca,
          SUM(prix - CASE WHEN LOWER(livraison) LIKE '%stop%' THEN 450 ELSE 650 END) as marge_nette
       FROM suivi
       WHERE UPPER(statut) LIKE '%LIVR%'${suiviAndScope}
       GROUP BY produit
       ORDER BY marge_nette DESC
       LIMIT 6`
    ).bind(...suiviAndParams).all(),
  ])
  const totalSuivi = (suiviCount as any)?.c || 0
  const totalLivre = (livreCount as any)?.c || 0
  const tauxLivraison = totalSuivi > 0 ? Math.round((totalLivre / totalSuivi) * 100) : 0
  let subscriptionInfo: any = null
  if (!isAdmin) {
    const user = await c.env.DB.prepare('SELECT subscription, created_at FROM users WHERE id = ?').bind(userId).first() as any
    const subscription = user?.subscription || 'starter'
    const isTrial = subscription === 'starter'
    const trialDays = 7
    const ordersLimit = getMonthlyOrderLimit(subscription)
    const createdAt = user?.created_at ? new Date(user.created_at) : new Date()
    const trialEndMs = createdAt.getTime() + trialDays * 24 * 60 * 60 * 1000
    const secondsLeft = Math.max(0, Math.floor((trialEndMs - Date.now()) / 1000))
    const trialStartSql = createdAt.toISOString().slice(0, 19).replace('T', ' ')
    const ordersUsed = await getMonthlyOrderUsage(c.env.DB, userId, hasCmdUserId, hasSuiviUserId)
    subscriptionInfo = {
      subscription,
      is_trial: isTrial,
      trial_end_at: new Date(trialEndMs).toISOString(),
      trial_seconds_left: secondsLeft,
      orders_limit: ordersLimit,
      orders_used: ordersUsed,
      orders_remaining: Math.max(0, ordersLimit - ordersUsed)
    }
  }
  return c.json({
    commandes_en_cours: (cmdCount as any)?.c || 0,
    commandes_a_preparer: (aPreparer as any)?.c || 0,
    commandes_a_expedier: (aExpedier as any)?.c || 0,
    total_suivi: totalSuivi,
    livres: totalLivre,
    retours: (retourCount as any)?.c || 0,
    ca_total: (caTotal as any)?.total || 0,
    taux_livraison: tauxLivraison,
    alertes_stock: (stockAlerts as any)?.c || 0,
    marge_par_produit: (margeParProduit as any)?.results || [],
    subscription_info: subscriptionInfo
  })
})

// ========================
// API CONFIG
// ========================
app.get('/api/config', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id, provider, config_json, active FROM api_config ORDER BY provider').all()
  return c.json(results)
})

app.put('/api/config/:provider', async (c) => {
  const provider = c.req.param('provider')
  const body = await c.req.json()
  await c.env.DB.prepare('UPDATE api_config SET config_json = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE provider = ?')
    .bind(JSON.stringify(body.config), body.active ?? 1, provider).run()
  return c.json({ success: true })
})

// ========================
// HISTORIQUE
// ========================
app.get('/api/historique', async (c) => {
  if (c.get('userRole') !== 'admin') {
    return c.json({ error: 'AccÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨s rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©servÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© aux administrateurs', code: 'FORBIDDEN' }, 403)
  }
  const { results } = await c.env.DB.prepare('SELECT * FROM historique ORDER BY created_at DESC LIMIT 100').all()
  return c.json(results)
})

// ========================
// WEBHOOK
// ========================
app.get('/api/webhook', (c) => {
  const crcToken = c.req.query('crc_token')
  if (crcToken) return c.text(crcToken)
  return c.json({ status: 'ok', message: 'AutoHub DZ Webhook endpoint is active', timestamp: new Date().toISOString() })
})

app.post('/api/webhook', async (c) => {
  try {
    const text = await c.req.text()
    if (!text) return c.json({ success: true, message: 'Ping received' })
    let parsedData: any = JSON.parse(text)
    console.log('Webhook Received:', JSON.stringify(parsedData))

    if (parsedData && !Array.isArray(parsedData) && Array.isArray(parsedData.data)) {
      parsedData = parsedData.data
    }

    const events = Array.isArray(parsedData) ? parsedData : [parsedData]
    let processedCount = 0

    for (const data of events) {
      let tracking = '', newStatut = '', situationText = ''

      // 1. ZR Express Format
      if (data?.Data?.TrackingNumber) {
        tracking = data.Data.TrackingNumber
        const stateName = typeof data.Data.State === 'object' ? data.Data.State?.name || '' : String(data.Data.State || '')
        newStatut = traduireStatutZR(stateName)
        if (data.Data.Situation && typeof data.Data.Situation === 'object') {
          situationText = data.Data.Situation.name || data.Data.Situation.description || ''
          if (data.Data.Situation.metadata?.comment) situationText += ` (${data.Data.Situation.metadata.comment})`
        }
      }
      // 2. Yalidine Format (often tracking is the key, or current_status)
      else if (data?.tracking && (data?.current_status || data?.status_id)) {
        tracking = data.tracking
        newStatut = traduireStatutYalidine(data.current_status || data.status_id)
        situationText = data.last_status || ''
        if (data.commune_name) situationText += ` - ${data.commune_name}`
      }
      // 3. Ecotrack Format
      else if (data?.tracking && (data?.status_name || data?.status)) {
        tracking = data.tracking
        newStatut = traduireStatutEcotrack(data.status_name || data.status)
        situationText = data.last_event || ''
      }
      // 4. Generic Format
      else if (data?.tracking) {
        tracking = data.tracking
        const s = String(data.status || data.state || '').toLowerCase()
        if (s.includes('livre')) newStatut = 'LIVRE'
        else if (s.includes('retour')) newStatut = 'RETOURNE'
        else if (s.includes('transit')) newStatut = 'EN TRANSIT'
        else if (s.includes('livraison')) newStatut = 'EN LIVRAISON'
        else newStatut = (data.status || data.state || '').toUpperCase()
      }

      if (tracking && newStatut) {
        // Find matching tracking in database
        const suiviRow = await c.env.DB.prepare('SELECT telephone, statut FROM suivi WHERE tracking = ?').bind(tracking).first() as any

        if (suiviRow) {
          await c.env.DB.prepare('UPDATE suivi SET statut = ?, situation = ?, updated_at = CURRENT_TIMESTAMP WHERE tracking = ?')
            .bind(newStatut, situationText, tracking).run()

          // Update phone verification stats (delivered vs returned)
          if (suiviRow.telephone) {
            const tel = suiviRow.telephone.replace(/[\s\-\.\']/g, '')
            const oldStatut = (suiviRow.statut || '').toUpperCase()
            const isNewDelivered = newStatut.toUpperCase().includes('LIVRE') && !oldStatut.includes('LIVRE')
            const isNewReturned = (newStatut.toUpperCase().includes('RETOURNE') || newStatut.toUpperCase().includes('RETOUR BUREAU')) && !oldStatut.includes('RETOURNE')

            if (isNewDelivered || isNewReturned) {
              await c.env.DB.prepare(
                `INSERT INTO phone_verification (telephone, delivered, returned) VALUES (?, ?, ?)
                 ON CONFLICT(telephone) DO UPDATE SET
                 delivered = delivered + ?, returned = returned + ?, updated_at = CURRENT_TIMESTAMP`
              ).bind(tel, isNewDelivered ? 1 : 0, isNewReturned ? 1 : 0, isNewDelivered ? 1 : 0, isNewReturned ? 1 : 0).run()
            }
          }

          await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind(
            'WEBHOOK_UPDATE', `Mise ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  jour via Webhook: ${newStatut} (${situationText || 'aucun dÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©tail'})`, null
          ).run()

          processedCount++
        }
      }
    }

    return c.json({ success: true, processed: processedCount > 0 })
  } catch (e: any) {
    console.error('Webhook Error:', e.message)
    return c.json({ error: e.message }, 500)
  }
})

// ========================
// STORE SOURCES (Shopify, WooCommerce, YouCan)
// ========================
app.get('/api/store-sources', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM store_sources WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()
  return c.json(results)
})

app.post('/api/store-sources', async (c) => {
  const userId = c.get('userId')
  const { platform, domain } = await c.req.json()
  if (!platform || !domain) return c.json({ error: 'Plateforme et domaine requis' }, 400)
  const validPlatforms = ['shopify', 'woocommerce', 'youcan']
  if (!validPlatforms.includes(platform)) return c.json({ error: 'Plateforme invalide' }, 400)

  const existing = await c.env.DB.prepare(
    'SELECT id FROM store_sources WHERE user_id = ? AND platform = ? AND domain = ?'
  ).bind(userId, platform, domain.trim()).first()
  if (existing) return c.json({ error: 'Cette boutique existe deja' }, 400)

  const result = await c.env.DB.prepare(
    'INSERT INTO store_sources (user_id, platform, domain) VALUES (?, ?, ?)'
  ).bind(userId, platform, domain.trim()).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.post('/api/store-sources/intelligent-config', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json()
  const rawUrl = String(body.store_url || '').trim()
  if (!rawUrl) return c.json({ error: 'URL boutique requise' }, 400)

  let normalized = rawUrl
  if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized

  let parsed: URL
  try { parsed = new URL(normalized) } catch { return c.json({ error: 'URL invalide' }, 400) }
  const domain = parsed.hostname.replace(/^www\./i, '').toLowerCase()

  let html = ''
  let finalUrl = normalized
  try {
    const resp = await fetch(normalized, { method: 'GET', redirect: 'follow' })
    finalUrl = resp.url || normalized
    html = await resp.text()
  } catch (_) {
    // continue with domain-only detection fallback
  }

  const content = (html || '').toLowerCase()
  let detectedPlatform = 'woocommerce'
  if (domain.includes('myshopify.com') || content.includes('cdn.shopify.com') || content.includes('shopify')) detectedPlatform = 'shopify'
  else if (domain.includes('youcan.shop') || content.includes('youcan') || content.includes('cdn.youcan')) detectedPlatform = 'youcan'
  else if (content.includes('woocommerce') || content.includes('wp-content') || content.includes('wordpress')) detectedPlatform = 'woocommerce'

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i)
  const title = (titleMatch?.[1] || domain).trim().slice(0, 120)
  const logoMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
  const themeColorMatch = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)
  const logo = logoMatch?.[1] || ''
  const theme_color = themeColorMatch?.[1] || ''

  const existing = await c.env.DB.prepare(
    'SELECT id FROM store_sources WHERE user_id = ? AND platform = ? AND domain = ?'
  ).bind(userId, detectedPlatform, domain).first() as any

  let sourceId = existing?.id || 0
  if (existing?.id) {
    await c.env.DB.prepare(
      'UPDATE store_sources SET active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?'
    ).bind(existing.id, userId).run()
  } else {
    const inserted = await c.env.DB.prepare(
      'INSERT INTO store_sources (user_id, platform, domain, active) VALUES (?, ?, ?, 1)'
    ).bind(userId, detectedPlatform, domain).run()
    sourceId = inserted.meta.last_row_id
  }

  // Prevent OAuth callback from updating the wrong WooCommerce source:
  // keep only the detected/target one as active for this user+platform.
  if (detectedPlatform === 'woocommerce') {
    await c.env.DB.prepare(
      `UPDATE store_sources
       SET active = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND platform = 'woocommerce'`
    ).bind(sourceId, userId).run()
  }

  await c.env.DB.prepare('INSERT INTO historique (action, details) VALUES (?, ?)').bind(
    'INTELLIGENT_STORE_SETUP',
    `Smart setup: ${detectedPlatform} - ${domain} - ${title}`
  ).run()

  return c.json({
    success: true,
    source_id: sourceId,
    platform: detectedPlatform,
    domain,
    title,
    logo,
    theme_color,
    final_url: finalUrl
  })
})

app.delete('/api/store-sources/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM store_sources WHERE id = ? AND user_id = ?').bind(id, userId).run()
  return c.json({ success: true })
})

app.put('/api/store-sources/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { platform, domain, active } = await c.req.json()
  const updates: string[] = []
  const values: any[] = []
  if (platform !== undefined) { updates.push('platform = ?'); values.push(platform) }
  if (domain !== undefined) { updates.push('domain = ?'); values.push(domain.trim()) }
  if (active !== undefined) { updates.push('active = ?'); values.push(active ? 1 : 0) }
  if (updates.length === 0) return c.json({ error: 'Rien a mettre a jour' }, 400)
  updates.push('updated_at = CURRENT_TIMESTAMP')
  values.push(id, userId)
  await c.env.DB.prepare(`UPDATE store_sources SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values).run()
  return c.json({ success: true })
})

// ========================
// PHONE VERIFICATION (delivered/returned tracking per phone)
// ========================
app.get('/api/phone-verify/:telephone', async (c) => {
  const tel = c.req.param('telephone').replace(/[\s\-\.\']/g, '')
  const row = await c.env.DB.prepare(
    'SELECT delivered, returned FROM phone_verification WHERE telephone = ?'
  ).bind(tel).first() as any
  return c.json({ delivered: row?.delivered || 0, returned: row?.returned || 0 })
})

app.get('/api/phone-verify-batch', async (c) => {
  const phones = c.req.query('phones')
  if (!phones) return c.json({})
  const phoneList = phones.split(',').map(p => p.replace(/[\s\-\.\']/g, '').trim()).filter(Boolean)
  if (phoneList.length === 0) return c.json({})
  const placeholders = phoneList.map(() => '?').join(',')
  const { results } = await c.env.DB.prepare(
    `SELECT telephone, delivered, returned FROM phone_verification WHERE telephone IN (${placeholders})`
  ).bind(...phoneList).all()
  const map: Record<string, { delivered: number, returned: number }> = {}
  for (const r of (results || [])) {
    const row = r as any
    map[row.telephone] = { delivered: row.delivered, returned: row.returned }
  }
  return c.json(map)
})

// ========================
// DELIVERY COMPANIES CRUD
// ========================
app.get('/api/delivery-companies', async (c) => {
  const userId = c.get('userId')
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM delivery_companies WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()
  return c.json(results)
})

app.post('/api/delivery-companies', async (c) => {
  const userId = c.get('userId')
  const { name, api_type, api_url, api_key, api_token, notes } = await c.req.json()
  if (!name) return c.json({ error: 'Le nom est requis' }, 400)
  const result = await c.env.DB.prepare(
    'INSERT INTO delivery_companies (user_id, name, api_type, api_url, api_key, api_token, notes) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(userId, name.trim(), api_type || 'manual', api_url || '', api_key || '', api_token || '', notes || '').run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.put('/api/delivery-companies/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields = ['name', 'api_type', 'api_url', 'api_key', 'api_token', 'active', 'notes']
  const updates: string[] = []
  const values: any[] = []
  for (const f of fields) {
    if (body[f] !== undefined) { updates.push(`${f} = ?`); values.push(body[f]) }
  }
  if (updates.length === 0) return c.json({ error: 'Rien a mettre a jour' }, 400)
  updates.push('updated_at = CURRENT_TIMESTAMP')
  values.push(id, userId)
  await c.env.DB.prepare(`UPDATE delivery_companies SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).bind(...values).run()
  return c.json({ success: true })
})

app.delete('/api/delivery-companies/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM delivery_companies WHERE id = ? AND user_id = ?').bind(id, userId).run()
  return c.json({ success: true })
})

// ========================
// WOOCOMMERCE OAUTH INTEGRATION
// ========================
app.get('/api/woo/connect', async (c) => {
  const userId = c.get('userId')
  const { domain } = c.req.query() as any
  if (!domain) return c.json({ error: 'Domaine requis' }, 400)
  const origin = new URL(c.req.url).origin
  const callbackUrl = `${origin}/api/woo/callback`
  const returnUrl = `${origin}/api/woo/return?domain=${encodeURIComponent(domain)}`
  const authUrl = `https://${domain}/wc-auth/v1/authorize?app_name=AutoHub%20DZ&scope=read_write&user_id=${userId}&return_url=${encodeURIComponent(returnUrl)}&callback_url=${encodeURIComponent(callbackUrl)}`
  return c.json({ url: authUrl })
})

app.post('/api/woo/callback', async (c) => {
  try {
    const body = await c.req.json()
    const { key_id, user_id, consumer_key, consumer_secret, key_permissions } = body
    if (!consumer_key || !consumer_secret || !user_id) {
      return c.json({ error: 'Donnees manquantes' }, 400)
    }
    // Update the store_source for this user with WooCommerce credentials
    await c.env.DB.prepare(
      `UPDATE store_sources SET consumer_key = ?, consumer_secret = ?, woo_user_id = ?, connected_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND platform = 'woocommerce' AND active = 1`
    ).bind(consumer_key, consumer_secret, String(user_id), user_id).run()
    await c.env.DB.prepare('INSERT INTO historique (action, details) VALUES (?, ?)').bind(
      'WOO_CONNECT', `WooCommerce connected for user ${user_id} (key: ${key_id}, permissions: ${key_permissions})`
    ).run()
    return c.json({ success: true })
  } catch (e: any) {
    return c.json({ error: e.message }, 500)
  }
})

app.get('/api/woo/return', async (c) => {
  const domain = c.req.query('domain') || ''
  const success = c.req.query('success') !== '0'
  if (success) {
    return c.redirect('/app?page=boutique&woo_connected=1&domain=' + encodeURIComponent(domain))
  }
  return c.redirect('/app?page=boutique&woo_error=1')
})

app.get('/api/woo/status/:sourceId', async (c) => {
  const userId = c.get('userId')
  const sourceId = c.req.param('sourceId')
  const source = await c.env.DB.prepare(
    'SELECT id, domain, consumer_key, consumer_secret, connected_at FROM store_sources WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(sourceId, userId, 'woocommerce').first() as any
  if (!source) return c.json({ connected: false })
  const connected = !!(source.consumer_key && source.consumer_secret)
  return c.json({ connected, domain: source.domain, connected_at: source.connected_at })
})

app.get('/api/woo/orders/:sourceId', async (c) => {
  const userId = c.get('userId')
  const sourceId = c.req.param('sourceId')
  const source = await c.env.DB.prepare(
    'SELECT * FROM store_sources WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(sourceId, userId, 'woocommerce').first() as any
  if (!source || !source.consumer_key || !source.consumer_secret) {
    return c.json({ error: 'Boutique non connectee' }, 400)
  }
  try {
    const url = `https://${source.domain}/wp-json/wc/v3/orders?per_page=50&status=processing`
    const resp = await fetch(url, {
      headers: {
        'Authorization': 'Basic ' + btoa(source.consumer_key + ':' + source.consumer_secret)
      }
    })
    if (!resp.ok) return c.json({ error: `WooCommerce API error: ${resp.status}` }, resp.status as any)
    const orders = await resp.json()
    return c.json(orders)
  } catch (e: any) {
    return c.json({ error: e.message || 'Erreur de connexion WooCommerce' }, 500)
  }
})

app.post('/api/woo/import/:sourceId', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const sourceId = c.req.param('sourceId')
  const source = await c.env.DB.prepare(
    'SELECT * FROM store_sources WHERE id = ? AND user_id = ? AND platform = ?'
  ).bind(sourceId, userId, 'woocommerce').first() as any
  if (!source || !source.consumer_key || !source.consumer_secret) {
    return c.json({ error: 'Boutique non connectee' }, 400)
  }
  try {
    const hasCmdUserId = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
    const hasSuiviUserId = await hasTableColumn(c.env.DB, 'suivi', 'user_id')
    let quotaLeft = Number.MAX_SAFE_INTEGER
    if (!isAdmin) {
      const user = await c.env.DB.prepare('SELECT subscription FROM users WHERE id = ?').bind(userId).first() as any
      const limit = getMonthlyOrderLimit(user?.subscription || 'starter')
      const used = await getMonthlyOrderUsage(c.env.DB, userId, hasCmdUserId, hasSuiviUserId)
      quotaLeft = Math.max(0, limit - used)
      if (quotaLeft <= 0) {
        return c.json({ error: `Limite mensuelle atteinte (${limit} commandes)`, code: 'QUOTA_EXCEEDED', orders_limit: limit, orders_used: used }, 403)
      }
    }
    const url = `https://${source.domain}/wp-json/wc/v3/orders?per_page=50&status=processing`
    const resp = await fetch(url, {
      headers: {
        'Authorization': 'Basic ' + btoa(source.consumer_key + ':' + source.consumer_secret)
      }
    })
    if (!resp.ok) return c.json({ error: `Erreur API: ${resp.status}` }, 500)
    const orders: any[] = await resp.json()
    let imported = 0, errors = 0
    for (const order of orders) {
      if (imported >= quotaLeft) break
      try {
        const nom = (order.billing?.first_name || '') + ' ' + (order.billing?.last_name || '')
        const telephone = order.billing?.phone || ''
        const produit = order.line_items?.map((i: any) => i.name).join(', ') || 'Produit WooCommerce'
        const prix = Number(order.total) || 0
        const wilaya = order.shipping?.state || order.billing?.state || ''
        const commune = order.shipping?.city || order.billing?.city || ''
        const adresse = (order.shipping?.address_1 || order.billing?.address_1 || '') + ' ' + (order.shipping?.address_2 || '')
        if (hasCmdUserId) {
          await c.env.DB.prepare(
            `INSERT INTO commandes (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, source, user_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(nom.trim(), prix, telephone, produit, commune, adresse.trim(), wilaya, 'A domicile', 'EN ATTENTE', 'woocommerce', userId).run()
        } else {
          await c.env.DB.prepare(
            `INSERT INTO commandes (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, source)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).bind(nom.trim(), prix, telephone, produit, commune, adresse.trim(), wilaya, 'A domicile', 'EN ATTENTE', 'woocommerce').run()
        }
        imported++
      } catch { errors++ }
    }
    await c.env.DB.prepare('INSERT INTO historique (action, details) VALUES (?, ?)').bind(
      'WOO_IMPORT', `Imported ${imported} orders from ${source.domain} (${errors} errors)`
    ).run()
    return c.json({ success: true, imported, errors, total: orders.length })
  } catch (e: any) {
    return c.json({ error: e.message || 'Erreur import' }, 500)
  }
})

// ========================
// COMMUNES SEARCH (for wilaya/commune browser)
// ========================
app.get('/api/communes-search', async (c) => {
  const q = c.req.query('q') || ''
  if (q.length < 2) return c.json([])
  const { results } = await c.env.DB.prepare(
    `SELECT c.id, c.name as commune_name, w.name as wilaya_name, w.code as wilaya_code, w.id as wilaya_id
     FROM communes c JOIN wilayas w ON w.id = c.wilaya_id
     WHERE c.name LIKE ? OR w.name LIKE ?
     ORDER BY w.id, c.name LIMIT 100`
  ).bind(`%${q}%`, `%${q}%`).all()
  return c.json(results)
})

app.get('/api/wilayas-full', async (c) => {
  const { results: wilayas } = await c.env.DB.prepare('SELECT id, name, code FROM wilayas ORDER BY id').all()
  const { results: communes } = await c.env.DB.prepare('SELECT id, name, wilaya_id FROM communes ORDER BY wilaya_id, name').all()
  const communesByWilaya: Record<number, any[]> = {}
  for (const c of (communes || [])) {
    const wid = (c as any).wilaya_id
    if (!communesByWilaya[wid]) communesByWilaya[wid] = []
    communesByWilaya[wid].push(c)
  }
  return c.json({ wilayas, communesByWilaya })
})


// ========================
// SUBSCRIPTION PAYMENTS
// ========================
app.get('/api/payment-requests', async (c) => {
  const userId = c.get('userId')
  await ensurePaymentRequestsTable(c.env.DB)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM payment_requests WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(userId).all()
  return c.json(results)
})

app.post('/api/payment-request', async (c) => {
  const userId = c.get('userId')
  await ensurePaymentRequestsTable(c.env.DB)
  const { plan, payment_method, proof_reference, proof_notes } = await c.req.json()

  if (!['pro', 'business'].includes(plan)) {
    return c.json({ error: 'Plan invalide' }, 400)
  }
  if (!['baridimob', 'ccp', 'redotpay'].includes(payment_method)) {
    return c.json({ error: 'MÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©thode de paiement invalide' }, 400)
  }
  if (!proof_reference) {
    return c.json({ error: 'RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©fÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©rence de preuve de paiement requise' }, 400)
  }

  let amount = 0
  let currency = 'DZD'

  if (plan === 'pro') {
    if (payment_method === 'redotpay') { amount = 15; currency = 'USD' }
    else { amount = 2900; currency = 'DZD' }
  } else if (plan === 'business') {
    if (payment_method === 'redotpay') { amount = 35; currency = 'USD' }
    else { amount = 6900; currency = 'DZD' }
  }

  const result = await c.env.DB.prepare(
    `INSERT INTO payment_requests (user_id, plan, amount, currency, payment_method, proof_reference, proof_notes, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(userId, plan, amount, currency, payment_method, proof_reference, proof_notes || '', 'pending').run()

  await c.env.DB.prepare('INSERT INTO historique (action, details) VALUES (?, ?)').bind(
    'PAYMENT_REQUEST', `User ${userId} requested ${plan} plan via ${payment_method}`
  ).run()

  return c.json({ success: true, id: result.meta.last_row_id, message: 'Demande envoyÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e, en attente de validation' })
})

app.get('/api/admin/payment-requests', async (c) => {
  const status = c.req.query('status')
  await ensurePaymentRequestsTable(c.env.DB)
  let query = 'SELECT p.*, u.email, u.store_name, u.username FROM payment_requests p JOIN users u ON u.id = p.user_id'
  const params: any[] = []
  if (status) {
    query += ' WHERE p.status = ?'
    params.push(status)
  }
  query += ' ORDER BY p.created_at DESC'
  const { results } = await c.env.DB.prepare(query).bind(...params).all()
  return c.json(results)
})

app.put('/api/admin/payment-requests/:id', async (c) => {
  const id = c.req.param('id')
  const adminId = c.get('userId')
  const { status, admin_notes } = await c.req.json()

  if (!['approved', 'rejected'].includes(status)) {
    return c.json({ error: 'Statut invalide' }, 400)
  }

  await ensurePaymentRequestsTable(c.env.DB)
  const request = await c.env.DB.prepare('SELECT * FROM payment_requests WHERE id = ?').bind(id).first() as any
  if (!request) return c.json({ error: 'Demande introuvable' }, 404)

  if (status === 'approved') {
    await c.env.DB.prepare(
      'UPDATE payment_requests SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind('approved', adminId, id).run()

    await c.env.DB.prepare('UPDATE users SET subscription = ? WHERE id = ?').bind(request.plan, request.user_id).run()

    await c.env.DB.prepare('INSERT INTO historique (action, details) VALUES (?, ?)').bind(
      'PAYMENT_APPROVED', `Payment ${id} approved by admin ${adminId} for user ${request.user_id}`
    ).run()
  } else {
    await c.env.DB.prepare(
      'UPDATE payment_requests SET status = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind('rejected', admin_notes || '', adminId, id).run()

    await c.env.DB.prepare('INSERT INTO historique (action, details) VALUES (?, ?)').bind(
      'PAYMENT_REJECTED', `Payment ${id} rejected by admin ${adminId} for user ${request.user_id}`
    ).run()
  }

  return c.json({ success: true })
})


// ========================
// PAGES HTML
// ========================
app.get('/', (c) => c.redirect('/login'))
app.get('/login', (c) => c.html(loginPage()))
app.get('/register', (c) => c.html(registerPage()))
app.get('/app', (c) => c.html(appPage()))
app.get('/app/*', (c) => c.html(appPage()))

export default app

// ========================
// HELPER FUNCTIONS
// ========================
function traduireStatutZR(stateName: string): string {
  const s = String(stateName).toLowerCase().trim()
  const mapping: Record<string, string> = {
    dispatch: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ PrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âªt ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  expÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©dier', ready: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ PrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âªt ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  expÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©dier',
    confirme_au_bureau: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ RamassÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', picked: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ RamassÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', ramasse: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ RamassÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©',
    vers_wilaya: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit', transit: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit', in_transit: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit', transfert: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit',
    sortie_en_livraison: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´ En cours de livraison', en_livraison: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´ En cours de livraison', out_for_delivery: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´ En cours de livraison', delivery: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´ En cours de livraison',
    livre: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° LivrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© & EncaissÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', delivered: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° LivrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© & EncaissÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', encaisse: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° LivrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© & EncaissÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©',
    retour: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur', returned: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur', retourne: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur', echec: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur',
    annule: 'Annule', cancelled: 'Annule', canceled: 'Annule'
  }
  if (mapping[s]) return mapping[s]
  for (const [key, value] of Object.entries(mapping)) { if (s.includes(key)) return value }
  return stateName.toUpperCase()
}

function traduireStatutYalidine(status: any): string {
  const s = String(status).trim()
  const mapping: Record<string, string> = {
    '1': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂºÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Nouvelle', '2': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ ConfirmÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©e', '3': 'Annule', '4': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ PrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âªt ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  expÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©dier', '5': 'EXPEDIE',
    '6': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ RamassÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', '7': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit', '8': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit', '9': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit', '10': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit',
    '11': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´ En cours de livraison', '12': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° LivrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© & EncaissÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', '13': 'ECHEC LIVRAISON', '14': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur', '15': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur'
  }
  if (mapping[s]) return mapping[s]

  const text = s.toLowerCase()
  if (text.includes('livre')) return 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° LivrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© & EncaissÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©'
  if (text.includes('retour')) return 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur'
  if (text.includes('transit')) return 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit'
  if (text.includes('livraison')) return 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´ En cours de livraison'
  if (text.includes('pret')) return 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ PrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âªt ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  expÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©dier'
  if (text.includes('ramasse')) return 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ RamassÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©'
  if (text.includes('annul')) return 'Annule'

  return s.toUpperCase()
}

function traduireStatutEcotrack(status: any): string {
  const s = String(status).toLowerCase().trim()
  const mapping: Record<string, string> = {
    'nouveau': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂºÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¯ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Nouvelle', 'en attente': 'EN ATTENTE', 'pret': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ PrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Âªt ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  expÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©dier',
    'expedie': 'EXPEDIE', 'recu': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ RamassÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', 'en cours': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¾ En cours de transit',
    'en livraison': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´ En cours de livraison', 'livre': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° LivrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© & EncaissÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', 'echoue': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur',
    'retourne': 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur', 'annule': 'Annule'
  }
  if (mapping[s]) return mapping[s]
  for (const [key, value] of Object.entries(mapping)) { if (s.includes(key)) return value }
  return s.toUpperCase()
}


async function diminuerStock(db: D1Database, produit: string) {
  // Legacy size-based stock logic removed.
  // Advanced inventory updates are handled through stock_items / stock_movements.
  void db
  void produit
}

// ========================
// REGISTER PAGE - Style Yalidine Dashboard
// ========================
function registerPage(): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AutoHub DZ - Inscription</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<script>
tailwind.config = {
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] }
    }
  }
}
</script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', sans-serif;
  min-height: 100vh;
  display: flex;
  background: #f8fafc;
}
.left-panel {
  flex: 1;
  background: linear-gradient(135deg, #0B1120 0%, #1e1b4b 30%, #312e81 60%, #3730a3 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
  padding: 40px;
}
.left-panel::before {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at 30% 40%, rgba(255,255,255,0.08) 0%, transparent 50%),
              radial-gradient(circle at 70% 60%, rgba(255,255,255,0.05) 0%, transparent 40%);
  pointer-events: none;
}
.left-panel::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 200px;
  background: linear-gradient(to top, rgba(11,17,32,0.4), transparent);
  pointer-events: none;
}
.right-panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: #ffffff;
}
.form-container {
  width: 100%;
  max-width: 440px;
}
.form-input {
  width: 100%;
  padding: 12px 16px 12px 44px;
  border: 2px solid #e2e8f0;
  border-radius: 12px;
  font-size: 14px;
  color: #1e293b;
  background: #f8fafc;
  transition: all 0.3s ease;
  outline: none;
}
.form-input:focus {
  border-color: #6366f1;
  background: #fff;
  box-shadow: 0 0 0 4px rgba(99, 102, 241, 0.1);
}
.form-input::placeholder {
  color: #94a3b8;
}
.input-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: #94a3b8;
  font-size: 16px;
  transition: color 0.3s;
}
.input-group:focus-within .input-icon {
  color: #6366f1;
}
.btn-register {
  width: 100%;
  padding: 14px;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: #fff;
  border: none;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.btn-register:hover {
  background: linear-gradient(135deg, #4f46e5, #4338ca);
  transform: translateY(-1px);
  box-shadow: 0 8px 25px rgba(99, 102, 241, 0.3);
}
.btn-register:active {
  transform: translateY(0);
}
.btn-register:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
}
.btn-google {
  width: 100%;
  padding: 12px;
  background: #fff;
  color: #374151;
  border: 2px solid #e2e8f0;
  border-radius: 12px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.3s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.btn-google:hover {
  border-color: #6366f1;
  background: #f8fafc;
  box-shadow: 0 4px 12px rgba(0,0,0,0.06);
}
.divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 16px 0;
}
.divider::before, .divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #e2e8f0;
}
.divider span {
  font-size: 12px;
  color: #94a3b8;
  white-space: nowrap;
}
.shake { animation: shake 0.5s; }
@keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-8px)} 40%,80%{transform:translateX(8px)} }
.fade-up { animation: fadeUp 0.6s ease-out; }
@keyframes fadeUp { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
.float { animation: float 6s ease-in-out infinite; }
@keyframes float { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-10px)} }
.spinner { border: 2px solid rgba(255,255,255,0.3); border-top: 2px solid #fff; border-radius: 50%; width: 20px; height: 20px; animation: spin 0.8s linear infinite; display: inline-block; }
@keyframes spin { to{transform:rotate(360deg)} }
.pattern-dots {
  position: absolute;
  width: 100%;
  height: 100%;
  background-image: radial-gradient(rgba(255,255,255,0.1) 1px, transparent 1px);
  background-size: 30px 30px;
  pointer-events: none;
}
.glass-card {
  background: rgba(255,255,255,0.1);
  backdrop-filter: blur(10px);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 16px;
  padding: 24px;
}
@media (max-width: 768px) {
  body { flex-direction: column; }
  .left-panel { min-height: 200px; padding: 30px 20px; }
  .right-panel { padding: 30px 20px; }
}

</style>
</head>
<body>

<!-- LEFT PANEL - Dark Navy/Indigo Brand Style -->
<div class="left-panel">
  <div class="pattern-dots"></div>
  <div class="relative z-10 text-center">
    <!-- Logo -->
    <div class="float mb-8">
      <div class="inline-flex items-center justify-center w-20 h-20 bg-white/15 backdrop-blur-sm rounded-2xl border border-white/20 shadow-lg">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="white"/><line x1="12" y1="2" x2="12" y2="9" stroke="white" stroke-width="1.5"/><line x1="12" y1="15" x2="12" y2="22" stroke="white" stroke-width="1.5"/><line x1="3" y1="7" x2="9" y2="10" stroke="white" stroke-width="1.5"/><line x1="15" y1="14" x2="21" y2="17" stroke="white" stroke-width="1.5"/><line x1="21" y1="7" x2="15" y2="10" stroke="white" stroke-width="1.5"/><line x1="9" y1="14" x2="3" y2="17" stroke="white" stroke-width="1.5"/></svg>
      </div>
    </div>

    <h1 class="text-4xl md:text-5xl font-extrabold text-white mb-4 leading-tight">
      Auto<span class="text-indigo-300">Hub</span> DZ
    </h1>
    <p class="text-indigo-200/80 text-lg mb-10 max-w-md">
      La plateforme logistique e-commerce n&deg;1 en Algerie
    </p>

    <!-- Feature cards -->
    <div class="space-y-4 max-w-sm mx-auto">
      <div class="glass-card flex items-center gap-4 text-left">
        <div class="w-10 h-10 bg-white/15 rounded-lg flex items-center justify-center flex-shrink-0">
          <i class="fas fa-truck-fast text-indigo-200"></i>
        </div>
        <div>
          <div class="text-white font-semibold text-sm">Multi-Transporteurs</div>
          <div class="text-indigo-200/70 text-xs">Yalidine, ZR Express, Ecotrack pdex et plus</div>
        </div>
      </div>
      <div class="glass-card flex items-center gap-4 text-left">
        <div class="w-10 h-10 bg-white/15 rounded-lg flex items-center justify-center flex-shrink-0">
          <i class="fas fa-map-marked-alt text-indigo-200"></i>
        </div>
        <div>
          <div class="text-white font-semibold text-sm">58 Wilayas</div>
          <div class="text-indigo-200/70 text-xs">Couverture nationale complete</div>
        </div>
      </div>
      <div class="glass-card flex items-center gap-4 text-left">
        <div class="w-10 h-10 bg-white/15 rounded-lg flex items-center justify-center flex-shrink-0">
          <i class="fas fa-shield-halved text-indigo-200"></i>
        </div>
        <div>
          <div class="text-white font-semibold text-sm">100% Securise</div>
          <div class="text-indigo-200/70 text-xs">Donnees protegees et chiffrees</div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- RIGHT PANEL - Registration Form -->
<div class="right-panel">
  <div class="form-container fade-up" id="register-card">
    <!-- Header -->
    <div class="mb-6">
      <h2 class="text-2xl font-bold text-gray-900 mb-2">Creer un compte</h2>
      <p class="text-gray-500 text-sm">Rejoignez AutoHub DZ et gerez vos livraisons facilement</p>
    </div>

    <!-- Google Sign-In Button -->
    <button type="button" onclick="handleGoogleSignIn()" class="btn-google" id="google-btn">
      <svg width="20" height="20" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
      S'inscrire avec Google
    </button>

    <div class="divider"><span>ou avec votre email</span></div>

    <!-- Error message -->
    <div id="error-msg" class="hidden mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-600 text-sm flex items-center gap-2">
      <i class="fas fa-exclamation-circle"></i>
      <span id="error-text"></span>
    </div>

    <!-- Success message -->
    <div id="success-msg" class="hidden mb-4 p-3 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 text-sm flex items-center gap-2">
      <i class="fas fa-check-circle"></i>
      <span id="success-text"></span>
    </div>

    <!-- Form -->
    <form onsubmit="handleRegister(event)" class="space-y-4">
      <!-- Prenom -->
      <div class="input-group relative">
        <i class="fas fa-user input-icon"></i>
        <input type="text" id="prenom" class="form-input" placeholder="Prenom" required minlength="2" autocomplete="given-name">
      </div>

      <!-- Email -->
      <div class="input-group relative">
        <i class="fas fa-envelope input-icon"></i>
        <input type="email" id="email" class="form-input" placeholder="Adresse email" required autocomplete="email">
      </div>

      <!-- Telephone -->
      <div class="input-group relative">
        <i class="fas fa-phone input-icon"></i>
        <input type="tel" id="telephone" class="form-input" placeholder="Telephone (ex: 05xxxxxxxx)" required pattern="^(0[567]\\d{8}|\\+213[567]\\d{8})$" autocomplete="tel">
      </div>

      <!-- Store Name -->
      <div class="input-group relative">
        <i class="fas fa-store input-icon"></i>
        <input type="text" id="store_name" class="form-input" placeholder="Nom du magasin" required minlength="2" autocomplete="organization">
      </div>

      <!-- Password -->
      <div class="input-group relative">
        <i class="fas fa-lock input-icon"></i>
        <input type="password" id="password" class="form-input" placeholder="Mot de passe (min. 6 caracteres)" required minlength="6" autocomplete="new-password" style="padding-right: 44px">
        <button type="button" onclick="togglePwd('password','eye1')" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition">
          <i class="fas fa-eye" id="eye1"></i>
        </button>
      </div>

      <!-- Confirm Password -->
      <div class="input-group relative">
        <i class="fas fa-lock input-icon"></i>
        <input type="password" id="confirm_password" class="form-input" placeholder="Confirmer le mot de passe" required minlength="6" autocomplete="new-password" style="padding-right: 44px">
        <button type="button" onclick="togglePwd('confirm_password','eye2')" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition">
          <i class="fas fa-eye" id="eye2"></i>
        </button>
      </div>

      <!-- Submit -->
      <button type="submit" id="register-btn" class="btn-register mt-6">
        <span id="btn-text">Creer mon compte</span>
        <span id="btn-spinner" class="hidden"><span class="spinner"></span></span>
      </button>
    </form>

    <!-- Footer links -->
    <div class="mt-6 text-center space-y-3">
      <p class="text-gray-500 text-sm">
        Deja un compte ?
        <a href="/login" class="text-indigo-600 font-semibold hover:text-indigo-700 transition">Se connecter</a>
      </p>
      <a href="/" class="inline-flex items-center gap-1 text-gray-400 text-xs hover:text-indigo-600 transition">
        <i class="fas fa-arrow-left"></i> Retour au site
      </a>
    </div>
  </div>
</div>

<script>
function togglePwd(inputId, iconId) {
  const p = document.getElementById(inputId)
  const i = document.getElementById(iconId)
  if(p.type === 'password') { p.type='text'; i.className='fas fa-eye-slash' }
  else { p.type='password'; i.className='fas fa-eye' }
}

// Google Sign-In handler
async function handleGoogleSignIn() {
  const btn = document.getElementById('google-btn')
  const errorMsg = document.getElementById('error-msg')
  const errorText = document.getElementById('error-text')
  const successMsg = document.getElementById('success-msg')
  const successText = document.getElementById('success-text')
  
  btn.disabled = true
  btn.innerHTML = '<span class="spinner" style="border-color:rgba(99,102,241,0.3);border-top-color:#6366f1;width:18px;height:18px"></span> Connexion Google...'
  errorMsg.classList.add('hidden')
  successMsg.classList.add('hidden')
  
  try {
    // Request Google OAuth consent
    const resp = await fetch('/api/auth/google-url')
    const data = await resp.json()
    if (data.url) {
      window.location.href = data.url
    } else {
      // Fallback: Simulated Google popup flow for demo
      successText.textContent = 'Google OAuth necessite une configuration cote serveur (Client ID Google). Contactez l\\'administrateur.'
      successMsg.classList.remove('hidden')
      successMsg.querySelector('span').className = ''
      successMsg.className = 'mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm flex items-center gap-2'
      successMsg.querySelector('i').className = 'fas fa-info-circle'
      btn.disabled = false
      btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> S\\'inscrire avec Google'
    }
  } catch(err) {
    // OAuth not configured yet - show info message
    successText.textContent = 'L\\'inscription Google sera disponible une fois le Client ID Google configure.'
    successMsg.classList.remove('hidden')
    successMsg.className = 'mb-4 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-sm flex items-center gap-2'
    successMsg.querySelector('i').className = 'fas fa-info-circle'
    btn.disabled = false
    btn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg> S\\'inscrire avec Google'
  }
}

async function handleRegister(e) {
  e.preventDefault()
  const btn = document.getElementById('register-btn')
  const btnText = document.getElementById('btn-text')
  const btnSpinner = document.getElementById('btn-spinner')
  const errorMsg = document.getElementById('error-msg')
  const errorText = document.getElementById('error-text')
  const successMsg = document.getElementById('success-msg')
  const successText = document.getElementById('success-text')
  const card = document.getElementById('register-card')

  btn.disabled = true
  btnText.classList.add('hidden')
  btnSpinner.classList.remove('hidden')
  errorMsg.classList.add('hidden')
  successMsg.classList.add('hidden')

  const prenom = document.getElementById('prenom').value.trim()
  const email = document.getElementById('email').value.trim()
  const telephone = document.getElementById('telephone').value.trim()
  const store_name = document.getElementById('store_name').value.trim()
  const password = document.getElementById('password').value
  const confirm_password = document.getElementById('confirm_password').value

  // Client-side validation
  if (password !== confirm_password) {
    errorText.textContent = 'Les mots de passe ne correspondent pas'
    errorMsg.classList.remove('hidden')
    card.classList.add('shake')
    setTimeout(() => card.classList.remove('shake'), 500)
    btn.disabled = false
    btnText.classList.remove('hidden')
    btnSpinner.classList.add('hidden')
    return
  }

  try {
    const resp = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prenom, email, telephone, store_name, password, confirm_password })
    })
    const data = await resp.json()

    if(data.success) {
      successMsg.className = 'mb-4 p-3 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-700 text-sm flex items-center gap-2'
      successMsg.querySelector('i').className = 'fas fa-check-circle'
      successText.textContent = 'Compte cree avec succes ! Redirection...'
      successMsg.classList.remove('hidden')
      btn.innerHTML = '<i class="fas fa-check mr-2"></i>Compte cree !'
      btn.style.background = 'linear-gradient(135deg, #4f46e5, #4338ca)'
      setTimeout(() => { window.location.href = '/app' }, 1000)
    } else {
      errorText.textContent = data.error || 'Erreur lors de la creation du compte'
      errorMsg.classList.remove('hidden')
      card.classList.add('shake')
      setTimeout(() => card.classList.remove('shake'), 500)
      btn.disabled = false
      btnText.classList.remove('hidden')
      btnSpinner.classList.add('hidden')
    }
  } catch(err) {
    errorText.textContent = 'Erreur de connexion au serveur'
    errorMsg.classList.remove('hidden')
    btn.disabled = false
    btnText.classList.remove('hidden')
    btnSpinner.classList.add('hidden')
  }
}

// Redirect if already logged in
fetch('/api/auth/check').then(r=>r.json()).then(d=>{ if(d.authenticated) window.location.href='/app' })
</script>
</body>
</html>`
}

// ========================
// LOGIN PAGE - Yalidine Green Style
// ========================
function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AutoHub DZ - Connexion</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<script>
tailwind.config = {
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] }
    }
  }
}
</script>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', sans-serif;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #0B1120 0%, #1e1b4b 30%, #312e81 60%, #3730a3 100%);
  position: relative;
  overflow: hidden;
}
body::before {
  content: '';
  position: absolute;
  top: -50%;
  left: -50%;
  width: 200%;
  height: 200%;
  background: radial-gradient(circle at 30% 40%, rgba(255,255,255,0.06) 0%, transparent 50%),
              radial-gradient(circle at 70% 60%, rgba(255,255,255,0.04) 0%, transparent 40%);
  pointer-events: none;
}
.pattern-dots {
  position: fixed;
  inset: 0;
  background-image: radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px);
  background-size: 30px 30px;
  pointer-events: none;
}
.login-card {
  background: rgba(255,255,255,0.95);
  backdrop-filter: blur(20px);
  border-radius: 20px;
  padding: 40px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 25px 60px rgba(0,0,0,0.3);
}
.form-input {
  width: 100%;
  padding: 12px 16px 12px 44px;
  border: 2px solid #e2e8f0;
  border-radius: 12px;
  font-size: 14px;
  color: #1e293b;
  background: #f8fafc;
  transition: all 0.3s ease;
  outline: none;
}
.form-input:focus {
  border-color: #6366f1;
  background: #fff;
  box-shadow: 0 0 0 4px rgba(99,102,241,0.1);
}
.form-input::placeholder { color: #94a3b8; }
.input-icon {
  position: absolute;
  left: 14px;
  top: 50%;
  transform: translateY(-50%);
  color: #94a3b8;
  font-size: 16px;
  transition: color 0.3s;
}
.input-group:focus-within .input-icon { color: #6366f1; }
.btn-login {
  width: 100%;
  padding: 14px;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: #fff;
  border: none;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
.btn-login:hover { background: linear-gradient(135deg, #4f46e5, #4338ca); transform: translateY(-1px); box-shadow: 0 8px 25px rgba(99,102,241,0.3); }
.btn-login:active { transform: translateY(0); }
.btn-login:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }
.shake { animation: shake 0.5s; }
@keyframes shake { 0%,100%{transform:translateX(0)} 20%,60%{transform:translateX(-8px)} 40%,80%{transform:translateX(8px)} }
.fade-in { animation: fadeIn 0.6s ease-out; }
@keyframes fadeIn { from{opacity:0;transform:translateY(20px)} to{opacity:1;transform:translateY(0)} }
.spinner { border: 2px solid rgba(255,255,255,0.3); border-top: 2px solid #fff; border-radius: 50%; width: 20px; height: 20px; animation: spin 0.8s linear infinite; display: inline-block; }
@keyframes spin { to{transform:rotate(360deg)} }

.toggle-switch { position:relative; width:44px; height:24px; }
.toggle-switch input { opacity:0; width:0; height:0; }
.toggle-switch .slider { position:absolute; cursor:pointer; inset:0; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.15); transition:0.3s; border-radius:24px; }
.toggle-switch .slider:before { content:''; position:absolute; height:18px; width:18px; left:2px; bottom:2px; background:#64748b; transition:0.3s; border-radius:50%; }
.toggle-switch input:checked + .slider { background:rgba(99,102,241,0.3); border-color:rgba(99,102,241,0.5); }
.toggle-switch input:checked + .slider:before { transform:translateX(20px); background:#818cf8; }
.permission-row { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-radius:10px; background:rgba(15,23,42,0.4); border:1px solid rgba(255,255,255,0.05); margin-bottom:8px; transition:all 0.2s; }
.permission-row:hover { background:rgba(15,23,42,0.6); border-color:rgba(99,102,241,0.15); }

</style>
</head>
<body>
<div class="pattern-dots"></div>
<div class="w-full px-6 fade-in" style="max-width:420px">
  <!-- Logo above card -->
  <div class="text-center mb-8">
    <div class="inline-flex items-center justify-center w-16 h-16 bg-white/15 backdrop-blur-sm rounded-2xl border border-white/20 mb-4 shadow-lg">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="white"/><line x1="12" y1="2" x2="12" y2="9" stroke="white" stroke-width="1.5"/><line x1="12" y1="15" x2="12" y2="22" stroke="white" stroke-width="1.5"/><line x1="3" y1="7" x2="9" y2="10" stroke="white" stroke-width="1.5"/><line x1="15" y1="14" x2="21" y2="17" stroke="white" stroke-width="1.5"/></svg>
    </div>
    <h1 class="text-2xl font-bold text-white">Auto<span class="text-indigo-300">Hub</span> DZ</h1>
    <p class="text-indigo-200/70 text-sm mt-1">Plateforme logistique e-commerce</p>
  </div>

  <!-- Login Card -->
  <div class="login-card" id="login-card">
    <h2 class="text-xl font-bold text-gray-900 mb-1">Connexion</h2>
    <p class="text-gray-500 text-sm mb-6">Connectez-vous pour acceder a votre tableau de bord</p>

    <div id="error-msg" class="hidden mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-red-600 text-sm flex items-center gap-2">
      <i class="fas fa-exclamation-circle"></i><span id="error-text"></span>
    </div>

    <form onsubmit="handleLogin(event)" class="space-y-4">
      <div class="input-group relative">
        <i class="fas fa-user input-icon"></i>
        <input type="text" id="username" class="form-input" placeholder="Email ou nom d'utilisateur" required autofocus>
      </div>
      <div class="input-group relative">
        <i class="fas fa-lock input-icon"></i>
        <input type="password" id="password" class="form-input" placeholder="Mot de passe" required style="padding-right:44px">
        <button type="button" onclick="togglePassword()" class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition">
          <i class="fas fa-eye" id="eye-icon"></i>
        </button>
      </div>
      <button type="submit" id="login-btn" class="btn-login mt-2">
        <span id="btn-text">Se connecter</span>
        <span id="btn-spinner" class="hidden"><span class="spinner"></span></span>
      </button>
    </form>

    <div class="mt-6 text-center space-y-3">
      <p class="text-gray-500 text-sm">
        Pas encore de compte ?
        <a href="/register" class="text-indigo-600 font-semibold hover:text-indigo-700 transition">S'inscrire</a>
      </p>
      <a href="/" class="inline-flex items-center gap-1 text-gray-400 text-xs hover:text-indigo-600 transition">
        <i class="fas fa-arrow-left"></i> Retour au site
      </a>
    </div>
  </div>

  <p class="text-center text-indigo-200/50 text-xs mt-6">&copy; 2026 AutoHub DZ</p>
</div>

<script>
function togglePassword() {
  const p = document.getElementById('password')
  const i = document.getElementById('eye-icon')
  if(p.type === 'password') { p.type='text'; i.className='fas fa-eye-slash' }
  else { p.type='password'; i.className='fas fa-eye' }
}

async function handleLogin(e) {
  e.preventDefault()
  const btn = document.getElementById('login-btn')
  const btnText = document.getElementById('btn-text')
  const btnSpinner = document.getElementById('btn-spinner')
  const errorMsg = document.getElementById('error-msg')
  const errorText = document.getElementById('error-text')
  const card = document.getElementById('login-card')

  btn.disabled = true
  btnText.classList.add('hidden')
  btnSpinner.classList.remove('hidden')
  errorMsg.classList.add('hidden')

  try {
    const resp = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('username').value,
        password: document.getElementById('password').value
      })
    })
    const data = await resp.json()
    if(data.success) {
      btn.innerHTML = '<i class="fas fa-check mr-2"></i>Connecte !'
      btn.style.background = 'linear-gradient(135deg, #4f46e5, #4338ca)'
      setTimeout(() => { window.location.href = '/app' }, 500)
    } else {
      errorText.textContent = data.error || 'Identifiants incorrects'
      errorMsg.classList.remove('hidden')
      card.classList.add('shake')
      setTimeout(() => card.classList.remove('shake'), 500)
      btn.disabled = false
      btnText.classList.remove('hidden')
      btnSpinner.classList.add('hidden')
    }
  } catch(err) {
    errorText.textContent = 'Erreur de connexion au serveur'
    errorMsg.classList.remove('hidden')
    btn.disabled = false
    btnText.classList.remove('hidden')
    btnSpinner.classList.add('hidden')
  }
}

fetch('/api/auth/check').then(r=>r.json()).then(d=>{ if(d.authenticated) window.location.href='/app' })
</script>
</body>
</html>`
}

// ========================
// LANDING PAGE - Updated with Yalidine green theme
// ========================
function landingPage(): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AutoHub DZ - Automatisez votre logistique e-commerce</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
<script>
tailwind.config = {
  theme: {
    extend: {
      fontFamily: { sans: ['Inter', 'sans-serif'] },
      colors: {
        dark: { 900: '#080c1a', 800: '#0B1120', 700: '#151D30', 600: '#1F2B40' },
        accent: { primary: '#6366f1', secondary: '#818cf8', blue: '#3b82f6', dark: '#312e81' }
      }
    }
  }
}
</script>
<style>
body { font-family: 'Inter', sans-serif; background: #080c1a; color: #fff; }
.hero-glow { background: radial-gradient(ellipse 600px 400px at center, rgba(99,102,241,0.12) 0%, transparent 70%); }
.card-glass { background: rgba(21,29,48,0.6); border: 1px solid rgba(255,255,255,0.06); backdrop-filter: blur(12px); }
.card-glass:hover { border-color: rgba(99,102,241,0.3); transform: translateY(-2px); transition: all 0.3s; }
.stat-num { background: linear-gradient(135deg, #818cf8, #6366f1); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.cta-gradient { background: linear-gradient(135deg, #0B1120 0%, #120f2e 40%, #1a1442 70%, #1e1b4b 100%); }
.badge { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); }
.icon-box { width: 40px; height: 40px; border-radius: 10px; display: flex; align-items: center; justify-content: center; }
.carrier-scroll { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; scrollbar-width: thin; scrollbar-color: rgba(22,163,74,0.3) transparent; }
.carrier-badge { flex-shrink: 0; }

.logo-scroll-container {
  overflow: hidden;
  position: relative;
  padding: 40px 0;
  background: rgba(255,255,255,0.02);
  border-top: 1px solid rgba(255,255,255,0.05);
  border-bottom: 1px solid rgba(255,255,255,0.05);
}
.logo-scroll-container::before,
.logo-scroll-container::after {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  width: 120px;
  z-index: 2;
  pointer-events: none;
}
.logo-scroll-container::before {
  left: 0;
  background: linear-gradient(to right, #080c1a, transparent);
}
.logo-scroll-container::after {
  right: 0;
  background: linear-gradient(to left, #080c1a, transparent);
}
.logo-scroll-track {
  display: flex;
  align-items: center;
  gap: 60px;
  animation: logoScroll 30s linear infinite;
  width: max-content;
}
.logo-scroll-track:hover {
  animation-play-state: paused;
}
.logo-item {
  display: flex;
  align-items: center;
  gap: 12px;
  filter: grayscale(1) opacity(0.5);
  transition: all 0.3s ease;
}
.logo-item:hover {
  filter: grayscale(0) opacity(1);
  transform: scale(1.05);
}
.logo-text {
  font-weight: 700;
  font-size: 16px;
  letter-spacing: -0.5px;
}
@keyframes logoScroll {
  0% { transform: translateX(0); }
  100% { transform: translateX(calc(-50% - 30px)); }
}
</style>
</head>
<body class="min-h-screen">

<!-- NAVBAR -->
<nav class="fixed top-0 w-full z-50 bg-dark-900/80 backdrop-blur-md border-b border-white/5">
  <div class="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
    <div class="flex items-center gap-2">
      <div class="w-8 h-8 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-lg flex items-center justify-center">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="2.5" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.5" fill="white"/></svg>
      </div>
      <span class="font-bold text-lg">Auto<span class="text-indigo-400">Hub</span> DZ</span>
    </div>
    <div class="flex items-center gap-3">
      <a href="/register" class="px-5 py-2 bg-indigo-600 text-white rounded-full text-sm font-medium hover:bg-indigo-500 transition">
        <i class="fas fa-user-plus mr-1"></i> S'inscrire
      </a>
      <a href="/login" class="px-5 py-2 bg-indigo-500/10 text-indigo-300 border border-indigo-500/30 rounded-full text-sm font-medium hover:bg-indigo-500/20 transition">
        <i class="fas fa-sign-in-alt mr-1"></i> Connexion
      </a>
    </div>
  </div>
</nav>

<!-- HERO -->
<section class="relative pt-28 pb-16">
  <div class="hero-glow absolute inset-0"></div>
  <div class="max-w-6xl mx-auto px-6 relative z-10 text-center">
    <div class="card-glass rounded-2xl p-8 mb-8 max-w-3xl mx-auto min-h-[260px] flex items-center justify-center">
      <div>
        <h1 class="text-3xl md:text-4xl font-extrabold mb-4">
          Automatisez votre <span class="text-indigo-400">logistique</span><br>e-commerce en Algerie
        </h1>
        <p class="text-gray-400 max-w-xl mx-auto">Centralisez vos commandes, connectez vos transporteurs et suivez vos colis en temps reel depuis un seul hub.</p>
      </div>
    </div>
    <div class="mb-4">
      <span class="text-xs text-gray-500 uppercase tracking-wider">Integre avec 5 transporteurs algeriens</span>
    </div>
    <div class="carrier-scroll max-w-4xl mx-auto mb-12 justify-center flex-wrap">
      <span class="carrier-badge badge px-3 py-1.5 rounded-full text-xs flex items-center gap-1.5"><span class="w-2 h-2 bg-yellow-400 rounded-full"></span>Yalidine</span>
      <span class="carrier-badge badge px-3 py-1.5 rounded-full text-xs flex items-center gap-1.5"><span class="w-2 h-2 bg-blue-400 rounded-full"></span>ZR Express</span>
      <span class="carrier-badge badge px-3 py-1.5 rounded-full text-xs flex items-center gap-1.5"><span class="w-2 h-2 bg-orange-400 rounded-full"></span>PDEX</span>
      <span class="carrier-badge badge px-3 py-1.5 rounded-full text-xs flex items-center gap-1.5"><span class="w-2 h-2 bg-red-400 rounded-full"></span>EcoTrack</span>
    </div>

    <!-- PARTNERS LOGOS SCROLL -->
    <section class="logo-scroll-container">
      <div style="text-align:center;margin-bottom:24px">
        <span style="font-size:11px;text-transform:uppercase;letter-spacing:2px;color:#64748b">Compatible avec vos outils</span>
      </div>
      <div class="logo-scroll-track">
        <!-- Set 1 -->
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#96bf48"/><path d="M15.5 7.5l-1 6.5-3-1.5L8 15V8l3.5 2 4-2.5z" fill="white"/></svg>
          <span class="logo-text" style="color:#96bf48">Shopify</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#9b5c8f"/><path d="M7 12c0-1.5.8-3 2.5-3s2.5 1 2.5 2.5c0 2-2 2.5-2 4h3c0-1.5 2-2 2-4.5C15 8.5 13 7 10.5 7 7.5 7 6 9.5 6 12s1.5 5 4.5 5c1.5 0 3-.5 3.5-1" stroke="white" stroke-width="1.2" fill="none"/></svg>
          <span class="logo-text" style="color:#9b5c8f">WooCommerce</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#60a5fa"/><path d="M8 8h8v8H8z" rx="1" fill="white" fill-opacity="0.9"/><path d="M10 11h4M10 13h3" stroke="#60a5fa" stroke-width="1"/></svg>
          <span class="logo-text" style="color:#60a5fa">YouCan</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#F7B731"/><path d="M6 15l4-4 3 3 5-6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="logo-text" style="color:#F7B731">Yalidine</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#3b82f6"/><path d="M5 12h14M12 5l7 7-7 7" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="logo-text" style="color:#3b82f6">ZR Express</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#f97316"/><path d="M7 17V7h4l3 5 3-5h4v10" stroke="white" stroke-width="1.5" fill="none"/></svg>
          <span class="logo-text" style="color:#f97316">Ecotrack</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#ef4444"/><circle cx="12" cy="12" r="5" stroke="white" stroke-width="2" fill="none"/><path d="M12 9v3l2 2" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="logo-text" style="color:#ef4444">DHD</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#8b5cf6"/><path d="M6 12h12M12 6v12" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
          <span class="logo-text" style="color:#8b5cf6">NOEST</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#25d366"/><path d="M8 12l3 3 5-6" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="logo-text" style="color:#25d366">WhatsApp</span>
        </div>
        <!-- Set 2 (DUPLICATE for infinite loop) -->
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" fill="#96bf48"/><path d="M15.5 7.5l-1 6.5-3-1.5L8 15V8l3.5 2 4-2.5z" fill="white"/></svg>
          <span class="logo-text" style="color:#96bf48">Shopify</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#9b5c8f"/><path d="M7 12c0-1.5.8-3 2.5-3s2.5 1 2.5 2.5c0 2-2 2.5-2 4h3c0-1.5 2-2 2-4.5C15 8.5 13 7 10.5 7 7.5 7 6 9.5 6 12s1.5 5 4.5 5c1.5 0 3-.5 3.5-1" stroke="white" stroke-width="1.2" fill="none"/></svg>
          <span class="logo-text" style="color:#9b5c8f">WooCommerce</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#60a5fa"/><path d="M8 8h8v8H8z" rx="1" fill="white" fill-opacity="0.9"/><path d="M10 11h4M10 13h3" stroke="#60a5fa" stroke-width="1"/></svg>
          <span class="logo-text" style="color:#60a5fa">YouCan</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#F7B731"/><path d="M6 15l4-4 3 3 5-6" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="logo-text" style="color:#F7B731">Yalidine</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#3b82f6"/><path d="M5 12h14M12 5l7 7-7 7" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="logo-text" style="color:#3b82f6">ZR Express</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#f97316"/><path d="M7 17V7h4l3 5 3-5h4v10" stroke="white" stroke-width="1.5" fill="none"/></svg>
          <span class="logo-text" style="color:#f97316">Ecotrack</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#ef4444"/><circle cx="12" cy="12" r="5" stroke="white" stroke-width="2" fill="none"/><path d="M12 9v3l2 2" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>
          <span class="logo-text" style="color:#ef4444">DHD</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><rect width="24" height="24" rx="6" fill="#8b5cf6"/><path d="M6 12h12M12 6v12" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
          <span class="logo-text" style="color:#8b5cf6">NOEST</span>
        </div>
        <div class="logo-item">
          <svg width="28" height="28" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#25d366"/><path d="M8 12l3 3 5-6" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="logo-text" style="color:#25d366">WhatsApp</span>
        </div>
      </div>
    </section>
  </div>
</section>

<!-- STATS -->
<section class="py-12">
  <div class="max-w-md mx-auto px-6">
    <div class="card-glass rounded-2xl p-8 text-center space-y-8">
      <div><div class="stat-num text-5xl font-black">4+</div><div class="text-gray-400 text-sm mt-1">Transporteurs Integres</div></div>
      <div class="border-t border-white/5"></div>
      <div><div class="stat-num text-5xl font-black">58</div><div class="text-gray-400 text-sm mt-1">Wilayas Couvertes</div></div>
      <div class="border-t border-white/5"></div>
      <div><div class="stat-num text-5xl font-black">100%</div><div class="text-gray-400 text-sm mt-1">Automation</div></div>
    </div>
  </div>
</section>

<!-- FEATURES -->
<section class="py-16">
  <div class="max-w-6xl mx-auto px-6">
    <div class="mb-10">
      <span class="text-indigo-400 text-xs uppercase tracking-widest">Fonctionnalites</span>
      <h2 class="text-2xl md:text-3xl font-bold mt-2">Tout ce dont vous avez besoin,<br>dans un seul hub.</h2>
    </div>
    <div class="grid md:grid-cols-2 gap-5">
      <div class="card-glass rounded-xl p-6">
        <div class="icon-box bg-orange-500/15 mb-4"><i class="fas fa-clipboard-list text-orange-400"></i></div>
        <h3 class="font-semibold text-lg mb-2">Gestion des commandes</h3>
        <p class="text-gray-400 text-sm">Centralisez toutes vos commandes en un seul endroit. Ajoutez, modifiez et suivez chaque commande en temps reel.</p>
      </div>
      <div class="card-glass rounded-xl p-6">
        <div class="icon-box bg-emerald-500/15 mb-4"><i class="fab fa-whatsapp text-emerald-400"></i></div>
        <h3 class="font-semibold text-lg mb-2">Confirmation WhatsApp automatique</h3>
        <p class="text-gray-400 text-sm">Activez l'envoi automatique des confirmations de commande sur WhatsApp des qu'une commande est creee.</p>
      </div>
      <div class="card-glass rounded-xl p-6">
        <div class="icon-box bg-green-500/15 mb-4"><i class="fas fa-truck text-green-400"></i></div>
        <h3 class="font-semibold text-lg mb-2">Multi-Transporteurs</h3>
        <p class="text-gray-400 text-sm">Yalidine, ZR Express, PDEX et EcoTrack connects et integres automatiquement. Choisissez le meilleur transporteur en un clic.</p>
      </div>
      <div class="card-glass rounded-xl p-6">
        <div class="icon-box bg-amber-500/15 mb-4"><i class="fas fa-map-marker-alt text-amber-400"></i></div>
        <h3 class="font-semibold text-lg mb-2">Suivi en temps reel</h3>
        <p class="text-gray-400 text-sm">Suivez chaque colis automatiquement. Statuts mis a jour en direct depuis les API des transporteurs.</p>
      </div>
      <div class="card-glass rounded-xl p-6">
        <div class="icon-box bg-indigo-500/15 mb-4"><i class="fas fa-chart-line text-indigo-400"></i></div>
        <h3 class="font-semibold text-lg mb-2">Tableau de bord intelligent</h3>
        <p class="text-gray-400 text-sm">Tableau logistique avec graphiques: commandes a preparer, a expedier, livrees et retours pour piloter l'operation au quotidien.</p>
      </div>
      <div class="card-glass rounded-xl p-6">
        <div class="icon-box bg-teal-500/15 mb-4"><i class="fas fa-coins text-teal-400"></i></div>
        <h3 class="font-semibold text-lg mb-2">Marge nette par produit</h3>
        <p class="text-gray-400 text-sm">Analysez la marge nette par produit (pas seulement le CA) pour savoir exactement ce qui est le plus rentable.</p>
      </div>
      <div class="card-glass rounded-xl p-6">
        <div class="icon-box bg-blue-500/15 mb-4"><i class="fas fa-shield-halved text-blue-400"></i></div>
        <h3 class="font-semibold text-lg mb-2">API & Webhook</h3>
        <p class="text-gray-400 text-sm">Connectez votre boutique Shopify, WooCommerce ou YouCan via notre API simple et puissante.</p>
      </div>
      <div class="card-glass rounded-xl p-6">
        <div class="icon-box bg-rose-500/15 mb-4"><i class="fas fa-boxes-stacked text-rose-400"></i></div>
        <h3 class="font-semibold text-lg mb-2">Gestion du stock</h3>
        <p class="text-gray-400 text-sm">Suivez votre stock par SKU et categorie. Alertes automatiques quand la disponibilite est basse.</p>
      </div>
    </div>
  </div>
</section>

<!-- PRICING -->
<section class="py-10">
  <div class="max-w-6xl mx-auto px-6">
    <div class="mb-8 text-center">
      <span class="text-indigo-400 text-xs uppercase tracking-widest">Plans</span>
      <h2 class="text-2xl md:text-3xl font-bold mt-2">Commencez gratuitement, passez en premium quand vous etes pret.</h2>
    </div>
    <div class="grid md:grid-cols-2 gap-5">
      <div class="card-glass rounded-xl p-6 border border-indigo-500/20">
        <div class="text-xs text-indigo-300 uppercase tracking-widest mb-2">Plan Gratuit</div>
        <h3 class="font-semibold text-xl mb-2">Ideal pour demarrer</h3>
        <p class="text-gray-400 text-sm mb-4">Fonctionnalites essentielles avec limites de volume pour tester votre flux logistique.</p>
        <ul class="text-sm text-gray-300 space-y-2">
          <li><i class="fas fa-check text-emerald-400 mr-2"></i>Gestion des commandes</li>
          <li><i class="fas fa-check text-emerald-400 mr-2"></i>Suivi de livraison de base</li>
          <li><i class="fas fa-check text-emerald-400 mr-2"></i>Quota mensuel limite</li>
        </ul>
      </div>
      <div class="card-glass rounded-xl p-6 border border-emerald-500/20">
        <div class="text-xs text-emerald-300 uppercase tracking-widest mb-2">Plan Premium</div>
        <h3 class="font-semibold text-xl mb-2">Pour accelerer la croissance</h3>
        <p class="text-gray-400 text-sm mb-4">Debloquez toutes les automatisations avec essai premium pour acquisition.</p>
        <ul class="text-sm text-gray-300 space-y-2">
          <li><i class="fas fa-check text-emerald-400 mr-2"></i>WhatsApp automatique + integrations avancees</li>
          <li><i class="fas fa-check text-emerald-400 mr-2"></i>Dashboard logistique avec graphiques</li>
          <li><i class="fas fa-check text-emerald-400 mr-2"></i>Analyse de marge nette par produit</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<!-- CTA -->
<section class="py-16">
  <div class="max-w-3xl mx-auto px-6">
    <div class="cta-gradient rounded-2xl p-10 text-center border border-white/5">
      <h2 class="text-2xl md:text-3xl font-bold mb-3">Pret a automatiser<br>votre logistique ?</h2>
      <p class="text-gray-400 text-sm mb-8">Rejoignez les e-commercants algeriens qui font confiance a AutoHub DZ</p>
      <a href="/register" class="inline-flex items-center gap-2 px-8 py-3 bg-indigo-600 text-white font-semibold rounded-full hover:bg-indigo-500 transition">
        <i class="fas fa-rocket"></i> Creer un compte gratuit
      </a>
    </div>
  </div>
</section>

<!-- FOOTER -->
<footer class="border-t border-white/5 py-8">
  <div class="max-w-6xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-4">
    <div class="flex items-center gap-2">
      <div class="w-6 h-6 bg-gradient-to-br from-indigo-500 to-indigo-700 rounded-md flex items-center justify-center">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="3" stroke-linejoin="round"/><circle cx="12" cy="12" r="2" fill="white"/></svg>
      </div>
      <span class="font-semibold text-sm">AutoHub DZ</span>
      <span class="text-gray-500 text-xs ml-2">Commencez. Automatisez. Livrez.</span>
    </div>
    <span class="text-gray-500 text-xs">&copy; 2026 AutoHub DZ - Tous droits reserves</span>
  </div>
</footer>
</body>
</html>`
}

// ========================
// APP PAGE (SPA) - Enhanced with verification, boutique sources, and refined branding
// ========================
function appPage(): string {
  return String.raw`<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AutoHub DZ - Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
<script>
tailwind.config={theme:{extend:{fontFamily:{sans:['Inter','sans-serif']},colors:{dark:{900:'#080c1a',800:'#0B1120',700:'#151D30',600:'#1F2B40'},accent:{primary:'#6366f1',secondary:'#818cf8',blue:'#3b82f6'}}}}}
</script>
<style>
body{font-family:'Inter',sans-serif;background:#080c1a;color:#fff;margin:0}
.sidebar{width:250px;background:#0B1120;border-right:1px solid rgba(255,255,255,0.05);min-height:100vh;position:fixed;left:0;top:0;z-index:40;display:flex;flex-direction:column}
.main-content{margin-left:250px;padding:24px;min-height:100vh}
.nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;border-radius:8px;margin:2px 12px;font-size:14px;cursor:pointer;transition:all 0.2s;color:#94A3B8}
.nav-item:hover,.nav-item.active{background:rgba(99,102,241,0.1);color:#818cf8}
.card{background:rgba(21,29,48,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;backdrop-filter:blur(12px)}
.stat-card{background:linear-gradient(135deg,rgba(21,29,48,0.8),rgba(31,43,64,0.4));border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:20px}
.btn{padding:8px 16px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.2s;border:none}
.btn-primary{background:#6366f1;color:#fff}.btn-primary:hover{background:#818cf8}
.btn-danger{background:rgba(239,68,68,0.15);color:#EF4444;border:1px solid rgba(239,68,68,0.2)}.btn-danger:hover{background:rgba(239,68,68,0.25)}
.btn-success{background:rgba(34,197,94,0.12);color:#22c55e;border:1px solid rgba(34,197,94,0.2)}.btn-success:hover{background:rgba(34,197,94,0.2)}
.btn-outline{background:transparent;color:#94A3B8;border:1px solid rgba(255,255,255,0.1)}.btn-outline:hover{border-color:#6366f1;color:#818cf8}
.btn-warning{background:rgba(245,158,11,0.15);color:#F59E0B;border:1px solid rgba(245,158,11,0.2)}.btn-warning:hover{background:rgba(245,158,11,0.25)}
.btn-whatsapp{background:rgba(37,211,102,0.15);color:#25d366;border:1px solid rgba(37,211,102,0.3)}.btn-whatsapp:hover{background:rgba(37,211,102,0.3)}
input,select,textarea{background:rgba(17,24,39,0.8);border:1px solid rgba(255,255,255,0.1);color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;width:100%}
input:focus,select:focus,textarea:focus{outline:none;border-color:#6366f1}
select option{background:#111827;color:#fff}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:10px 12px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;color:#64748B;border-bottom:1px solid rgba(255,255,255,0.06);white-space:nowrap}
td{padding:10px 12px;font-size:13px;border-bottom:1px solid rgba(255,255,255,0.03)}
tr:hover{background:rgba(22,163,74,0.03)}
.toggle-switch { position:relative; width:44px; height:24px; display:inline-block; }
.toggle-switch input { opacity:0; width:0; height:0; }
.toggle-switch .slider { position:absolute; cursor:pointer; inset:0; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.15); transition:0.3s; border-radius:24px; }
.toggle-switch .slider:before { content:''; position:absolute; height:18px; width:18px; left:2px; bottom:2px; background:#64748b; transition:0.3s; border-radius:50%; }
.toggle-switch input:checked + .slider { background:rgba(99,102,241,0.3); border-color:rgba(99,102,241,0.5); }
.toggle-switch input:checked + .slider:before { transform:translateX(20px); background:#818cf8; }
.permission-row { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-radius:10px; background:rgba(15,23,42,0.4); border:1px solid rgba(255,255,255,0.05); margin-bottom:8px; transition:all 0.2s; }
.permission-row:hover { background:rgba(15,23,42,0.6); border-color:rgba(99,102,241,0.15); }
.badge-status{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;display:inline-block;white-space:nowrap}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:100;display:flex;align-items:center;justify-content:center}
.modal{background:#111827;border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:24px;max-width:600px;width:90%;max-height:90vh;overflow-y:auto}
.toast{position:fixed;top:20px;right:20px;z-index:200;padding:12px 20px;border-radius:10px;font-size:13px;animation:slideIn 0.3s}
@keyframes slideIn{from{transform:translateX(100%);opacity:0}to{transform:translateX(0);opacity:1}}
.user-badge{background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);border-radius:8px;padding:8px 12px;display:flex;align-items:center;gap:8px}
.loading-overlay{position:fixed;inset:0;background:rgba(8,12,26,0.9);z-index:1000;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:16px}
.spinner-lg{border:3px solid rgba(99,102,241,0.2);border-top:3px solid #6366f1;border-radius:50%;width:40px;height:40px;animation:spin 0.8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
/* Verification badges */
.verify-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:700}
.verify-delivered{background:rgba(34,197,94,0.15);color:#4ade80;border:1px solid rgba(34,197,94,0.3)}
.verify-returned{background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3)}
/* Platform badges */
.platform-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600}
.platform-shopify{background:rgba(150,191,72,0.12);color:#96bf48;border:1px solid rgba(150,191,72,0.3)}
.platform-woocommerce{background:rgba(150,100,200,0.12);color:#9b5c8f;border:1px solid rgba(150,100,200,0.3)}
.platform-youcan{background:rgba(59,130,246,0.12);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)}
/* Logo SVG styles */
.logo-hub{display:inline-flex;align-items:center;gap:8px}
.logo-icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#6366f1,#818cf8);box-shadow:0 4px 12px rgba(99,102,241,0.3)}
@media(max-width:768px){.sidebar{transform:translateX(-100%);transition:0.3s}.sidebar.open{transform:translateX(0)}.main-content{margin-left:0}}

/* ========== MODAL REFONTE V2 ========== */
@keyframes modalOverlayIn { from{opacity:0} to{opacity:1} }
@keyframes modalSlideUp { from{opacity:0;transform:translateY(40px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
@keyframes modalSlideOut { from{opacity:1;transform:translateY(0) scale(1)} to{opacity:0;transform:translateY(20px) scale(0.97)} }
@keyframes shimmer { 0%{background-position:-200% 0} 100%{background-position:200% 0} }
@keyframes fieldFadeIn { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
@keyframes pulseGlow { 0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,0.3)} 50%{box-shadow:0 0 20px 4px rgba(99,102,241,0.15)} }
@keyframes checkPop { 0%{transform:scale(0)} 50%{transform:scale(1.2)} 100%{transform:scale(1)} }

.modal-overlay-v2 {
  position:fixed;inset:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(8px);z-index:100;
  display:flex;align-items:center;justify-content:center;padding:20px;
  animation:modalOverlayIn 0.3s ease-out;
}
.modal-v2 {
  background:linear-gradient(145deg,#111827 0%,#0f172a 100%);
  border:1px solid rgba(99,102,241,0.15);
  border-radius:20px;padding:0;max-width:680px;width:100%;max-height:90vh;overflow:hidden;
  box-shadow:0 25px 80px rgba(0,0,0,0.5),0 0 40px rgba(99,102,241,0.08);
  animation:modalSlideUp 0.4s cubic-bezier(0.16,1,0.3,1);
}
.modal-v2.closing { animation:modalSlideOut 0.25s ease-in forwards; }
.modal-v2-header {
  padding:24px 28px 16px;display:flex;align-items:center;justify-content:space-between;
  border-bottom:1px solid rgba(255,255,255,0.05);
  background:linear-gradient(135deg,rgba(99,102,241,0.08),rgba(139,92,246,0.05));
}
.modal-v2-header h2 {
  font-size:18px;font-weight:700;color:#fff;display:flex;align-items:center;gap:10px;
}
.modal-v2-header .header-icon {
  width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#6366f1,#8b5cf6);font-size:16px;color:#fff;
  animation:pulseGlow 3s ease-in-out infinite;
}
.modal-v2-close {
  width:32px;height:32px;border-radius:8px;border:1px solid rgba(255,255,255,0.08);
  background:rgba(255,255,255,0.03);color:#64748b;font-size:14px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;transition:all 0.25s;
}
.modal-v2-close:hover { background:rgba(239,68,68,0.15);color:#f87171;border-color:rgba(239,68,68,0.3);transform:rotate(90deg); }
.modal-v2-body { padding:20px 28px 28px;overflow-y:auto;max-height:calc(90vh - 140px); }
.modal-v2-section {
  margin-bottom:20px;padding-bottom:16px;border-bottom:1px solid rgba(255,255,255,0.04);
}
.modal-v2-section:last-child { border-bottom:none;margin-bottom:0; }
.modal-v2-section-title {
  font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;
  color:#6366f1;margin-bottom:14px;display:flex;align-items:center;gap:8px;
}
.modal-v2-section-title i { font-size:12px;opacity:0.7; }
.form-grid { display:grid;grid-template-columns:1fr 1fr;gap:14px; }
.form-grid .full-width { grid-column:1/-1; }

/* Floating label input */
.float-field {
  position:relative;border-radius:12px;
  background:rgba(15,23,42,0.6);border:1.5px solid rgba(255,255,255,0.08);
  transition:all 0.3s cubic-bezier(0.4,0,0.2,1);overflow:hidden;
}
.float-field::before {
  content:'';position:absolute;bottom:0;left:50%;width:0;height:2px;
  background:linear-gradient(90deg,#6366f1,#8b5cf6);transition:all 0.4s cubic-bezier(0.4,0,0.2,1);
  transform:translateX(-50%);border-radius:2px;
}
.float-field:focus-within { border-color:rgba(99,102,241,0.4);background:rgba(15,23,42,0.9);box-shadow:0 4px 20px rgba(99,102,241,0.08); }
.float-field:focus-within::before { width:100%; }
.float-field .field-icon {
  position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:14px;
  color:#475569;transition:color 0.3s;pointer-events:none;z-index:2;
}
.float-field:focus-within .field-icon { color:#818cf8; }
.float-field input, .float-field select, .float-field textarea {
  width:100%;padding:18px 14px 8px 40px;background:transparent !important;
  border:none !important;color:#e2e8f0;font-size:13.5px;outline:none !important;
  box-shadow:none !important;font-family:'Inter',sans-serif;
}
.float-field select { padding-right:32px;cursor:pointer;appearance:none;-webkit-appearance:none; }
.float-field select option { background:#1e293b;color:#e2e8f0;padding:8px; }
.float-field textarea { min-height:50px;resize:vertical; }
.float-field label {
  position:absolute;left:40px;top:50%;transform:translateY(-50%);
  font-size:13px;color:#64748b;pointer-events:none;
  transition:all 0.25s cubic-bezier(0.4,0,0.2,1);
}
.float-field textarea ~ label { top:24px; }
.float-field input:focus ~ label, .float-field input:not(:placeholder-shown) ~ label,
.float-field select:focus ~ label, .float-field select:valid ~ label,
.float-field textarea:focus ~ label, .float-field textarea:not(:placeholder-shown) ~ label {
  top:8px;font-size:10px;color:#818cf8;font-weight:600;letter-spacing:0.3px;
  transform:translateY(0);
}
.float-field .select-arrow {
  position:absolute;right:12px;top:50%;transform:translateY(-50%);
  color:#475569;font-size:10px;pointer-events:none;transition:all 0.3s;
}
.float-field:focus-within .select-arrow { color:#818cf8;transform:translateY(-50%) rotate(180deg); }

/* Animated field entrance */
.form-grid .float-field { animation:fieldFadeIn 0.35s ease-out backwards; }
.form-grid .float-field:nth-child(1) { animation-delay:0.05s; }
.form-grid .float-field:nth-child(2) { animation-delay:0.1s; }
.form-grid .float-field:nth-child(3) { animation-delay:0.15s; }
.form-grid .float-field:nth-child(4) { animation-delay:0.2s; }
.form-grid .float-field:nth-child(5) { animation-delay:0.25s; }
.form-grid .float-field:nth-child(6) { animation-delay:0.3s; }

/* Buttons V2 */
.modal-v2-footer {
  display:flex;justify-content:flex-end;gap:10px;padding-top:20px;
  border-top:1px solid rgba(255,255,255,0.05);margin-top:8px;
}
.btn-v2-cancel {
  padding:10px 22px;border-radius:10px;font-size:13px;font-weight:500;
  background:rgba(255,255,255,0.04);color:#94a3b8;border:1px solid rgba(255,255,255,0.08);
  cursor:pointer;transition:all 0.25s;
}
.btn-v2-cancel:hover { background:rgba(255,255,255,0.08);color:#e2e8f0;transform:translateY(-1px); }
.btn-v2-submit {
  padding:10px 28px;border-radius:10px;font-size:13px;font-weight:600;
  background:linear-gradient(135deg,#6366f1,#7c3aed);color:#fff;border:none;
  cursor:pointer;transition:all 0.3s;display:flex;align-items:center;gap:8px;
  box-shadow:0 4px 15px rgba(99,102,241,0.25);position:relative;overflow:hidden;
}
.btn-v2-submit::before {
  content:'';position:absolute;top:0;left:-100%;width:100%;height:100%;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,0.15),transparent);
  transition:left 0.5s;
}
.btn-v2-submit:hover { transform:translateY(-2px);box-shadow:0 8px 25px rgba(99,102,241,0.35); }
.btn-v2-submit:hover::before { left:100%; }
.btn-v2-submit:active { transform:translateY(0); }
.btn-v2-submit:disabled { opacity:0.6;cursor:not-allowed;transform:none; }
.btn-v2-submit .spinner-sm {
  width:16px;height:16px;border:2px solid rgba(255,255,255,0.3);
  border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite;
}

/* Scrollbar inside modal */
.modal-v2-body::-webkit-scrollbar { width:5px; }
.modal-v2-body::-webkit-scrollbar-track { background:transparent; }
.modal-v2-body::-webkit-scrollbar-thumb { background:rgba(99,102,241,0.2);border-radius:10px; }
.modal-v2-body::-webkit-scrollbar-thumb:hover { background:rgba(99,102,241,0.4); }

.toggle-switch { position:relative; width:44px; height:24px; }
.toggle-switch input { opacity:0; width:0; height:0; }
.toggle-switch .slider { position:absolute; cursor:pointer; inset:0; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.15); transition:0.3s; border-radius:24px; }
.toggle-switch .slider:before { content:''; position:absolute; height:18px; width:18px; left:2px; bottom:2px; background:#64748b; transition:0.3s; border-radius:50%; }
.toggle-switch input:checked + .slider { background:rgba(99,102,241,0.3); border-color:rgba(99,102,241,0.5); }
.toggle-switch input:checked + .slider:before { transform:translateX(20px); background:#818cf8; }
.permission-row { display:flex; align-items:center; justify-content:space-between; padding:12px 16px; border-radius:10px; background:rgba(15,23,42,0.4); border:1px solid rgba(255,255,255,0.05); margin-bottom:8px; transition:all 0.2s; }
.permission-row:hover { background:rgba(15,23,42,0.6); border-color:rgba(99,102,241,0.15); }

</style>
</head>
<body>

<!-- LOADING -->
<div class="loading-overlay" id="loading-screen">
  <div class="spinner-lg"></div>
  <p class="text-gray-400 text-sm">Chargement...</p>
</div>

<!-- SIDEBAR -->
<aside class="sidebar" id="sidebar">
  <div class="p-5 border-b border-white/5">
    <div class="logo-hub">
      <div class="logo-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="2" stroke-linejoin="round"/>
          <circle cx="12" cy="12" r="3" fill="white"/>
          <line x1="12" y1="2" x2="12" y2="9" stroke="white" stroke-width="1.5"/>
          <line x1="12" y1="15" x2="12" y2="22" stroke="white" stroke-width="1.5"/>
          <line x1="3" y1="7" x2="9" y2="10" stroke="white" stroke-width="1.5"/>
          <line x1="15" y1="14" x2="21" y2="17" stroke="white" stroke-width="1.5"/>
          <line x1="21" y1="7" x2="15" y2="10" stroke="white" stroke-width="1.5"/>
          <line x1="9" y1="14" x2="3" y2="17" stroke="white" stroke-width="1.5"/>
        </svg>
      </div>
      <div>
        <span class="font-bold text-base">Auto<span class="text-indigo-400">Hub</span> DZ</span>
        <div class="text-[10px] text-gray-500 flex items-center gap-1">
          <span class="inline-block w-1.5 h-1.5 bg-indigo-500 rounded-full"></span> En ligne
        </div>
      </div>
    </div>
  </div>
  <nav class="py-4 flex-1">
    <div id="nav-item-dashboard" class="nav-item active" onclick="navigateTo('dashboard')"><i class="fas fa-chart-pie w-5"></i> Tableau de bord</div>
    <div id="nav-item-commandes" class="nav-item" onclick="navigateTo('commandes')"><i class="fas fa-clipboard-list w-5"></i> Commandes</div>
    <div id="nav-item-suivi" class="nav-item" onclick="navigateTo('suivi')"><i class="fas fa-truck w-5"></i> Suivi</div>
    <div id="nav-item-stock" class="nav-item" onclick="navigateTo('stock')"><i class="fas fa-boxes-stacked w-5"></i> Stock</div>
    <div id="nav-item-wilayaspage" class="nav-item" onclick="navigateTo('wilayaspage')"><i class="fas fa-map-marked-alt w-5"></i> Wilayas & Communes</div>
    <div id="nav-item-boutique" class="nav-item" onclick="navigateTo('boutique')"><i class="fas fa-store w-5"></i> Boutique</div>
    <div id="nav-item-integration" class="nav-item" onclick="navigateTo('integration')"><i class="fas fa-plug-circle-bolt w-5"></i> Integration API</div>
    <div id="nav-item-historique" class="nav-item" onclick="navigateTo('historique')"><i class="fas fa-clock-rotate-left w-5"></i> Historique</div>
    <div id="nav-item-equipe" class="nav-item" onclick="navigateTo('equipe')"><i class="fas fa-user-shield w-5"></i> Equipe</div>
    <div id="nav-item-utilisateurs" class="nav-item hidden" onclick="navigateTo('utilisateurs')"><i class="fas fa-users-cog w-5"></i> Utilisateurs</div>
    <div id="nav-item-pricing" class="nav-item" onclick="navigateTo('pricing')"><i class="fas fa-tags w-5"></i> Tarification</div>
    <div id="nav-item-guide" class="nav-item" onclick="navigateTo('guide')"><i class="fas fa-book-open w-5"></i> Guide</div>
    <div class="px-4 mt-3 mb-2">
      <div class="user-badge">
        <i class="fas fa-user-circle text-indigo-400 text-lg"></i>
        <div>
          <div class="text-xs font-medium" id="sidebar-user">Admin</div>
          <div class="text-[10px] text-gray-500" id="sidebar-store"></div>
        </div>
      </div>
    </div>
    <button onclick="logout()" class="nav-item text-red-400 w-full hover:bg-red-500/10 mt-3">
      <i class="fas fa-sign-out-alt w-5"></i> Deconnexion
    </button>
  </nav>
  <div class="p-4 border-t border-white/5" style="padding-bottom:18px">
  </div>
</aside>

<!-- MOBILE HEADER -->
<div class="md:hidden fixed top-0 w-full bg-dark-900/90 backdrop-blur z-30 flex items-center justify-between px-4 h-14 border-b border-white/5">
  <button onclick="document.getElementById('sidebar').classList.toggle('open')" class="text-gray-400"><i class="fas fa-bars text-xl"></i></button>
  <div class="logo-hub">
    <div class="logo-icon" style="width:28px;height:28px">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="2.5" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.5" fill="white"/></svg>
    </div>
    <span class="font-bold text-sm">Auto<span class="text-indigo-400">Hub</span> DZ</span>
  </div>
  <button onclick="logout()" class="text-red-400"><i class="fas fa-sign-out-alt"></i></button>
</div>

<!-- MAIN CONTENT -->
<main class="main-content md:pt-0 pt-16" id="main-content">
  <div id="view-dashboard"></div>
  <div id="view-commandes" class="hidden"></div>
  <div id="view-suivi" class="hidden"></div>
  <div id="view-stock" class="hidden"></div>
  <div id="view-wilayaspage" class="hidden"></div>
  <div id="view-boutique" class="hidden"></div>
  <div id="view-integration" class="hidden"></div>
  <div id="view-historique" class="hidden"></div>
  <div id="view-equipe" class="hidden"></div>
  <div id="view-utilisateurs" class="hidden"></div>
  <div id="view-pricing" class="hidden"></div>
  <div id="view-guide" class="hidden"></div>
</main>

<script>
// ===================== STATE =====================
let state = { wilayas:[], currentView:'dashboard', commandes:[], suivi:[], stock:[], stats:{}, config:[], historique:[], equipe:[], user:null, transporteurs:[], storeSources:[], phoneCache:{}, deliveryCompanies:[], wilayasFull:null, subscription: 'starter', adminUsers:[], adminFilters:{ commandesUserId:'', suiviUserId:'' }, equipeAccess:{ role:'', permissions:[], allowedViews:['dashboard'] }, stockAudit:null, paymentRequests: [] }
let selectedCommandeIds = []
let trialCountdownTimer = null
let suiviAutoRefreshTimer = null
let suiviRefreshInFlight = false
const SUIVI_AUTO_REFRESH_MS = 60000
let suiviLastSyncAt = null
let autoWhatsAppEnabled = localStorage.getItem('auto_whatsapp_confirm') === '1'
const api = axios.create({ baseURL: '/api' })
const platformIcons = { shopify:'fab fa-shopify', woocommerce:'fab fa-wordpress', youcan:'fas fa-shopping-bag' }
const platformColors = { shopify:'platform-shopify', woocommerce:'platform-woocommerce', youcan:'platform-youcan' }

function normalizeStatus(status) {
  const raw = String(status || '')
  // First try standard NFD normalization (works for proper UTF-8)
  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9\s]/g, '').trim().toLowerCase()
  return normalized
}

// More robust check specifically for "confirmed" status detection
// Handles Mojibake-corrupted strings from the database
function isConfirmedFrontend(status) {
  const s = String(status || '')
  // Standard normalized check
  if (normalizeStatus(s).includes('confirme')) return true
  // Direct lowercase check (catches Mojibake where 'Confirm' survives corruption)
  const lower = s.toLowerCase()
  if (lower.includes('confirmee') || lower.includes('confirmée') || lower.includes('confirme') || lower.includes('confirm')) return true
  // Check for the ✅ emoji (U+2705) which marks confirmed status
  if (s.includes('\u2705')) return true
  return false
}

function computeEmployeAllowedViews(teamRole, permissions) {
  const p = new Set((permissions || []).map(x => String(x).toLowerCase()))
  const views = new Set(['dashboard', 'guide'])
  if (p.has('confirmation')) views.add('commandes')
  if (p.has('suivi')) views.add('suivi')
  if (p.has('stock')) views.add('stock')
  return Array.from(views)
}

function applyNavigationVisibility() {
  if (state.user?.role !== 'employe') return
  const allowed = new Set(state.equipeAccess.allowedViews || ['dashboard'])
  const all = ['dashboard','commandes','suivi','stock','wilayaspage','boutique','integration','historique','equipe','utilisateurs','pricing','guide']
  all.forEach(v => {
    const nav = document.getElementById('nav-item-' + v)
    const view = document.getElementById('view-' + v)
    const can = allowed.has(v)
    if (nav) nav.classList.toggle('hidden', !can)
    if (view && !can) view.classList.add('hidden')
  })
}

api.interceptors.response.use(r => r, err => {
  if(err.response?.status === 401 && err.response?.data?.code === 'AUTH_REQUIRED') {
    window.location.href = '/login'
  }
  if(err.response?.status === 403 && err.response?.data?.code === 'FORBIDDEN') {
    toast(err.response?.data?.error || 'AccÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨s refusÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', 'error')
  }
  return Promise.reject(err)
})

// ===================== AUTH CHECK =====================
async function checkAuth() {
  try {
    const { data } = await api.get('/auth/check')
    if(!data.authenticated) { window.location.href = '/login'; return false }
    state.user = data.user
    state.subscription = data.user.subscription || 'starter'
    document.getElementById('sidebar-user').textContent = data.user.prenom || data.user.nom || data.user.username
    document.getElementById('sidebar-store').textContent = data.user.store_name || 'Connecte'
    
    // Role visibility
    const navAdmin = document.getElementById('nav-item-utilisateurs')
    const navBoutique = document.getElementById('nav-item-boutique')
    const navInteg = document.getElementById('nav-item-integration')
    const navHistorique = document.getElementById('nav-item-historique')
    
    if (data.user.role === 'admin') {
      navAdmin?.classList.remove('hidden')
      navBoutique?.classList.remove('hidden')
      navInteg?.classList.remove('hidden')
      navHistorique?.classList.remove('hidden')
    } else if (data.user.role === 'employe') {
      navAdmin?.classList.add('hidden')
      navBoutique?.classList.add('hidden')
      navInteg?.classList.add('hidden')
      navHistorique?.classList.add('hidden')
      try {
        const { data: access } = await api.get('/team-members/me')
        if (!access.allowed) {
          toast('Acces plateforme refuse pour ce membre', 'error')
          await logout()
          return false
        }
        state.equipeAccess.role = access.role || ''
        state.equipeAccess.permissions = access.permissions || []
        state.equipeAccess.allowedViews = computeEmployeAllowedViews(state.equipeAccess.role, state.equipeAccess.permissions)
        applyNavigationVisibility()
      } catch (e) {
        toast('Verification des permissions impossible', 'error')
        await logout()
        return false
      }
    } else {
      navAdmin?.classList.add('hidden')
      navHistorique?.classList.add('hidden')
    }
    // Masquer tout de suite : avant, on attendait /transporteurs, ce qui pouvait laisser
    // l'overlay plein ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©cran actif (ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©cran "ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©teint ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  moitiÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©", aucun clic).
    document.getElementById('loading-screen').style.display = 'none'
    closeModal()
    try {
      const t = await api.get('/transporteurs')
      state.transporteurs = t.data
    } catch {
      state.transporteurs = []
    }
    return true
  } catch(e) { window.location.href = '/login'; return false }
}

async function logout() {
  try { await api.post('/auth/logout') } catch(e) {}
  window.location.href = '/login'
}

// ===================== TOAST =====================
function toast(msg, type='success') {
  const d = document.createElement('div')
  d.className = 'toast ' + (type==='error'?'bg-red-500/90 text-white':'bg-indigo-600/90 text-white')
  d.innerHTML = '<i class="fas fa-'+(type==='error'?'exclamation-circle':'check-circle')+' mr-2"></i>'+msg
  document.getElementById('toasts').appendChild(d)
  setTimeout(()=>d.remove(), 3000)
}

// ===================== NAVIGATION =====================
function navigateTo(view) {
  if (view === 'historique' && state.user?.role !== 'admin') {
    toast('AccÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©s rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©servÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© aux administrateurs', 'error')
    return
  }
  if (state.user?.role === 'employe') {
    const allowed = new Set(state.equipeAccess.allowedViews || ['dashboard'])
    if (!allowed.has(view)) {
      toast('Acces non autorise pour votre role', 'error')
      return
    }
  }
  if (view === 'utilisateurs' && state.user?.role !== 'admin') {
    toast('AccÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©s rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©servÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© aux administrateurs', 'error')
    return
  }
  if (state.user?.role === 'employe' && (view === 'boutique' || view === 'integration')) {
    toast('AccÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©s non autorisÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© pour le rÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´le employÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©', 'error')
    return
  }
  if (view !== 'suivi' && suiviAutoRefreshTimer) {
    clearInterval(suiviAutoRefreshTimer)
    suiviAutoRefreshTimer = null
  }
  const views = ['dashboard','commandes','suivi','stock','wilayaspage','boutique','integration','historique','equipe','utilisateurs','pricing','guide']
  views.forEach(v => {
    const el = document.getElementById('view-'+v)
    if (el) el.classList.toggle('hidden', v !== view)
  })
  document.querySelectorAll('.sidebar nav .nav-item').forEach((el,i) => {
    // If Admin tab is hidden, we need to adjust the index or matches
    const viewNameAtIdx = el.getAttribute('onclick')?.match(/'([^']+)'/)?.[1]
    el.classList.toggle('active', viewNameAtIdx === view)
  })
  state.currentView = view
  try { localStorage.setItem('autohub_last_view', view) } catch (e) {}
  if (view==='dashboard') loadDashboard()
  else if (view==='commandes') loadCommandes()
  else if (view==='suivi') loadSuivi()
  else if (view==='stock') loadStock()
  else if (view==='wilayaspage') loadWilayasPage()
  else if (view==='boutique') loadSources()
  else if (view==='integration') loadConfig()
  else if (view==='historique') loadHistorique()
  else if (view==='equipe') loadEquipe()
  else if (view==='utilisateurs') loadUtilisateurs()
  else if (view==='pricing') loadPricing()
  else if (view==='guide') loadGuide()
  document.getElementById('sidebar').classList.remove('open')
}

// ===================== STATUS COLORS =====================
// ===================== CONSTANTS =====================
const livraisons = ['A domicile', 'Stop Desk']
const statuts = [
  '🆕 Nouvelle', '✅ Confirmée', '📵 Pas de réponse', '🚫 Numéro erroné', '👯 Doublon',
  '📦 Prêt à expédier', '🚚 Ramassé', '🚢 En cours de transit', '🚴 En cours de livraison',
  '💰 Livré & Encaissé', '🔄 Retour Expéditeur', 'Annule', 'Reporte'
]

// ===================== STATUS COLORS =====================
function statusBadge(s) {
  const colors = {
    'NOUVELLE':'bg-indigo-500/20 text-indigo-300',
    'CONFIRME':'bg-blue-500/20 text-blue-400',
    'LIVRE':'bg-green-600/20 text-green-300',
    'RETOUR':'bg-red-600/20 text-red-300',
    'RAMASSE':'bg-orange-500/20 text-orange-300',
    'TRANSIT':'bg-purple-500/20 text-purple-300',
    'LIVRAISON':'bg-cyan-500/20 text-cyan-300',
    'EXPEDIE':'bg-green-500/20 text-green-400',
    'PAS DE REPONSE':'bg-yellow-500/20 text-yellow-400',
    'ERREUR':'bg-rose-500/20 text-rose-400',
    'DOUBLON':'bg-purple-500/20 text-purple-400',
    'ATTENTE':'bg-gray-500/20 text-gray-300'
  }
  const sUp = (s||'').toUpperCase()
  const c = Object.entries(colors).find(([k]) => sUp.includes(k))
  return '<span class="badge-status '+(c?c[1]:'bg-gray-500/20 text-gray-300')+'">'+(s||'--')+'</span>'
}

// ===================== SEARCHABLE DROPDOWN UTILITY =====================
function initSearchableDropdown(selectId, options, placeholder, onSelect) {
  const container = document.getElementById(selectId).parentElement
  const originalSelect = document.getElementById(selectId)
  originalSelect.classList.add('hidden')
  
  const wrapper = document.createElement('div')
  wrapper.className = 'relative searchable-dropdown'
  
  let initialText = originalSelect.value || ''
  if (originalSelect.selectedIndex >= 0) {
    initialText = originalSelect.options[originalSelect.selectedIndex].text
    if (initialText.startsWith('--')) initialText = ''
  }

  // Build items HTML using map and join with single quotes to avoid backtick nesting
  const itemsHtml = options.map(opt => {
    const val = typeof opt === 'object' ? opt.value : opt
    const text = typeof opt === 'object' ? opt.text : opt
    return '<div class="dropdown-item p-2 text-sm hover:bg-indigo-500/20 cursor-pointer transition" data-value="' + val + '">' + text + '</div>'
  }).join('')

  wrapper.innerHTML = '<div class="relative">' +
    '<input type="text" class="dropdown-input" placeholder="' + placeholder + '" value="' + initialText + '" autocomplete="off">' +
    '<i class="fas fa-chevron-down absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-[10px] pointer-events-none"></i>' +
    '</div>' +
    '<div class="dropdown-list hidden absolute left-0 right-0 mt-1 max-h-48 overflow-y-auto z-[110] bg-dark-800 border border-white/10 rounded-lg shadow-xl">' +
    itemsHtml +
    '</div>'
    
  container.appendChild(wrapper)
  
  const input = wrapper.querySelector('.dropdown-input')
  const list = wrapper.querySelector('.dropdown-list')
  const items = wrapper.querySelectorAll('.dropdown-item')
  
  const showList = () => list.classList.remove('hidden')
  const hideList = () => setTimeout(() => list.classList.add('hidden'), 200)
  
  input.addEventListener('focus', showList)
  input.addEventListener('blur', hideList)
  
  input.addEventListener('input', (e) => {
    const val = e.target.value.toLowerCase()
    items.forEach(item => {
      const txt = item.textContent.toLowerCase()
      item.style.display = txt.includes(val) ? 'block' : 'none'
    })
    showList()
  })
  
  items.forEach(item => {
    item.addEventListener('click', () => {
      const val = item.getAttribute('data-value')
      input.value = item.textContent
      originalSelect.value = val
      originalSelect.dispatchEvent(new Event('change'))
      if (onSelect) onSelect(val)
      hideList()
    })
  })
  
  // Keyboard navigation
  let focusedIndex = -1
  input.addEventListener('keydown', (e) => {
    const visibleItems = Array.from(items).filter(i => i.style.display !== 'none')
    if (e.key === 'ArrowDown') {
      e.preventDefault(); showList()
      focusedIndex = (focusedIndex + 1) % visibleItems.length
      visibleItems.forEach((i, idx) => i.classList.toggle('bg-indigo-500/20', idx === focusedIndex))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      focusedIndex = (focusedIndex - 1 + visibleItems.length) % visibleItems.length
      visibleItems.forEach((i, idx) => i.classList.toggle('bg-indigo-500/20', idx === focusedIndex))
    } else if (e.key === 'Enter' && focusedIndex > -1) {
      e.preventDefault()
      visibleItems[focusedIndex].click()
    }
  })
}

// ===================== PHONE VERIFICATION BADGE =====================
function verifyBadge(tel) {
  const cleanTel = (tel||'').replace(/[\\s\\-\\.\\']/g, '')
  const v = state.phoneCache[cleanTel] || { delivered: 0, returned: 0 }
  return '<div class="flex items-center gap-1.5">' +
    '<span class="verify-badge verify-delivered"><i class="fas fa-thumbs-up" style="font-size:10px"></i> ' + v.delivered + '</span>' +
    '<span class="verify-badge verify-returned"><i class="fas fa-thumbs-down" style="font-size:10px"></i> ' + v.returned + '</span>' +
    '</div>'
}

// ===================== API INTEGRATION BADGE =====================
function getApiIntegrationBadge(c) {
  const t = (c.transporteur || '').toLowerCase()
  // Check if any transporteur has API config
  const hasApi = t.includes('yalidine') || t.includes('zr') || t.includes('ecotrack') || t.includes('dhd') || t.includes('noest')
  if (hasApi && isConfirmedFrontend(c.statut)) {
    return '<span class="badge-status bg-emerald-500/20 text-emerald-300" style="font-size:10px"><i class="fas fa-link" style="font-size:9px;margin-right:3px"></i>API Prete</span>'
  } else if (hasApi && c.tracking) {
    return '<span class="badge-status bg-blue-500/20 text-blue-300" style="font-size:10px"><i class="fas fa-check-circle" style="font-size:9px;margin-right:3px"></i>API Envoyee</span>'
  } else if (hasApi) {
    return '<span class="badge-status bg-indigo-500/20 text-indigo-300" style="font-size:10px"><i class="fas fa-plug" style="font-size:9px;margin-right:3px"></i>API Active</span>'
  }
  return '<span class="badge-status bg-gray-500/20 text-gray-500" style="font-size:10px"><i class="fas fa-unlink" style="font-size:9px;margin-right:3px"></i>Manuel</span>'
}

// ===================== WHATSAPP SEND =====================
function sendWhatsApp(id) {
  const cmd = state.commandes.find(c => c.id === id)
  if (!cmd) return
  sendWhatsAppMessage(cmd)
}

function sendWhatsAppMessage(cmd) {
  let phone = (cmd.telephone || '').replace(/[\\s\\-\\.\\']/g, '')
  // Normalize Algerian phone
  if (phone.startsWith('0')) phone = '213' + phone.substring(1)
  else if (phone.startsWith('+213')) phone = phone.substring(1)
  else if (!phone.startsWith('213')) phone = '213' + phone
  const msg = encodeURIComponent(
    'Bonjour ' + cmd.nom + ',\\n\\n' +
    'Votre commande est prete :\\n' +
    'Produit : ' + cmd.produit + '\\n' +
    'Prix : ' + Number(cmd.prix).toLocaleString() + ' DA\\n' +
    'Livraison : ' + (cmd.livraison || 'A domicile') + '\\n' +
    'Wilaya : ' + cmd.wilaya + '\\n' +
    'Commune : ' + cmd.commune + '\\n\\n' +
    (cmd.tracking ? 'Tracking : ' + cmd.tracking + '\\n\\n' : '') +
    'Merci pour votre confiance !\\n' +
    'AutoHub DZ'
  )
  window.open('https://wa.me/' + phone + '?text=' + msg, '_blank')
}

function toggleAutoWhatsApp() {
  if (state.subscription === 'starter') {
    toast("L'automatisation WhatsApp est reservee aux plans PRO et Business. Veuillez mettre a jour votre abonnement.", 'error')
    navigateTo('pricing')
    return
  }
  autoWhatsAppEnabled = !autoWhatsAppEnabled
  localStorage.setItem('auto_whatsapp_confirm', autoWhatsAppEnabled ? '1' : '0')
  toast('Confirmation WhatsApp automatique: ' + (autoWhatsAppEnabled ? 'activee' : 'desactivee'))
  loadCommandes()
}

// Load phone verification data in batch
async function loadPhoneVerification(phones) {
  const uniquePhones = [...new Set(phones.map(p => (p||'').replace(/[\\s\\-\\.\\']/g, '')).filter(Boolean))]
  if (uniquePhones.length === 0) return
  try {
    const { data } = await api.get('/phone-verify-batch?phones=' + uniquePhones.join(','))
    Object.assign(state.phoneCache, data)
    uniquePhones.forEach(p => { if (!state.phoneCache[p]) state.phoneCache[p] = { delivered: 0, returned: 0 } })
  } catch(e) { console.error('Phone verify error', e) }
}

async function ensureAdminUsersLoaded() {
  if (state.user?.role !== 'admin') return
  if (state.adminUsers.length > 0) return
  try {
    const { data } = await api.get('/admin/users')
    state.adminUsers = data || []
  } catch (e) {
    state.adminUsers = []
  }
}

// ===================== DASHBOARD =====================
async function loadDashboard() {
  const { data } = await api.get('/stats')
  state.stats = data
  const totalLog = Math.max(1, Number(data.commandes_a_preparer || 0) + Number(data.commandes_a_expedier || 0) + Number(data.livres || 0) + Number(data.retours || 0))
  const pctPreparer = Math.round((Number(data.commandes_a_preparer || 0) / totalLog) * 100)
  const pctExpedier = Math.round((Number(data.commandes_a_expedier || 0) / totalLog) * 100)
  const pctLivrees = Math.round((Number(data.livres || 0) / totalLog) * 100)
  const pctRetours = Math.round((Number(data.retours || 0) / totalLog) * 100)
  
  const margeRows = (data.marge_par_produit || []).map((m, idx) => 
    '<tr>' +
      '<td class="text-gray-400">' + (idx + 1) + '</td>' +
      '<td class="max-w-[220px] truncate text-gray-200">' + (m.produit || 'Produit') + '</td>' +
      '<td class="text-blue-300">' + Number(m.ventes || 0) + '</td>' +
      '<td class="text-emerald-300 font-medium">' + Number(m.marge_nette || 0).toLocaleString('fr-DZ') + ' DA</td>' +
    '</tr>').join('')

  const trialInfo = data.subscription_info
  const trialBanner = trialInfo && trialInfo.is_trial ? (
    '<div class="grid md:grid-cols-2 gap-4 mb-6">' +
      '<div class="stat-card">' +
        '<div class="text-gray-400 text-xs mb-2"><i class="fas fa-box mr-1"></i> Commandes restantes (essai)</div>' +
        '<div class="text-3xl font-bold text-emerald-400"><span id="trial-orders-remaining">' + Number(trialInfo.orders_remaining || 0) + '</span><span class="text-sm text-gray-500"> / ' + Number(trialInfo.orders_limit || 500) + '</span></div>' +
      '</div>' +
      '<div class="stat-card">' +
        '<div class="text-gray-400 text-xs mb-2"><i class="fas fa-hourglass-half mr-1"></i> Fin de l\\\'essai</div>' +
        '<div class="text-2xl font-bold text-indigo-300" id="trial-countdown">--:--:--:--</div>' +
      '</div>' +
    '</div>'
  ) : ''

  document.getElementById('view-dashboard').innerHTML = '<div class="mb-6">' +
      '<h1 class="text-2xl font-bold">Tableau de bord</h1>' +
      '<p class="text-gray-400 text-sm mt-1">Bienvenue, ' + (state.user?.prenom || state.user?.nom || state.user?.username || 'Admin') + '</p>' +
    '</div>' +
    trialBanner +
    '<div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">' +
      '<div class="stat-card"><div class="text-gray-400 text-xs mb-2"><i class="fas fa-clipboard-list mr-1"></i> Commandes en cours</div><div class="text-3xl font-bold text-indigo-400">' + data.commandes_en_cours + '</div></div>' +
      '<div class="stat-card"><div class="text-gray-400 text-xs mb-2"><i class="fas fa-truck mr-1"></i> Total suivi</div><div class="text-3xl font-bold text-blue-400">' + data.total_suivi + '</div></div>' +
      '<div class="stat-card"><div class="text-gray-400 text-xs mb-2"><i class="fas fa-check-circle mr-1"></i> Livres</div><div class="text-3xl font-bold text-emerald-400">' + data.livres + '</div></div>' +
      '<div class="stat-card"><div class="text-gray-400 text-xs mb-2"><i class="fas fa-rotate-left mr-1"></i> Retours</div><div class="text-3xl font-bold text-red-400">' + data.retours + '</div></div>' +
    '</div>' +
    '<div class="grid lg:grid-cols-3 gap-4 mb-6">' +
      '<div class="stat-card"><div class="text-gray-400 text-xs mb-2"><i class="fas fa-money-bill mr-1"></i> CA Total</div><div class="text-2xl font-bold text-emerald-400">' + Number(data.ca_total||0).toLocaleString('fr-DZ') + ' DA</div></div>' +
      '<div class="stat-card"><div class="text-gray-400 text-xs mb-2"><i class="fas fa-percent mr-1"></i> Taux de livraison</div><div class="text-2xl font-bold text-indigo-400">' + data.taux_livraison + '%</div></div>' +
      '<div class="stat-card"><div class="text-gray-400 text-xs mb-2"><i class="fas fa-exclamation-triangle mr-1"></i> Alertes stock</div><div class="text-2xl font-bold ' + (data.alertes_stock>0?'text-red-400':'text-emerald-400') + '">' + data.alertes_stock + '</div></div>' +
    '</div>' +
    '<div class="grid lg:grid-cols-2 gap-4">' +
      '<div class="card p-5">' +
        '<h2 class="text-sm font-semibold text-gray-300 mb-4 uppercase tracking-wider"><i class="fas fa-chart-column mr-2 text-indigo-400"></i>Logistique: a preparer, expedier, livrees, retours</h2>' +
        '<div class="space-y-3">' +
          '<div><div class="flex justify-between text-xs text-gray-300 mb-1"><span>A preparer</span><span>' + (data.commandes_a_preparer || 0) + '</span></div><div class="w-full h-2 bg-dark-700 rounded-full overflow-hidden"><div class="h-full bg-indigo-400" style="width:' + pctPreparer + '%"></div></div></div>' +
          '<div><div class="flex justify-between text-xs text-gray-300 mb-1"><span>A expedier</span><span>' + (data.commandes_a_expedier || 0) + '</span></div><div class="w-full h-2 bg-dark-700 rounded-full overflow-hidden"><div class="h-full bg-blue-400" style="width:' + pctExpedier + '%"></div></div></div>' +
          '<div><div class="flex justify-between text-xs text-gray-300 mb-1"><span>Livrees</span><span>' + (data.livres || 0) + '</span></div><div class="w-full h-2 bg-dark-700 rounded-full overflow-hidden"><div class="h-full bg-emerald-400" style="width:' + pctLivrees + '%"></div></div></div>' +
          '<div><div class="flex justify-between text-xs text-gray-300 mb-1"><span>Retours</span><span>' + (data.retours || 0) + '</span></div><div class="w-full h-2 bg-dark-700 rounded-full overflow-hidden"><div class="h-full bg-red-400" style="width:' + pctRetours + '%"></div></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="card p-5">' +
        '<h2 class="text-sm font-semibold text-gray-300 mb-4 uppercase tracking-wider"><i class="fas fa-coins mr-2 text-emerald-400"></i>Marge nette par produit (estimee)</h2>' +
        '<div class="overflow-x-auto">' +
          '<table>' +
            '<thead><tr><th>#</th><th>Produit</th><th>Ventes</th><th>Marge nette</th></tr></thead>' +
            '<tbody>' + (margeRows || '<tr><td colspan="4" class="text-center text-gray-500 py-6">Aucune donnee livree pour le moment.</td></tr>') + '</tbody>' +
          '</table>' +
        '</div>' +
        '<p class="text-[11px] text-gray-500 mt-3">Calcul estime: prix livre - frais logistique moyens (650 DA domicile / 450 DA stop desk).</p>' +
      '</div>' +
    '</div>'

  if (trialCountdownTimer) {
    clearInterval(trialCountdownTimer)
    trialCountdownTimer = null
  }
  if (trialInfo && trialInfo.is_trial) {
    const endMs = new Date(trialInfo.trial_end_at).getTime()
    const renderCountdown = () => {
      const el = document.getElementById('trial-countdown')
      if (!el) return
      let left = Math.max(0, Math.floor((endMs - Date.now()) / 1000))
      const d = Math.floor(left / 86400); left %= 86400
      const h = Math.floor(left / 3600); left %= 3600
      const m = Math.floor(left / 60); const s = left % 60
      const pad = (n) => String(n).padStart(2, '0')
      el.textContent = pad(d) + 'j ' + pad(h) + 'h ' + pad(m) + 'm ' + pad(s) + 's'
    }
    renderCountdown()
    trialCountdownTimer = setInterval(renderCountdown, 1000)
  }
}

async function loadCommandes() {
  await ensureAdminUsersLoaded()
  const qs = state.user?.role === 'admin' && state.adminFilters.commandesUserId ? ('?user_id=' + encodeURIComponent(state.adminFilters.commandesUserId)) : ''
  const { data } = await api.get('/commandes' + qs)
  state.commandes = data
  const availableIds = new Set(data.map(c => c.id))
  selectedCommandeIds = selectedCommandeIds.filter(id => availableIds.has(id))
  if (state.wilayas.length === 0) { const w = await api.get('/wilayas'); state.wilayas = w.data }
  
  const phones = data.map(c => (c.telephone || ''))
  await loadPhoneVerification(phones)
  
  const confirmedCount = data.filter(c => isConfirmedFrontend(c.statut)).length
  const selectedCount = selectedCommandeIds.length
  const selectedSet = new Set(selectedCommandeIds)
  const selectedConfirmedCount = data.filter(c => selectedSet.has(c.id) && isConfirmedFrontend(c.statut)).length
  const allSelected = data.length > 0 && selectedCount === data.length
  const v = document.getElementById('view-commandes')
  
  const rows = data.map(c => '<tr>' +
    '<td><input type="checkbox" class="w-4 h-4 accent-indigo-500 cursor-pointer" onchange="toggleCommandeSelection(' + c.id + ', this.checked)" ' + (selectedSet.has(c.id) ? 'checked' : '') + ' aria-label="Selectionner la commande ' + (c.nom || c.id) + '"></td>' +
    '<td class="font-medium text-white">' + (c.nom || '') + '</td>' +
    '<td class="text-gray-300"><div class="flex items-center gap-1"><i class="fab fa-whatsapp text-green-500 text-xs"></i> ' + (c.telephone || '') + '</div></td>' +
    '<td>' + verifyBadge(c.telephone) + '</td>' +
    '<td class="max-w-[130px] truncate text-gray-300">' + (c.produit || '') + '</td>' +
    '<td class="text-emerald-400 font-medium">' + Number(c.prix || 0).toLocaleString() + ' DA</td>' +
    '<td class="text-gray-300">' + (c.commune || '') + '</td>' +
    '<td class="text-gray-300">' + (c.wilaya || '') + '</td>' +
    '<td><span class="text-xs text-gray-400">' + (c.livraison || '') + '</span></td>' +
    '<td>' + statusBadge(c.statut) + '</td>' +
    '<td>' + (c.source ? '<span class="platform-badge ' + platformColors[c.source] + '"><i class="' + (platformIcons[c.source] || 'fas fa-globe') + '" style="font-size:10px"></i> ' + c.source + '</span>' : '<span class="badge-status bg-indigo-500/20 text-indigo-300" style="font-size:10px"><i class="fas fa-store" style="font-size:9px;margin-right:3px"></i>Boutique</span>') + '</td>' +
    '<td>' + getApiIntegrationBadge(c) + '</td>' +
    '<td class="text-sm text-gray-300">' + (c.transporteur || '--') + '</td>' +
    '<td>' +
      '<div class="flex gap-1">' +
        '<button onclick="editCommande(' + c.id + ')" class="btn btn-outline text-xs py-1 px-2" title="Modifier"><i class="fas fa-pen"></i></button>' +
        '<button onclick="sendWhatsApp(' + c.id + ')" class="btn btn-whatsapp text-xs py-1 px-2" title="Envoyer sur WhatsApp"><i class="fab fa-whatsapp"></i></button>' +
        '<button onclick="envoyerCommande(' + c.id + ')" class="btn btn-success text-xs py-1 px-2" title="Envoyer" ' + (!isConfirmedFrontend(c.statut) ? 'disabled style="opacity:0.3"' : '') + '><i class="fas fa-paper-plane"></i></button>' +
        '<button onclick="deleteCommande(' + c.id + ')" class="btn btn-danger text-xs py-1 px-2" title="Supprimer"><i class="fas fa-trash"></i></button>' +
      '</div>' +
    '</td>' +
  '</tr>').join('')

  v.innerHTML = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">' +
      '<div><h1 class="text-2xl font-bold">Commandes</h1><p class="text-gray-400 text-sm">' + data.length + ' commande(s)</p></div>' +
      '<div class="flex gap-2 flex-wrap">' +
        (state.user?.role === 'admin' ? ('<select onchange="setAdminFilterCommandes(this.value)" class="bg-dark-800 border border-white/10 rounded px-3 py-2 text-sm"><option value="">Tous les clients</option>' + state.adminUsers.map(u => '<option value="' + u.id + '"' + (String(state.adminFilters.commandesUserId) === String(u.id) ? ' selected' : '') + '>' + (u.store_name || u.email || u.username) + '</option>').join('') + '</select>') : '') +
        '<button onclick="showCommandeModal()" class="btn btn-primary"><i class="fas fa-plus mr-1"></i> Nouvelle</button>' +
        '<button onclick="toggleAutoWhatsApp()" class="btn ' + (state.subscription === 'starter' ? 'opacity-40 grayscale cursor-not-allowed' : (autoWhatsAppEnabled ? 'btn-success' : 'btn-outline')) + '">' +
          '<i class="' + (state.subscription === 'starter' ? 'fas fa-lock' : 'fab fa-whatsapp') + ' mr-1"></i> Auto WhatsApp: ' + (state.subscription === 'starter' ? 'PRO' : (autoWhatsAppEnabled ? 'ON' : 'OFF')) +
        '</button>' +
        '<button onclick="envoyerTous()" class="btn btn-success ' + (confirmedCount === 0 ? 'opacity-40 cursor-not-allowed' : '') + '" ' + (confirmedCount === 0 ? 'disabled' : '') + '>' +
          '<i class="fas fa-paper-plane mr-1"></i> Envoyer les commandes Confirmees (' + confirmedCount + ')' +
        '</button>' +
        '<button onclick="envoyerSelection()" class="btn btn-success ' + (selectedConfirmedCount === 0 ? 'opacity-40 cursor-not-allowed' : '') + '" ' + (selectedConfirmedCount === 0 ? 'disabled' : '') + '>' +
          '<i class="fas fa-share mr-1"></i> Envoyer selection (' + selectedConfirmedCount + ')' +
        '</button>' +
        '<button onclick="deleteSelection()" class="btn btn-danger ' + (selectedCount === 0 ? 'opacity-40 cursor-not-allowed' : '') + '" ' + (selectedCount === 0 ? 'disabled' : '') + '>' +
          '<i class="fas fa-trash mr-1"></i> Supprimer selection (' + selectedCount + ')' +
        '</button>' +
      '</div>' +
    '</div>' +
    '<div class="card overflow-x-auto">' +
      '<table>' +
        '<thead><tr>' +
          '<th><input type="checkbox" class="w-4 h-4 accent-indigo-500 cursor-pointer" onchange="toggleAllCommandesSelection(this.checked)" ' + (allSelected ? 'checked' : '') + ' aria-label="Selectionner toutes les commandes"></th><th>Nom</th><th>Tel</th><th>Verifier</th><th>Produit</th><th>Prix</th><th>Commune</th><th>Wilaya</th><th>Livraison</th><th>Statut</th><th>Boutique</th><th>Integration API</th><th>Transporteur</th><th>Actions</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      (data.length === 0 ? '<div class="text-center py-12 text-gray-500"><i class="fas fa-inbox text-4xl mb-3 block"></i><p>Aucune commande</p></div>' : '') +
    '</div>'
}

function setAdminFilterCommandes(userId) {
  state.adminFilters.commandesUserId = userId || ''
  selectedCommandeIds = []
  loadCommandes()
}

async function showCommandeModal(editCmd = null) {
  if (state.wilayas.length === 0) { const w = await api.get('/wilayas'); state.wilayas = w.data }
  if (state.transporteurs.length === 0) { const t = await api.get('/user-transporteurs'); state.transporteurs = t.data }
  
  const isEdit = !!editCmd
  const title = isEdit ? 'Modifier la commande' : 'Nouvelle commande'
  const icon = isEdit ? 'fa-pen-to-square' : 'fa-plus'

  const wilayaOptions = state.wilayas.map(w =>
    '<option value="' + w.name + '"' + (editCmd && editCmd.wilaya === w.name ? ' selected' : '') + '>' + w.code + ' - ' + w.name + '</option>'
  ).join('')

  const transporteurOptions = state.transporteurs.map(t =>
    '<option value="' + t + '"' + (editCmd && editCmd.transporteur === t ? ' selected' : '') + '>' + t + '</option>'
  ).join('')

  const livOptions = livraisons.map(l =>
    '<option value="' + l + '"' + (editCmd && editCmd.livraison === l ? ' selected' : '') + '>' + l + '</option>'
  ).join('')

  const statutOptions = statuts.map(s =>
    '<option value="' + s + '"' + (editCmd && editCmd.statut === s ? ' selected' : '') + '>' + s + '</option>'
  ).join('')

  document.getElementById('modals').innerHTML =
    '<div class="modal-overlay-v2" onclick="closeModalV2(event)">' +
      '<div class="modal-v2" onclick="event.stopPropagation()">' +

        '<div class="modal-v2-header">' +
          '<h2><span class="header-icon"><i class="fas ' + icon + '"></i></span>' + title + '</h2>' +
          '<button class="modal-v2-close" onclick="closeModalAnimated()"><i class="fas fa-xmark"></i></button>' +
        '</div>' +

        '<div class="modal-v2-body">' +

          '<div class="modal-v2-section">' +
            '<div class="modal-v2-section-title"><i class="fas fa-user-circle"></i> Informations client</div>' +
            '<div class="form-grid">' +
              '<div class="float-field">' +
                '<i class="fas fa-user field-icon"></i>' +
                '<input type="text" id="cmd-nom" placeholder=" " value="' + (editCmd?.nom || '') + '" required>' +
                '<label>Nom complet *</label>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-coins field-icon"></i>' +
                '<input type="number" id="cmd-prix" placeholder=" " value="' + (editCmd?.prix || 0) + '">' +
                '<label>Prix (DA) *</label>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-phone field-icon"></i>' +
                '<input type="tel" id="cmd-telephone" placeholder=" " value="' + (editCmd?.telephone || '') + '" required>' +
                '<label>Telephone *</label>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-box field-icon"></i>' +
                '<input type="text" id="cmd-produit" placeholder=" " value="' + (editCmd?.produit || '') + '" required>' +
                '<label>Produit *</label>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="modal-v2-section">' +
            '<div class="modal-v2-section-title"><i class="fas fa-map-location-dot"></i> Adresse de livraison</div>' +
            '<div class="form-grid">' +
              '<div class="float-field">' +
                '<i class="fas fa-map-marked-alt field-icon"></i>' +
                '<select id="cmd-wilaya" onchange="refreshCommuneList()" required>' +
                  '<option value="" disabled ' + (!editCmd ? 'selected' : '') + '> </option>' +
                  wilayaOptions +
                '</select>' +
                '<label>Wilaya *</label>' +
                '<i class="fas fa-chevron-down select-arrow"></i>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-location-dot field-icon"></i>' +
                '<select id="cmd-commune" required>' +
                  '<option value="" disabled selected> </option>' +
                  (editCmd?.commune ? '<option value="' + editCmd.commune + '" selected>' + editCmd.commune + '</option>' : '') +
                '</select>' +
                '<label id="lbl-commune">Commune *</label>' +
                '<i class="fas fa-chevron-down select-arrow"></i>' +
              '</div>' +
              '<div class="float-field full-width">' +
                '<i class="fas fa-house field-icon"></i>' +
                '<input type="text" id="cmd-adresse" placeholder=" " value="' + (editCmd?.adresse || '') + '">' +
                '<label>Adresse complete</label>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="modal-v2-section">' +
            '<div class="modal-v2-section-title"><i class="fas fa-truck-fast"></i> Expedition</div>' +
            '<div class="form-grid">' +
              '<div class="float-field">' +
                '<i class="fas fa-dolly field-icon"></i>' +
                '<select id="cmd-livraison" onchange="refreshCommuneList()">' +
                  livOptions +
                '</select>' +
                '<label>Mode de livraison</label>' +
                '<i class="fas fa-chevron-down select-arrow"></i>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-tag field-icon"></i>' +
                '<select id="cmd-statut">' +
                  statutOptions +
                '</select>' +
                '<label>Statut</label>' +
                '<i class="fas fa-chevron-down select-arrow"></i>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-truck field-icon"></i>' +
                '<select id="cmd-transporteur" onchange="refreshCommuneList()">' +
                  '<option value="" disabled ' + (!editCmd?.transporteur ? 'selected' : '') + '> </option>' +
                  transporteurOptions +
                '</select>' +
                '<label>Transporteur</label>' +
                '<i class="fas fa-chevron-down select-arrow"></i>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-sticky-note field-icon"></i>' +
                '<input type="text" id="cmd-notes" placeholder=" " value="' + (editCmd?.notes || '') + '">' +
                '<label>Notes</label>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="modal-v2-footer">' +
            '<button class="btn-v2-cancel" onclick="closeModalAnimated()">Annuler</button>' +
            '<button class="btn-v2-submit" id="cmd-submit-btn" onclick="submitCommande(' + (editCmd?.id || 'null') + ')">' +
              '<i class="fas ' + (isEdit ? 'fa-save' : 'fa-paper-plane') + '"></i> ' +
              '<span id="cmd-submit-text">' + (isEdit ? 'Enregistrer' : 'Creer la commande') + '</span>' +
            '</button>' +
          '</div>' +

        '</div>' +
      '</div>' +
    '</div>'

  if (editCmd?.wilaya) {
    refreshCommuneList(editCmd.commune)
  }
}

function closeModalV2(event) {
  if (event.target === event.currentTarget) closeModalAnimated()
}

function closeModalAnimated() {
  const modal = document.querySelector('.modal-v2')
  const overlay = document.querySelector('.modal-overlay-v2')
  if (modal) {
    modal.classList.add('closing')
    if (overlay) overlay.style.animation = 'modalOverlayIn 0.2s ease-in reverse forwards'
    setTimeout(() => { document.getElementById('modals').innerHTML = '' }, 250)
  } else {
    document.getElementById('modals').innerHTML = ''
  }
}

async function refreshCommuneList(selectedMatch = null) {
  const wilayaName = document.getElementById('cmd-wilaya')?.value
  const livraison = document.getElementById('cmd-livraison')?.value
  const transporteur = document.getElementById('cmd-transporteur')?.value
  const sel = document.getElementById('cmd-commune')
  const label = document.getElementById('lbl-commune')
  
  if (!wilayaName || !sel) return
  
  const wilaya = state.wilayas.find(w => w.name === wilayaName)
  if (!wilaya) return

  if (livraison === 'Stop Desk' && transporteur) {
    if (label) label.innerText = 'Point Relais *'
    sel.innerHTML = '<option value="" disabled selected>Chargement des points relais...</option>'
    try {
      const { data } = await api.get('/stop-desks/' + wilaya.id + '?transporteur=' + encodeURIComponent(transporteur))
      if (data && data.length > 0) {
        sel.innerHTML = '<option value="" disabled selected> </option>' +
          data.map(c => {
            const displayName = c.address ? (c.name + ' - ' + c.address) : c.name
            return '<option value="' + c.name + '"' + (c.name === selectedMatch ? ' selected' : '') + '>' + displayName + '</option>'
          }).join('')
      } else {
        sel.innerHTML = '<option value="" disabled selected>Aucun point relais disponible</option>'
        setTimeout(async () => {
          if (label) label.innerText = 'Commune *'
          await loadCommunesForModal(wilayaName, selectedMatch)
        }, 800)
      }
    } catch(e) {
      console.error(e)
      if (label) label.innerText = 'Commune *'
      await loadCommunesForModal(wilayaName, selectedMatch)
    }
  } else {
    if (label) label.innerText = 'Commune *'
    sel.innerHTML = '<option value="" disabled selected>Chargement...</option>'
    await loadCommunesForModal(wilayaName, selectedMatch)
  }
}

async function loadCommunesForModal(wilayaName, selectedCommune) {
  const wilaya = state.wilayas.find(w => w.name === wilayaName)
  if (!wilaya) return
  try {
    const { data } = await api.get('/communes/' + wilaya.id)
    const sel = document.getElementById('cmd-commune')
    if (!sel) return
    sel.innerHTML = '<option value="" disabled selected> </option>' +
      data.map(c => '<option value="' + c.name + '"' + (c.name === selectedCommune ? ' selected' : '') + '>' + c.name + '</option>').join('')
  } catch(e) { console.error(e) }
}

async function submitCommande(editId) {
  const btn = document.getElementById('cmd-submit-btn')
  const btnText = document.getElementById('cmd-submit-text')
  const nom = document.getElementById('cmd-nom').value.trim()
  const telephone = document.getElementById('cmd-telephone').value.trim()
  const produit = document.getElementById('cmd-produit').value.trim()
  const wilaya = document.getElementById('cmd-wilaya').value
  const commune = document.getElementById('cmd-commune').value

  if (!nom || !telephone || !produit || !wilaya || !commune) {
    toast('Veuillez remplir tous les champs obligatoires', 'error')
    return
  }

  btn.disabled = true
  btnText.innerHTML = '<span class="spinner-sm"></span> Enregistrement...'

  const payload = {
    nom,
    prix: Number(document.getElementById('cmd-prix').value) || 0,
    telephone,
    produit,
    wilaya,
    commune,
    adresse: document.getElementById('cmd-adresse').value.trim(),
    livraison: document.getElementById('cmd-livraison').value,
    statut: document.getElementById('cmd-statut').value,
    transporteur: document.getElementById('cmd-transporteur').value,
    notes: document.getElementById('cmd-notes').value.trim()
  }

  try {
    if (editId) {
      await api.put('/commandes/' + editId, payload)
      toast('Commande modifiee avec succes !')
    } else {
      await api.post('/commandes', payload)
      toast('Commande creee avec succes !')
      if (typeof autoWhatsAppEnabled !== 'undefined' && autoWhatsAppEnabled && payload.telephone) {
        if(typeof sendWhatsAppMessage === 'function') sendWhatsAppMessage(payload)
      }
    }
    closeModalAnimated()
    setTimeout(() => loadCommandes(), 300)
  } catch(e) {
    const msg = e.response?.data?.error || 'Erreur lors de la sauvegarde'
    toast(msg, 'error')
    btn.disabled = false
    btnText.innerHTML = (editId ? 'Enregistrer' : 'Creer la commande')
  }
}

async function editCommande(id) {
  const cmd = state.commandes.find(c=>c.id===id)
  if(cmd) showCommandeModal(cmd)
}

async function deleteCommande(id) {
  if(!confirm('Supprimer cette commande ?')) return
  await api.delete('/commandes/'+id)
  selectedCommandeIds = selectedCommandeIds.filter(x => x !== id)
  toast('Commande supprimee'); loadCommandes()
}

async function envoyerCommande(id) {
  if(!confirm('Envoyer cette commande au transporteur ?')) return
  try {
    const { data } = await api.post('/envoyer/'+id)
    toast('Expedie ! Tracking: '+data.tracking)
    loadCommandes()
  } catch(err) { toast(err.response?.data?.error || 'Erreur envoi', 'error') }
}

async function envoyerTous() {
  const count = state.commandes.filter(c => isConfirmedFrontend(c.statut)).length
  if(!confirm('Envoyer toutes les ' + count + ' commandes Confirmees aux transporteurs ?')) return
  try {
    const { data } = await api.post('/envoyer-tous')
    toast(data.sent+' envoyee(s), '+data.errors+' erreur(s)')
    loadCommandes()
  } catch(err) { toast('Erreur envoi en masse', 'error') }
}

function toggleCommandeSelection(id, checked) {
  if (checked) {
    if (!selectedCommandeIds.includes(id)) selectedCommandeIds.push(id)
  } else {
    selectedCommandeIds = selectedCommandeIds.filter(x => x !== id)
  }
  loadCommandes()
}

function toggleAllCommandesSelection(checked) {
  if (checked) selectedCommandeIds = state.commandes.map(c => c.id)
  else selectedCommandeIds = []
  loadCommandes()
}

async function deleteSelection() {
  if (selectedCommandeIds.length === 0) return
  if (!confirm('Supprimer ' + selectedCommandeIds.length + ' commande(s) selectionnee(s) ?')) return
  let ok = 0
  let errors = 0
  for (const id of selectedCommandeIds) {
    try {
      await api.delete('/commandes/' + id)
      ok++
    } catch (e) { errors++ }
  }
  selectedCommandeIds = []
  toast(ok + ' supprimee(s), ' + errors + ' erreur(s)', errors > 0 ? 'error' : 'success')
  loadCommandes()
}

async function envoyerSelection() {
  const targets = state.commandes.filter(c => selectedCommandeIds.includes(c.id) && isConfirmedFrontend(c.statut))
  if (targets.length === 0) {
    toast('Selection vide ou sans commandes confirmees', 'error')
    return
  }
  if (!confirm('Envoyer ' + targets.length + ' commande(s) confirmee(s) au transporteur ?')) return
  let sent = 0
  let errors = 0
  for (const cmd of targets) {
    try {
      await api.post('/envoyer/' + cmd.id)
      sent++
    } catch (e) { errors++ }
  }
  toast(sent + ' envoyee(s), ' + errors + ' erreur(s)', errors > 0 ? 'error' : 'success')
  loadCommandes()
}

function formatHistoryDate(entry) {
  const raw = entry?.date || entry?.created_at || entry?.updated_at || entry?.timestamp
  if (!raw) return 'Date indisponible'
  if (typeof raw === 'string') {
    const lowered = raw.trim().toLowerCase()
    if (!lowered || lowered === 'undefined' || lowered === 'null' || lowered === 'nan' || lowered === 'invalid date') return 'Date indisponible'
  }
  let d = new Date(raw)
  if (Number.isNaN(d.getTime()) && typeof raw === 'string') {
    // Handle date strings like: 07/04/2026 12:25:21 PM
    const m = raw.match(/^(\\d{1,2})\\/(\\d{1,2})\\/(\\d{4})\\s+(\\d{1,2}):(\\d{2})(?::(\\d{2}))?\\s*(AM|PM)?$/i)
    if (m) {
      const day = Number(m[1])
      const month = Number(m[2])
      const year = Number(m[3])
      let hour = Number(m[4])
      const minute = Number(m[5])
      const second = Number(m[6] || '0')
      const ampm = (m[7] || '').toUpperCase()
      if (ampm === 'PM' && hour < 12) hour += 12
      if (ampm === 'AM' && hour === 12) hour = 0
      d = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    }
  }
  if (Number.isNaN(d.getTime()) && typeof raw === 'string') {
    // Handle date strings like: 2026-04-07 12:25:21 (without timezone)
    const isoLike = raw.match(/^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})(?::(\\d{2}))?$/)
    if (isoLike) {
      const year = Number(isoLike[1])
      const month = Number(isoLike[2])
      const day = Number(isoLike[3])
      const hour = Number(isoLike[4])
      const minute = Number(isoLike[5])
      const second = Number(isoLike[6] || '0')
      d = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    }
  }
  if (Number.isNaN(d.getTime())) return 'Date indisponible'
  return new Intl.DateTimeFormat('fr-DZ', {
    timeZone: 'Africa/Algiers',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(d)
}

function closeModal() { document.getElementById('modals').innerHTML = '' }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal()
})

// ===================== SUIVI (with Verification column) =====================
async function loadSuivi() {
  await ensureAdminUsersLoaded()
  const qs = state.user?.role === 'admin' && state.adminFilters.suiviUserId ? ('?user_id=' + encodeURIComponent(state.adminFilters.suiviUserId)) : ''
  const { data } = await api.get('/suivi' + qs)
  state.suivi = data
  
  const phones = data.map(s => s.telephone)
  await loadPhoneVerification(phones)
  
  const rows = data.map(s => '<tr>' +
    '<td class="font-medium text-white">' + (s.nom || '') + '</td>' +
    '<td class="text-gray-300"><div class="flex items-center gap-1"><i class="fab fa-whatsapp text-green-500 text-xs"></i> ' + (s.telephone || '') + '</div></td>' +
    '<td>' + verifyBadge(s.telephone) + '</td>' +
    '<td class="max-w-[120px] truncate text-gray-300">' + (s.produit || '') + '</td>' +
    '<td class="text-emerald-400 font-medium">' + Number(s.prix || 0).toLocaleString() + ' DA</td>' +
    '<td class="text-gray-300">' + (s.commune || '') + '</td>' +
    '<td class="text-gray-300">' + (s.wilaya || '') + '</td>' +
    '<td class="hover:bg-white/5 cursor-pointer transition-colors" onclick="showHistoriqueColis(\\\'' + (s.tracking || '') + '\\\', \\\'' + (s.transporteur || '') + '\\\')" title="Voir historique">' + statusBadge(s.statut) + '</td>' +
    '<td class="font-mono text-xs text-green-300">' + (s.tracking || '') + '</td>' +
    '<td class="text-sm text-gray-300">' + (s.transporteur || '') + '</td>' +
    '<td><div class="flex gap-1"><button onclick="returnOrder(' + s.id + ')" class="btn btn-danger text-[10px] py-1 px-2" title="Marquer comme Retour"><i class="fas fa-rotate-left"></i> Retour</button></div></td>' +
    '</tr>').join('')

  const syncLabel = suiviLastSyncAt
    ? new Intl.DateTimeFormat('fr-DZ', { timeZone: 'Africa/Algiers', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(suiviLastSyncAt)
    : 'Jamais'
  document.getElementById('view-suivi').innerHTML = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">' +
    '<div><h1 class="text-2xl font-bold">Suivi des colis</h1><p class="text-gray-400 text-sm">' + data.length + ' colis</p></div>' +
    (state.user?.role === 'admin' ? ('<select onchange="setAdminFilterSuivi(this.value)" class="bg-dark-800 border border-white/10 rounded px-3 py-2 text-sm"><option value="">Tous les clients</option>' + state.adminUsers.map(u => '<option value="' + u.id + '"' + (String(state.adminFilters.suiviUserId) === String(u.id) ? ' selected' : '') + '>' + (u.store_name || u.email || u.username) + '</option>').join('') + '</select>') : '') +
    '<div class="text-xs text-gray-400"><i class="fas fa-clock mr-1"></i>Derniere synchronisation: ' + syncLabel + '</div>' +
    '<button onclick="actualiserStatuts()" class="btn btn-primary"><i class="fas fa-sync mr-1"></i> Actualiser statuts</button>' +
    '</div>' +
    '<div class="card overflow-x-auto">' +
    '<table><thead><tr><th>Nom</th><th>Tel</th><th>Verifier</th><th>Produit</th><th>Prix</th><th>Commune</th><th>Wilaya</th><th>Statut</th><th>Tracking</th><th>Transporteur</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    (data.length === 0 ? '<div class="text-center py-12 text-gray-500"><i class="fas fa-truck text-4xl mb-3 block"></i><p>Aucun colis en suivi</p></div>' : '') +
    '</div>'
  if (suiviAutoRefreshTimer) clearInterval(suiviAutoRefreshTimer)
  suiviAutoRefreshTimer = setInterval(async () => {
    if (state.currentView !== 'suivi' || suiviRefreshInFlight) return
    suiviRefreshInFlight = true
    try {
      await actualiserStatuts(true)
    } finally {
      suiviRefreshInFlight = false
    }
  }, SUIVI_AUTO_REFRESH_MS)
}

function setAdminFilterSuivi(userId) {
  state.adminFilters.suiviUserId = userId || ''
  loadSuivi()
}

async function returnOrder(id) {
  if(!confirm('Marquer cet envoi comme RETOURNE ?')) return
  try {
    await api.put('/commandes/'+id, { statut: 'ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¸ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ Retour ExpÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©diteur', situation: 'MarquÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© comme retour manuellement' })
    toast('Colis marquÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© comme retour'); loadSuivi()
  } catch(e) { toast('Erreur', 'error') }
}

async function actualiserStatuts(silent = false) {
  try {
    const { data } = await api.post('/actualiser-statuts')
    suiviLastSyncAt = new Date()
    if (!silent || Number(data.updated || 0) > 0 || Number(data.errors || 0) > 0) {
      toast(data.updated+' mis a jour, '+data.errors+' erreur(s)')
    }
    loadSuivi()
  } catch(err) {
    if (!silent) toast('Erreur actualisation', 'error')
  }
}

async function showHistoriqueColis(tracking, transporteur) {
  if (!tracking || tracking === 'undefined') { toast('Aucun tracking pour ce colis', 'error'); return; }
  
  document.getElementById('modals').innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal" style="max-width: 500px">' +
      '<div class="flex items-center justify-between mb-4 border-b border-white/10 pb-4">' +
        '<h2 class="text-lg font-bold"><i class="fas fa-history mr-2 text-indigo-400"></i>Historique: ' + tracking + '</h2>' +
        '<button onclick="closeModal()" class="text-gray-400 hover:text-white"><i class="fas fa-times"></i></button>' +
      '</div>' +
      '<div class="py-12 flex justify-center"><i class="fas fa-circle-notch fa-spin text-3xl text-indigo-500"></i></div>' +
    '</div>' +
  '</div>'
  
  try {
    const { data } = await api.get('/suivi/historique/' + tracking + '?trans=' + encodeURIComponent(transporteur))
    
    let html = '<div class="space-y-4 max-h-[60vh] overflow-y-auto pr-2">'
    if (!data.history || data.history.length === 0) {
      html += '<div class="text-center text-gray-400 py-6">Aucun historique disponible</div>'
    } else {
      html += '<div class="relative border-l border-indigo-500/30 ml-3 space-y-6 mt-4 mb-4">'
      data.history.forEach((h, i) => {
        const displayDate = formatHistoryDate(h)
        html += '<div class="relative pl-6">' +
          '<div class="absolute w-3 h-3 ' + (i === 0 ? 'bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.5)]' : 'bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.5)]') + ' rounded-full -left-[6.5px] top-1.5"></div>' +
          '<div class="text-xs text-indigo-200 mb-1 flex items-center gap-1"><i class="fas fa-calendar-alt text-[10px] opacity-80"></i><span>' + displayDate + '</span></div>' +
          '<div class="font-medium text-white mb-1">' + (h.status || '') + '</div>' +
          '<div class="text-xs text-gray-500">' + (h.situation || '') + '</div>' +
        '</div>'
      })
      html += '</div>'
    }
    html += '</div>'
    
    document.querySelector('#modals .modal').innerHTML = '<div class="flex items-center justify-between mb-4 border-b border-white/10 pb-4">' +
        '<h2 class="text-lg font-bold"><i class="fas fa-history mr-2 text-indigo-400"></i>Historique: ' + tracking + '</h2>' +
        '<button onclick="closeModal()" class="text-gray-400 hover:text-white"><i class="fas fa-times"></i></button>' +
      '</div>' + html
      
  } catch(e) {
    closeModal()
    toast("Erreur de chargement de l'historique", 'error')
  }
}

// ===================== STOCK =====================
async function loadStock() {
  const [{ data }, { data: auditData }] = await Promise.all([
    api.get('/stock'),
    api.get('/stock/audit').catch(() => ({ data: null }))
  ])
  state.stock = data
  state.stockAudit = auditData
  const itemRows = (data || []).map((s) => {
    const available = Number(s.stock_available || 0)
    const safety = Number(s.safety_stock || 0)
    const rowClass = available <= 0 ? 'text-red-300' : (available <= safety ? 'text-orange-300' : 'text-emerald-300')
    return '<tr>' +
      '<td class="font-mono text-xs text-indigo-200">' + (s.sku || '') + '</td>' +
      '<td class="text-gray-200">' + (s.nom || '') + '</td>' +
      '<td class="text-gray-400">' + ((s.categorie || 'Non classe') + (s.sous_categorie ? (' / ' + s.sous_categorie) : '')) + '</td>' +
      '<td class="' + rowClass + ' font-semibold">' + available + '</td>' +
      '<td class="text-gray-300">' + Number(s.stock_on_hand || 0) + '</td>' +
      '<td class="text-gray-400">' + Number(s.stock_reserved || 0) + '</td>' +
      '<td class="text-gray-400">' + Number(s.stock_in_transit || 0) + '</td>' +
      '<td class="text-orange-300">' + safety + '</td>' +
      '<td><button onclick="editStock(' + s.id + ')" class="btn btn-outline text-[10px] py-1 px-2"><i class="fas fa-pen mr-1"></i>Modifier</button></td>' +
    '</tr>'
  }).join('')

  const summary = state.stockAudit?.summary || { total_skus: 0, obsolete_count: 0, slow_count: 0, reorder_count: 0, duplicate_count: 0 }
  const obsoleteRows = (state.stockAudit?.obsolete || []).map((i) =>
    '<tr><td class="text-gray-200">' + (i.nom || '') + '</td><td class="font-mono text-xs text-gray-300">' + (i.sku || '') + '</td><td class="text-red-300">' + Number(i.on_hand || 0) + '</td></tr>'
  ).join('')
  const reorderRows = (state.stockAudit?.reorder || []).map((i) =>
    '<tr><td class="text-gray-200">' + (i.nom || '') + '</td><td class="text-orange-300">' + Number(i.available || 0) + '</td><td class="text-emerald-300">' + Number(i.suggested_qty || 0) + '</td></tr>'
  ).join('')

  document.getElementById('view-stock').innerHTML = '<div class="mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-3"><div><h1 class="text-2xl font-bold">Gestion du stock</h1><p class="text-gray-400 text-sm">Inventaire avance par SKU (ancien stock par tailles supprime)</p></div><div class="flex gap-2"><button onclick="showStockEntryModal()" class="btn btn-outline text-xs"><i class="fas fa-plus mr-1"></i>Entree stock</button><button onclick="showAddSkuModal()" class="btn btn-primary text-xs"><i class="fas fa-box-open mr-1"></i>Ajouter SKU</button></div></div>' +
    '<div class="grid md:grid-cols-5 gap-3 mb-6">' +
      '<div class="card p-4"><div class="text-[11px] text-gray-400">SKU actifs</div><div class="text-2xl font-bold text-indigo-300">' + Number(summary.total_skus || 0) + '</div></div>' +
      '<div class="card p-4"><div class="text-[11px] text-gray-400">Obsoletes</div><div class="text-2xl font-bold text-red-300">' + Number(summary.obsolete_count || 0) + '</div></div>' +
      '<div class="card p-4"><div class="text-[11px] text-gray-400">Mouvement lent</div><div class="text-2xl font-bold text-orange-300">' + Number(summary.slow_count || 0) + '</div></div>' +
      '<div class="card p-4"><div class="text-[11px] text-gray-400">A reapprovisionner</div><div class="text-2xl font-bold text-emerald-300">' + Number(summary.reorder_count || 0) + '</div></div>' +
      '<div class="card p-4"><div class="text-[11px] text-gray-400">Doublons nom</div><div class="text-2xl font-bold text-yellow-300">' + Number(summary.duplicate_count || 0) + '</div></div>' +
    '</div>' +
    '<div class="grid lg:grid-cols-2 gap-4">' +
      '<div class="card overflow-x-auto"><div class="p-4 border-b border-white/5"><h3 class="font-semibold"><i class="fas fa-boxes-stacked text-indigo-300 mr-2"></i>Inventaire SKU</h3></div>' +
      '<table><thead><tr><th>SKU</th><th>Produit</th><th>Categorie</th><th>Disponible</th><th>On hand</th><th>Reserve</th><th>Transit</th><th>Seuil</th><th>Action</th></tr></thead><tbody>' + (itemRows || '<tr><td colspan="9" class="text-gray-500">Aucun SKU configure. Ajoutez des articles dans stock_items.</td></tr>') + '</tbody></table></div>' +
      '<div class="card overflow-x-auto"><div class="p-4 border-b border-white/5"><h3 class="font-semibold"><i class="fas fa-trash-can text-red-300 mr-2"></i>Produits obsoletes (top 20)</h3></div>' +
      '<table><thead><tr><th>Produit</th><th>SKU</th><th>Stock</th></tr></thead><tbody>' + (obsoleteRows || '<tr><td colspan="3" class="text-gray-500">Aucun produit obsolete detecte</td></tr>') + '</tbody></table></div>' +
      '<div class="card overflow-x-auto"><div class="p-4 border-b border-white/5"><h3 class="font-semibold"><i class="fas fa-cart-plus text-emerald-300 mr-2"></i>Reappro recommande (top 20)</h3></div>' +
      '<table><thead><tr><th>Produit</th><th>Disponible</th><th>QtÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© suggeree</th></tr></thead><tbody>' + (reorderRows || '<tr><td colspan="3" class="text-gray-500">Aucun besoin de reappro immediat</td></tr>') + '</tbody></table></div>' +
    '</div>'
}

async function editStock(id) {
  const s = state.stock.find(x=>x.id===id)
  if(!s) return
  document.getElementById('modals').innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal" style="max-width:400px">' +
      '<h2 class="text-lg font-bold mb-4"><i class="fas fa-boxes-stacked mr-2 text-indigo-400"></i>Modifier stock - ' + (s.sku || s.nom || 'Article') + '</h2>' +
      '<form onsubmit="saveStock(event,' + id + ')" class="space-y-3">' +
        '<div><label class="text-xs text-gray-400">Stock on hand</label><input id="s-on-hand" type="number" value="' + Number(s.stock_on_hand || 0) + '"></div>' +
        '<div><label class="text-xs text-gray-400">Reserve</label><input id="s-reserved" type="number" value="' + Number(s.stock_reserved || 0) + '"></div>' +
        '<div><label class="text-xs text-gray-400">En transit</label><input id="s-transit" type="number" value="' + Number(s.stock_in_transit || 0) + '"></div>' +
        '<div><label class="text-xs text-gray-400">Seuil securite</label><input id="s-safety" type="number" value="' + Number(s.safety_stock || 0) + '"></div>' +
        '<div class="flex justify-end gap-3 pt-3 border-t border-white/5">' +
          '<button type="button" onclick="closeModal()" class="btn btn-outline">Annuler</button>' +
          '<button type="submit" class="btn btn-primary">Enregistrer</button>' +
        '</div></form></div></div>'
}

async function saveStock(e, id) {
  e.preventDefault()
  try {
    await api.put('/stock/'+id, {
      stock_on_hand: Number(document.getElementById('s-on-hand').value),
      stock_reserved: Number(document.getElementById('s-reserved').value),
      stock_in_transit: Number(document.getElementById('s-transit').value),
      safety_stock: Number(document.getElementById('s-safety').value)
    })
    toast('Stock mis a jour'); closeModal(); loadStock()
  } catch(err) { toast('Erreur','error') }
}

function showAddSkuModal() {
  document.getElementById('modals').innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal" style="max-width:560px">' +
      '<h2 class="text-lg font-bold mb-4"><i class="fas fa-box-open mr-2 text-indigo-400"></i>Ajouter un SKU</h2>' +
      '<form onsubmit="saveNewSku(event)" class="grid md:grid-cols-2 gap-3">' +
        '<div><label class="text-xs text-gray-400">SKU *</label><input id="new-sku" required placeholder="TSHIRT-BLK-M"></div>' +
        '<div><label class="text-xs text-gray-400">Nom produit *</label><input id="new-nom" required placeholder="T-shirt Noir M"></div>' +
        '<div><label class="text-xs text-gray-400">Categorie</label><input id="new-cat" placeholder="Vetements"></div>' +
        '<div><label class="text-xs text-gray-400">Sous-categorie</label><input id="new-subcat" placeholder="T-shirt"></div>' +
        '<div><label class="text-xs text-gray-400">Cout unitaire</label><input id="new-cost" type="number" step="0.01" value="0"></div>' +
        '<div><label class="text-xs text-gray-400">Prix vente</label><input id="new-price" type="number" step="0.01" value="0"></div>' +
        '<div><label class="text-xs text-gray-400">Lead time (jours)</label><input id="new-lead" type="number" value="7"></div>' +
        '<div><label class="text-xs text-gray-400">Seuil securite</label><input id="new-safety" type="number" value="5"></div>' +
        '<div><label class="text-xs text-gray-400">Quantite reappro</label><input id="new-reorder" type="number" value="20"></div>' +
        '<div><label class="text-xs text-gray-400">Stock initial</label><input id="new-onhand" type="number" value="0"></div>' +
        '<div class="md:col-span-2 flex justify-end gap-3 pt-3 border-t border-white/5">' +
          '<button type="button" onclick="closeModal()" class="btn btn-outline">Annuler</button>' +
          '<button type="submit" class="btn btn-primary">Creer SKU</button>' +
        '</div>' +
      '</form>' +
    '</div>' +
  '</div>'
}

async function saveNewSku(e) {
  e.preventDefault()
  try {
    await api.post('/stock', {
      sku: document.getElementById('new-sku').value,
      nom: document.getElementById('new-nom').value,
      categorie: document.getElementById('new-cat').value,
      sous_categorie: document.getElementById('new-subcat').value,
      unit_cost: Number(document.getElementById('new-cost').value),
      unit_price: Number(document.getElementById('new-price').value),
      lead_time_days: Number(document.getElementById('new-lead').value),
      safety_stock: Number(document.getElementById('new-safety').value),
      reorder_qty: Number(document.getElementById('new-reorder').value),
      stock_on_hand: Number(document.getElementById('new-onhand').value)
    })
    toast('SKU ajoute avec succes')
    closeModal()
    loadStock()
  } catch (err) {
    toast(err.response?.data?.error || 'Erreur creation SKU', 'error')
  }
}

function showStockEntryModal() {
  const options = (state.stock || []).map((s) => '<option value="' + s.id + '">' + (s.sku || '') + ' - ' + (s.nom || '') + '</option>').join('')
  document.getElementById('modals').innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal" style="max-width:500px">' +
      '<h2 class="text-lg font-bold mb-4"><i class="fas fa-plus mr-2 text-emerald-400"></i>Entree de stock</h2>' +
      '<form onsubmit="saveStockEntry(event)" class="space-y-3">' +
        '<div><label class="text-xs text-gray-400">Article</label><select id="entry-item-id" required><option value="">-- Choisir --</option>' + options + '</select></div>' +
        '<div><label class="text-xs text-gray-400">Quantite *</label><input id="entry-qty" type="number" min="1" value="1" required></div>' +
        '<div><label class="text-xs text-gray-400">Cout unitaire</label><input id="entry-cost" type="number" step="0.01" value="0"></div>' +
        '<div><label class="text-xs text-gray-400">Note</label><input id="entry-note" placeholder="Reception fournisseur"></div>' +
        '<div class="flex justify-end gap-3 pt-3 border-t border-white/5">' +
          '<button type="button" onclick="closeModal()" class="btn btn-outline">Annuler</button>' +
          '<button type="submit" class="btn btn-primary">Enregistrer</button>' +
        '</div>' +
      '</form>' +
    '</div>' +
  '</div>'
}

async function saveStockEntry(e) {
  e.preventDefault()
  const id = Number(document.getElementById('entry-item-id').value || 0)
  if (!id) { toast('Selectionnez un article', 'error'); return }
  try {
    await api.post('/stock/' + id + '/entry', {
      quantity: Number(document.getElementById('entry-qty').value),
      unit_cost: Number(document.getElementById('entry-cost').value),
      notes: document.getElementById('entry-note').value
    })
    toast('Entree de stock enregistree')
    closeModal()
    loadStock()
  } catch (err) {
    toast(err.response?.data?.error || 'Erreur entree stock', 'error')
  }
}

async function loadEquipe() {
  const { data } = await api.get('/team-members')
  state.equipe = data || []
  const rows = state.equipe.map(m => {
    const perms = (() => { try { return JSON.parse(m.permissions_json || '[]') } catch { return [] } })()
    return '<tr>' +
      '<td class="font-medium text-white">' + (m.nom || '') + '</td>' +
      '<td class="text-gray-300">' + (m.email || '--') + '</td>' +
      '<td class="text-gray-300">' + (m.telephone || '--') + '</td>' +
      '<td>' + rolePill(m.role) + '</td>' +
      '<td class="text-gray-300 text-xs">' + (perms.length ? perms.join(', ') : '--') + '</td>' +
      '<td>' + accessPill(m.can_access_platform, m.active) + '</td>' +
      '<td><div class="flex gap-1">' +
        '<button onclick="showTeamMemberModal(state.equipe.find(x => x.id === ' + m.id + '))" class="btn btn-outline text-xs py-1 px-2"><i class="fas fa-pen"></i></button>' +
        '<button onclick="toggleTeamMemberAccess(' + m.id + ', ' + (m.can_access_platform ? 0 : 1) + ')" class="btn btn-warning text-xs py-1 px-2"><i class="fas fa-key"></i></button>' +
        '<button onclick="toggleTeamMemberActive(' + m.id + ', ' + (m.active ? 0 : 1) + ')" class="btn btn-success text-xs py-1 px-2"><i class="fas fa-power-off"></i></button>' +
        '<button onclick="deleteTeamMember(' + m.id + ')" class="btn btn-danger text-xs py-1 px-2"><i class="fas fa-trash"></i></button>' +
      '</div></td>' +
    '</tr>'
  }).join('')
  if (!state.wilayasFull) {
    const { data } = await api.get('/wilayas-full')
    state.wilayasFull = data
  }
  document.getElementById('view-equipe').innerHTML = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">' +
    '<div><h1 class="text-2xl font-bold"><i class="fas fa-user-shield text-indigo-400 mr-2"></i>Equipe</h1><p class="text-gray-400 text-sm">Gestion confirmateurs/livreurs et acces plateforme</p></div>' +
    '<button onclick="showTeamMemberModal()" class="btn btn-primary"><i class="fas fa-user-plus mr-1"></i> Ajouter membre</button>' +
    '</div>' +
    '<div class="card overflow-x-auto"><table><thead><tr><th>Nom</th><th>Email</th><th>Telephone</th><th>Role</th><th>Permissions</th><th>Acces</th><th>Actions</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    (state.equipe.length === 0 ? '<div class="text-center py-12 text-gray-500"><i class="fas fa-users text-4xl mb-3 block"></i><p>Aucun membre d&apos;equipe</p></div>' : '') +
    '</div>'
}


function showTeamMemberModal(editMember) {
  var isEdit = !!editMember
  var title = isEdit ? 'Modifier membre' : 'Ajouter membre'
  var icon = isEdit ? 'fa-pen-to-square text-indigo-400' : 'fa-user-plus text-emerald-400'
  
  var m = editMember || { nom: '', email: '', telephone: '', role: 'confirmateur', active: 1, can_access_platform: 1, permissions_json: '[]' }
  var perms = []
  try { perms = JSON.parse(m.permissions_json || '[]') } catch(e) { perms = [] }

  document.getElementById('modals').innerHTML = '<div class="modal-overlay-v2" onclick="closeModalV2(event)">' +
    '<div class="modal-v2" style="max-width: 650px" onclick="event.stopPropagation()">' +
      '<div class="modal-v2-header">' +
        '<h2><span class="header-icon bg-gray-800"><i class="fas ' + icon + '"></i></span> ' + title + '</h2>' +
        '<button class="modal-v2-close" onclick="closeModalAnimated()"><i class="fas fa-xmark"></i></button>' +
      '</div>' +
      '<div class="modal-v2-body">' +
        '<form id="team-member-form" onsubmit="submitTeamMember(event' + (isEdit ? ', ' + m.id : '') + ')">' +
          '<div class="modal-v2-section">' +
            '<h3><i class="fas fa-id-card"></i> INFORMATIONS GÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°NÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°RALES</h3>' +
            '<div class="form-grid">' +
              '<div class="float-field">' +
                '<i class="fas fa-user field-icon"></i>' +
                '<input type="text" id="m-nom" value="' + (m.nom || '') + '" placeholder=" " required>' +
                '<label>Nom complet</label>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-envelope field-icon"></i>' +
                '<input type="email" id="m-email" value="' + (m.email || '') + '" placeholder=" " required>' +
                '<label>Email de connexion</label>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-phone field-icon"></i>' +
                '<input type="text" id="m-phone" value="' + (m.telephone || '') + '" placeholder=" ">' +
                '<label>TÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©lÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©phone</label>' +
              '</div>' +
              '<div class="float-field">' +
                '<i class="fas fa-lock field-icon"></i>' +
                '<input type="password" id="m-pass" placeholder=" " ' + (isEdit ? '' : 'required') + '>' +
                '<label>' + (isEdit ? 'Nouveau mot de passe (optionnel)' : 'Mot de passe') + '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +
          
          '<div class="modal-v2-section">' +
            '<h3><i class="fas fa-shield-halved"></i> SÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°CURITÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â° & RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚ÂLE</h3>' +
            '<div class="form-grid">' +
              '<div>' +
                '<label class="field-label">RÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â´le SystÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨me</label>' +
                '<select id="m-role" class="v2-select">' +
                  '<option value="confirmateur" ' + (m.role === 'confirmateur' ? 'selected' : '') + '>Confirmateur (Standard)</option>' +
                  '<option value="livreur" ' + (m.role === 'livreur' ? 'selected' : '') + '>Livreur / Partenaire</option>' +
                  '<option value="admin" ' + (m.role === 'admin' ? 'selected' : '') + '>Administrateur</option>' +
                '</select>' +
              '</div>' +
              '<div class="flex items-center justify-between p-3 bg-white/3 rounded-xl border border-white/5">' +
                '<div>' +
                  '<div class="text-sm font-bold">AccÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨s Plateforme</div>' +
                  '<div class="text-[10px] text-gray-500">Autoriser la connexion</div>' +
                '</div>' +
                '<label class="v2-toggle">' +
                  '<input type="checkbox" id="m-access" ' + (m.can_access_platform ? 'checked' : '') + '>' +
                  '<span class="v2-toggle-slider"></span>' +
                '</label>' +
              '</div>' +
            '</div>' +
          '</div>' +

          '<div class="modal-v2-section">' +
            '<div class="flex items-center justify-between mb-4">' +
              '<h3><i class="fas fa-key"></i> PERMISSIONS OPÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â°RATIONNELLES</h3>' +
              '<div class="flex gap-2">' +
                '<button type="button" onclick="toggleAllPerms(true)" class="text-[10px] text-indigo-400 hover:underline">Tout ON</button>' +
                '<button type="button" onclick="toggleAllPerms(false)" class="text-[10px] text-gray-500 hover:underline">Tout OFF</button>' +
              '</div>' +
            '</div>' +
            '<div class="grid grid-cols-1 md:grid-cols-3 gap-3">' +
              permissionToggle('Confirmation', 'confirmation', perms.includes('confirmation')) +
              permissionToggle('Suivi Colis', 'suivi', perms.includes('suivi')) +
              permissionToggle('Gestion Stock', 'stock', perms.includes('stock')) +
            '</div>' +
          '</div>' +
          
          '<div class="modal-v2-footer">' +
            '<button type="button" class="btn-v2-cancel" onclick="closeModalAnimated()">Annuler</button>' +
            '<button type="submit" class="btn-v2-submit"><i class="fas fa-check"></i> ' + (isEdit ? 'Enregistrer les modifications' : 'CrÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©er le membre') + '</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>' +
  '</div>'
}

function permissionToggle(label, id, checked) {
  return '<div class="flex items-center justify-between p-3 bg-white/2 rounded-lg border border-white/5">' +
    '<span class="text-xs font-medium">' + label + '</span>' +
    '<label class="v2-toggle scale-75">' +
      '<input type="checkbox" class="perm-checkbox" data-perm="' + id + '" ' + (checked ? 'checked' : '') + '>' +
      '<span class="v2-toggle-slider"></span>' +
    '</label>' +
  '</div>'
}

function toggleAllPerms(val) {
  document.querySelectorAll('.perm-checkbox').forEach(cb => cb.checked = val)
}

async function submitTeamMember(e, id) {
  e.preventDefault()
  var isEdit = !!id
  var perms = []
  document.querySelectorAll('.perm-checkbox:checked').forEach(cb => perms.push(cb.getAttribute('data-perm')))
  
  var payload = {
    nom: document.getElementById('m-nom').value,
    email: document.getElementById('m-email').value,
    telephone: document.getElementById('m-phone').value,
    role: document.getElementById('m-role').value,
    can_access_platform: document.getElementById('m-access').checked ? 1 : 0,
    permissions_json: JSON.stringify(perms)
  }
  
  var pass = document.getElementById('m-pass').value
  if(pass) payload.password = pass

  try {
    if(isEdit) await api.put('/team-members/' + id, payload)
    else await api.post('/team-members', payload)
    
    toast(isEdit ? 'Membre mis ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â  jour' : 'Membre ajoutÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â© avec succÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¨s')
    closeModalAnimated()
    loadEquipe()
  } catch(err) {
    toast(err.response?.data?.error || 'Erreur lors de l\\'enregistrement', 'error')
  }
}

// ===================== STORE SOURCES =====================
async function loadSources() {
  const { data } = await api.get('/store-sources')
  state.storeSources = data

  let html = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">' +
    '<div><h1 class="text-2xl font-bold">Boutique</h1><p class="text-gray-400 text-sm">Connectez vos boutiques Shopify, WooCommerce ou YouCan</p></div>' +
    '</div>'

  if (data.length === 0) {
    html += '<div style="max-width:800px;margin:40px auto;text-align:center">' +
      '<div style="margin-bottom:32px">' +
        '<div style="width:64px;height:64px;margin:0 auto 16px;border-radius:16px;background:rgba(99,102,241,0.1);display:flex;align-items:center;justify-content:center">' +
          '<i class="fas fa-store text-2xl text-indigo-400"></i>' +
        '</div>' +
        '<h3 style="font-size:20px;font-weight:700;color:#fff;margin-bottom:8px">Connectez votre boutique</h3>' +
        '<p style="color:#64748b;font-size:14px;max-width:500px;margin:0 auto">Importez automatiquement vos commandes depuis votre plateforme e-commerce</p>' +
      '</div>' +
      
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:32px">' +
        
        '<!-- Carte Shopify -->' +
        '<div onclick="showConnectStoreModal(\'shopify\')" style="cursor:pointer;background:rgba(21,29,48,0.6);border:1.5px solid rgba(255,255,255,0.06);border-radius:16px;padding:28px 20px;transition:all 0.3s;text-align:center" onmouseover="this.style.borderColor=\'rgba(150,191,72,0.4)\';this.style.transform=\'translateY(-4px)\';this.style.boxShadow=\'0 12px 40px rgba(150,191,72,0.1)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.06)\';this.style.transform=\'none\';this.style.boxShadow=\'none\'">' +
          '<div style="width:56px;height:56px;margin:0 auto 16px;border-radius:14px;background:rgba(150,191,72,0.1);display:flex;align-items:center;justify-content:center">' +
            '<i class="fab fa-shopify" style="font-size:28px;color:#96bf48"></i>' +
          '</div>' +
          '<div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:4px">Shopify</div>' +
          '<div style="font-size:12px;color:#64748b;margin-bottom:16px">Importez vos commandes Shopify</div>' +
          '<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:rgba(150,191,72,0.1);color:#96bf48;font-size:12px;font-weight:600">' +
            '<i class="fas fa-plug" style="font-size:10px"></i> Connecter' +
          '</div>' +
        '</div>' +

        '<!-- Carte WooCommerce -->' +
        '<div onclick="showConnectStoreModal(\'woocommerce\')" style="cursor:pointer;background:rgba(21,29,48,0.6);border:1.5px solid rgba(255,255,255,0.06);border-radius:16px;padding:28px 20px;transition:all 0.3s;text-align:center" onmouseover="this.style.borderColor=\'rgba(150,100,200,0.4)\';this.style.transform=\'translateY(-4px)\';this.style.boxShadow=\'0 12px 40px rgba(150,100,200,0.1)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.06)\';this.style.transform=\'none\';this.style.boxShadow=\'none\'">' +
          '<div style="width:56px;height:56px;margin:0 auto 16px;border-radius:14px;background:rgba(150,100,200,0.1);display:flex;align-items:center;justify-content:center">' +
            '<i class="fab fa-wordpress" style="font-size:28px;color:#9b5c8f"></i>' +
          '</div>' +
          '<div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:4px">WooCommerce</div>' +
          '<div style="font-size:12px;color:#64748b;margin-bottom:16px">Sync automatique WordPress</div>' +
          '<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:rgba(150,100,200,0.1);color:#9b5c8f;font-size:12px;font-weight:600">' +
            '<i class="fas fa-plug" style="font-size:10px"></i> Connecter' +
          '</div>' +
        '</div>' +

        '<!-- Carte YouCan -->' +
        '<div onclick="showConnectStoreModal(\'youcan\')" style="cursor:pointer;background:rgba(21,29,48,0.6);border:1.5px solid rgba(255,255,255,0.06);border-radius:16px;padding:28px 20px;transition:all 0.3s;text-align:center" onmouseover="this.style.borderColor=\'rgba(59,130,246,0.4)\';this.style.transform=\'translateY(-4px)\';this.style.boxShadow=\'0 12px 40px rgba(59,130,246,0.1)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.06)\';this.style.transform=\'none\';this.style.boxShadow=\'none\'">' +
          '<div style="width:56px;height:56px;margin:0 auto 16px;border-radius:14px;background:rgba(59,130,246,0.1);display:flex;align-items:center;justify-content:center">' +
            '<i class="fas fa-shopping-bag" style="font-size:24px;color:#60a5fa"></i>' +
          '</div>' +
          '<div style="font-size:16px;font-weight:700;color:#fff;margin-bottom:4px">YouCan</div>' +
          '<div style="font-size:12px;color:#64748b;margin-bottom:16px">Boutique YouCan Shop</div>' +
          '<div style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:8px;background:rgba(59,130,246,0.1);color:#60a5fa;font-size:12px;font-weight:600">' +
            '<i class="fas fa-plug" style="font-size:10px"></i> Connecter' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<!-- SÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â©parateur avec Configuration Intelligente -->' +
      '<div style="border-top:1px solid rgba(255,255,255,0.05);padding-top:24px">' +
        '<div style="display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:12px">' +
          '<div style="height:1px;flex:1;max-width:100px;background:rgba(255,255,255,0.06)"></div>' +
          '<span style="font-size:12px;color:#64748b">ou</span>' +
          '<div style="height:1px;flex:1;max-width:100px;background:rgba(255,255,255,0.06)"></div>' +
        '</div>' +
        '<button onclick="showIntelligentConfigModal()" style="cursor:pointer;background:linear-gradient(135deg,rgba(99,102,241,0.1),rgba(139,92,246,0.1));border:1.5px solid rgba(99,102,241,0.2);border-radius:12px;padding:16px 28px;color:#818cf8;font-size:14px;font-weight:600;transition:all 0.3s;display:inline-flex;align-items:center;gap:10px" onmouseover="this.style.borderColor=\'rgba(99,102,241,0.5)\';this.style.transform=\'translateY(-2px)\'" onmouseout="this.style.borderColor=\'rgba(99,102,241,0.2)\';this.style.transform=\'none\'">' +
          '<i class="fas fa-wand-magic-sparkles"></i> Configuration intelligente' +
          '<span style="font-size:11px;color:#64748b;font-weight:400">ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â Collez l\'URL, on detecte tout</span>' +
        '</button>' +
      '</div>' +
    '</div>'
  } else {
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:32px">' +
      '<div onclick="showConnectStoreModal(\'shopify\')" style="cursor:pointer;background:rgba(21,29,48,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;display:flex;align-items:center;gap:12px;transition:all 0.2s" onmouseover="this.style.borderColor=\'rgba(150,191,72,0.4)\';this.style.background=\'rgba(150,191,72,0.05)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.06)\';this.style.background=\'rgba(21,29,48,0.6)\'">' +
        '<div style="width:40px;height:40px;border-radius:10px;background:rgba(150,191,72,0.1);display:flex;align-items:center;justify-content:center"><i class="fab fa-shopify text-xl" style="color:#96bf48"></i></div>' +
        '<div><div style="font-size:14px;font-weight:600;color:#fff">Shopify</div><div style="font-size:11px;color:#64748b">Connecter une boutique</div></div>' +
      '</div>' +
      '<div onclick="showConnectStoreModal(\'woocommerce\')" style="cursor:pointer;background:rgba(21,29,48,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;display:flex;align-items:center;gap:12px;transition:all 0.2s" onmouseover="this.style.borderColor=\'rgba(150,100,200,0.4)\';this.style.background=\'rgba(150,100,200,0.05)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.06)\';this.style.background=\'rgba(21,29,48,0.6)\'">' +
        '<div style="width:40px;height:40px;border-radius:10px;background:rgba(150,100,200,0.1);display:flex;align-items:center;justify-content:center"><i class="fab fa-wordpress text-xl" style="color:#9b5c8f"></i></div>' +
        '<div><div style="font-size:14px;font-weight:600;color:#fff">WooCommerce</div><div style="font-size:11px;color:#64748b">Connecter une boutique</div></div>' +
      '</div>' +
      '<div onclick="showConnectStoreModal(\'youcan\')" style="cursor:pointer;background:rgba(21,29,48,0.6);border:1px solid rgba(255,255,255,0.06);border-radius:12px;padding:16px;display:flex;align-items:center;gap:12px;transition:all 0.2s" onmouseover="this.style.borderColor=\'rgba(59,130,246,0.4)\';this.style.background=\'rgba(59,130,246,0.05)\'" onmouseout="this.style.borderColor=\'rgba(255,255,255,0.06)\';this.style.background=\'rgba(21,29,48,0.6)\'">' +
        '<div style="width:40px;height:40px;border-radius:10px;background:rgba(59,130,246,0.1);display:flex;align-items:center;justify-content:center"><i class="fas fa-shopping-bag text-xl" style="color:#60a5fa"></i></div>' +
        '<div><div style="font-size:14px;font-weight:600;color:#fff">YouCan</div><div style="font-size:11px;color:#64748b">Connecter une boutique</div></div>' +
      '</div>' +
    '</div>'

    html += '<h3 class="text-lg font-bold mb-4">Vos boutiques connectees</h3>'
    html += '<div class="grid md:grid-cols-2 lg:grid-cols-3 gap-4">'
    html += data.map(s => {
      const isWoo = s.platform === 'woocommerce'
      const wooConnected = isWoo && s.consumer_key && s.consumer_secret
      const isConnected = isWoo ? wooConnected : true
      
      const icon = s.platform === 'shopify' ? 'fab fa-shopify' : s.platform === 'woocommerce' ? 'fab fa-wordpress' : s.platform === 'youcan' ? 'fas fa-shopping-bag' : 'fas fa-globe'
      const iconColor = s.platform === 'shopify' ? 'text-green-400' : s.platform === 'woocommerce' ? 'text-purple-400' : s.platform === 'youcan' ? 'text-blue-400' : 'text-gray-400'
      const bgIconColor = s.platform === 'shopify' ? 'bg-green-500/10' : s.platform === 'woocommerce' ? 'bg-purple-500/10' : s.platform === 'youcan' ? 'bg-blue-500/10' : 'bg-gray-500/10'
      const badgeConnected = isConnected

      return '<div class="card p-5">' +
          '<div class="flex items-center justify-between mb-4">' +
            '<div class="flex items-center gap-3">' +
              '<div class="w-10 h-10 rounded-lg flex items-center justify-center ' + bgIconColor + '">' +
                '<i class="' + icon + ' text-lg ' + iconColor + '"></i>' +
              '</div>' +
              '<div>' +
                '<div class="font-medium text-sm capitalize">' + s.platform + '</div>' +
                '<div class="text-xs text-gray-400">' + s.domain + '</div>' +
              '</div>' +
            '</div>' +
            '<div class="flex items-center gap-2">' +
              (badgeConnected 
                ? '<span class="inline-flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full"><i class="fas fa-check-circle"></i>Connecte</span>' 
                : '<span class="inline-flex items-center gap-1 text-[10px] text-orange-400 bg-orange-500/10 px-2 py-0.5 rounded-full"><i class="fas fa-exclamation-circle"></i>Non connecte</span>') +
            '</div>' +
          '</div>' +
          (isWoo && wooConnected ? '<div class="mb-3"><button onclick="importWooOrders(' + s.id + ')" class="btn btn-success text-xs w-full"><i class="fas fa-download mr-1"></i>Importer commandes</button></div>' : '') +
          (isWoo && !wooConnected ? '<div class="mb-3"><button onclick="connectWooCommerce(\'' + s.domain + '\')" class="btn text-xs w-full" style="background:linear-gradient(135deg,#10b981,#059669);color:white;border:none"><i class="fas fa-plug mr-1"></i>Connecter AutoHub DZ</button></div>' : '') +
          '<div class="flex gap-2 mt-4 pt-4 border-t border-white/5 justify-between">' +
            '<span class="text-xs text-gray-500">' + (isWoo ? 'Sync Auto' : 'Sync manuelle') + '</span>' +
            '<button onclick="deleteSource(' + s.id + ')" class="btn btn-danger text-xs px-3 py-1"><i class="fas fa-trash mr-1"></i> Deconnecter</button>' +
          '</div>' +
        '</div>'
    }).join('')
    html += '</div>'
  }

  document.getElementById('view-boutique').innerHTML = html
}

function showConnectStoreModal(platform) {
  let title = platform === 'shopify' ? 'Shopify' : platform === 'woocommerce' ? 'WooCommerce' : 'YouCan'
  let icon = platform === 'shopify' ? 'fab fa-shopify" style="color:#96bf48' : platform === 'woocommerce' ? 'fab fa-wordpress" style="color:#9b5c8f' : 'fas fa-shopping-bag" style="color:#60a5fa'
  
  let content = ''
  if (platform === 'woocommerce') {
    content = '<div class="float-field mb-4">' +
        '<i class="fas fa-globe field-icon"></i>' +
        '<input type="text" id="woo-domain-connect" placeholder=" " required>' +
        '<label>Domaine de votre boutique</label>' +
      '</div>' +
      '<div class="text-xs text-gray-400 mb-2"><i class="fas fa-info-circle text-indigo-400 mr-1"></i> Ex: maboutique.com (sans https://)</div>'
  } else if (platform === 'shopify') {
    content = '<div class="float-field mb-4">' +
        '<i class="fas fa-link field-icon"></i>' +
        '<input type="text" id="shopify-url-connect" placeholder=" ">' +
        '<label>URL Shopify</label>' +
      '</div>' +
      '<div class="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-300 text-sm mb-2 text-center">' +
        '<i class="fas fa-tools mr-1"></i> Connexion API bientot disponible' +
      '</div>'
  } else {
    content = '<div class="float-field mb-4">' +
        '<i class="fas fa-link field-icon"></i>' +
        '<input type="text" id="youcan-url-connect" placeholder=" ">' +
        '<label>URL YouCan</label>' +
      '</div>' +
      '<div class="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-300 text-sm mb-2 text-center">' +
        '<i class="fas fa-tools mr-1"></i> Connexion API bientot disponible' +
      '</div>'
  }

  document.getElementById('modals').innerHTML = '<div class="modal-overlay-v2" onclick="closeModalV2(event)">' +
      '<div class="modal-v2" style="max-width:450px" onclick="event.stopPropagation()">' +
        '<div class="modal-v2-header">' +
          '<h2><span class="header-icon bg-gray-800"><i class="' + icon + '"></i></span> Connexion ' + title + '</h2>' +
          '<button class="modal-v2-close" onclick="closeModalAnimated()"><i class="fas fa-xmark"></i></button>' +
        '</div>' +
        '<div class="modal-v2-body">' +
          '<div class="modal-v2-section border-0 p-0 m-0">' +
            '<div class="form-grid" style="grid-template-columns: 1fr;">' +
              content +
            '</div>' +
          '</div>' +
          '<div class="modal-v2-footer">' +
            '<button class="btn-v2-cancel" onclick="closeModalAnimated()">Annuler</button>' +
            '<button class="btn-v2-submit" id="btn-submit-connect" onclick="submitConnectStore(\'' + platform + '\')"><i class="fas fa-plug"></i> Connecter</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
}

async function submitConnectStore(platform) {
  if (platform === 'woocommerce') {
    const domain = document.getElementById('woo-domain-connect').value.trim()
    if (!domain) { toast('Le domaine est requis', 'error'); return }
    const loadingBtn = document.getElementById('btn-submit-connect')
    loadingBtn.innerHTML = '<span class="spinner-sm"></span> Connexion...'
    loadingBtn.disabled = true
    try {
      await api.post('/store-sources', { platform: 'woocommerce', domain, active: 1 })
      toast('Boutique WooCommerce ajoutee!')
      setTimeout(() => { window.location.href = '/api/woo/connect?domain=' + encodeURIComponent(domain) }, 500)
    } catch(e) {
      toast(e.response?.data?.error || 'Erreur', 'error')
      loadingBtn.innerHTML = '<i class="fas fa-plug"></i> Connecter'
      loadingBtn.disabled = false
    }
  } else {
    toast('Connexion API pour ' + platform + ' bientot disponible', 'error')
    closeModalAnimated()
  }
}

function showIntelligentConfigModal() {
  document.getElementById('modals').innerHTML = '<div class="modal-overlay-v2" onclick="closeModalV2(event)">' +
      '<div class="modal-v2" style="max-width:500px" onclick="event.stopPropagation()">' +
        '<div class="modal-v2-header">' +
          '<h2><span class="header-icon bg-indigo-500/20 text-indigo-400"><i class="fas fa-wand-magic-sparkles"></i></span> Configuration intelligente</h2>' +
          '<button class="modal-v2-close" onclick="closeModalAnimated()"><i class="fas fa-xmark"></i></button>' +
        '</div>' +
        '<div class="modal-v2-body">' +
          '<div class="modal-v2-section mb-0">' +
            '<p class="text-sm text-gray-400 mb-4">Entrez l\'URL de votre boutique. Nous detecterons la plateforme et configurerons l\'integration automatiquement.</p>' +
            '<div id="smart-config-content">' +
              '<div class="float-field mb-4">' +
                '<i class="fas fa-globe field-icon"></i>' +
                '<input type="url" id="smart-store-url" placeholder=" " required>' +
                '<label>URL de votre boutique</label>' +
              '</div>' +
            '</div>' +
            '<div id="smart-result" class="hidden"></div>' +
          '</div>' +
          '<div class="modal-v2-footer">' +
            '<button class="btn-v2-cancel" onclick="closeModalAnimated()">Annuler</button>' +
            '<button class="btn-v2-submit" id="smart-submit-btn" onclick="submitIntelligentConfig()"><i class="fas fa-search"></i> <span id="smart-submit-text">Detecter automatiquement</span></button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>'
}

async function submitIntelligentConfig() {
  const url = document.getElementById('smart-store-url').value.trim()
  if (!url) { toast('URL requise', 'error'); return }

  const btn = document.getElementById('smart-submit-btn')
  const resultDiv = document.getElementById('smart-result')
  const contentDiv = document.getElementById('smart-config-content')
  
  btn.disabled = true
  btn.innerHTML = '<span class="spinner-sm"></span> Detection...'

  try {
    const { data } = await api.post('/store-sources/intelligent-config', { store_url: url })
    
    // Icon and colors
    const icon = data.platform === 'shopify' ? 'fab fa-shopify' : data.platform === 'woocommerce' ? 'fab fa-wordpress' : data.platform === 'youcan' ? 'fas fa-shopping-bag' : 'fas fa-globe'
    const color = data.platform === 'shopify' ? 'text-green-400' : data.platform === 'woocommerce' ? 'text-purple-400' : data.platform === 'youcan' ? 'text-blue-400' : 'text-indigo-400'
    const bg = data.platform === 'shopify' ? 'bg-green-500/10' : data.platform === 'woocommerce' ? 'bg-purple-500/10' : data.platform === 'youcan' ? 'bg-blue-500/10' : 'bg-indigo-500/10'
    
    // Hide input, show result
    contentDiv.classList.add('hidden')
    resultDiv.classList.remove('hidden')
    
    resultDiv.innerHTML = '<div class="p-4 rounded-xl border border-white/10 bg-dark-900/50 mb-4 text-center">' +
        '<div class="w-16 h-16 rounded-2xl mx-auto mb-3 flex items-center justify-center ' + bg + '">' +
          (data.logo ? '<img src="' + encodeURI(data.logo) + '" class="w-10 h-10 object-contain">' : '<i class="' + icon + ' text-3xl ' + color + '"></i>') +
        '</div>' +
        '<div class="font-bold text-lg text-white mb-1">' + (data.name || 'Boutique detectee') + '</div>' +
        '<div class="text-sm font-medium ' + color + ' capitalize mb-2">' + (data.platform) + '</div>' +
        '<div class="text-xs text-gray-500">' + (data.domain) + '</div>' +
      '</div>' +
      '<div class="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-300 text-sm text-center">' +
        '<i class="fas fa-check-circle mr-1"></i> Plateforme detectee et configuree avec succes !' +
      '</div>'
      
    toast('Configuration reussie !')
    btn.innerHTML = '<i class="fas fa-check"></i> Terminer'
    btn.disabled = false
    btn.onclick = () => {
      closeModalAnimated()
      loadSources()
      if (data.platform === 'woocommerce') {
        setTimeout(() => connectWooCommerce(data.domain), 500)
      }
    }
  } catch(e) {
    toast(e.response?.data?.error || 'Erreur lors de la configuration', 'error')
    btn.innerHTML = '<i class="fas fa-search"></i> <span id="smart-submit-text">Detecter automatiquement</span>'
    btn.disabled = false
  }
}
async function loadUtilisateurs() {
  try {
    const { data } = await api.get('/admin/users')
    const rows = data.map(u => {
      const isSelf = u.id === state.user.id
      const dis = isSelf ? 'disabled' : ''
      const r = u.role || 'client'
      const s = u.subscription || 'starter'
      const a = (u.active === 1 || u.active === true) ? 1 : 0
      
      return '<tr>' +
        '<td class="text-gray-400">' + u.id + '</td>' +
        '<td class="font-medium text-white">' + escapeHtml(u.username) + '</td>' +
        '<td class="text-gray-300 text-sm">' + escapeHtml(u.email || '') + '</td>' +
        '<td class="text-gray-300 text-sm max-w-[140px] truncate">' + escapeHtml(u.store_name || '') + '</td>' +
        '<td><select ' + dis + ' onchange="adminUpdateUser(' + u.id + ', \\'role\\', this.value)" class="text-xs bg-dark-800 border border-white/10 rounded px-2 py-1">' +
  } catch (e) {
    document.getElementById('view-utilisateurs').innerHTML = '<div class="text-red-400">Impossible de charger les utilisateurs.</div>'
  }
}

async function adminUpdateUser(id, field, value) {
  try {
    const body = {}
    if (field === 'role') body.role = value
    else if (field === 'active') body.active = Number(value)
    else if (field === 'subscription') body.subscription = value
    
    await api.put('/admin/users/' + id, body)
    toast('Utilisateur mis a jour')
    await loadUtilisateurs()
  } catch (e) {
    await loadUtilisateurs()
  }
}

// ===================== WILAYAS & COMMUNES BROWSER =====================
async function loadWilayasPage() {
  if (!state.wilayasFull) {
async function loadWilayasPage() {
  if (!state.wilayasFull) {
    const { data } = await api.get('/wilayas-full')
    state.wilayasFull = data
  }
  const container = document.getElementById('view-wilayaspage')
  if (!container) return
  container.innerHTML = \`
    <div class="mb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl font-bold"><i class="fas fa-map-marked-alt text-indigo-400 mr-2"></i>Wilayas & Communes</h1>
        <p class="text-gray-400 text-sm">Consultez les zones de livraison et activez/désactivez des communes.</p>
      </div>
      <div class="flex gap-2">
        <button onclick="toggleAllWilayas()" class="btn btn-outline text-xs"><i class="fas fa-layer-group mr-1"></i> Tout basculer</button>
      </div>
    </div>
    <div class="mb-6 relative">
      <i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-gray-500"></i>
      <input type="text" oninput="filterWilayas(this.value)" placeholder="Rechercher une wilaya ou une commune..." class="w-full pl-12 pr-4 py-3 bg-white/5 border border-white/10 rounded-xl focus:border-indigo-500/50 transition-all outline-none">
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4" id="wilayas-grid">
      \${state.wilayasFull.map(w => \`
        <div class="wilaya-card card border border-white/5 bg-white/2 hover:border-white/10 transition-all" data-wilaya-name="\${w.name.toLowerCase()}">
          <button onclick="toggleWilaya(this)" class="w-full flex items-center justify-between p-4" aria-expanded="false">
            <div class="flex items-center gap-3">
              <span class="w-8 h-8 rounded-lg bg-indigo-500/10 flex items-center justify-center font-bold text-indigo-400 text-xs">\${w.id}</span>
              <span class="font-bold text-gray-200">\${w.name}</span>
            </div>
            <i class="fas fa-chevron-down text-gray-600 transition-transform"></i>
          </button>
          <div class="hidden border-t border-white/5 bg-black/20 p-4">
             <div class="grid grid-cols-1 gap-2">
               \${w.communes.map(c => \`
                 <div class="commune-item flex items-center justify-between py-1.5 px-3 rounded-lg hover:bg-white/5 transition" data-commune-name="\${c.name.toLowerCase()}">
                   <div class="flex items-center gap-2">
                     <i class="fas fa-location-dot text-[10px] text-gray-600"></i>
                     <span class="text-sm text-gray-400">\${c.name}</span>
                   </div>
                   <div class="toggle-switch transform scale-75">
                     <input type="checkbox" \${c.active ? 'checked' : ''} onchange="toggleCommune(\${c.id}, this.checked)">
                     <label class="slider"></label>
                   </div>
                 </div>
               \`).join('')}
             </div>
          </div>
        </div>
      \`).join('')}
    </div>
  \`
}

function toggleAllWilayas() {
  const cards = document.querySelectorAll('.wilaya-card button[aria-expanded]')
  const allOpen = Array.from(cards).every(b => b.getAttribute('aria-expanded') === 'true')
  cards.forEach(b => {
    b.setAttribute('aria-expanded', allOpen ? 'false' : 'true')
    const panel = b.nextElementSibling
    if (panel) panel.classList.toggle('hidden', allOpen)
  })
}

function toggleWilaya(btn) {
  const expanded = btn.getAttribute('aria-expanded') === 'true'
  btn.setAttribute('aria-expanded', !expanded)
  const panel = btn.nextElementSibling
  if (panel) panel.classList.toggle('hidden')
  btn.querySelector('i').style.transform = expanded ? '' : 'rotate(180deg)'
}

function filterWilayas(query) {
  const q = query.toLowerCase().trim()
  const cards = document.querySelectorAll('.wilaya-card')
  document.querySelectorAll('.commune-highlight').forEach(el => el.classList.remove('commune-highlight'))
  cards.forEach(card => {
    const wname = card.dataset.wilayaName || ''
    const communes = card.querySelectorAll('.commune-item')
    let wilayaMatch = wname.includes(q)
    let communeMatch = false
    communes.forEach(c => {
      const cname = c.dataset.communeName || ''
      if (cname.includes(q)) {
        communeMatch = true
        if (q) c.classList.add('commune-highlight')
      } else {
        c.classList.remove('commune-highlight')
      }
    })
    const show = !q || wilayaMatch || communeMatch
    card.style.display = show ? '' : 'none'
    if (communeMatch && q) {
      const btn = card.querySelector('button[aria-expanded]')
      if (btn) {
        btn.setAttribute('aria-expanded', 'true')
        if (btn.nextElementSibling) btn.nextElementSibling.classList.remove('hidden')
      }
    }
  })
}

// ===================== DELIVERY COMPANIES =====================
async function loadDeliveryCompanies() {
  const { data } = await api.get('/delivery-companies')
  state.deliveryCompanies = data
  return data
}

function showAddCompanyModal(edit = null) {
  const c = edit || { name: '', api_type: 'manual', api_url: '', api_key: '', api_token: '', notes: '' }
  const isEdit = !!edit
  const title = (isEdit ? 'Modifier' : 'Ajouter') + ' Societe de Livraison'
  const icon = isEdit ? 'fa-pen-to-square' : 'fa-truck-fast'

  document.getElementById('modals').innerHTML = \`
    <div class="modal-overlay-v2" onclick="closeModalV2(event)">
      <div class="modal-v2" style="max-width:550px" onclick="event.stopPropagation()">
        <div class="modal-v2-header">
          <h2><span class="header-icon"><i class="fas \${icon}"></i></span> \${title}</h2>
          <button class="modal-v2-close" onclick="closeModalAnimated()"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="modal-v2-body">
          <form onsubmit="saveCompany(event, \${isEdit ? edit.id : 'null'})" class="space-y-4">
            <div class="modal-v2-section">
              <div class="modal-v2-section-title"><i class="fas fa-info-circle"></i> Identite</div>
              <div class="form-grid">
                <div class="float-field full-width">
                  <i class="fas fa-building field-icon"></i>
                  <input type="text" id="dc-name" value="\${c.name || ''}" placeholder=" " required>
                  <label>Nom de la societe *</label>
                </div>
              </div>
            </div>
            <div class="modal-v2-section">
              <div class="modal-v2-section-title"><i class="fas fa-plug"></i> Configuration API</div>
              <div class="form-grid">
                <div class="float-field">
                  <i class="fas fa-laptop-code field-icon"></i>
                  <select id="dc-type">
                    <option \${c.api_type === 'manual' ? 'selected' : ''} value="manual">Manuel (sans API)</option>
                    <option \${c.api_type === 'rest' ? 'selected' : ''} value="rest">REST API</option>
                    <option \${c.api_type === 'custom' ? 'selected' : ''} value="custom">Personnalise</option>
                  </select>
                  <label>Type d'API</label>
                </div>
                <div class="float-field">
                  <i class="fas fa-link field-icon"></i>
                  <input type="text" id="dc-url" value="\${c.api_url || ''}" placeholder=" ">
                  <label>URL de l'API</label>
                </div>
                <div class="float-field">
                  <i class="fas fa-key field-icon"></i>
                  <input type="password" id="dc-key" value="\${c.api_key || ''}" placeholder=" ">
                  <label>Cle API</label>
                </div>
                <div class="float-field">
                  <i class="fas fa-shield-cat field-icon"></i>
                  <input type="password" id="dc-token" value="\${c.api_token || ''}" placeholder=" ">
                  <label>Token / Secret</label>
                </div>
              </div>
            </div>
            <div class="modal-v2-section last">
               <div class="modal-v2-section-title"><i class="fas fa-comment-dots"></i> Notes</div>
               <div class="float-field full-width">
                 <input type="text" id="dc-notes" value="\${c.notes || ''}" placeholder=" ">
                 <label>Notes internes</label>
               </div>
            </div>
            <div class="modal-v2-footer">
              <button type="button" class="btn-v2-cancel" onclick="closeModalAnimated()">Annuler</button>
              <button type="submit" class="btn-v2-submit"><i class="fas fa-save"></i> Enregistrer</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  \`
}

async function saveCompany(e, id) {
  e.preventDefault()
  const body = {
    name: document.getElementById('dc-name').value,
    api_type: document.getElementById('dc-type').value,
    api_url: document.getElementById('dc-url').value,
    api_key: document.getElementById('dc-key').value,
    api_token: document.getElementById('dc-token').value,
    notes: document.getElementById('dc-notes').value
  }
  try {
    if (id) await api.put('/delivery-companies/' + id, body)
    else await api.post('/delivery-companies', body)
    toast(id ? 'Societe modifiee' : 'Societe ajoutee')
    closeModalAnimated(); loadConfig()
  } catch (err) { toast(err.response?.data?.error || 'Erreur', 'error') }
}

async function deleteCompany(id) {
  if (!confirm('Supprimer cette societe de livraison ?')) return
  try {
    await api.delete('/delivery-companies/' + id)
    toast('Societe supprimee'); loadConfig()
  } catch (err) { toast('Erreur', 'error') }
}

async function toggleCompany(id, active) {
  try {
    await api.put('/delivery-companies/' + id, { active: active ? 1 : 0 })
    toast(active ? 'Societe activee' : 'Societe desactivee'); loadConfig()
  } catch (err) { toast('Erreur', 'error') }
}

async function connectWooCommerce(domain) {
  try {
    const { data } = await api.get('/api/woo/connect?domain=' + encodeURIComponent(domain))
    if (data.url) window.location.href = data.url
  } catch (e) { toast('Erreur de connexion WooCommerce', 'error') }
}

// ===================== SUBSCRIPTION SYSTEM =====================
async function loadPaymentRequests() {
  try {
    const { data } = await api.get('/payment-requests')
    state.paymentRequests = data
    return data
  } catch (e) { console.error(e); return [] }
}

async function loadPricing() {
  const container = document.getElementById('view-pricing')
  if (!container) return
  container.innerHTML = '<div class="flex items-center justify-center py-20"><div class="spinner-lg"></div></div>'
  const [requests] = await Promise.all([loadPaymentRequests()])
  const currentSub = (state.user?.subscription || 'starter').toLowerCase()
  let rows = ''
  requests.forEach((r) => {
    const statusClass = r.status === 'approved' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' :
                      r.status === 'rejected' ? 'bg-rose-500/10 text-rose-400 border-rose-500/20' :
                      'bg-amber-500/10 text-amber-400 border-amber-500/20'
    const statusLabel = r.status === 'approved' ? 'Approuv\u00e9' : r.status === 'rejected' ? 'Refus\u00e9' : 'En attente'
    rows += '<tr>' +
      '<td class="py-3 px-4 text-xs text-gray-400">' + new Date(r.created_at).toLocaleDateString('fr-FR', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'}) + '</td>' +
      '<td class="py-3 px-4 font-bold text-white text-xs uppercase">' + r.plan + '</td>' +
      '<td class="py-3 px-4 text-xs">' + Number(r.amount).toLocaleString() + ' ' + r.currency + '</td>' +
      '<td class="py-3 px-4 text-xs font-medium text-gray-300 uppercase">' + r.payment_method + '</td>' +
      '<td class="py-3 px-4"><span class="badge-status border ' + statusClass + '">' + statusLabel + '</span></td>' +
      '<td class="py-3 px-4 text-xs text-gray-500">' + (r.admin_notes || '-') + '</td>' +
    '</tr>'
  })
  container.innerHTML = \`
    <div class="mb-10 text-center">
      <span class="text-indigo-400 text-xs uppercase tracking-widest font-semibold">Plans & Tarification</span>
      <h1 class="text-3xl font-extrabold text-white mt-2 mb-2">Choisissez votre plan</h1>
      <p class="text-gray-400">Des offres adapt\u00e9es \u00e0 chaque \u00e9tape de votre croissance</p>
    </div>
    <div class="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto mb-10">
      <div class="card-glass p-8 flex flex-col relative overflow-hidden group \${currentSub === 'starter' ? 'border-indigo-500/30 ring-1 ring-indigo-500/20' : ''}">
        \${currentSub === 'starter' ? '<div class="bg-indigo-600 text-white text-[10px] font-bold px-3 py-1 rounded-full absolute top-4 right-4 uppercase">Actuel</div>' : ''}
        <div class="w-14 h-14 rounded-2xl bg-gray-500/10 flex items-center justify-center mb-5 group-hover:scale-110 transition-transform"><i class="fas fa-seedling text-gray-400 text-xl"></i></div>
        <h3 class="text-xl font-bold mb-1">Starter</h3>
        <div class="text-3xl font-black mb-1">Gratuit<span class="text-sm text-gray-500 font-medium ml-1">/mois</span></div>
        <p class="text-xs text-gray-500 mb-5">Pour d\u00e9marrer votre activit\u00e9</p>
        <ul class="text-sm text-gray-400 space-y-2.5 mb-8 flex-1">
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>500 commandes / mois</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>Dashboard basique</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>1 Boutique connect\u00e9e</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>Suivi de livraison</span></li>
          <li class="flex items-center gap-2 opacity-30"><i class="fas fa-times-circle text-gray-500 flex-shrink-0"></i><span>Support prioritaire</span></li>
          <li class="flex items-center gap-2 opacity-30"><i class="fas fa-times-circle text-gray-500 flex-shrink-0"></i><span>Automatisation WhatsApp</span></li>
        </ul>
        <button class="btn btn-outline w-full py-3 rounded-xl opacity-50 cursor-not-allowed text-sm" disabled>Plan inclus</button>
      </div>
      <div class="card-glass p-8 flex flex-col relative overflow-hidden group scale-105" style="border-color:rgba(99,102,241,0.5);box-shadow:0 0 40px rgba(99,102,241,0.15),0 25px 50px -12px rgba(0,0,0,0.5)">
        <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500"></div>
        \${currentSub === 'pro'
          ? '<div class="bg-indigo-600 text-white text-[10px] font-bold px-3 py-1 rounded-full absolute top-4 right-4 uppercase">Actuel</div>'
      npm run deploy  <div class="w-14 h-14 rounded-2xl bg-indigo-500/20 flex items-center justify-center mb-5 group-hover:scale-110 transition-transform"><i class="fas fa-rocket text-indigo-400 text-xl"></i></div>
        <h3 class="text-xl font-bold mb-1 text-white">Pro</h3>
        <div class="text-3xl font-black mb-1 text-indigo-300">2\u202f900 DA<span class="text-sm text-gray-500 font-medium ml-1">/mois</span></div>
        <p class="text-xs text-indigo-400/70 mb-5">\u2248 15 USD \u2014 Pour les vendeurs actifs</p>
        <ul class="text-sm text-gray-300 space-y-2.5 mb-8 flex-1">
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>1\u202f500 commandes / mois</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>\u00c9tiquettes personnalis\u00e9es</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>Analyse de stock avanc\u00e9e</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>Jusqu\u2019\u00e0 3 boutiques</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>Support 24/7</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-indigo-400 flex-shrink-0"></i><span>Automatisation WhatsApp</span></li>
        </ul>
        <button onclick="showPaymentModal('pro')" class="btn btn-primary w-full py-3 rounded-xl shadow-lg shadow-indigo-500/30 text-sm font-bold" \${currentSub === 'pro' ? 'disabled' : ''}>\${currentSub === 'pro' ? 'Plan Actuel' : '\ud83d\ude80 D\u00e9marrer maintenant'}</button>
      </div>
      <div class="card-glass p-8 flex flex-col relative overflow-hidden group \${currentSub === 'business' ? 'border-emerald-500/30 ring-1 ring-emerald-500/20' : ''}">
        \${currentSub === 'business' ? '<div class="bg-emerald-600 text-white text-[10px] font-bold px-3 py-1 rounded-full absolute top-4 right-4 uppercase">Actuel</div>' : ''}
        <div class="w-14 h-14 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-5 group-hover:scale-110 transition-transform"><i class="fas fa-building text-emerald-400 text-xl"></i></div>
        <h3 class="text-xl font-bold mb-1">Business</h3>
        <div class="text-3xl font-black mb-1 text-emerald-300">6\u202f900 DA<span class="text-sm text-gray-500 font-medium ml-1">/mois</span></div>
        <p class="text-xs text-emerald-400/70 mb-5">\u2248 35 USD \u2014 Pour les \u00e9quipes & entreprises</p>
        <ul class="text-sm text-gray-300 space-y-2.5 mb-8 flex-1">
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-emerald-400 flex-shrink-0"></i><span>Commandes illimit\u00e9es</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-emerald-400 flex-shrink-0"></i><span>Multi-utilisateurs (\u00c9quipe)</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-emerald-400 flex-shrink-0"></i><span>Support Prioritaire d\u00e9di\u00e9</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-emerald-400 flex-shrink-0"></i><span>Boutiques illimit\u00e9es</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-emerald-400 flex-shrink-0"></i><span>Int\u00e9gration API illimit\u00e9e</span></li>
          <li class="flex items-center gap-2"><i class="fas fa-check-circle text-emerald-400 flex-shrink-0"></i><span>Acc\u00e8s complet au stock</span></li>
        </ul>
        <button onclick="showPaymentModal('business')" class="w-full py-3 rounded-xl text-sm font-bold transition-all" style="border:1px solid rgba(16,185,129,0.4);color:#6ee7b7;background:transparent" onmouseover="this.style.background='rgba(16,185,129,0.08)'" onmouseout="this.style.background='transparent'" \${currentSub === 'business' ? 'disabled' : ''}>\${currentSub === 'business' ? 'Plan Actuel' : 'Passer \u00e0 la vitesse sup\u00e9rieure \u2192'}</button>
      </div>
    </div>
    <div class="max-w-4xl mx-auto mb-10">
      <div class="card-glass p-6">
        <p class="text-center text-xs text-gray-500 uppercase tracking-widest mb-5 font-semibold">M\u00e9thodes de paiement accept\u00e9es</p>
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div class="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/3 hover:bg-white/5 transition">
            <div class="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center"><i class="fas fa-mobile-alt text-amber-400 text-lg"></i></div>
            <span class="text-xs font-bold text-amber-300">BaridiMob</span>
            <span class="text-[10px] text-gray-500">Paiement local</span>
          </div>
          <div class="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/3 hover:bg-white/5 transition">
            <div class="w-10 h-10 rounded-full bg-yellow-500/20 flex items-center justify-center"><i class="fas fa-university text-yellow-400 text-lg"></i></div>
            <span class="text-xs font-bold text-yellow-300">CCP Alg\u00e9rie</span>
            <span class="text-[10px] text-gray-500">Virement postal</span>
          </div>
          <div class="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/3 hover:bg-white/5 transition">
            <div class="w-10 h-10 rounded-full bg-emerald-500/20 flex items-center justify-center"><i class="fab fa-bitcoin text-emerald-400 text-lg"></i></div>
            <span class="text-xs font-bold text-emerald-300">RedotPay</span>
            <span class="text-[10px] text-gray-500">USDT / Crypto</span>
          </div>
          <div class="flex flex-col items-center gap-2 p-4 rounded-xl bg-white/3 hover:bg-white/5 transition">
            <div class="w-10 h-10 rounded-full bg-blue-500/20 flex items-center justify-center"><i class="fas fa-globe text-blue-400 text-lg"></i></div>
            <span class="text-xs font-bold text-blue-300">Payera</span>
            <span class="text-[10px] text-gray-500">International</span>
          </div>
        </div>
      </div>
    </div>
    <div class="max-w-4xl mx-auto mb-10">
      <div class="flex items-center gap-3 mb-4"><i class="fas fa-shield-alt text-indigo-400"></i><h2 class="text-lg font-bold">Garanties & R\u00e9assurance</h2></div>
      <div class="grid md:grid-cols-3 gap-4">
        <div class="card-glass p-5 flex items-start gap-4">
          <div class="w-10 h-10 rounded-xl bg-emerald-500/15 flex items-center justify-center flex-shrink-0"><i class="fas fa-bolt text-emerald-400"></i></div>
          <div>
            <h4 class="text-sm font-bold text-white mb-1">Activation instantan\u00e9e</h4>
            <p class="text-xs text-gray-400">Votre plan est activ\u00e9 dans les <strong class="text-emerald-300">2\u00a0heures</strong> apr\u00e8s v\u00e9rification de votre paiement.</p>
          </div>
        </div>
        <div class="card-glass p-5 flex items-start gap-4">
          <div class="w-10 h-10 rounded-xl bg-indigo-500/15 flex items-center justify-center flex-shrink-0"><i class="fas fa-lock text-indigo-400"></i></div>
          <div>
            <h4 class="text-sm font-bold text-white mb-1">Aucun frais cach\u00e9</h4>
            <p class="text-xs text-gray-400">Le prix affich\u00e9 est le prix final. <strong class="text-indigo-300">Pas de surprise</strong> sur votre facture.</p>
          </div>
        </div>
        <div class="card-glass p-5 flex items-start gap-4">
          <div class="w-10 h-10 rounded-xl bg-purple-500/15 flex items-center justify-center flex-shrink-0"><i class="fas fa-headset text-purple-400"></i></div>
          <div>
            <h4 class="text-sm font-bold text-white mb-1">Support r\u00e9actif</h4>
            <p class="text-xs text-gray-400">Notre \u00e9quipe vous accompagne \u00e0 chaque \u00e9tape via <strong class="text-purple-300">WhatsApp & email</strong>.</p>
          </div>
        </div>
      </div>
    </div>
    <div class="max-w-4xl mx-auto">
      <div class="flex items-center gap-3 mb-6"><i class="fas fa-history text-indigo-400"></i><h2 class="text-xl font-bold">Historique des paiements</h2></div>
      <div class="card overflow-hidden">
        <table class="w-full text-left">
          <thead><tr class="bg-white/3"><th class="py-4 px-4 text-[10px] font-bold uppercase text-gray-500">Date</th><th class="py-4 px-4 text-[10px] font-bold uppercase text-gray-500">Plan</th><th class="py-4 px-4 text-[10px] font-bold uppercase text-gray-500">Montant</th><th class="py-4 px-4 text-[10px] font-bold uppercase text-gray-500">M\u00e9thode</th><th class="py-4 px-4 text-[10px] font-bold uppercase text-gray-500">Statut</th><th class="py-4 px-4 text-[10px] font-bold uppercase text-gray-500">Notes Admin</th></tr></thead>
          <tbody class="divide-y divide-white/5">\${rows || '<tr><td colspan="6" class="py-10 text-center text-gray-500">Aucun paiement enregistr\u00e9</td></tr>'}</tbody>
        </table>
      </div>
    </div>
  \`
}

function showPaymentModal(plan) {
  const price = plan === 'pro' ? '2\u202f900 DA' : '6\u202f900 DA'
  const usdPrice = plan === 'pro' ? '15 USD' : '35 USD'
  document.getElementById('modals').innerHTML = \`
    <div class="modal-overlay-v2" onclick = "closeModalV2(event)">
      <div class="modal-v2" onclick="event.stopPropagation()" style="max-width:580px">
        <div class="modal-v2-header">
          <h2><span class="header-icon"><i class="fas fa-credit-card"></i></span> Activer le Plan \${plan.toUpperCase()}</h2>
          <button class="modal-v2-close" onclick="closeModalAnimated()"><i class="fas fa-xmark"></i></button>
        </div>
        <div class="modal-v2-body">
          <div class="flex items-center justify-center gap-4 mb-6 p-4 rounded-xl" style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.15)">
            <div class="text-center">
              <div class="text-2xl font-black text-white">\${price}</div>
              <div class="text-xs text-indigo-400">\u2248 \${usdPrice}</div>
            </div>
            <div class="text-gray-600 text-xl">/</div>
            <div class="text-sm text-gray-300">Plan <strong class="text-indigo-300 uppercase">\${plan}</strong><br><span class="text-xs text-gray-500">Abonnement mensuel</span></div>
          </div>
          <p class="text-sm text-gray-400 mb-3">Choisissez votre m\u00e9thode de paiement\u00a0:</p>
          <div class="mb-1">
            <div class="text-[10px] uppercase tracking-widest text-amber-400/80 font-bold mb-2 px-1">\ud83c\udde9\ud83c\uddff Paiement Local (Alg\u00e9rie)</div>
            <div class="space-y-2">
              <label class="flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition-all" style="border-color:rgba(255,255,255,0.06);background:rgba(255,255,255,0.02)" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='rgba(255,255,255,0.02)'">
                <input type="radio" name="payment-method" value="baridimob" checked onchange="updatePaymentInstructions('baridimob')" class="mt-1 w-4 h-4 accent-indigo-500">
                  <div class="flex-1">
                    <div class="font-bold text-sm text-white flex items-center gap-2 flex-wrap">
                      <span class="px-2 py-0.5 rounded text-[10px] font-black" style="background:rgba(251,191,36,0.2);color:#fbbf24;border:1px solid rgba(251,191,36,0.3)">BARIDIMOB</span>
                      <span class="text-gray-400 text-xs">Virement instantan\u00e9</span>
                      <span class="ml-auto text-indigo-300 font-black">\${price}</span>
                    </div>
                    <p class="text-xs text-gray-500 mt-1.5">Num\u00e9ro de compte RIP\u00a0:</p>
                    <code class="block mt-1 p-2 rounded text-indigo-300 text-[11px] font-mono select-all cursor-text" style="background:rgba(0,0,0,0.3)">00799999XXXXXXXXXX99</code>
                  </div>
              </label>
              <label class="flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition-all" style="border-color:rgba(255,255,255,0.06);background:rgba(255,255,255,0.02)" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='rgba(255,255,255,0.02)'">
                <input type="radio" name="payment-method" value="ccp" onchange="updatePaymentInstructions('ccp')" class="mt-1 w-4 h-4 accent-indigo-500">
                  <div class="flex-1">
                    <div class="font-bold text-sm text-white flex items-center gap-2 flex-wrap">
                      <span class="px-2 py-0.5 rounded text-[10px] font-black" style="background:rgba(234,179,8,0.2);color:#eab308;border:1px solid rgba(234,179,8,0.3)">CCP</span>
                      <span class="text-gray-400 text-xs">Versement / Virement postal</span>
                      <span class="ml-auto text-indigo-300 font-black">\${price}</span>
                    </div>
                    <p class="text-xs text-gray-500 mt-1.5">Num\u00e9ro de compte CCP\u00a0:</p>
                    <code class="block mt-1 p-2 rounded text-amber-300 text-[11px] font-mono select-all cursor-text" style="background:rgba(0,0,0,0.3)">XXXXXXXXXX cl\u00e9 XX</code>
                  </div>
              </label>
            </div>
          </div>
          <div class="mt-4 mb-5">
            <div class="text-[10px] uppercase tracking-widest text-emerald-400/80 font-bold mb-2 px-1">\ud83c\udf0d Paiement International / Crypto</div>
            <div class="space-y-2">
              <label class="flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition-all" style="border-color:rgba(255,255,255,0.06);background:rgba(255,255,255,0.02)" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='rgba(255,255,255,0.02)'">
                <input type="radio" name="payment-method" value="redotpay" onchange="updatePaymentInstructions('redotpay')" class="mt-1 w-4 h-4 accent-emerald-500">
                  <div class="flex-1">
                    <div class="font-bold text-sm text-white flex items-center gap-2 flex-wrap">
                      <span class="px-2 py-0.5 rounded text-[10px] font-black" style="background:rgba(16,185,129,0.2);color:#34d399;border:1px solid rgba(16,185,129,0.3)">REDOTPAY</span>
                      <span class="text-gray-400 text-xs">USDT TRC20</span>
                      <span class="ml-auto text-emerald-300 font-black">\${usdPrice}</span>
                    </div>
                    <p class="text-xs text-gray-500 mt-1.5">Adresse USDT TRC20\u00a0:</p>
                    <code class="block mt-1 p-2 rounded text-emerald-300 text-[11px] font-mono select-all cursor-text" style="background:rgba(0,0,0,0.3)">TXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX</code>
                  </div>
              </label>
              <label class="flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition-all" style="border-color:rgba(255,255,255,0.06);background:rgba(255,255,255,0.02)" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background='rgba(255,255,255,0.02)'">
                <input type="radio" name="payment-method" value="payera" onchange="updatePaymentInstructions('payera')" class="mt-1 w-4 h-4 accent-blue-500">
                  <div class="flex-1">
                    <div class="font-bold text-sm text-white flex items-center gap-2 flex-wrap">
                      <span class="px-2 py-0.5 rounded text-[10px] font-black" style="background:rgba(59,130,246,0.2);color:#60a5fa;border:1px solid rgba(59,130,246,0.3)">PAYERA</span>
                      <span class="text-gray-400 text-xs">Paiement international</span>
                      <span class="ml-auto text-blue-300 font-black">\${usdPrice}</span>
                    </div>
                    <p class="text-xs text-gray-500 mt-1.5">ID / Adresse Payera\u00a0:</p>
                    <code class="block mt-1 p-2 rounded text-blue-300 text-[11px] font-mono select-all cursor-text" style="background:rgba(0,0,0,0.3)">PAYERA-ID-XXXXXXXXXXXX</code>
                  </div>
              </label>
            </div>
          </div>
          <div class="p-4 rounded-xl mb-5" style="background:rgba(37,211,102,0.07);border:1px solid rgba(37,211,102,0.2)">
            <div class="flex items-center gap-2 mb-1.5">
              <i class="fab fa-whatsapp text-green-400 text-lg"></i>
              <span class="text-sm font-bold text-green-300">Envoyer la preuve via WhatsApp</span>
            </div>
            <p class="text-xs text-gray-400 mb-3">Apr\u00e8s le virement, envoyez une capture d\u2019\u00e9cran de votre re\u00e7u. L\u2019activation est effectu\u00e9e sous 2\u00a0h.</p>
            <button onclick="sendProofViaWhatsApp('\${plan}', '\${price}')" class="w-full py-2.5 rounded-lg font-bold text-sm flex items-center justify-center gap-2 transition-all" style="background:rgba(37,211,102,0.12);color:#4ade80;border:1px solid rgba(37,211,102,0.3)" onmouseover="this.style.background='rgba(37,211,102,0.22)'" onmouseout="this.style.background='rgba(37,211,102,0.12)'">
              <i class="fab fa-whatsapp"></i> Envoyer ma capture d\u2019\u00e9cran
            </button>
          </div>
          <div class="modal-v2-section">
            <div class="modal-v2-section-title"><i class="fas fa-receipt"></i> R\u00e9f\u00e9rence de transaction (optionnel)</div>
            <div class="form-grid">
              <div class="float-field full-width">
                <i class="fas fa-hashtag field-icon"></i>
                <input type="text" id="pay-ref" placeholder=" ">
                  <label id="pay-ref-label">R\u00e9f\u00e9rence de transaction / N\u00b0 Bordereau</label>
              </div>
              <div class="float-field full-width">
                <i class="fas fa-comment-dots field-icon"></i>
                <input type="text" id="pay-notes" placeholder=" ">
                  <label>Notes ou message (optionnel)</label>
              </div>
            </div>
          </div>
          <div class="modal-v2-footer">
            <button class="btn-v2-cancel" onclick="closeModalAnimated()">Annuler</button>
            <button class="btn-v2-submit" id="pay-submit-btn" onclick="submitPaymentRequest('\${plan}')">
              <i class="fas fa-paper-plane"></i> <span id="pay-submit-text">Envoyer ma demande</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    \`
}

function updatePaymentInstructions(method) {
  const lbl = document.getElementById('pay-ref-label')
  if (!lbl) return
  if (method === 'redotpay') lbl.innerText = 'Transaction Hash (TXID)'
  else if (method === 'payera') lbl.innerText = 'ID de transaction Payera'
  else if (method === 'baridimob') lbl.innerText = 'R\u00e9f\u00e9rence de transaction BaridiMob'
  else lbl.innerText = 'N\u00b0 Bordereau ou R\u00e9f\u00e9rence mandat'
}

function sendProofViaWhatsApp(plan, price) {
  const method = (document.querySelector('input[name="payment-method"]:checked') || {}).value || 'paiement'
  const userName = (typeof state !== 'undefined' && state.user?.prenom) ? state.user.prenom : 'Client'
  const storeName = (typeof state !== 'undefined' && state.user?.store_name) ? state.user.store_name : ''
  const msg = encodeURIComponent(
    'Bonjour AutoHub DZ \ud83d\udc4b\n\n' +
    'Je souhaite activer le plan *' + plan.toUpperCase() + '* (' + price + '/mois).\n' +
    'M\u00e9thode de paiement\u00a0: *' + method.toUpperCase() + '*\n' +
    (storeName ? 'Boutique\u00a0: ' + storeName + '\n' : '') +
    'Nom\u00a0: ' + userName + '\n\n' +
    'Ci-joint la capture d\u2019\u00e9cran de mon re\u00e7u de paiement. \ud83d\udcce'
  )
  // Remplacez le numero ci-dessous par votre numero WhatsApp Business (format international sans +)
  const waNumber = '213552295894'
  window.open('https://wa.me/' + waNumber + '?text=' + msg, '_blank')
}

async function submitPaymentRequest(plan) {
  const btn = document.getElementById('pay-submit-btn')
  const btnText = document.getElementById('pay-submit-text')
  const proof_reference = document.getElementById('pay-ref').value.trim()
  const payment_method = document.querySelector('input[name="payment-method"]:checked').value
  const proof_notes = document.getElementById('pay-notes').value.trim()

  if (btn) btn.disabled = true
  if (btnText) btnText.innerHTML = '<span class="spinner-sm"></span> Envoi...'

  try {
    const { data } = await api.post('/payment-request', { plan, payment_method, proof_reference, proof_notes })
    toast(data.message || 'Demande transmise avec succ\u00e8s !')
    closeModalAnimated(); loadPricing()
  } catch (e) {
    toast(e.response?.data?.error || 'Erreur lors de l\'envoi', 'error')
    if (btn) btn.disabled = false
    if (btnText) btnText.innerHTML = 'Envoyer ma demande'
  }
}

// ===================== ADMIN PAYMENTS =====================
async function loadAdminPaymentRequests() {
  try {
    const { data } = await api.get('/admin/payment-requests?status=pending')
    const container = document.getElementById('admin-payment-section')
    if (!container) return
    
    if (data.length === 0) {
      container.innerHTML = '<div class="text-center py-10 text-gray-500 text-sm"><i class="fas fa-check-double mb-2 block text-2xl opacity-20"></i>Aucune demande de paiement en attente.</div>'
      return
    }

    const rows = data.map((r) => \`
      <div class="p-4 rounded-xl bg-white/3 border border-indigo-500/10 hover:bg-white/5 transition mb-3">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 rounded-full bg-indigo-500/20 flex items-center justify-center font-bold text-indigo-300 capitalize">\${r.username?.[0] || 'U'}</div>
            <div>
              <div class="text-sm font-bold text-white">\${r.username || r.email || 'Utilisateur'}</div>
              <div class="text-[10px] text-gray-500 uppercase font-mono">\${r.store_name || '-'}</div>
            </div>
          </div>
          <div class="text-right">
            <div class="text-sm font-black text-white">\${Number(r.amount).toLocaleString()} \${r.currency}</div>
            <div class="text-[10px] text-indigo-400 font-bold uppercase tracking-wider">PLAN \${r.plan}</div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-2 mb-4">
          <div class="p-2 rounded bg-black/20">
            <div class="text-[9px] text-gray-500 uppercase">Methode</div>
            <div class="text-xs text-gray-300 font-bold uppercase">\${r.payment_method}</div>
          </div>
          <div class="p-2 rounded bg-black/20">
            <div class="text-[9px] text-gray-500 uppercase">Reference</div>
            <div class="text-xs text-indigo-300 font-mono font-bold select-all truncate">\${r.proof_reference}</div>
          </div>
        </div>
        \${r.proof_notes ? '<div class="text-xs text-gray-400 italic mb-4 bg-white/2 p-2 rounded">"'+r.proof_notes+'"</div>' : ''}
        <div class="flex gap-2">
          <button onclick="adminReviewPayment(\${r.id}, 'approved')" class="btn btn-success flex-1 py-2 text-xs font-bold"><i class="fas fa-check mr-1"></i> Approuver</button>
          <button onclick="adminReviewPayment(\${r.id}, 'rejected')" class="btn btn-danger flex-1 py-2 text-xs font-bold"><i class="fas fa-times mr-1"></i> Rejeter</button>
        </div>
      </div>
    \`).join('')

    container.innerHTML = \`<div class="grid md:grid-cols-2 lg:grid-cols-3 gap-4">\${rows}</div>\`
  } catch (e) {
    console.error(e)
  }
}

async function adminReviewPayment(id, status) {
  let admin_notes = ''
  if (status === 'rejected') {
    admin_notes = prompt('Motif du rejet (optionnel) :') || ''
  } else {
    if (!confirm('Confirmer l\'activation de l\'abonnement pour cet utilisateur ?')) return
  }

  try {
    await api.put('/admin/payment-requests/' + id, { status, admin_notes })
    toast(status === 'approved' ? 'Abonnement active avec succes !' : 'Paiement rejete')
    loadUtilisateurs()
  } catch (e) {
    toast('Erreur lors de la validation', 'error')
  }
}

function loadGuide() {
  const container = document.getElementById('view-guide')
  if (!container) return
  container.innerHTML = '<div class="mb-6">' +
      '<h1 class="text-2xl font-bold"><i class="fas fa-book-open text-indigo-400 mr-2"></i>Guide - Connecter AutoHub DZ</h1>' +
      '<p class="text-gray-400 text-sm">Documentation complete pour integrer votre boutique WooCommerce avec AutoHub DZ</p>' +
    '</div>' +
    '<div class="space-y-5 max-w-4xl">' +
      '<div class="card p-6">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-amber-500/15 flex items-center justify-center">' +
            '<i class="fas fa-clipboard-check text-amber-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">1. Prerequis</h2>' +
        '</div>' +
        '<ul class="space-y-2">' +
          '<li class="flex items-start gap-2 text-sm text-gray-300">' +
            '<i class="fas fa-check-circle text-emerald-400 mt-0.5 flex-shrink-0"></i>' +
            'Un site WordPress / WooCommerce actif avec un certificat SSL (HTTPS)' +
          '</li>' +
        '</ul>' +
      '</div>' +
    '</div>'
}

function rolePill(role) {
  const colors = { admin:'bg-indigo-500/20 text-indigo-300 border-indigo-500/30', employe:'bg-amber-500/20 text-amber-300 border-amber-500/30' }
  return '<span class="px-2 py-0.5 rounded-full text-[10px] border '+ (colors[role] || 'bg-gray-500/20 text-gray-300 border-gray-500/30') +'">' + role + '</span>'
}

async function loadConfig() {
  const { data } = await api.get('/user-config')
  const webhookUrl = window.location.origin + '/api/webhook/' + data.webhook_token
  document.getElementById('view-integration').innerHTML = '<div class="mb-6"><h1 class="text-2xl font-bold">Integrations</h1></div>' +
    '<div class="card p-6"><code class="text-indigo-300 text-xs">' + webhookUrl + '</code></div>'
}

async function loadHistorique() {
  const { data } = await api.get('/historique')
  const rows = data.map(h => '<tr><td class="text-xs">' + new Date(h.created_at).toLocaleString() + '</td><td>' + h.action + '</td></tr>').join('')
  document.getElementById('view-historique').innerHTML = '<div class="card"><table><tbody>' + rows + '</tbody></table></div>'
}

function escapeHtml(text) {
  if(!text) return ''
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

checkAuth().then(ok => {
  if(ok) {
    navigateTo('dashboard')
  }
})
</script>
</body>
</html>`
}

