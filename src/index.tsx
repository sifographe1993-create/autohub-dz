import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import type { D1Database } from '@cloudflare/workers-types'

type Bindings = { DB: D1Database; ASSETS: Fetcher }
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
  return String(status || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

function isConfirmedStatus(status: string): boolean {
  return normalizeStatusWorker(status).includes('confirme')
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
  if (!token) return c.json({ error: 'Non authentifié', code: 'AUTH_REQUIRED' }, 401)

  const session = await c.env.DB.prepare(
    "SELECT s.user_id, u.username, u.nom, u.prenom, u.role, u.subscription, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).bind(token).first() as any

  if (!session) {
    deleteCookie(c, 'session_token')
    return c.json({ error: 'Session expirée', code: 'AUTH_REQUIRED' }, 401)
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

  // Validation prénom
  if (prenom.trim().length < 2) {
    return c.json({ error: 'Le prénom doit contenir au moins 2 caractères' }, 400)
  }

  // Validation email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(email)) {
    return c.json({ error: 'Adresse email invalide' }, 400)
  }

  // Validation téléphone algérien (05xx, 06xx, 07xx)
  const phoneClean = telephone.replace(/[\s\-\.]/g, '')
  const phoneRegex = /^(0[567]\d{8}|\+213[567]\d{8})$/
  if (!phoneRegex.test(phoneClean)) {
    return c.json({ error: 'Numéro de téléphone invalide (format: 05xxxxxxxx, 06xxxxxxxx, 07xxxxxxxx)' }, 400)
  }

  // Validation store name
  if (store_name.trim().length < 2) {
    return c.json({ error: 'Le nom du magasin doit contenir au moins 2 caractères' }, 400)
  }

  // Validation mot de passe
  if (password.length < 6) {
    return c.json({ error: 'Le mot de passe doit contenir au moins 6 caractères' }, 400)
  }

  if (password !== confirm_password) {
    return c.json({ error: 'Les mots de passe ne correspondent pas' }, 400)
  }

  // Vérifier si l'email existe déjà
  const existingUser = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email.trim().toLowerCase()).first()
  if (existingUser) {
    return c.json({ error: 'Cette adresse email est déjà utilisée' }, 400)
  }

  // Vérifier si le téléphone existe déjà
  const existingPhone = await c.env.DB.prepare('SELECT id FROM users WHERE telephone = ?').bind(phoneClean).first()
  if (existingPhone) {
    return c.json({ error: 'Ce numéro de téléphone est déjà utilisé' }, 400)
  }

  // Hacher le mot de passe
  const hashedPassword = await hashPassword(password)

  // Créer le username à partir de l'email (partie avant @)
  const username = email.trim().toLowerCase().split('@')[0] + '_' + Date.now().toString(36)

  // Insérer l'utilisateur avec abonnement par défaut
  const result = await c.env.DB.prepare(
    `INSERT INTO users (username, password_hash, prenom, nom, email, telephone, store_name, role, active, subscription)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'client', 1, 'starter')`
  ).bind(username, hashedPassword, prenom.trim(), prenom.trim(), email.trim().toLowerCase(), phoneClean, store_name.trim()).run()

  const userId = result.meta.last_row_id

  // Par défaut, assigner tous les transporteurs disponibles au nouveau client
  for (const t of TRANSPORTEURS) {
    await c.env.DB.prepare('INSERT OR IGNORE INTO user_transporteurs (user_id, transporteur) VALUES (?, ?)').bind(userId, t).run()
  }

  // Créer la session automatiquement (auto-login)
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
  if (new_password.length < 6) return c.json({ error: 'Minimum 6 caractères' }, 400)

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
    return c.json({ error: 'Accès réservé aux administrateurs', code: 'FORBIDDEN' }, 403)
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
    return c.json({ error: 'Rôle invalide' }, 400)
  }
  if (active !== undefined && active !== 0 && active !== 1) {
    return c.json({ error: 'Statut actif invalide' }, 400)
  }

  const target = await c.env.DB.prepare('SELECT id, role, active FROM users WHERE id = ?').bind(id).first() as any
  if (!target) return c.json({ error: 'Utilisateur introuvable' }, 404)

  if (id === adminId && (role === 'client' || role === 'employe' || active === 0)) {
    return c.json({ error: 'Vous ne pouvez pas rétrograder ou désactiver votre propre compte' }, 400)
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
// TRANSPORTEURS - Filtrés par utilisateur
// ========================
app.get('/api/transporteurs', async (c) => {
  // Si utilisateur authentifié, retourner seulement ses transporteurs liés
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
  // Fallback : liste complète pour les non-authentifiés
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

  // Valider que chaque transporteur est dans la liste autorisée
  const validTransporteurs = transporteurs.filter(t => TRANSPORTEURS.includes(t))

  // Supprimer les anciens liens
  await c.env.DB.prepare('DELETE FROM user_transporteurs WHERE user_id = ?').bind(userId).run()

  // Insérer les nouveaux
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
  try { permissions = JSON.parse(row.permissions_json || '[]') } catch(e) { permissions = [] }
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
// STOP DESKS ADMIN CRUD
// ========================
app.get('/api/admin/stop-desks', async (c) => {
  const wilayaId = c.req.query('wilaya_id')
  const transporteur = c.req.query('transporteur') || ''
  let query = 'SELECT sd.id, sd.name, sd.address, sd.transporteur, sd.wilaya_id, w.name as wilaya_name FROM stop_desks sd LEFT JOIN wilayas w ON sd.wilaya_id = w.id WHERE 1=1'
  const params: any[] = []
  if (wilayaId) { query += ' AND sd.wilaya_id = ?'; params.push(Number(wilayaId)) }
  if (transporteur) { query += ' AND sd.transporteur = ?'; params.push(transporteur) }
  query += ' ORDER BY w.id, sd.transporteur, sd.name'
  const { results } = await c.env.DB.prepare(query).bind(...params).all()
  return c.json(results || [])
})

app.post('/api/admin/stop-desks', async (c) => {
  const body = await c.req.json()
  const name = (body.name || '').trim()
  const wilaya_id = Number(body.wilaya_id)
  const transporteur = (body.transporteur || '').trim()
  const address = (body.address || '').trim()
  if (!name) return c.json({ error: 'Nom requis' }, 400)
  if (!wilaya_id) return c.json({ error: 'Wilaya requise' }, 400)
  if (!transporteur) return c.json({ error: 'Transporteur requis' }, 400)
  const result = await c.env.DB.prepare(
    'INSERT INTO stop_desks (name, wilaya_id, transporteur, address) VALUES (?, ?, ?, ?)'
  ).bind(name, wilaya_id, transporteur, address).run()
  return c.json({ success: true, id: result.meta.last_row_id })
})

app.put('/api/admin/stop-desks/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const body = await c.req.json()
  const name = (body.name || '').trim()
  const wilaya_id = Number(body.wilaya_id)
  const transporteur = (body.transporteur || '').trim()
  const address = (body.address || '').trim()
  if (!name) return c.json({ error: 'Nom requis' }, 400)
  if (!wilaya_id) return c.json({ error: 'Wilaya requise' }, 400)
  if (!transporteur) return c.json({ error: 'Transporteur requis' }, 400)
  const result = await c.env.DB.prepare(
    'UPDATE stop_desks SET name = ?, wilaya_id = ?, transporteur = ?, address = ? WHERE id = ?'
  ).bind(name, wilaya_id, transporteur, address, id).run()
  if ((result.meta?.changes || 0) === 0) return c.json({ error: 'Point relais introuvable' }, 404)
  return c.json({ success: true })
})

app.delete('/api/admin/stop-desks/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const result = await c.env.DB.prepare('DELETE FROM stop_desks WHERE id = ?').bind(id).run()
  if ((result.meta?.changes || 0) === 0) return c.json({ error: 'Point relais introuvable' }, 404)
  return c.json({ success: true })
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
    ).bind(nom, prix || 0, telephone, produit, commune, adresse || '', wilaya, livraison || 'A domicile', statut || '🛍️ Nouvelle', transporteur || '', notes || '', userId).run()
    : await c.env.DB.prepare(
      `INSERT INTO commandes (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, transporteur, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(nom, prix || 0, telephone, produit, commune, adresse || '', wilaya, livraison || 'A domicile', statut || '🛍️ Nouvelle', transporteur || '', notes || '').run()
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
async function expedierCommande(
  db: D1Database,
  cmd: any,
  hasCmdUserId: boolean,
  hasSuiviUserId: boolean,
  userId: number,
  isAdmin: boolean
): Promise<{ success: boolean, tracking?: string, error?: string }> {
  const transporteur = (cmd.transporteur || '').toLowerCase()
  let providerKey = ''
  if (transporteur.includes('yalidine')) providerKey = 'yalidine'
  else if (transporteur.includes('zr') || (transporteur.includes('express') && transporteur.includes('zr'))) providerKey = 'zr_express'
  else if (transporteur.includes('ecotrack') || transporteur.includes('pdex')) providerKey = 'ecotrack_pdex'
  else if (transporteur.includes('dhd')) providerKey = 'dhd'
  else if (transporteur.includes('noest')) providerKey = 'noest'
  else { providerKey = transporteur.replace(/[^a-z0-9]/g, '_') }

  const { results: configs } = await db.prepare('SELECT * FROM api_config WHERE provider = ? AND active = 1').bind(providerKey).all()
  const config = configs && configs.length > 0 ? JSON.parse((configs[0] as any).config_json) : null

  let tracking = ''
  let error = ''

  try {
    if (providerKey === 'yalidine' && config?.api_id && config?.api_token) {
      const isStop = cmd.livraison?.toLowerCase().includes('stop')
      const data = [{
        order_id: `CMD-${cmd.id}-${Date.now()}`, firstname: cmd.nom, familyname: '',
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
      await db.prepare(
        `INSERT INTO suivi (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, tracking, transporteur, notes, created_at, user_id)
         SELECT nom, prix, telephone, produit, commune, adresse, wilaya, livraison, 'EXPEDIE', ?, transporteur, notes, created_at, user_id FROM commandes WHERE id = ?`
      ).bind(tracking, cmd.id).run()
    } else {
      await db.prepare(
        `INSERT INTO suivi (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, tracking, transporteur, notes, created_at)
         SELECT nom, prix, telephone, produit, commune, adresse, wilaya, livraison, 'EXPEDIE', ?, transporteur, notes, created_at FROM commandes WHERE id = ?`
      ).bind(tracking, cmd.id).run()
    }
    await diminuerStock(db, cmd.produit)
    let deleteSql = 'DELETE FROM commandes WHERE id = ?'
    const deleteParams: any[] = [cmd.id]
    if (!isAdmin && hasCmdUserId) { deleteSql += ' AND user_id = ?'; deleteParams.push(userId) }
    await db.prepare(deleteSql).bind(...deleteParams).run()
    await db.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind('EXPEDIE', `Tracking: ${tracking} via ${cmd.transporteur}`, cmd.id).run()
    return { success: true, tracking }
  } else {
    await db.prepare('UPDATE commandes SET statut = ? WHERE id = ?').bind(`ERREUR: ${error}`, cmd.id).run()
    return { success: false, error }
  }
}

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
  const result = await expedierCommande(c.env.DB, cmd, hasCmdUserId, hasSuiviUserId, userId, isAdmin)
  if (result.success) return c.json({ success: true, tracking: result.tracking })
  return c.json({ error: result.error }, 500)
})

app.post('/api/envoyer-tous', async (c) => {
  const userId = c.get('userId')
  const isAdmin = c.get('userRole') === 'admin'
  const hasCmdUserId = await hasTableColumn(c.env.DB, 'commandes', 'user_id')
  const hasSuiviUserId = await hasTableColumn(c.env.DB, 'suivi', 'user_id')
  let query = "SELECT * FROM commandes WHERE LOWER(statut) LIKE 'confirm%' AND (tracking IS NULL OR tracking = '')"
  const params: any[] = []
  if (!isAdmin && hasCmdUserId) { query += ' AND user_id = ?'; params.push(userId) }
  const stmt = params.length ? c.env.DB.prepare(query).bind(...params) : c.env.DB.prepare(query)
  const { results } = await stmt.all()
  const sent: any[] = []
  const errors: any[] = []
  for (const cmd of (results || [])) {
    const r = await expedierCommande(c.env.DB, cmd as any, hasCmdUserId, hasSuiviUserId, userId, isAdmin)
    if (r.success) sent.push({ id: (cmd as any).id, nom: (cmd as any).nom, tracking: r.tracking })
    else errors.push({ id: (cmd as any).id, nom: (cmd as any).nom, error: r.error })
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
          return c.json({ history: data.history.map((h:any) => ({
              date: pickHistoryDate(h),
              status: h.state?.name || h.state,
              situation: h.situation?.name || h.situation || ''
          })) })
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
          return c.json({ history: items.map((h:any) => ({
              date: pickHistoryDate(h),
              status: h.status || h.status_id,
              situation: h.commune_name || h.center_name || ''
          })) })
        }
      }
    }
    return c.json({ history: [] })
  } catch(e:any) {
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

  // Sélectionner uniquement les colis non terminaux pour éviter de surcharger les APIs
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
        // Utiliser l'API histories plus fiable pour récupérer le dernier statut
        const resp = await fetch(`https://api.yalidine.com/v1/histories/?tracking=${tracking}`, {
          headers: { 'X-API-ID': config.api_id, 'X-API-TOKEN': config.api_token }
        })
        
        if (resp.ok) {
          const data: any = await resp.json()
          let parcel = null
          if (data?.data && Array.isArray(data.data) && data.data.length > 0) {
            // L'API Yalidine renvoie l'historique du plus récent au plus ancien, donc l'index 0 est le statut actuel
            parcel = data.data[0]
          } else if (data?.[tracking] && Array.isArray(data[tracking]) && data[tracking].length > 0) {
            parcel = data[tracking][0]
          }

          if (parcel && typeof parcel === 'object' && (parcel.status_id !== undefined || parcel.status !== undefined)) {
            const rawStatus = parcel.status_id || parcel.status
            let mappedStatut = traduireStatutYalidine(rawStatus)
            
            // Map specific statuses manually
            if (String(rawStatus) === '8' || String(rawStatus).toLowerCase().includes('vers wilaya') || String(parcel.status).toLowerCase().includes('vers wilaya')) mappedStatut = 'Vers Wilaya'
            if (String(rawStatus) === '13' || String(rawStatus).toLowerCase().includes('tentative') || String(parcel.status).toLowerCase().includes('tentative')) mappedStatut = 'Tentative échouée'

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
          'API_SYNC', `Synchronisation manuelle API: ${newStatut} (${situationText || 'aucun détail'})`, null
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
// USER CONFIG (webhook token)
// ========================
app.get('/api/user-config', async (c) => {
  const userId = c.get('userId')
  const db = c.env.DB
  await db.prepare('ALTER TABLE users ADD COLUMN webhook_token TEXT DEFAULT NULL').run().catch(() => {})
  let row = await db.prepare('SELECT webhook_token FROM users WHERE id = ?').bind(userId).first() as any
  if (!row?.webhook_token) {
    const token = await generateToken()
    await db.prepare('UPDATE users SET webhook_token = ? WHERE id = ?').bind(token, userId).run()
    row = { webhook_token: token }
  }
  return c.json({ webhook_token: row.webhook_token })
})

// ========================
// HISTORIQUE
// ========================
app.get('/api/historique', async (c) => {
  if (c.get('userRole') !== 'admin') {
    return c.json({ error: 'Accès réservé aux administrateurs', code: 'FORBIDDEN' }, 403)
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
            'WEBHOOK_UPDATE', `Mise à jour via Webhook: ${newStatut} (${situationText || 'aucun détail'})`, null
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
  try { parsed = new URL(normalized) } catch(e) { return c.json({ error: 'URL invalide' }, 400) }
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
    ).bind(consumer_key, consumer_secret, String(user_id), Number(user_id)).run()
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
      } catch(e) { errors++ }
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
    return c.json({ error: 'Méthode de paiement invalide' }, 400)
  }
  if (!proof_reference) {
    return c.json({ error: 'Référence de preuve de paiement requise' }, 400)
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

  return c.json({ success: true, id: result.meta.last_row_id, message: 'Demande envoyée, en attente de validation' })
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

// ========================
// PAGES HTML (served as static files from public/)
// ========================
app.get('/', (c) => c.redirect('/login'))

const loginHtml = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoHub DZ - Connexion</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="stylesheet" href="/static/tailwind.css">
</head>
<body class="min-h-screen bg-gray-50 flex items-center justify-center">
<div class="bg-white p-8 rounded-xl shadow-lg w-full max-w-md">
  <h1 class="text-2xl font-bold text-center mb-6">AutoHub DZ</h1>
  <form id="loginForm" class="space-y-4">
    <input id="username" type="text" placeholder="Email ou nom d'utilisateur" class="w-full border rounded-lg px-4 py-2" required>
    <input id="password" type="password" placeholder="Mot de passe" class="w-full border rounded-lg px-4 py-2" required>
    <button type="submit" class="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold hover:bg-blue-700">Se connecter</button>
    <p id="loginError" class="text-red-500 text-sm hidden"></p>
  </form>
  <p class="text-center text-sm mt-4">Pas de compte ? <a href="/register" class="text-blue-600">S'inscrire</a></p>
</div>
<script>
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('loginError')
  err.classList.add('hidden')
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ username: document.getElementById('username').value, password: document.getElementById('password').value })
  })
  const data = await res.json()
  if (data.success) { window.location.href = '/app' }
  else { err.textContent = data.error || 'Erreur de connexion'; err.classList.remove('hidden') }
})
</script>
</body></html>`

const registerHtml = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoHub DZ - Inscription</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="stylesheet" href="/static/tailwind.css">
</head>
<body class="min-h-screen bg-gray-50 flex items-center justify-center">
<div class="bg-white p-8 rounded-xl shadow-lg w-full max-w-md">
  <h1 class="text-2xl font-bold text-center mb-6">Créer un compte</h1>
  <form id="regForm" class="space-y-4">
    <input id="prenom" type="text" placeholder="Prénom" class="w-full border rounded-lg px-4 py-2" required>
    <input id="email" type="email" placeholder="Email" class="w-full border rounded-lg px-4 py-2" required>
    <input id="telephone" type="tel" placeholder="Téléphone (05xxxxxxxx)" class="w-full border rounded-lg px-4 py-2" required>
    <input id="store_name" type="text" placeholder="Nom du magasin" class="w-full border rounded-lg px-4 py-2" required>
    <input id="password" type="password" placeholder="Mot de passe" class="w-full border rounded-lg px-4 py-2" required>
    <input id="confirm_password" type="password" placeholder="Confirmer le mot de passe" class="w-full border rounded-lg px-4 py-2" required>
    <button type="submit" class="w-full bg-green-600 text-white py-2 rounded-lg font-semibold hover:bg-green-700">S'inscrire</button>
    <p id="regError" class="text-red-500 text-sm hidden"></p>
  </form>
  <p class="text-center text-sm mt-4">Déjà un compte ? <a href="/login" class="text-blue-600">Se connecter</a></p>
</div>
<script>
document.getElementById('regForm').addEventListener('submit', async (e) => {
  e.preventDefault()
  const err = document.getElementById('regError')
  err.classList.add('hidden')
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      prenom: document.getElementById('prenom').value,
      email: document.getElementById('email').value,
      telephone: document.getElementById('telephone').value,
      store_name: document.getElementById('store_name').value,
      password: document.getElementById('password').value,
      confirm_password: document.getElementById('confirm_password').value
    })
  })
  const data = await res.json()
  if (data.success) { window.location.href = '/app' }
  else { err.textContent = data.error || 'Erreur inscription'; err.classList.remove('hidden') }
})
</script>
</body></html>`

const appHtml = `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoHub DZ</title>
<link rel="stylesheet" href="/static/style.css">
<link rel="stylesheet" href="/static/tailwind.css">
</head>
<body class="min-h-screen bg-gray-100">
<div id="app-loading" class="flex items-center justify-center min-h-screen">
  <div class="text-center">
    <div class="text-4xl mb-4">🚚</div>
    <p class="text-gray-600 text-lg font-semibold">AutoHub DZ</p>
    <p class="text-gray-400 text-sm mt-2">Chargement...</p>
  </div>
</div>
<div id="app-root" class="hidden">
  <nav class="bg-white shadow-sm border-b px-6 py-3 flex items-center justify-between">
    <div class="font-bold text-lg text-blue-700">🚚 AutoHub DZ</div>
    <div class="flex items-center gap-4">
      <span id="nav-user" class="text-sm text-gray-600"></span>
      <button onclick="logout()" class="text-sm text-red-500 hover:underline">Déconnexion</button>
    </div>
  </nav>
  <main class="p-6">
    <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
      <div class="bg-white rounded-xl p-4 shadow-sm border">
        <p class="text-gray-500 text-sm">Commandes ce mois</p>
        <p id="stat-orders" class="text-3xl font-bold text-blue-700 mt-1">—</p>
      </div>
      <div class="bg-white rounded-xl p-4 shadow-sm border">
        <p class="text-gray-500 text-sm">Plan actuel</p>
        <p id="stat-plan" class="text-3xl font-bold text-green-600 mt-1">—</p>
      </div>
      <div class="bg-white rounded-xl p-4 shadow-sm border">
        <p class="text-gray-500 text-sm">Transporteurs actifs</p>
        <p id="stat-transporteurs" class="text-3xl font-bold text-purple-600 mt-1">—</p>
      </div>
    </div>
    <div class="bg-white rounded-xl p-6 shadow-sm border">
      <h2 class="text-lg font-semibold mb-4">Bienvenue sur AutoHub DZ</h2>
      <p class="text-gray-500">Votre plateforme de gestion des commandes et livraisons en Algérie.</p>
      <p class="text-gray-400 text-sm mt-2">Transporteurs disponibles : Yalidine, ZR Express, Ecotrack PDEX, DHD, NOEST</p>
    </div>
  </main>
</div>
<script>
async function init() {
  const res = await fetch('/api/auth/check')
  const data = await res.json()
  if (!data.authenticated) { window.location.href = '/login'; return }
  document.getElementById('app-loading').classList.add('hidden')
  document.getElementById('app-root').classList.remove('hidden')
  document.getElementById('nav-user').textContent = data.user.prenom || data.user.username
  document.getElementById('stat-plan').textContent = (data.user.subscription || 'starter').toUpperCase()
  const t = await fetch('/api/transporteurs')
  const tData = await t.json()
  document.getElementById('stat-transporteurs').textContent = Array.isArray(tData) ? tData.length : '—'
}
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' })
  window.location.href = '/login'
}
init()
</script>
</body></html>`

app.get('/login', (c) => c.html(loginHtml))
app.get('/register', (c) => c.html(registerHtml))
app.get('/app', (c) => c.html(appHtml))
app.get('/app/*', (c) => c.html(appHtml))

export default app

// ========================
// HELPER FUNCTIONS
// ========================
function traduireStatutZR(stateName: string): string {
  const s = String(stateName).toLowerCase().trim()
  const mapping: Record<string, string> = {
    dispatch: '📦 Prêt à expédier', ready: '📦 Prêt à expédier',
    confirme_au_bureau: '🚚 Ramassé', picked: '🚚 Ramassé', ramasse: '🚚 Ramassé',
    vers_wilaya: '🔄 En cours de transit', transit: '🔄 En cours de transit', in_transit: '🔄 En cours de transit', transfert: '🔄 En cours de transit',
    sortie_en_livraison: '?? En cours de livraison', en_livraison: '?? En cours de livraison', out_for_delivery: '?? En cours de livraison', delivery: '?? En cours de livraison',
    livre: '?? Livré & Encaissé', delivered: '?? Livré & Encaissé', encaisse: '?? Livré & Encaissé',
    retour: '??? Retour Expéditeur', returned: '??? Retour Expéditeur', retourne: '??? Retour Expéditeur', echec: '??? Retour Expéditeur',
    annule: 'Annule', cancelled: 'Annule', canceled: 'Annule'
  }
  if (mapping[s]) return mapping[s]
  for (const [key, value] of Object.entries(mapping)) { if (s.includes(key)) return value }
  return stateName.toUpperCase()
}

function traduireStatutYalidine(status: any): string {
  const s = String(status).trim()
  const mapping: Record<string, string> = {
    '1': '🛍️ Nouvelle', '2': '✅ Confirmée', '3': 'Annule', '4': '📦 Prêt à expédier', '5': 'EXPEDIE',
    '6': '🚚 Ramassé', '7': '🔄 En cours de transit', '8': '🔄 En cours de transit', '9': '🔄 En cours de transit', '10': '🔄 En cours de transit',
    '11': '?? En cours de livraison', '12': '?? Livré & Encaissé', '13': 'ECHEC LIVRAISON', '14': '??? Retour Expéditeur', '15': '??? Retour Expéditeur'
  }
  if (mapping[s]) return mapping[s]

  const text = s.toLowerCase()
  if (text.includes('livre')) return '?? Livré & Encaissé'
  if (text.includes('retour')) return '??? Retour Expéditeur'
  if (text.includes('transit')) return '🔄 En cours de transit'
  if (text.includes('livraison')) return '?? En cours de livraison'
  if (text.includes('pret')) return '📦 Prêt à expédier'
  if (text.includes('ramasse')) return '🚚 Ramassé'
  if (text.includes('annul')) return 'Annule'

  return s.toUpperCase()
}

function traduireStatutEcotrack(status: any): string {
  const s = String(status).toLowerCase().trim()
  const mapping: Record<string, string> = {
    'nouveau': '🛍️ Nouvelle', 'en attente': 'EN ATTENTE', 'pret': '📦 Prêt à expédier',
    'expedie': 'EXPEDIE', 'recu': '🚚 Ramassé', 'en cours': '🔄 En cours de transit',
    'en livraison': '?? En cours de livraison', 'livre': '?? Livré & Encaissé', 'echoue': '??? Retour Expéditeur',
    'retourne': '??? Retour Expéditeur', 'annule': 'Annule'
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


