# AutoHub DZ

## Project Overview
- **Name**: AutoHub DZ
- **Goal**: Plateforme logistique e-commerce centralisee pour l'Algerie - automatiser la gestion des commandes et le suivi des colis avec 5 transporteurs integres
- **Theme**: Dark UI professionnel avec accents verts (branding AutoHub DZ)

## URLs
- **Sandbox**: https://3000-ijgknwppu7frq4hy1p4pz-ea026bf9.sandbox.novita.ai
- **Login**: /login (admin / admin123)
- **Register**: /register
- **Dashboard**: /app

## Fonctionnalites implementees

### Dashboard (Tableau de bord)
- Statistiques en temps reel : commandes, livraisons, retours, CA, taux
- Alertes stock automatiques

### Gestion des commandes (/app -> Commandes)
- CRUD complet : ajouter, modifier, supprimer
- **Colonne "Verifier"** : badges verts (livres) / rouges (retournes) par numero de telephone
- **Colonne "Boutique"** : badge plateforme (Shopify/WooCommerce/YouCan) pour tracer l'origine
- Statuts : EN ATTENTE, Confirme, EXPEDIE, Ne repond pas, Ferme, Annule, Reporte, Faux Numero, Double
- Envoi vers transporteur (individuel ou en masse)
- WhatsApp icon a cote du telephone

### Suivi des colis (/app -> Suivi)
- Vue complete avec colonnes Verifier (delivered/returned)
- Actualisation des statuts via API transporteurs
- Tracking en temps reel

### Boutique (/app -> Boutique)
- Integration Shopify (subdomain), WooCommerce (domain), YouCan (domain)
- CRUD complet : ajouter, activer/desactiver, supprimer
- Modal dynamique avec champs adaptes par plateforme
- Design inspire d'Octomatic (modal teal/green avec boutons arrondis)

### Stock
- Gestion par taille (S, M, L, XL, 2XL, XXL)
- Alertes seuil automatiques
- Decrementation automatique a l'expedition

### Integration API
- 5 transporteurs : Yalidine, ZR Express, Ecotrack pdex, DHD, NOEST
- Toggle actif/inactif par transporteur
- Champs API configurables

### Authentification
- Login/Register avec sessions securisees
- Hachage SHA-256 des mots de passe
- Sessions cookies HttpOnly de 30 jours
- Transporteurs filtres par utilisateur

### API & Webhook
- Webhook pour reception de statuts transporteurs
- Mise a jour automatique des compteurs phone_verification

## Data Architecture

### Tables principales
- **users** : Utilisateurs avec roles (admin/client)
- **sessions** : Sessions JWT-like via cookies
- **commandes** : Commandes en cours avec source
- **suivi** : Commandes expediees avec tracking
- **stock** : Stock par taille avec seuils d'alerte
- **store_sources** : Boutiques par utilisateur (shopify/woocommerce/youcan)
- **phone_verification** : Compteurs livres/retournes par telephone
- **user_transporteurs** : Liaison user -> transporteurs autorises
- **api_config** : Integration API des 5 transporteurs
- **wilayas** / **communes** : 58 wilayas et communes d'Algerie
- **historique** : Journal d'actions

### Storage
- **Cloudflare D1** (SQLite) pour toutes les donnees

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/login | Connexion |
| POST | /api/auth/register | Inscription |
| GET | /api/auth/check | Verification session |
| POST | /api/auth/logout | Deconnexion |
| GET | /api/commandes | Liste commandes |
| POST | /api/commandes | Creer commande |
| PUT | /api/commandes/:id | Modifier commande |
| DELETE | /api/commandes/:id | Supprimer commande |
| POST | /api/envoyer/:id | Envoyer au transporteur |
| POST | /api/envoyer-tous | Envoi en masse |
| GET | /api/suivi | Liste suivi |
| POST | /api/actualiser-statuts | Refresh statuts |
| GET | /api/stock | Stock |
| PUT | /api/stock/:id | Modifier stock |
| GET | /api/store-sources | Liste boutiques |
| POST | /api/store-sources | Ajouter boutique |
| PUT | /api/store-sources/:id | Modifier boutique |
| DELETE | /api/store-sources/:id | Supprimer boutique |
| GET | /api/phone-verify-batch?phones=... | Verification batch |
| GET | /api/phone-verify/:telephone | Verification unitaire |
| POST | /api/webhook | Webhook transporteurs |

## Deployment
- **Platform**: Cloudflare Pages
- **Tech Stack**: Hono + TypeScript + TailwindCSS CDN + D1 Database
- **Status**: En developpement local
- **Last Updated**: 2026-03-31
