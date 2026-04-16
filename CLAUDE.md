# AutoHub DZ — Contexte Projet

## Stack technique
- **Frontend/Backend** : Hono framework (fullstack sur Cloudflare Workers)
- **Runtime** : Cloudflare Workers (edge computing, PAS Node.js)
- **Base de données** : Cloudflare D1 (SQLite compatible, PAS PostgreSQL)
- **Build tool** : Vite + @hono/vite-build
- **Déploiement** : Cloudflare Pages via Wrangler
- **Langage** : TypeScript (tsx)
- **Type de projet** : Application de gestion automobile/livraison avec intégration WooCommerce

## Structure du projet
```
webapp/
├── src/
│   └── index.tsx          ← Point d'entrée principal (TOUT le code app est ici)
├── migrations/            ← Migrations SQL D1 (à appliquer dans l'ordre)
├── public/static/         ← Assets statiques (CSS, images)
├── .claude/worktrees/     ← Worktrees Claude Code (ne pas toucher)
├── dist/                  ← Build output (généré automatiquement)
├── seed.sql               ← Données initiales de la base
├── vite.config.ts         ← Config Vite
├── wrangler.jsonc         ← Config Cloudflare (D1, Pages, Workers)
├── ecosystem.config.cjs   ← Config PM2
└── fix_encoding.py        ← Script utilitaire encodage
```

## Commandes utiles
```bash
# Développement local
npm run dev

# Dev avec sandbox Cloudflare D1 local
npm run dev:sandbox

# Build production
npm run build

# Déployer sur Cloudflare Pages
npm run deploy

# Base de données locale
npm run db:migrate:local   # Appliquer les migrations
npm run db:seed            # Insérer les données initiales
npm run db:reset           # Reset complet (migrations + seed)

# Générer les types Cloudflare
npm run cf-typegen
```

## Base de données — Migrations (ordre important)
```
0001_initial_schema.sql
0002_registration_and_transporteurs.sql
0003_store_sources_and_verification.sql
0004_delivery_companies.sql
0005_woocommerce_integration.sql
0006_stop_desks.sql
0007_add_subscription.sql
0008_drop_legacy_stock_table.sql
001_add_user_scope_to_orders_and_tracking.sql
002_create_team_members.sql
```

## Conventions du projet
- Tout le code applicatif est dans `src/index.tsx` (fichier unique, très long ~6000+ lignes)
- Runtime Cloudflare Workers : pas de `fs`, `path`, `process` Node.js natifs
- Base de données accédée via `env.DB` (binding D1 Cloudflare), PAS via SQLAlchemy ou Prisma
- Utiliser `async/await` partout
- Les requêtes SQL sont du SQLite (pas PostgreSQL) — attention à la syntaxe

## Ce qu'il ne faut PAS toucher
- `.claude/worktrees/` — géré automatiquement par Claude Code
- `dist/` — généré par le build, ne pas éditer manuellement
- `wrangler.jsonc` — config de déploiement production, modifier avec précaution
- L'ordre des migrations dans `migrations/` — ne jamais modifier une migration existante

## Points d'attention importants
- C'est un projet **Cloudflare Workers**, pas un serveur Node.js classique
- Le déploiement se fait sur **Cloudflare Pages** (edge), pas sur un VPS
- La DB est **D1 (SQLite)** — les requêtes PostgreSQL ne fonctionneront pas
- `fix_encoding.py` suggère des problèmes d'encodage UTF-8 potentiels sur Windows
- Intégration WooCommerce présente (migration 0005)
