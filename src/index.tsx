import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'

type Bindings = { DB: D1Database }
type Variables = { userId: number; userName: string; userRole: string; userSubscription: string }

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
    "SELECT s.user_id, u.username, u.nom, u.prenom, u.role, u.subscription FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).bind(token).first() as any

  if (!session) {
    deleteCookie(c, 'session_token')
    return c.json({ error: 'Session expirée', code: 'AUTH_REQUIRED' }, 401)
  }

  c.set('userId', session.user_id)
  c.set('userName', session.prenom || session.nom || session.username)
  c.set('userRole', session.role || 'client')
  c.set('userSubscription', session.subscription || 'starter')
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
    "SELECT s.user_id, u.username, u.nom, u.prenom, u.role, u.store_name, u.subscription FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > datetime('now')"
  ).bind(token).first() as any
  if (!session) return c.json({ authenticated: false })
  return c.json({ authenticated: true, user: { id: session.user_id, username: session.username, nom: session.nom, prenom: session.prenom, role: session.role, subscription: session.subscription || 'starter', store_name: session.store_name } })
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
  if (role !== undefined && role !== 'admin' && role !== 'client') {
    return c.json({ error: 'Rôle invalide' }, 400)
  }
  if (active !== undefined && active !== 0 && active !== 1) {
    return c.json({ error: 'Statut actif invalide' }, 400)
  }

  const target = await c.env.DB.prepare('SELECT id, role, active FROM users WHERE id = ?').bind(id).first() as any
  if (!target) return c.json({ error: 'Utilisateur introuvable' }, 404)

  if (id === adminId && (role === 'client' || active === 0)) {
    return c.json({ error: 'Vous ne pouvez pas rétrograder ou désactiver votre propre compte' }, 400)
  }

  const demoteAdmin = target.role === 'admin' && role === 'client'
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
  const transporteur = c.req.query('transporteur') || '%'
  const { results } = await c.env.DB.prepare(
    'SELECT name FROM stop_desks WHERE wilaya_id = ? AND transporteur LIKE ? ORDER BY name'
  ).bind(wid, transporteur).all()
  return c.json(results)
})

// ========================
// COMMANDES CRUD
// ========================
app.get('/api/commandes', async (c) => {
  const statut = c.req.query('statut')
  let query = 'SELECT * FROM commandes'
  const params: any[] = []
  if (statut) { query += ' WHERE statut = ?'; params.push(statut) }
  query += ' ORDER BY created_at DESC'
  const stmt = params.length ? c.env.DB.prepare(query).bind(...params) : c.env.DB.prepare(query)
  const { results } = await stmt.all()
  return c.json(results)
})

app.post('/api/commandes', async (c) => {
  const body = await c.req.json()
  const { nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, transporteur, notes } = body
  if (!nom || !telephone || !produit || !wilaya || !commune) {
    return c.json({ error: 'Champs obligatoires manquants' }, 400)
  }
  const result = await c.env.DB.prepare(
    `INSERT INTO commandes (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, transporteur, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(nom, prix || 0, telephone, produit, commune, adresse || '', wilaya, livraison || 'A domicile', statut || '🛍️ Nouvelle', transporteur || '', notes || '').run()
  await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind('CREATION', `Nouvelle commande enregistree pour ${nom}`, result.meta.last_row_id).run()
  return c.json({ id: result.meta.last_row_id, success: true })
})

app.put('/api/commandes/:id', async (c) => {
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
  values.push(id)
  await c.env.DB.prepare(`UPDATE commandes SET ${updates.join(', ')} WHERE id = ?`).bind(...values).run()
  await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind('MODIFICATION', JSON.stringify(body), id).run()
  return c.json({ success: true })
})

app.delete('/api/commandes/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('DELETE FROM commandes WHERE id = ?').bind(id).run()
  return c.json({ success: true })
})

// ========================
// ENVOI VERS TRANSPORTEURS
// ========================
app.post('/api/envoyer/:id', async (c) => {
  const id = c.req.param('id')
  const { results } = await c.env.DB.prepare('SELECT * FROM commandes WHERE id = ?').bind(id).all()
  if (!results || results.length === 0) return c.json({ error: 'Commande introuvable' }, 404)
  const cmd = results[0] as any
  if (cmd.statut !== 'Confirme') return c.json({ error: 'Seules les commandes confirmees peuvent etre envoyees' }, 400)
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
    await c.env.DB.prepare(
      `INSERT INTO suivi (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, tracking, transporteur, notes, created_at)
       SELECT nom, prix, telephone, produit, commune, adresse, wilaya, livraison, 'EXPEDIE', ?, transporteur, notes, created_at FROM commandes WHERE id = ?`
    ).bind(tracking, id).run()
    await diminuerStock(c.env.DB, cmd.produit)
    await c.env.DB.prepare('DELETE FROM commandes WHERE id = ?').bind(id).run()
    await c.env.DB.prepare('INSERT INTO historique (action, details, commande_id) VALUES (?, ?, ?)').bind('EXPEDIE', `Tracking: ${tracking} via ${cmd.transporteur}`, id).run()
    return c.json({ success: true, tracking })
  } else {
    await c.env.DB.prepare('UPDATE commandes SET statut = ? WHERE id = ?').bind(`ERREUR: ${error}`, id).run()
    return c.json({ error }, 500)
  }
})

app.post('/api/envoyer-tous', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id FROM commandes WHERE statut = 'Confirme' AND (tracking IS NULL OR tracking = '')").all()
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
  const statut = c.req.query('statut')
  const transporteur = c.req.query('transporteur')
  let query = 'SELECT * FROM suivi WHERE 1=1'
  const params: any[] = []
  if (statut) { query += ' AND statut = ?'; params.push(statut) }
  if (transporteur) { query += ' AND transporteur LIKE ?'; params.push(`%${transporteur}%`) }
  query += ' ORDER BY created_at DESC'
  const stmt = params.length ? c.env.DB.prepare(query).bind(...params) : c.env.DB.prepare(query)
  const { results } = await stmt.all()
  return c.json(results)
})

app.post('/api/actualiser-statuts', async (c) => {
  const { results: configs } = await c.env.DB.prepare("SELECT config_json FROM api_config WHERE provider = 'zr_express' AND active = 1").all()
  if (!configs || configs.length === 0) return c.json({ error: 'Config ZR Express manquante' }, 400)
  const config = JSON.parse((configs[0] as any).config_json)
  const { results: suivis } = await c.env.DB.prepare("SELECT * FROM suivi WHERE transporteur LIKE '%ZR%' OR transporteur LIKE '%zr%' OR transporteur LIKE '%Express%'").all()
  let updated = 0, errors = 0
  for (const s of (suivis || [])) {
    const item = s as any
    if (!item.tracking || item.tracking.startsWith('MAN-')) continue
    try {
      const resp = await fetch(`https://api.zrexpress.app/api/v1/parcels/${item.tracking}`, {
        headers: { 'X-Api-Key': config.api_key, 'X-Tenant': config.tenant }
      })
      if (resp.ok) {
        const data: any = await resp.json()
        let stateName = typeof data.state === 'object' ? data.state?.name || '' : String(data.state || '')
        let situationText = ''
        if (data.situation && typeof data.situation === 'object') {
          situationText = data.situation.name || data.situation.description || ''
          if (data.situation.metadata?.comment) situationText += ` (${data.situation.metadata.comment})`
        }
        const traduit = traduireStatutZR(stateName)
        const oldStatut = (item.statut || '').toUpperCase()
        await c.env.DB.prepare('UPDATE suivi SET statut = ?, situation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(traduit, situationText, item.id).run()
        // Update phone verification stats
        const tel = (item.telephone || '').replace(/[\s\-\.\']/g, '')
        if (tel) {
          const isNewDelivered = traduit.toUpperCase().includes('LIVRE') && !oldStatut.includes('LIVRE')
          const isNewReturned = traduit.toUpperCase().includes('RETOURNE') && !oldStatut.includes('RETOURNE')
          if (isNewDelivered || isNewReturned) {
            await c.env.DB.prepare(
              `INSERT INTO phone_verification (telephone, delivered, returned) VALUES (?, ?, ?)
               ON CONFLICT(telephone) DO UPDATE SET
               delivered = delivered + ?, returned = returned + ?, updated_at = CURRENT_TIMESTAMP`
            ).bind(tel, isNewDelivered ? 1 : 0, isNewReturned ? 1 : 0, isNewDelivered ? 1 : 0, isNewReturned ? 1 : 0).run()
          }
        }
        updated++
      } else { errors++ }
    } catch { errors++ }
  }
  return c.json({ updated, errors })
})

// ========================
// STOCK
// ========================
app.get('/api/stock', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM stock ORDER BY id').all()
  return c.json(results)
})

app.put('/api/stock/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const { stock_actuel, entree, sortie, seuil_alerte } = body
  if (stock_actuel !== undefined) {
    const sf = (stock_actuel || 0) + (entree || 0) - (sortie || 0)
    await c.env.DB.prepare('UPDATE stock SET stock_actuel = ?, entree = ?, sortie = ?, stock_final = ?, seuil_alerte = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(stock_actuel, entree || 0, sortie || 0, sf, seuil_alerte || 5, id).run()
  }
  return c.json({ success: true })
})

// ========================
// DASHBOARD STATS
// ========================
app.get('/api/stats', async (c) => {
  const [cmdCount, suiviCount, livreCount, retourCount, caTotal, stockAlerts, aPreparer, aExpedier, margeParProduit] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) as c FROM commandes').first(),
    c.env.DB.prepare('SELECT COUNT(*) as c FROM suivi').first(),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM suivi WHERE statut LIKE '%LIVRE%'").first(),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM suivi WHERE statut LIKE '%RETOURNE%'").first(),
    c.env.DB.prepare("SELECT SUM(prix) as total FROM suivi WHERE statut LIKE '%LIVRE%'").first(),
    c.env.DB.prepare('SELECT COUNT(*) as c FROM stock WHERE stock_actuel <= seuil_alerte').first(),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM commandes WHERE UPPER(statut) IN ('EN ATTENTE','CONFIRME')").first(),
    c.env.DB.prepare("SELECT COUNT(*) as c FROM suivi WHERE UPPER(statut) LIKE '%EXPEDIE%' OR UPPER(statut) LIKE '%EN LIVRAISON%'").first(),
    c.env.DB.prepare(
      `SELECT
          produit,
          COUNT(*) as ventes,
          SUM(prix) as ca,
          SUM(prix - CASE WHEN LOWER(livraison) LIKE '%stop%' THEN 450 ELSE 650 END) as marge_nette
       FROM suivi
       WHERE UPPER(statut) LIKE '%LIVRE%'
       GROUP BY produit
       ORDER BY marge_nette DESC
       LIMIT 6`
    ).all(),
  ])
  const totalSuivi = (suiviCount as any)?.c || 0
  const totalLivre = (livreCount as any)?.c || 0
  const tauxLivraison = totalSuivi > 0 ? Math.round((totalLivre / totalSuivi) * 100) : 0
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
    marge_par_produit: (margeParProduit as any)?.results || []
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
  const { results } = await c.env.DB.prepare('SELECT * FROM historique ORDER BY created_at DESC LIMIT 100').all()
  return c.json(results)
})

// ========================
// WEBHOOK
// ========================
app.post('/api/webhook', async (c) => {
  try {
    const data: any = await c.req.json()
    console.log('Webhook Received:', JSON.stringify(data))

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
      }
    }

    return c.json({ success: true, processed: !!(tracking && newStatut) })
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
    if (!resp.ok) return c.json({ error: `Erreur API: ${resp.status}` }, 500)
    const orders: any[] = await resp.json()
    let imported = 0, errors = 0
    for (const order of orders) {
      try {
        const nom = (order.billing?.first_name || '') + ' ' + (order.billing?.last_name || '')
        const telephone = order.billing?.phone || ''
        const produit = order.line_items?.map((i: any) => i.name).join(', ') || 'Produit WooCommerce'
        const prix = Number(order.total) || 0
        const wilaya = order.shipping?.state || order.billing?.state || ''
        const commune = order.shipping?.city || order.billing?.city || ''
        const adresse = (order.shipping?.address_1 || order.billing?.address_1 || '') + ' ' + (order.shipping?.address_2 || '')
        await c.env.DB.prepare(
          `INSERT INTO commandes (nom, prix, telephone, produit, commune, adresse, wilaya, livraison, statut, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(nom.trim(), prix, telephone, produit, commune, adresse.trim(), wilaya, 'A domicile', 'EN ATTENTE', 'woocommerce').run()
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
// PAGES HTML
// ========================
app.get('/', (c) => c.html(landingPage()))
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
    dispatch: '📦 Prêt à expédier', ready: '📦 Prêt à expédier',
    confirme_au_bureau: '🚚 Ramassé', picked: '🚚 Ramassé', ramasse: '🚚 Ramassé',
    vers_wilaya: '🔄 En cours de transit', transit: '🔄 En cours de transit', in_transit: '🔄 En cours de transit', transfert: '🔄 En cours de transit',
    sortie_en_livraison: '🚴 En cours de livraison', en_livraison: '🚴 En cours de livraison', out_for_delivery: '🚴 En cours de livraison', delivery: '🚴 En cours de livraison',
    livre: '💰 Livré & Encaissé', delivered: '💰 Livré & Encaissé', encaisse: '💰 Livré & Encaissé',
    retour: '🔙 Retour Expéditeur', returned: '🔙 Retour Expéditeur', retourne: '🔙 Retour Expéditeur', echec: '🔙 Retour Expéditeur',
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
    '11': '🚴 En cours de livraison', '12': '💰 Livré & Encaissé', '13': 'ECHEC LIVRAISON', '14': '🔙 Retour Expéditeur', '15': '🔙 Retour Expéditeur'
  }
  if (mapping[s]) return mapping[s]

  const text = s.toLowerCase()
  if (text.includes('livre')) return '💰 Livré & Encaissé'
  if (text.includes('retour')) return '🔙 Retour Expéditeur'
  if (text.includes('transit')) return '🔄 En cours de transit'
  if (text.includes('livraison')) return '🚴 En cours de livraison'
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
    'en livraison': '🚴 En cours de livraison', 'livre': '💰 Livré & Encaissé', 'echoue': '🔙 Retour Expéditeur',
    'retourne': '🔙 Retour Expéditeur', 'annule': 'Annule'
  }
  if (mapping[s]) return mapping[s]
  for (const [key, value] of Object.entries(mapping)) { if (s.includes(key)) return value }
  return s.toUpperCase()
}


async function diminuerStock(db: D1Database, produit: string) {
  const tailles = ['2XL', 'XXL', 'XL', 'S', 'M', 'L']
  const produitUp = produit.toUpperCase()
  let taille = ''
  for (const t of tailles) {
    if (produitUp.includes('TAILLE:' + t) || produitUp.includes('_' + t + '_') || produitUp.includes(':' + t)) { taille = t; break }
  }
  if (!taille) return
  const stock = await db.prepare('SELECT * FROM stock WHERE taille = ?').bind(taille).first() as any
  if (!stock) return
  const newStock = Math.max(0, stock.stock_actuel - 1)
  const newSortie = stock.sortie + 1
  await db.prepare('UPDATE stock SET stock_actuel = ?, sortie = ?, stock_final = ?, updated_at = CURRENT_TIMESTAMP WHERE taille = ?')
    .bind(newStock, newSortie, newStock, taille).run()
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
        <p class="text-gray-400 text-sm">Suivez votre stock par taille et reference. Alertes automatiques quand le stock est bas.</p>
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
  return `<!DOCTYPE html>
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
    <div class="nav-item active" onclick="navigateTo('dashboard')"><i class="fas fa-chart-pie w-5"></i> Tableau de bord</div>
    <div class="nav-item" onclick="navigateTo('commandes')"><i class="fas fa-clipboard-list w-5"></i> Commandes</div>
    <div class="nav-item" onclick="navigateTo('suivi')"><i class="fas fa-truck w-5"></i> Suivi</div>
    <div class="nav-item" onclick="navigateTo('stock')"><i class="fas fa-boxes-stacked w-5"></i> Stock</div>
    <div class="nav-item" onclick="navigateTo('wilayaspage')"><i class="fas fa-map-marked-alt w-5"></i> Wilayas & Communes</div>
    <div id="nav-item-boutique" class="nav-item" onclick="navigateTo('boutique')"><i class="fas fa-store w-5"></i> Boutique</div>
    <div id="nav-item-integration" class="nav-item" onclick="navigateTo('integration')"><i class="fas fa-plug-circle-bolt w-5"></i> Integration API</div>
    <div class="nav-item" onclick="navigateTo('historique')"><i class="fas fa-clock-rotate-left w-5"></i> Historique</div>
    <div id="nav-item-utilisateurs" class="nav-item hidden" onclick="navigateTo('utilisateurs')"><i class="fas fa-users-cog w-5"></i> Utilisateurs</div>
    <div class="nav-item" onclick="navigateTo('pricing')"><i class="fas fa-tags w-5"></i> Tarification</div>
    <div class="nav-item" onclick="navigateTo('guide')"><i class="fas fa-book-open w-5"></i> Guide</div>
  </nav>
  <div class="p-4 border-t border-white/5">
    <div class="user-badge mb-3">
      <i class="fas fa-user-circle text-indigo-400 text-lg"></i>
      <div>
        <div class="text-xs font-medium" id="sidebar-user">Admin</div>
        <div class="text-[10px] text-gray-500" id="sidebar-store"></div>
      </div>
    </div>
    <button onclick="logout()" class="nav-item text-red-400 text-xs w-full justify-center hover:bg-red-500/10" style="margin:0;padding:8px">
      <i class="fas fa-sign-out-alt"></i> Deconnexion
    </button>
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
  <div id="view-utilisateurs" class="hidden"></div>
  <div id="view-pricing" class="hidden"></div>
  <div id="view-guide" class="hidden"></div>
</main>

<div id="modals"></div>
<div id="toasts"></div>

<script>
// ===================== STATE =====================
let state = { wilayas:[], currentView:'dashboard', commandes:[], suivi:[], stock:[], stats:{}, config:[], historique:[], user:null, transporteurs:[], storeSources:[], phoneCache:{}, deliveryCompanies:[], wilayasFull:null, subscription: 'starter' }
let autoWhatsAppEnabled = localStorage.getItem('auto_whatsapp_confirm') === '1'
const api = axios.create({ baseURL: '/api' })
const platformIcons = { shopify:'fab fa-shopify', woocommerce:'fab fa-wordpress', youcan:'fas fa-shopping-bag' }
const platformColors = { shopify:'platform-shopify', woocommerce:'platform-woocommerce', youcan:'platform-youcan' }

api.interceptors.response.use(r => r, err => {
  if(err.response?.status === 401 && err.response?.data?.code === 'AUTH_REQUIRED') {
    window.location.href = '/login'
  }
  if(err.response?.status === 403 && err.response?.data?.code === 'FORBIDDEN') {
    toast(err.response?.data?.error || 'Accès refusé', 'error')
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
    
    if (data.user.role === 'admin') {
      navAdmin?.classList.remove('hidden')
      navBoutique?.classList.remove('hidden')
      navInteg?.classList.remove('hidden')
    } else if (data.user.role === 'employe') {
      navAdmin?.classList.add('hidden')
      navBoutique?.classList.add('hidden')
      navInteg?.classList.add('hidden')
    } else {
      navAdmin?.classList.add('hidden')
    }
    // Masquer tout de suite : avant, on attendait /transporteurs, ce qui pouvait laisser
    // l'overlay plein écran actif (écran "éteint à moitié", aucun clic).
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
  if (view === 'utilisateurs' && state.user?.role !== 'admin') {
    toast('Accés réservé aux administrateurs', 'error')
    return
  }
  if (state.user?.role === 'employe' && (view === 'boutique' || view === 'integration')) {
    toast('Accés non autorisé pour le rôle employé', 'error')
    return
  }
  const views = ['dashboard','commandes','suivi','stock','wilayaspage','boutique','integration','historique','utilisateurs','pricing','guide']
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
  if (view==='dashboard') loadDashboard()
  else if (view==='commandes') loadCommandes()
  else if (view==='suivi') loadSuivi()
  else if (view==='stock') loadStock()
  else if (view==='wilayaspage') loadWilayasPage()
  else if (view==='boutique') loadSources()
  else if (view==='integration') loadConfig()
  else if (view==='historique') loadHistorique()
  else if (view==='utilisateurs') loadUtilisateurs()
  else if (view==='pricing') loadPricing()
  else if (view==='guide') loadGuide()
  document.getElementById('sidebar').classList.remove('open')
}

// ===================== STATUS COLORS =====================
// ===================== CONSTANTS =====================
const livraisons = ['A domicile', 'Stop Desk']
const statuts = [
  '🛍️ Nouvelle', '✅ Confirmée', '📵 Pas de réponse', '🚫 Numéro erroné', '👯 Doublon',
  '📦 Prêt à expédier', '🚚 Ramassé', '🔄 En cours de transit', '🚴 En cours de livraison',
  '💰 Livré & Encaissé', '🔙 Retour Expéditeur', 'Annule', 'Reporte'
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
  
  // Build items HTML using map and join with single quotes to avoid backtick nesting
  const itemsHtml = options.map(opt => 
    '<div class="dropdown-item p-2 text-sm hover:bg-indigo-500/20 cursor-pointer transition" data-value="' + opt + '">' + opt + '</div>'
  ).join('')

  wrapper.innerHTML = '<div class="relative">' +
    '<input type="text" class="dropdown-input" placeholder="' + placeholder + '" value="' + (originalSelect.value || '') + '" autocomplete="off">' +
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
      input.value = val
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
  if (hasApi && c.statut === 'Confirme') {
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
    toast('L\\'automatisation WhatsApp est reservee aux plans PRO et Business. Veuillez mettre a jour votre abonnement.', 'error')
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

  document.getElementById('view-dashboard').innerHTML = '<div class="mb-6">' +
      '<h1 class="text-2xl font-bold">Tableau de bord</h1>' +
      '<p class="text-gray-400 text-sm mt-1">Bienvenue, ' + (state.user?.prenom || state.user?.nom || state.user?.username || 'Admin') + '</p>' +
    '</div>' +
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
}

async function loadCommandes() {
  const { data } = await api.get('/commandes')
  state.commandes = data
  if (state.wilayas.length === 0) { const w = await api.get('/wilayas'); state.wilayas = w.data }
  
  const phones = data.map(c => (c.telephone || ''))
  await loadPhoneVerification(phones)
  
  const confirmedCount = data.filter(c => c.statut === 'Confirme').length
  const v = document.getElementById('view-commandes')
  
  const rows = data.map(c => '<tr>' +
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
        '<button onclick="envoyerCommande(' + c.id + ')" class="btn btn-success text-xs py-1 px-2" title="Envoyer" ' + (c.statut !== 'Confirme' ? 'disabled style="opacity:0.3"' : '') + '><i class="fas fa-paper-plane"></i></button>' +
        '<button onclick="deleteCommande(' + c.id + ')" class="btn btn-danger text-xs py-1 px-2" title="Supprimer"><i class="fas fa-trash"></i></button>' +
      '</div>' +
    '</td>' +
  '</tr>').join('')

  v.innerHTML = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">' +
      '<div><h1 class="text-2xl font-bold">Commandes</h1><p class="text-gray-400 text-sm">' + data.length + ' commande(s)</p></div>' +
      '<div class="flex gap-2 flex-wrap">' +
        '<button onclick="showAddModal()" class="btn btn-primary"><i class="fas fa-plus mr-1"></i> Nouvelle</button>' +
        '<button onclick="toggleAutoWhatsApp()" class="btn ' + (state.subscription === 'starter' ? 'opacity-40 grayscale cursor-not-allowed' : (autoWhatsAppEnabled ? 'btn-success' : 'btn-outline')) + '">' +
          '<i class="' + (state.subscription === 'starter' ? 'fas fa-lock' : 'fab fa-whatsapp') + ' mr-1"></i> Auto WhatsApp: ' + (state.subscription === 'starter' ? 'PRO' : (autoWhatsAppEnabled ? 'ON' : 'OFF')) +
        '</button>' +
        '<button onclick="envoyerTous()" class="btn btn-success ' + (confirmedCount === 0 ? 'opacity-40 cursor-not-allowed' : '') + '" ' + (confirmedCount === 0 ? 'disabled' : '') + '>' +
          '<i class="fas fa-paper-plane mr-1"></i> Envoyer Confirmees (' + confirmedCount + ')' +
        '</button>' +
      '</div>' +
    '</div>' +
    '<div class="card overflow-x-auto">' +
      '<table>' +
        '<thead><tr>' +
          '<th>Nom</th><th>Tel</th><th>Verifier</th><th>Produit</th><th>Prix</th><th>Commune</th><th>Wilaya</th><th>Livraison</th><th>Statut</th><th>Boutique</th><th>Integration API</th><th>Transporteur</th><th>Actions</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      (data.length === 0 ? '<div class="text-center py-12 text-gray-500"><i class="fas fa-inbox text-4xl mb-3 block"></i><p>Aucune commande</p></div>' : '') +
    '</div>'
}

async function showAddModal(edit=null) {
  if(state.wilayas.length===0){const w=await api.get('/wilayas');state.wilayas=w.data}
  const c = edit || {nom:'',prix:'',telephone:'',produit:'',commune:'',adresse:'',wilaya:'',livraison:'A domicile',statut:'🛍️ Nouvelle',transporteur:'',notes:'',source:''}
  
  const wilayaOptions = state.wilayas.map(w => 
    '<option value="' + w.id + '"' + (c.wilaya === w.name ? ' selected' : '') + '>' + w.code + ' - ' + w.name + '</option>'
  ).join('')
  
  const livraisonOptions = livraisons.map(l => 
    '<option' + (c.livraison === l ? ' selected' : '') + '>' + l + '</option>'
  ).join('')
  
  const statutOptions = statuts.map(s => 
    '<option' + (c.statut === s ? ' selected' : '') + '>' + s + '</option>'
  ).join('')
  
  const transporteurOptions = state.transporteurs.map(t => 
    '<option' + (c.transporteur === t ? ' selected' : '') + '>' + t + '</option>'
  ).join('')

  document.getElementById('modals').innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal">' +
      '<div class="flex items-center justify-between mb-6">' +
        '<h2 class="text-lg font-bold"><i class="fas fa-' + (edit?'pen':'plus-circle') + ' mr-2 text-indigo-400"></i>' + (edit?'Modifier':'Nouvelle') + ' commande</h2>' +
        '<button onclick="closeModal()" class="text-gray-400 hover:text-white"><i class="fas fa-times"></i></button>' +
      '</div>' +
      '<form onsubmit="saveCommande(event,' + (edit?edit.id:'null') + ')" class="space-y-4">' +
        '<div class="grid grid-cols-2 gap-4">' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Nom complet *</label><input id="f-nom" value="' + c.nom + '" required placeholder="Nom du client"></div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Prix (DA) *</label><input id="f-prix" type="number" value="' + c.prix + '" required placeholder="0"></div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Telephone *</label><input id="f-tel" value="' + c.telephone + '" required placeholder="05xxxxxxxx"></div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Produit *</label><input id="f-produit" value="' + c.produit + '" required placeholder="Description produit"></div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Wilaya *</label>' +
            '<select id="f-wilaya" onchange="updateCommuneSource()" required>' +
              '<option value="">-- Choisir --</option>' +
              wilayaOptions +
            '</select>' +
          '</div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block" id="label-commune">Commune *</label>' +
            '<select id="f-commune" required><option value="' + c.commune + '">' + (c.commune||'-- Choisir wilaya --') + '</option></select>' +
          '</div>' +
          '<div class="col-span-2"><label class="text-xs text-gray-400 mb-1 block">Adresse</label><input id="f-adresse" value="' + (c.adresse||'') + '" placeholder="Adresse de livraison"></div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Livraison</label>' +
            '<select id="f-livraison" onchange="updateCommuneSource()">' + livraisonOptions + '</select>' +
          '</div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Statut</label>' +
            '<select id="f-statut">' + statutOptions + '</select>' +
          '</div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Transporteur</label>' +
            '<select id="f-transporteur" onchange="updateCommuneSource()"><option value="">-- Choisir --</option>' + transporteurOptions + '</select>' +
          '</div>' +
          '<div><label class="text-xs text-gray-400 mb-1 block">Notes</label><input id="f-notes" value="' + (c.notes||'') + '" placeholder="Notes optionnelles"></div>' +
        '</div>' +
        '<div class="flex justify-end gap-3 pt-4 border-t border-white/5">' +
          '<button type="button" onclick="closeModal()" class="btn btn-outline">Annuler</button>' +
          '<button type="submit" class="btn btn-primary"><i class="fas fa-save mr-1"></i> Enregistrer</button>' +
        '</div>' +
      '</form>' +
    '</div>' +
  '</div>'
  
  // Initialize Searchable Dropdowns
  const wilayaNames = state.wilayas.map(w => w.code + ' - ' + w.name)
  initSearchableDropdown('f-wilaya', wilayaNames, 'Rechercher wilaya...', (val) => {
    updateCommuneSource()
  })
  initSearchableDropdown('f-transporteur', state.transporteurs, 'Choisir transporteur...', () => updateCommuneSource())
  initSearchableDropdown('f-livraison', livraisons, 'Type livraison...', () => updateCommuneSource())
  initSearchableDropdown('f-statut', statuts, 'Statut...', null)

  if(edit){
    const wid=state.wilayas.find(w=>w.name===c.wilaya);
    if(wid) updateCommuneSource(c.commune)
  }
}

async function updateCommuneSource(selected='') {
  const wilayaId = document.getElementById('f-wilaya').value
  const type = document.getElementById('f-livraison').value
  const transporteur = document.getElementById('f-transporteur').value
  const label = document.getElementById('label-commune')
  const sel = document.getElementById('f-commune')
  
  if(!wilayaId) return
  
  sel.innerHTML = '<option value="">Chargement...</option>'
  
  try {
    let results = []
    if (type === 'Stop Desk') {
      label.innerHTML = '<i class="fas fa-building mr-1"></i> Bureau de retrait *'
      const { data } = await api.get('/api/stop-desks/' + wilayaId + '?transporteur=' + transporteur)
      results = data.map(d => d.name)
    } else {
      label.innerHTML = '<i class="fas fa-map-marker-alt mr-1"></i> Commune *'
      const { data } = await api.get('/api/communes/' + wilayaId)
      results = data.map(d => d.name)
    }
    
    sel.innerHTML = '<option value="">-- Choisir --</option>' + 
      results.map(r => '<option ' + (r===selected?'selected':'') + '>' + r + '</option>').join('')
    
    // Convert commune to searchable too (re-init if exists or first time)
    const existing = sel.parentElement.querySelector('.searchable-dropdown')
    if(existing) existing.remove()
    initSearchableDropdown('f-commune', results, type === 'Stop Desk' ? 'Rechercher bureau...' : 'Rechercher commune...', null)
    
  } catch (e) {
    sel.innerHTML = '<option value="">Erreur de chargement</option>'
  }
}

async function loadCommunesForSelect(wilayaId, selected='') {
  const { data } = await api.get('/communes/'+wilayaId)
  const sel = document.getElementById('f-commune')
  sel.innerHTML = '<option value="">-- Choisir --</option>' + data.map(c=>'<option'+(c.name===selected?' selected':'')+'>'+c.name+'</option>').join('')
}

async function saveCommande(e, id) {
  e.preventDefault()
  const wilayaSel = document.getElementById('f-wilaya')
  const wilayaName = wilayaSel.options[wilayaSel.selectedIndex]?.text?.split(' - ')[1] || ''
  const body = {
    nom: document.getElementById('f-nom').value,
    prix: Number(document.getElementById('f-prix').value),
    telephone: document.getElementById('f-tel').value,
    produit: document.getElementById('f-produit').value,
    wilaya: wilayaName,
    commune: document.getElementById('f-commune').value,
    adresse: document.getElementById('f-adresse').value,
    livraison: document.getElementById('f-livraison').value,
    statut: document.getElementById('f-statut').value,
    transporteur: document.getElementById('f-transporteur').value,
    notes: document.getElementById('f-notes').value
  }
  try {
    if(id) await api.put('/commandes/'+id, body)
    else {
      await api.post('/commandes', body)
      if (autoWhatsAppEnabled) sendWhatsAppMessage(body)
    }
    toast(id?'Commande modifiee':'Commande ajoutee')
    closeModal(); loadCommandes()
  } catch(err) { toast(err.response?.data?.error || 'Erreur', 'error') }
}

async function editCommande(id) {
  const cmd = state.commandes.find(c=>c.id===id)
  if(cmd) showAddModal(cmd)
}

async function deleteCommande(id) {
  if(!confirm('Supprimer cette commande ?')) return
  await api.delete('/commandes/'+id)
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
  const count = state.commandes.filter(c => c.statut === 'Confirme').length
  if(!confirm('Envoyer toutes les ' + count + ' commandes Confirmees aux transporteurs ?')) return
  try {
    const { data } = await api.get('/envoyer-tous')
    toast(data.sent+' envoyee(s), '+data.errors+' erreur(s)')
    loadCommandes()
  } catch(err) { toast('Erreur envoi en masse', 'error') }
}

function closeModal() { document.getElementById('modals').innerHTML = '' }

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal()
})

// ===================== SUIVI (with Verification column) =====================
async function loadSuivi() {
  const { data } = await api.get('/suivi')
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
    '<td>' + statusBadge(s.statut) + '</td>' +
    '<td class="font-mono text-xs text-green-300">' + (s.tracking || '') + '</td>' +
    '<td class="text-sm text-gray-300">' + (s.transporteur || '') + '</td>' +
    '<td><div class="flex gap-1"><button onclick="returnOrder(' + s.id + ')" class="btn btn-danger text-[10px] py-1 px-2" title="Marquer comme Retour"><i class="fas fa-rotate-left"></i> Retour</button></div></td>' +
    '</tr>').join('')

  document.getElementById('view-suivi').innerHTML = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">' +
    '<div><h1 class="text-2xl font-bold">Suivi des colis</h1><p class="text-gray-400 text-sm">' + data.length + ' colis</p></div>' +
    '<button onclick="actualiserStatuts()" class="btn btn-primary"><i class="fas fa-sync mr-1"></i> Actualiser statuts</button>' +
    '</div>' +
    '<div class="card overflow-x-auto">' +
    '<table><thead><tr><th>Nom</th><th>Tel</th><th>Verifier</th><th>Produit</th><th>Prix</th><th>Commune</th><th>Wilaya</th><th>Statut</th><th>Tracking</th><th>Transporteur</th><th>Actions</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>' +
    (data.length === 0 ? '<div class="text-center py-12 text-gray-500"><i class="fas fa-truck text-4xl mb-3 block"></i><p>Aucun colis en suivi</p></div>' : '') +
    '</div>'
}

async function returnOrder(id) {
  if(!confirm('Marquer cet envoi comme RETOURNE ?')) return
  try {
    await api.put('/commandes/'+id, { statut: '🔙 Retour Expéditeur', situation: 'Marqué comme retour manuellement' })
    toast('Colis marqué comme retour'); loadSuivi()
  } catch(e) { toast('Erreur', 'error') }
}

async function actualiserStatuts() {
  try {
    const { data } = await api.post('/actualiser-statuts')
    toast(data.updated+' mis a jour, '+data.errors+' erreur(s)')
    loadSuivi()
  } catch(err) { toast('Erreur actualisation', 'error') }
}

// ===================== STOCK =====================
async function loadStock() {
  const { data } = await api.get('/stock')
  state.stock = data
  const cards = data.map(s => {
    const pct = s.stock_actuel <= 0 ? 0 : s.stock_actuel <= s.seuil_alerte ? 30 : 100
    const color = pct===0?'text-red-400 bg-red-500/10 border-red-500/20':pct===30?'text-orange-400 bg-orange-500/10 border-orange-500/20':'text-indigo-400 bg-indigo-500/10 border-indigo-500/20'
    return '<div class="card p-5 text-center border ' + color + '">' +
      '<div class="text-2xl font-bold mb-1">' + s.taille + '</div>' +
      '<div class="text-3xl font-black ' + (pct===0?'text-red-400':pct===30?'text-orange-400':'text-indigo-400') + '">' + s.stock_actuel + '</div>' +
      '<div class="text-xs text-gray-400 mt-1">Sortie: ' + s.sortie + '</div>' +
      '<button onclick="editStock(' + s.id + ')" class="btn btn-outline text-xs mt-3 w-full py-1"><i class="fas fa-pen mr-1"></i>Modifier</button>' +
      '</div>'
  }).join('')

  document.getElementById('view-stock').innerHTML = '<div class="mb-6"><h1 class="text-2xl font-bold">Gestion du stock</h1><p class="text-gray-400 text-sm">Stock par taille</p></div>' +
    '<div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">' + cards + '</div>'
}

async function editStock(id) {
  const s = state.stock.find(x=>x.id===id)
  if(!s) return
  document.getElementById('modals').innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal" style="max-width:400px">' +
      '<h2 class="text-lg font-bold mb-4"><i class="fas fa-boxes-stacked mr-2 text-indigo-400"></i>Modifier stock - Taille ' + s.taille + '</h2>' +
      '<form onsubmit="saveStock(event,' + id + ')" class="space-y-3">' +
        '<div><label class="text-xs text-gray-400">Stock actuel</label><input id="s-actuel" type="number" value="' + s.stock_actuel + '"></div>' +
        '<div><label class="text-xs text-gray-400">Entree</label><input id="s-entree" type="number" value="' + s.entree + '"></div>' +
        '<div><label class="text-xs text-gray-400">Sortie</label><input id="s-sortie" type="number" value="' + s.sortie + '"></div>' +
        '<div><label class="text-xs text-gray-400">Seuil d\\\'alerte</label><input id="s-seuil" type="number" value="' + s.seuil_alerte + '"></div>' +
        '<div class="flex justify-end gap-3 pt-3 border-t border-white/5">' +
          '<button type="button" onclick="closeModal()" class="btn btn-outline">Annuler</button>' +
          '<button type="submit" class="btn btn-primary">Enregistrer</button>' +
        '</div></form></div></div>'
}

async function saveStock(e, id) {
  e.preventDefault()
  try {
    await api.put('/stock/'+id, {
      stock_actuel: Number(document.getElementById('s-actuel').value),
      entree: Number(document.getElementById('s-entree').value),
      sortie: Number(document.getElementById('s-sortie').value),
      seuil_alerte: Number(document.getElementById('s-seuil').value)
    })
    toast('Stock mis a jour'); closeModal(); loadStock()
  } catch(err) { toast('Erreur','error') }
}

// ===================== STORE SOURCES =====================
async function loadSources() {
  const { data } = await api.get('/store-sources')
  state.storeSources = data
  const cards = data.map(s => {
    const icon = platformIcons[s.platform] || 'fas fa-globe'
    const color = platformColors[s.platform] || ''
    const isWoo = s.platform === 'woocommerce'
    const wooConnected = isWoo && s.consumer_key && s.consumer_secret
    return '<div class="card p-5">' +
      '<div class="flex items-center justify-between mb-4">' +
        '<div class="flex items-center gap-3">' +
          '<div class="w-10 h-10 rounded-lg flex items-center justify-center ' + (s.platform==='shopify'?'bg-green-500/10':'') + '  ' + (s.platform==='woocommerce'?'bg-purple-500/10':'') + ' ' + (s.platform==='youcan'?'bg-blue-500/10':'') + '">' +
            '<i class="' + icon + ' text-lg ' + (s.platform==='shopify'?'text-green-400':'') + ' ' + (s.platform==='woocommerce'?'text-purple-400':'') + ' ' + (s.platform==='youcan'?'text-blue-400':'') + '"></i>' +
          '</div>' +
          '<div><div class="font-medium text-sm capitalize">' + s.platform + '</div><div class="text-xs text-gray-400">' + s.domain + '</div></div>' +
        '</div>' +
        '<div class="flex items-center gap-2">' +
          (wooConnected ? '<span class="inline-flex items-center gap-1 text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full"><i class="fas fa-check-circle"></i>Connecte</span>' : '') +
          '<span class="inline-block w-2 h-2 rounded-full ' + (s.active?'bg-green-500':'bg-gray-600') + '"></span>' +
        '</div>' +
      '</div>' +
      (isWoo ? '<div class="mb-3 flex gap-2">' + (wooConnected
            ? '<button onclick="importWooOrders('+s.id+')" class="btn btn-success text-xs flex-1"><i class="fas fa-download mr-1"></i>Importer commandes</button>'
            : '<button onclick="connectWooCommerce(\\\'\' + s.domain + \'\\\')" class="btn text-xs flex-1" style="background:linear-gradient(135deg,#10b981,#059669);color:white;border:none"><i class="fas fa-plug mr-1"></i>Connecter AutoHub DZ</button>'
          ) + '</div>' : '') +
      '<div class="flex gap-2">' +
        '<button onclick="toggleSource(' + s.id + ', ' + (s.active?0:1) + ')" class="btn ' + (s.active?'btn-warning':'btn-success') + ' text-xs flex-1">' +
          '<i class="fas fa-' + (s.active?'pause':'play') + ' mr-1"></i> ' + (s.active?'Desactiver':'Activer') +
        '</button>' +
        '<button onclick="deleteSource(' + s.id + ')" class="btn btn-danger text-xs"><i class="fas fa-trash"></i></button>' +
      '</div>' +
    '</div>'
  }).join('')

  document.getElementById('view-boutique').innerHTML = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">' +
    '<div><h1 class="text-2xl font-bold">Boutique</h1><p class="text-gray-400 text-sm">Connectez vos boutiques Shopify, WooCommerce ou YouCan</p></div>' +
    '<button onclick="showAddSourceModal()" class="btn btn-primary"><i class="fas fa-plus mr-1"></i> Ajouter une boutique</button>' +
    '</div>' +
    '<div class="grid md:grid-cols-2 lg:grid-cols-3 gap-4">' + cards +
    (data.length===0?'<div class="col-span-full card p-12 text-center"><i class="fas fa-store text-4xl text-gray-600 mb-4 block"></i><p class="text-gray-400 mb-2">Aucune boutique configuree</p><p class="text-gray-500 text-sm">Ajoutez votre boutique Shopify, WooCommerce ou YouCan pour importer automatiquement vos commandes.</p></div>':'') +
    '</div>'
}

function showAddSourceModal() {
  document.getElementById('modals').innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal" style="max-width:450px">' +
      '<div class="bg-gradient-to-r from-indigo-600 to-indigo-700 -m-6 mb-5 p-5 rounded-t-2xl">' +
        '<h2 class="text-white font-bold text-center"><i class="fas fa-plus-circle mr-2"></i>Ajouter une nouvelle boutique</h2>' +
      '</div>' +
      '<form onsubmit="saveSource(event)" class="space-y-4 mt-2">' +
        '<div><label class="text-sm font-semibold text-gray-300 mb-2 block">Plateforme</label>' +
          '<select id="src-platform" onchange="updateSourceFields()" class="w-full" style="font-size:14px;padding:10px 14px">' +
            '<option value="shopify">Shopify</option><option value="woocommerce">WooCommerce</option><option value="youcan">YouCan</option></select></div>' +
        '<div id="src-domain-group"><label class="text-sm font-semibold text-gray-300 mb-1 block" id="src-domain-label">Subdomain</label>' +
          '<div class="text-xs text-indigo-400 mb-2" id="src-domain-hint">example.myshopify.com</div>' +
          '<input id="src-domain" required placeholder="votre-boutique.myshopify.com" style="font-size:14px;padding:10px 14px"></div>' +
        '<div class="flex gap-3 pt-2">' +
          '<button type="button" onclick="closeModal()" class="btn flex-1" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);padding:12px;border-radius:25px;font-weight:600">Annuler <i class="fas fa-times ml-1"></i></button>' +
          '<button type="submit" class="btn btn-primary flex-1" style="padding:12px;border-radius:25px;font-weight:600">Enregistrer <i class="fas fa-bookmark ml-1"></i></button>' +
        '</div></form></div></div>'
}

function updateSourceFields() {
  const platform = document.getElementById('src-platform').value
  const label = document.getElementById('src-domain-label')
  const hint = document.getElementById('src-domain-hint')
  const input = document.getElementById('src-domain')
  if (platform === 'shopify') {
    label.textContent = 'Subdomain'
    hint.textContent = 'example.myshopify.com'
    hint.style.display = 'block'
    input.placeholder = 'votre-boutique.myshopify.com'
  } else if (platform === 'woocommerce') {
    label.textContent = 'Domain'
    hint.textContent = ''
    hint.style.display = 'none'
    input.placeholder = 'votre-domaine.com'
  } else {
    label.textContent = 'Domain'
    hint.textContent = 'example.youcan.shop'
    hint.style.display = 'block'
    input.placeholder = 'votre-boutique.youcan.shop'
  }
}

async function saveSource(e) {
  e.preventDefault()
  try {
    await api.post('/store-sources', {
      platform: document.getElementById('src-platform').value,
      domain: document.getElementById('src-domain').value
    })
    toast('Boutique ajoutee avec succes'); closeModal(); loadSources()
  } catch(err) { toast(err.response?.data?.error || 'Erreur', 'error') }
}

async function toggleSource(id, active) {
  try {
    await api.put('/store-sources/'+id, { active })
    toast(active ? 'Boutique activee' : 'Boutique desactivee'); loadSources()
  } catch(err) { toast('Erreur', 'error') }
}

async function deleteSource(id) {
  if(!confirm('Supprimer cette boutique ?')) return
  try {
    await api.delete('/store-sources/'+id)
    toast('Boutique supprimee'); loadSources()
  } catch(err) { toast('Erreur', 'error') }
}

// ===================== CONFIG =====================
async function loadConfig() {
  const { data } = await api.get('/config')
  state.config = data
  const companies = await loadDeliveryCompanies()
  const providerNames = {
    yalidine:'Yalidine', zr_express:'ZR Express', ecotrack_pdex:'Ecotrack pdex',
    dhd:'DHD', noest:'NOEST'
  }
  const providerColors = {
    yalidine:'text-yellow-400', zr_express:'text-blue-400', ecotrack_pdex:'text-green-400',
    dhd:'text-red-400', noest:'text-indigo-400'
  }
  const allowedProviders = ['yalidine', 'zr_express', 'ecotrack_pdex', 'dhd', 'noest']
  const filteredData = data.filter(cfg => allowedProviders.includes(cfg.provider))

  let companiesHtml = ''
  if (companies.length > 0) {
    companiesHtml = '<div class="mb-6"><h2 class="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wider"><i class="fas fa-building mr-1"></i> Societes de livraison personnalisees</h2><div class="grid lg:grid-cols-2 xl:grid-cols-3 gap-4">'
    companies.forEach(function(dc) {
      companiesHtml += '<div class="card p-5" style="border:1px solid rgba(16,185,129,0.15)">' +
        '<div class="flex items-center justify-between mb-3">' +
          '<div class="flex items-center gap-2">' +
            '<div class="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400"><i class="fas fa-building text-sm"></i></div>' +
            '<div><div class="font-medium text-sm">' + dc.name + '</div>' +
            '<div class="text-[10px] ' + (dc.active?'text-green-400':'text-gray-500') + '">' + (dc.active?'Actif':'Inactif') + ' - ' + dc.api_type + '</div></div></div>' +
          '<div class="flex gap-1">' +
            '<button onclick="editCompanyById(' + dc.id + ')" class="btn btn-outline text-xs py-1 px-2"><i class="fas fa-pen"></i></button>' +
            '<button onclick="toggleCompany(' + dc.id + ',' + (dc.active?0:1) + ')" class="btn ' + (dc.active?'btn-warning':'btn-success') + ' text-xs py-1 px-2"><i class="fas fa-'+(dc.active?'pause':'play')+'"></i></button>' +
            '<button onclick="deleteCompany(' + dc.id + ')" class="btn btn-danger text-xs py-1 px-2"><i class="fas fa-trash"></i></button>' +
          '</div></div>' +
        (dc.api_url ? '<div class="text-[10px] text-gray-500 truncate"><i class="fas fa-link mr-1"></i>' + dc.api_url + '</div>' : '') +
        (dc.notes ? '<div class="text-[10px] text-gray-500 mt-1 truncate"><i class="fas fa-sticky-note mr-1"></i>' + dc.notes + '</div>' : '') +
        '</div>'
    })
    companiesHtml += '</div></div>'
  }

  const providersHtml = filteredData.map(cfg => {
    const p = JSON.parse(cfg.config_json)
    const displayName = providerNames[cfg.provider] || cfg.provider.replace(/_/g,' ')
    const color = providerColors[cfg.provider] || 'text-gray-400'
    const fieldsHtml = Object.entries(p).filter(([k])=>k!=='base_url').map(([k,v]) => 
      '<div><label class="text-[10px] text-gray-500">' + k + '</label>' +
      '<input value="' + v + '" onchange="updateConfigField(\\\'\' + cfg.provider + \'\\\',\\\'\' + k + \'\\\',this.value)" placeholder="' + k + '" class="mt-0.5 text-xs py-1.5"></div>'
    ).join('')

    return '<div class="card p-5">' +
      '<div class="flex items-center justify-between mb-3">' +
        '<div class="flex items-center gap-2">' +
          '<div class="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center ' + color + '"><i class="fas fa-truck text-sm"></i></div>' +
          '<div><div class="font-medium text-sm">' + displayName + '</div><div class="text-[10px] ' + (cfg.active?'text-green-400':'text-gray-500') + '">' + (cfg.active?'Actif':'Inactif') + '</div></div>' +
        '</div>' +
        '<label class="relative inline-flex items-center cursor-pointer">' +
          '<input type="checkbox" ' + (cfg.active?'checked':'') + ' onchange="toggleProvider(\\\'\' + cfg.provider + \'\\\',this.checked)" class="sr-only peer">' +
          '<div class="w-9 h-5 bg-gray-600 rounded-full peer peer-checked:bg-indigo-500 after:content-[\\\'\\\'] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full"></div>' +
        '</label>' +
      '</div>' +
      '<div class="space-y-2">' + fieldsHtml + '</div>' +
      '</div>'
  }).join('')

  document.getElementById('view-integration').innerHTML = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">' +
    '<div><h1 class="text-2xl font-bold">Integration API</h1><p class="text-gray-400 text-sm">Transporteurs actifs</p></div>' +
    '<button onclick="showAddCompanyModal()" class="btn" style="background:linear-gradient(135deg,#10b981,#059669);color:white;border:none;padding:10px 20px;border-radius:10px;font-weight:600;font-size:14px">' +
    '<i class="fas fa-plus-circle mr-2"></i>Ajouter Societe de Livraison</button>' +
    '</div>' +
    companiesHtml +
    '<div class="card p-5 mb-8 border border-indigo-500/30 bg-indigo-500/5">' +
      '<div class="flex items-center justify-between mb-3">' +
        '<h3 class="text-indigo-400 font-bold flex items-center gap-2"><i class="fas fa-satellite-dish"></i> Suivi en temps reel (Webhook)</h3>' +
        '<span class="badge-status bg-indigo-500/20 text-indigo-300 text-[10px]">Recommande</span>' +
      '</div>' +
      '<p class="text-[11px] text-gray-400 mb-4">Copiez cette URL et collez-la dans les parametres Webhook de vos transporteurs (Yalidine, ZR Express, etc.) pour des mises a jour instantanees.</p>' +
      '<div class="flex gap-2">' +
        '<input id="webhook-url" readonly value="' + window.location.origin + '/api/webhook" class="flex-1 bg-dark-900 border-white/10 text-indigo-300 font-mono text-xs py-2 px-3 rounded-lg outline-none border focus:border-indigo-500/50">' +
        '<button onclick="copyWebhookUrl()" class="btn btn-primary text-xs whitespace-nowrap py-2 px-4 rounded-lg"><i class="fas fa-copy mr-1"></i> Copier l\\\'URL</button>' +
      '</div></div>' +
    '<h2 class="text-sm font-semibold text-gray-400 mb-3 uppercase tracking-wider"><i class="fas fa-truck mr-1"></i> Transporteurs partenaires</h2>' +
    '<div class="grid lg:grid-cols-2 xl:grid-cols-3 gap-4">' + providersHtml + '</div>'
}

function editCompanyById(id) {
  const dc = state.deliveryCompanies.find(c => c.id === id)
  if (dc) showAddCompanyModal(dc)
}

async function toggleProvider(provider, active) {
  const cfg = state.config.find(c=>c.provider===provider)
  if(!cfg) return
  await api.put('/config/'+provider, { config: JSON.parse(cfg.config_json), active: active?1:0 })
  toast(provider.replace(/_/g,' ')+' '+(active?'active':'desactive')); loadConfig()
}

async function updateConfigField(provider, key, value) {
  const cfg = state.config.find(c=>c.provider===provider)
  if(!cfg) return
  const p = JSON.parse(cfg.config_json)
  p[key] = value
  await api.put('/config/'+provider, { config: p, active: cfg.active })
  state.config = state.config.map(c=>c.provider===provider?{...c,config_json:JSON.stringify(p)}:c)
}

// ===================== HISTORIQUE =====================
async function loadHistorique() {
  const { data } = await api.get('/historique')
  const rows = data.map(h => '<tr>' +
    '<td class="text-xs text-gray-400">' + new Date(h.created_at).toLocaleString('fr-FR') + '</td>' +
    '<td class="font-medium">' + h.action + '</td>' +
    '<td class="max-w-[300px] truncate text-sm text-gray-300">' + h.details + '</td>' +
    '<td>' + (h.commande_id||'--') + '</td>' +
    '</tr>').join('')

  document.getElementById('view-historique').innerHTML = '<div class="mb-6"><h1 class="text-2xl font-bold">Historique</h1></div>' +
    '<div class="card overflow-x-auto"><table><thead><tr><th>Date</th><th>Action</th><th>Details</th><th>ID Commande</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>'
}

function escapeHtml(s) {
  if (s === null || s === undefined) return ''
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
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
        '<option value="admin"' + (r === 'admin' ? ' selected' : '') + '>Admin</option>' +
        '<option value="employe"' + (r === 'employe' ? ' selected' : '') + '>Employé</option>' +
        '<option value="client"' + (r === 'client' ? ' selected' : '') + '>Client</option></select></td>' +
        '<td><select onchange="adminUpdateUser(' + u.id + ', \\'subscription\\', this.value)" class="text-xs bg-dark-800 border border-white/10 rounded px-2 py-1 ' + (s === 'pro' ? 'text-indigo-400' : (s === 'business' ? 'text-emerald-400' : 'text-gray-400')) + '">' +
        '<option value="starter"' + (s === 'starter' ? ' selected' : '') + '>Starter</option>' +
        '<option value="pro"' + (s === 'pro' ? ' selected' : '') + '>PRO</option>' +
        '<option value="business"' + (s === 'business' ? ' selected' : '') + '>Business</option></select></td>' +
        '<td><select ' + dis + ' onchange="adminUpdateUser(' + u.id + ', \\'active\\', this.value)" class="text-xs bg-dark-800 border border-white/10 rounded px-2 py-1">' +
        '<option value="1"' + (a === 1 ? ' selected' : '') + '>Actif</option>' +
        '<option value="0"' + (a === 0 ? ' selected' : '') + '>Inactif</option></select></td>' +
        '<td class="text-xs text-gray-500">' + (u.last_login ? new Date(u.last_login).toLocaleString('fr-FR') : '—') + '</td>' +
        '</tr>'
    }).join('')
    document.getElementById('view-utilisateurs').innerHTML = '<div class="mb-6"><h1 class="text-2xl font-bold"><i class="fas fa-users-cog text-indigo-400 mr-2"></i>Utilisateurs</h1><p class="text-gray-400 text-sm mt-1">Roles et activation des comptes (reserve admin).</p></div>' +
      '<div class="card overflow-x-auto"><table><thead><tr><th>ID</th><th>Username</th><th>Email</th><th>Boutique</th><th>Role</th><th>Plan</th><th>Statut</th><th>Derniere connexion</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>'
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
    const { data } = await api.get('/wilayas-full')
    state.wilayasFull = data
  }
  const wf = state.wilayasFull
  const wilayas = wf.wilayas || []
  const communesByWilaya = wf.communesByWilaya || {}

  let cardsHtml = ''
  wilayas.forEach(function(w) {
    const communes = communesByWilaya[w.id] || []
    let communesList = ''
    communes.forEach(function(c) {
      communesList += '<div class="commune-item text-xs text-gray-300 py-1.5 px-2.5 rounded-md hover:bg-indigo-500/10 hover:text-indigo-300 transition cursor-default flex items-center gap-1.5" role="listitem" data-commune-name="'+c.name.toLowerCase()+'"><i class="fas fa-map-pin text-gray-600" style="font-size:9px"></i> '+c.name+'</div>'
    })
    cardsHtml += '<div class="wilaya-card card p-0 overflow-hidden" data-wilaya-name="'+w.name.toLowerCase()+'" role="region" aria-label="Wilaya de '+w.name+'">'
    cardsHtml += '<button onclick="toggleWilaya(this)" class="w-full flex items-center justify-between p-4 hover:bg-white/3 transition cursor-pointer" aria-expanded="false" aria-controls="communes-'+w.id+'" style="background:none;border:none;text-align:left">'
    cardsHtml += '<div class="flex items-center gap-3"><div class="w-10 h-10 rounded-lg bg-indigo-500/15 flex items-center justify-center text-indigo-400 font-bold text-sm flex-shrink-0">'+w.code+'</div>'
    cardsHtml += '<div><div class="font-semibold text-sm text-white">'+w.name+'</div><div class="text-[11px] text-gray-500">'+communes.length+' commune(s)</div></div></div>'
    cardsHtml += '<i class="fas fa-chevron-down text-gray-500 text-xs transition-transform wilaya-chevron"></i></button>'
    cardsHtml += '<div id="communes-'+w.id+'" class="hidden border-t border-white/5" role="list" aria-label="Communes de '+w.name+'"><div class="p-3 grid grid-cols-2 gap-1">'+communesList+'</div></div></div>'
  })

  document.getElementById('view-wilayaspage').innerHTML = '<div class="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4"><div><h1 class="text-2xl font-bold"><i class="fas fa-map-marked-alt text-indigo-400 mr-2"></i>Wilayas & Communes</h1><p class="text-gray-400 text-sm">Explorez les '+wilayas.length+' wilayas et leurs communes</p></div><div class="flex gap-2"><div class="relative"><i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-sm"></i><input id="wilaya-search" type="text" placeholder="Rechercher wilaya ou commune..." oninput="filterWilayas(this.value)" style="padding-left:36px;width:300px;background:rgba(17,24,39,0.8);border:1px solid rgba(255,255,255,0.1);color:#fff;border-radius:10px;font-size:13px;padding-top:10px;padding-bottom:10px" aria-label="Rechercher une wilaya ou commune"></div><button onclick="toggleAllWilayas()" class="btn btn-outline" aria-label="Tout ouvrir/fermer"><i class="fas fa-arrows-up-down mr-1"></i> Tout ouvrir/fermer</button></div></div><div id="wilayas-grid" class="grid md:grid-cols-2 xl:grid-cols-3 gap-3">'+cardsHtml+'</div><style>.wilaya-card button[aria-expanded="true"] .wilaya-chevron{transform:rotate(180deg)}.commune-highlight{background:rgba(99,102,241,0.2)!important;color:#818cf8!important}</style>'
}

function toggleWilaya(btn) {
  const expanded = btn.getAttribute('aria-expanded') === 'true'
  btn.setAttribute('aria-expanded', !expanded)
  const panel = btn.nextElementSibling
  panel.classList.toggle('hidden')
}

function toggleAllWilayas() {
  const cards = document.querySelectorAll('.wilaya-card button[aria-expanded]')
  const allOpen = Array.from(cards).every(b => b.getAttribute('aria-expanded') === 'true')
  cards.forEach(b => {
    b.setAttribute('aria-expanded', allOpen ? 'false' : 'true')
    b.nextElementSibling.classList.toggle('hidden', allOpen)
  })
}

function filterWilayas(query) {
  const q = query.toLowerCase().trim()
  const cards = document.querySelectorAll('.wilaya-card')
  document.querySelectorAll('.commune-highlight').forEach(el => el.classList.remove('commune-highlight'))
  cards.forEach(card => {
    const wname = card.dataset.wilayaName
    const communes = card.querySelectorAll('.commune-item')
    let wilayaMatch = wname.includes(q)
    let communeMatch = false
    communes.forEach(c => {
      if (c.dataset.communeName.includes(q)) { communeMatch = true; if (q) c.classList.add('commune-highlight') }
      else { c.classList.remove('commune-highlight') }
    })
    const show = !q || wilayaMatch || communeMatch
    card.style.display = show ? '' : 'none'
    if (communeMatch && q) {
      const btn = card.querySelector('button[aria-expanded]')
      btn.setAttribute('aria-expanded', 'true')
      btn.nextElementSibling.classList.remove('hidden')
    }
  })
}

// ===================== DELIVERY COMPANIES =====================
async function loadDeliveryCompanies() {
  const { data } = await api.get('/delivery-companies')
  state.deliveryCompanies = data
  return data
}

function showAddCompanyModal(edit=null) {
  const c = edit || { name:'', api_type:'manual', api_url:'', api_key:'', api_token:'', notes:'' }
  const title = (edit ? 'Modifier' : 'Ajouter') + ' Societe de Livraison'
  const icon = edit ? 'pen' : 'plus-circle'
  const idToPass = edit ? edit.id : 'null'

  document.getElementById('modals').innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)closeModal()">' +
    '<div class="modal" style="max-width:500px">' +
      '<div class="bg-gradient-to-r from-emerald-600 to-teal-600 -m-6 mb-5 p-5 rounded-t-2xl">' +
        '<h2 class="text-white font-bold text-center">' +
          '<i class="fas fa-' + icon + ' mr-2"></i>' + title +
        '</h2>' +
      '</div>' +
      '<form onsubmit="saveCompany(event,' + idToPass + ')" class="space-y-4 mt-2">' +
        '<div><label class="text-sm font-semibold text-gray-300 mb-1 block">Nom de la societe *</label>' +
          '<input id="dc-name" value="' + (c.name||'') + '" required placeholder="Ex: Ma Societe Express" style="font-size:14px;padding:10px 14px"></div>' +
        '<div><label class="text-sm font-semibold text-gray-300 mb-1 block">Type d\\\'API</label>' +
          '<select id="dc-type" style="font-size:14px;padding:10px 14px">' +
            '<option ' + (c.api_type==='manual'?'selected':'') + ' value="manual">Manuel (sans API)</option>' +
            '<option ' + (c.api_type==='rest'?'selected':'') + ' value="rest">REST API</option>' +
            '<option ' + (c.api_type==='custom'?'selected':'') + ' value="custom">Personnalise</option>' +
          '</select></div>' +
        '<div><label class="text-sm font-semibold text-gray-300 mb-1 block">URL de l\\\'API</label>' +
          '<input id="dc-url" value="' + (c.api_url||'') + '" placeholder="https://api.societe.dz/v1" style="font-size:14px;padding:10px 14px"></div>' +
        '<div class="grid grid-cols-2 gap-3">' +
          '<div><label class="text-sm font-semibold text-gray-300 mb-1 block">Cle API</label>' +
            '<input id="dc-key" type="password" value="' + (c.api_key||'') + '" placeholder="Cle API" style="font-size:13px;padding:10px 14px"></div>' +
          '<div><label class="text-sm font-semibold text-gray-300 mb-1 block">Token API</label>' +
            '<input id="dc-token" type="password" value="' + (c.api_token||'') + '" placeholder="Token" style="font-size:13px;padding:10px 14px"></div>' +
        '</div>' +
        '<div><label class="text-sm font-semibold text-gray-300 mb-1 block">Notes</label>' +
          '<textarea id="dc-notes" rows="2" placeholder="Notes optionnelles..." style="font-size:13px;padding:10px 14px">' + (c.notes||'') + '</textarea></div>' +
        '<div class="flex gap-3 pt-2">' +
          '<button type="button" onclick="closeModal()" class="btn flex-1" style="background:rgba(239,68,68,0.15);color:#f87171;border:1px solid rgba(239,68,68,0.3);padding:12px;border-radius:25px;font-weight:600">Annuler <i class="fas fa-times ml-1"></i></button>' +
          '<button type="submit" class="btn btn-primary flex-1" style="padding:12px;border-radius:25px;font-weight:600;background:linear-gradient(135deg,#10b981,#059669)">Enregistrer <i class="fas fa-save ml-1"></i></button>' +
        '</div></form></div></div>'
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
    if (id) await api.put('/delivery-companies/'+id, body)
    else await api.post('/delivery-companies', body)
    toast(id ? 'Societe modifiee' : 'Societe ajoutee')
    closeModal(); loadConfig()
  } catch(err) { toast(err.response?.data?.error || 'Erreur', 'error') }
}

async function deleteCompany(id) {
  if (!confirm('Supprimer cette societe de livraison ?')) return
  try {
    await api.delete('/delivery-companies/'+id)
    toast('Societe supprimee'); loadConfig()
  } catch(err) { toast('Erreur', 'error') }
}

async function toggleCompany(id, active) {
  try {
    await api.put('/delivery-companies/'+id, { active: active ? 1 : 0 })
    toast(active ? 'Societe activee' : 'Societe desactivee'); loadConfig()
  } catch(err) { toast('Erreur', 'error') }
}

// ===================== WOOCOMMERCE CONNECT =====================
async function connectWooCommerce(domain) {
  try {
    const { data } = await api.get('/woo/connect?domain=' + encodeURIComponent(domain))
    if (data.url) window.location.href = data.url
  } catch(e) { toast('Erreur de connexion WooCommerce', 'error') }
}

async function loadPricing() {
  document.getElementById('view-pricing').innerHTML = '<div class="mb-10 text-center">' +
      '<h1 class="text-3xl font-extrabold text-white mb-2">Tarification & Plans</h1>' +
      '<p class="text-gray-400">Choisissez le plan qui correspond a la taille de votre boutique</p>' +
    '</div>' +
    '<div class="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto">' +
      '<!-- Plan Starter -->' +
      '<div class="card-glass p-8 flex flex-col items-center text-center relative overflow-hidden group">' +
        '<div class="absolute top-0 left-0 w-full h-1 bg-gray-600/30"></div>' +
        '<div class="w-16 h-16 rounded-2xl bg-gray-500/10 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">' +
          '<i class="fas fa-seedling text-gray-400 text-2xl"></i>' +
        '</div>' +
        '<h3 class="text-xl font-bold mb-2">Starter</h3>' +
        '<div class="text-3xl font-black mb-4">0 DA<span class="text-sm text-gray-500 font-medium">/mois</span></div>' +
        '<p class="text-gray-400 text-sm mb-8">Pour les nouvelles boutiques qui debutent.</p>' +
        '<ul class="text-sm text-gray-300 space-y-4 mb-10 text-left w-full">' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-emerald-400"></i> Jusqu\\'a 50 commandes/mois</li>' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-emerald-400"></i> Integration Yalidine & ZR</li>' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-emerald-400"></i> Suivi de livraison standard</li>' +
          '<li class="flex items-center gap-3 text-gray-600"><i class="fas fa-times"></i> Confirmations WhatsApp Auto</li>' +
        '</ul>' +
        '<button class="btn btn-outline w-full py-3 rounded-xl mt-auto">Plan Actuel</button>' +
      '</div>' +

      '<!-- Plan Pro -->' +
      '<div class="card-glass p-8 flex flex-col items-center text-center relative overflow-hidden border-indigo-500/30 group scale-105 shadow-2xl shadow-indigo-500/10">' +
        '<div class="absolute top-0 left-0 w-full h-1 bg-indigo-500"></div>' +
        '<div class="absolute -right-12 -top-12 w-24 h-24 bg-indigo-500/10 rounded-full blur-3xl"></div>' +
        '<div class="bg-indigo-600 text-white text-[10px] font-bold px-3 py-1 rounded-full absolute top-4 right-4 uppercase tracking-wider">Populaire</div>' +
        '<div class="w-16 h-16 rounded-2xl bg-indigo-500/20 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">' +
          '<i class="fas fa-rocket text-indigo-400 text-2xl"></i>' +
        '</div>' +
        '<h3 class="text-xl font-bold mb-2">Pro</h3>' +
        '<div class="text-3xl font-black mb-4">2,500 DA<span class="text-sm text-gray-500 font-medium">/mois</span></div>' +
        '<p class="text-gray-400 text-sm mb-8">L\\\'automatisation complete pour votre croissance.</p>' +
        '<ul class="text-sm text-gray-300 space-y-4 mb-10 text-left w-full">' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-indigo-400"></i> Commandes illimitees</li>' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-indigo-400"></i> <strong>WhatsApp Auto Illimite</strong></li>' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-indigo-400"></i> Dashboard Analytique Avance</li>' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-indigo-400"></i> Gestion de stock multicriteres</li>' +
        '</ul>' +
        '<button class="btn btn-primary w-full py-3 rounded-xl mt-auto shadow-lg shadow-indigo-500/20">Passer au Pro</button>' +
      '</div>' +

      '<!-- Plan Business -->' +
      '<div class="card-glass p-8 flex flex-col items-center text-center relative overflow-hidden group">' +
        '<div class="absolute top-0 left-0 w-full h-1 bg-emerald-500/30"></div>' +
        '<div class="w-16 h-16 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">' +
          '<i class="fas fa-building text-emerald-400 text-2xl"></i>' +
        '</div>' +
        '<h3 class="text-xl font-bold mb-2">Business</h3>' +
        '<div class="text-3xl font-black mb-4">Sur Devis</div>' +
        '<p class="text-gray-400 text-sm mb-8">Solutions sur mesure pour grandes structures.</p>' +
        '<ul class="text-sm text-gray-300 space-y-4 mb-10 text-left w-full">' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-emerald-400"></i> Support prioritaire 24/7</li>' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-emerald-400"></i> Integration API Personnalisee</li>' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-emerald-400"></i> Multi-comptes employes</li>' +
          '<li class="flex items-center gap-3"><i class="fas fa-check text-emerald-400"></i> Rapports comptables exportables</li>' +
        '</ul>' +
        '<button class="btn btn-outline w-full py-3 rounded-xl mt-auto hover:bg-emerald-500/5">Contacter le Support</button>' +
      '</div>' +
    '</div>' +

    '<div class="mt-16 card p-6 max-w-3xl mx-auto border-dashed border-white/10">' +
        '<div class="flex items-center gap-4">' +
            '<div class="w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center flex-shrink-0">' +
                '<i class="fas fa-gift text-amber-500"></i>' +
            '</div>' +
            '<div>' +
                '<h4 class="font-bold text-white">Offre de lancement</h4>' +
                '<p class="text-sm text-gray-400">Tous les nouveaux comptes beneficient de <strong>14 jours d\\\'essai gratuit</strong> au plan Pro. Aucune carte bancaire requise.</p>' +
            '</div>' +
        '</div>' +
    '</div>'
}
function loadGuide() {
  document.getElementById('view-guide').innerHTML = '<div class="mb-6">' +
      '<h1 class="text-2xl font-bold"><i class="fas fa-book-open text-indigo-400 mr-2"></i>Guide - Connecter AutoHub DZ</h1>' +
      '<p class="text-gray-400 text-sm">Documentation complete pour integrer votre boutique WooCommerce avec AutoHub DZ</p>' +
    '</div>' +

    '<div class="space-y-5 max-w-4xl">' +

      '<!-- Introduction -->' +
      '<div class="card p-6">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-indigo-500/15 flex items-center justify-center">' +
            '<i class="fas fa-link text-indigo-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">Introduction</h2>' +
        '</div>' +
        '<p class="text-gray-300 text-sm leading-relaxed mb-3">' +
          'AutoHub DZ vous permet de connecter votre boutique <strong class="text-indigo-300">WooCommerce</strong> pour importer automatiquement vos commandes ' +
          'et les envoyer aux transporteurs partenaires (Yalidine, ZR Express, Ecotrack pdex, DHD, NOEST).' +
        '</p>' +
        '<p class="text-gray-300 text-sm leading-relaxed">' +
          'La connexion se fait via le protocole <strong class="text-white">OAuth</strong> de WooCommerce, qui vous permet d\\\'autoriser AutoHub DZ ' +
          'a acceder a votre boutique en lecture et ecriture de maniere securisee, sans partager votre mot de passe.' +
        '</p>' +
      '</div>' +

      '<!-- Prerequisites -->' +
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
          '<li class="flex items-start gap-2 text-sm text-gray-300">' +
            '<i class="fas fa-check-circle text-emerald-400 mt-0.5 flex-shrink-0"></i>' +
            'Acces administrateur a votre boutique WooCommerce' +
          '</li>' +
          '<li class="flex items-start gap-2 text-sm text-gray-300">' +
            '<i class="fas fa-check-circle text-emerald-400 mt-0.5 flex-shrink-0"></i>' +
            'WooCommerce version 3.5 ou superieure installee et activee' +
          '</li>' +
          '<li class="flex items-start gap-2 text-sm text-gray-300">' +
            '<i class="fas fa-check-circle text-emerald-400 mt-0.5 flex-shrink-0"></i>' +
            'L\\\'API REST de WooCommerce activee (activee par defaut)' +
          '</li>' +
          '<li class="flex items-start gap-2 text-sm text-gray-300">' +
            '<i class="fas fa-check-circle text-emerald-400 mt-0.5 flex-shrink-0"></i>' +
            'Les permaliens WordPress configures (autre que "Simple")' +
          '</li>' +
        '</ul>' +
      '</div>' +

      '<!-- Step 1 -->' +
      '<div class="card p-6">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-blue-500/15 flex items-center justify-center">' +
            '<i class="fas fa-store text-blue-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">2. Ajouter votre boutique</h2>' +
        '</div>' +
        '<ol class="space-y-3 text-sm text-gray-300">' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>' +
            'Allez dans <strong class="text-white">Boutique</strong> dans le menu lateral' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>' +
            'Cliquez sur <strong class="text-white">Ajouter une boutique</strong>' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>' +
            'Selectionnez <strong class="text-white">WooCommerce</strong> comme plateforme' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0">4</span>' +
            'Entrez votre domaine (ex: <code class="px-2 py-0.5 bg-white/5 rounded text-indigo-300 text-xs">votre-site.com</code>)' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-blue-500/20 text-blue-300 text-xs font-bold flex items-center justify-center flex-shrink-0">5</span>' +
            'Cliquez sur <strong class="text-white">Enregistrer</strong>' +
          '</li>' +
        '</ol>' +
      '</div>' +

      '<!-- Step 2 OAuth -->' +
      '<div class="card p-6">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-purple-500/15 flex items-center justify-center">' +
            '<i class="fas fa-key text-purple-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">3. Autoriser AutoHub DZ (OAuth)</h2>' +
        '</div>' +
        '<ol class="space-y-3 text-sm text-gray-300">' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>' +
            'Sur la carte de votre boutique WooCommerce, cliquez sur <strong class="text-emerald-300">Connecter AutoHub DZ</strong>' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>' +
            'Vous serez redirige vers votre site WooCommerce. <strong class="text-white">Connectez-vous</strong> si necessaire.' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>' +
            'WooCommerce affichera un ecran de consentement :' +
            '<div class="mt-2 ml-0 card p-3" style="background:rgba(255,255,255,0.04)">' +
              '<p class="text-xs text-gray-400 mb-2">AutoHub DZ demande acces Lecture/Ecriture :</p>' +
              '<ul class="space-y-1 text-xs text-gray-400">' +
                '<li><i class="fas fa-code text-indigo-400 mr-1"></i> Creer des crochets Web</li>' +
                '<li><i class="fas fa-tags text-indigo-400 mr-1"></i> Voir et gerer les codes promo</li>' +
                '<li><i class="fas fa-users text-indigo-400 mr-1"></i> Voir et gerer les clients</li>' +
                '<li><i class="fas fa-shopping-cart text-indigo-400 mr-1"></i> Voir et gerer les commandes et rapports de vente</li>' +
                '<li><i class="fas fa-box text-indigo-400 mr-1"></i> Voir et gerer les produits</li>' +
              '</ul>' +
            '</div>' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold flex items-center justify-center flex-shrink-0">4</span>' +
            'Cliquez sur <strong class="text-emerald-300">Approuver</strong> pour autoriser la connexion' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-purple-500/20 text-purple-300 text-xs font-bold flex items-center justify-center flex-shrink-0">5</span>' +
            'Vous serez rediriges automatiquement vers AutoHub DZ avec la confirmation de connexion' +
          '</li>' +
        '</ol>' +
      '</div>' +

      '<!-- Step 3 Permissions -->' +
      '<div class="card p-6">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center">' +
            '<i class="fas fa-shield-halved text-emerald-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">4. Permissions Lecture/Ecriture</h2>' +
        '</div>' +
        '<p class="text-gray-300 text-sm leading-relaxed mb-4">' +
          'AutoHub DZ demande un acces <strong class="text-white">Lecture/Ecriture</strong> (read_write) pour les raisons suivantes :' +
        '</p>' +
        '<div class="grid md:grid-cols-2 gap-3">' +
          '<div class="p-3 rounded-lg" style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.15)">' +
            '<div class="text-emerald-400 font-semibold text-sm mb-2"><i class="fas fa-eye mr-1"></i> Lecture (Read)</div>' +
            '<ul class="space-y-1 text-xs text-gray-400">' +
              '<li>• Lire les commandes en cours</li>' +
              '<li>• Voir les details des clients</li>' +
              '<li>• Recuperer les informations produits</li>' +
              '<li>• Consulter les rapports de vente</li>' +
            '</ul>' +
          '</div>' +
          '<div class="p-3 rounded-lg" style="background:rgba(59,130,246,0.06);border:1px solid rgba(59,130,246,0.15)">' +
            '<div class="text-blue-400 font-semibold text-sm mb-2"><i class="fas fa-pen mr-1"></i> Ecriture (Write)</div>' +
            '<ul class="space-y-1 text-xs text-gray-400">' +
              '<li>• Mettre a jour le statut des commandes</li>' +
              '<li>• Ajouter les numeros de tracking</li>' +
              '<li>• Creer des webhooks de notification</li>' +
              '<li>• Synchroniser les informations de livraison</li>' +
            '</ul>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<!-- Step 4 Import -->' +
      '<div class="card p-6">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-cyan-500/15 flex items-center justify-center">' +
            '<i class="fas fa-download text-cyan-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">5. Importer les commandes</h2>' +
        '</div>' +
        '<ol class="space-y-3 text-sm text-gray-300">' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>' +
            'Une fois connecte, un bouton <strong class="text-white">Importer commandes</strong> apparaitra sur la carte de votre boutique' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>' +
            'Cliquez dessus pour recuperer les commandes "En cours" de WooCommerce' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>' +
            'Les commandes seront ajoutees dans la section <strong class="text-white">Commandes</strong> avec le statut "EN ATTENTE"' +
          '</li>' +
          '<li class="flex items-start gap-3">' +
            '<span class="w-6 h-6 rounded-full bg-cyan-500/20 text-cyan-300 text-xs font-bold flex items-center justify-center flex-shrink-0">4</span>' +
            'Vous pouvez ensuite les traiter, choisir un transporteur, et les envoyer normalement' +
          '</li>' +
        '</ol>' +
      '</div>' +

      '<!-- Security -->' +
      '<div class="card p-6" style="border:1px solid rgba(239,68,68,0.15)">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-red-500/15 flex items-center justify-center">' +
            '<i class="fas fa-lock text-red-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">6. Securite & Bonnes Pratiques</h2>' +
        '</div>' +
        '<div class="space-y-3">' +
          '<div class="flex items-start gap-3 text-sm">' +
            '<div class="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0">' +
              '<i class="fas fa-shield-virus text-red-400 text-xs"></i>' +
            '</div>' +
            '<div>' +
              '<div class="text-white font-medium">HTTPS obligatoire</div>' +
              '<div class="text-gray-400 text-xs">Votre site WooCommerce doit utiliser HTTPS. Les connexions non securisees sont refusees.</div>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-start gap-3 text-sm">' +
            '<div class="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0">' +
              '<i class="fas fa-key text-red-400 text-xs"></i>' +
            '</div>' +
            '<div>' +
              '<div class="text-white font-medium">Cles API securisees</div>' +
              '<div class="text-gray-400 text-xs">Les cles Consumer Key/Secret sont stockees de maniere securisee et ne sont jamais exposees cote client.</div>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-start gap-3 text-sm">' +
            '<div class="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0">' +
              '<i class="fas fa-rotate text-red-400 text-xs"></i>' +
            '</div>' +
            '<div>' +
              '<div class="text-white font-medium">Revocation d\\\'acces</div>' +
              '<div class="text-gray-400 text-xs">Vous pouvez revoquer l\\\'acces a tout moment depuis WooCommerce > Reglages > Avance > API REST.</div>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-start gap-3 text-sm">' +
            '<div class="w-8 h-8 rounded-lg bg-red-500/10 flex items-center justify-center flex-shrink-0">' +
              '<i class="fas fa-user-shield text-red-400 text-xs"></i>' +
            '</div>' +
            '<div>' +
              '<div class="text-white font-medium">Conformite RGPD</div>' +
              '<div class="text-gray-400 text-xs">Les donnees clients importees sont traitees conformement aux reglementations en vigueur. Aucune donnee n\\'est partagee avec des tiers.</div>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<!-- Troubleshooting -->' +
      '<div class="card p-6">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-orange-500/15 flex items-center justify-center">' +
            '<i class="fas fa-wrench text-orange-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">7. Depannage</h2>' +
        '</div>' +
        '<div class="space-y-3">' +
          '<details class="group">' +
            '<summary class="flex items-center justify-between cursor-pointer text-sm text-white p-3 rounded-lg hover:bg-white/3 transition">' +
              '<span><i class="fas fa-exclamation-triangle text-orange-400 mr-2"></i>Erreur "Impossible de se connecter"</span>' +
              '<i class="fas fa-chevron-down text-gray-500 text-xs group-open:rotate-180 transition-transform"></i>' +
            '</summary>' +
            '<div class="p-3 text-xs text-gray-400 leading-relaxed">' +
              'Verifiez que votre site est accessible en HTTPS, que WooCommerce est actif, et que les permaliens ne sont pas en mode "Simple". Allez dans Reglages > Permaliens et choisissez "Nom de l\\\'article".' +
            '</div>' +
          '</details>' +
          '<details class="group">' +
            '<summary class="flex items-center justify-between cursor-pointer text-sm text-white p-3 rounded-lg hover:bg-white/3 transition">' +
              '<span><i class="fas fa-exclamation-triangle text-orange-400 mr-2"></i>Erreur 401 lors de l\\\'import</span>' +
              '<i class="fas fa-chevron-down text-gray-500 text-xs group-open:rotate-180 transition-transform"></i>' +
            '</summary>' +
            '<div class="p-3 text-xs text-gray-400 leading-relaxed">' +
              'Les cles API ont peut-etre ete revoquees. Deconnectez votre boutique, supprimez-la, puis reconnectez-la pour generer de nouvelles cles.' +
            '</div>' +
          '</details>' +
          '<details class="group">' +
            '<summary class="flex items-center justify-between cursor-pointer text-sm text-white p-3 rounded-lg hover:bg-white/3 transition">' +
              '<span><i class="fas fa-exclamation-triangle text-orange-400 mr-2"></i>Les commandes ne s\\\'importent pas</span>' +
              '<i class="fas fa-chevron-down text-gray-500 text-xs group-open:rotate-180 transition-transform"></i>' +
            '</summary>' +
            '<div class="p-3 text-xs text-gray-400 leading-relaxed">' +
              'AutoHub DZ importe uniquement les commandes avec le statut "Processing" (En cours). Verifiez que vous avez des commandes dans ce statut dans votre boutique WooCommerce.' +
            '</div>' +
          '</details>' +
        '</div>' +
      '</div>' +

      '<!-- API Credentials Info -->' +
      '<div class="card p-6">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-violet-500/15 flex items-center justify-center">' +
            '<i class="fas fa-code text-violet-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">8. Details techniques</h2>' +
        '</div>' +
        '<div class="space-y-2 text-sm text-gray-300">' +
          '<div class="flex items-center gap-2 p-2 rounded-lg bg-white/3">' +
            '<span class="text-gray-500 w-28 flex-shrink-0">Protocole</span>' +
            '<span class="text-indigo-300 font-mono text-xs">OAuth 1.0a (WooCommerce REST API)</span>' +
          '</div>' +
          '<div class="flex items-center gap-2 p-2 rounded-lg bg-white/3">' +
            '<span class="text-gray-500 w-28 flex-shrink-0">Scope</span>' +
            '<span class="text-indigo-300 font-mono text-xs">read_write</span>' +
          '</div>' +
          '<div class="flex items-center gap-2 p-2 rounded-lg bg-white/3">' +
            '<span class="text-gray-500 w-28 flex-shrink-0">Endpoint</span>' +
            '<span class="text-indigo-300 font-mono text-xs">/wc-auth/v1/authorize</span>' +
          '</div>' +
          '<div class="flex items-center gap-2 p-2 rounded-lg bg-white/3">' +
            '<span class="text-gray-500 w-28 flex-shrink-0">Authentification</span>' +
            '<span class="text-indigo-300 font-mono text-xs">Basic Auth (Consumer Key:Secret)</span>' +
          '</div>' +
          '<div class="flex items-center gap-2 p-2 rounded-lg bg-white/3">' +
            '<span class="text-gray-500 w-28 flex-shrink-0">API Version</span>' +
            '<span class="text-indigo-300 font-mono text-xs">WooCommerce REST API v3</span>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<!-- NEW: ADMIN ACCESS MANAGEMENT -->' +
      '<div class="card p-6 border-indigo-500/20 shadow-xl shadow-indigo-500/5">' +
        '<div class="flex items-center gap-3 mb-4">' +
          '<div class="w-10 h-10 rounded-lg bg-indigo-600/20 flex items-center justify-center">' +
            '<i class="fas fa-users-cog text-indigo-400"></i>' +
          '</div>' +
          '<h2 class="text-lg font-bold">Gestion des Accès Admin</h2>' +
        '</div>' +
        '<p class="text-gray-300 text-sm leading-relaxed mb-4">' +
          'En tant qu\\'administrateur, vous avez le pouvoir de gérer les permissions et les accès de tous les utilisateurs de la plateforme.' +
        '</p>' +
        '<div class="space-y-4">' +
          '<div class="flex items-start gap-3">' +
            '<div class="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-xs font-bold flex-shrink-0">1</div>' +
            '<div>' +
              '<div class="text-white font-medium text-sm">Promouvoir un utilisateur</div>' +
              '<p class="text-xs text-gray-400 mt-1">Allez dans l\\'onglet <strong>Utilisateurs</strong> (visible uniquement par les admins). Dans la colonne <strong>Rôle</strong>, changez "Client" en "Admin". Le changement est immédiat.</p>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-start gap-3">' +
            '<div class="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-xs font-bold flex-shrink-0">2</div>' +
            '<div>' +
              '<div class="text-white font-medium text-sm">Désactiver un compte</div>' +
              '<p class="text-xs text-gray-400 mt-1">Dans la colonne <strong>Statut</strong> de l\\'onglet Utilisateurs, vous pouvez passer un compte en "Inactif". L\\'utilisateur ne pourra plus se connecter.</p>' +
            '</div>' +
          '</div>' +
          '<div class="flex items-start gap-3">' +
            '<div class="w-8 h-8 rounded-full bg-indigo-500/20 text-indigo-300 flex items-center justify-center text-xs font-bold flex-shrink-0">3</div>' +
            '<div>' +
              '<div class="text-white font-medium text-sm">Sécurité Critique</div>' +
              '<p class="text-xs text-gray-400 mt-1 text-amber-400/80"><i class="fas fa-shield-alt mr-1"></i> Vous ne pouvez pas désactiver votre propre compte ni vous rétrograder. Au moins un administrateur doit rester actif dans le système.</p>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>' +

    '</div>'
}

// ===================== INIT =====================
checkAuth().then(ok => {
  if(ok) {
    // Handle query params (WooCommerce return redirect)
    const params = new URLSearchParams(window.location.search)
    if (params.get('page')) {
      navigateTo(params.get('page'))
      if (params.get('woo_connected')) {
        setTimeout(() => toast('WooCommerce connecte avec succes !'), 500)
      }
    } else {
      loadDashboard()
    }
  }
})
</script>
</body>
</html>`
}
