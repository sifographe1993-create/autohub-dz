import { Hono } from 'hono'

const app = new Hono()

// Note: avec @hono/vite-build/cloudflare-pages, public/static est copié dans dist/static
// et Cloudflare Pages sert automatiquement /static/* sans route Hono explicite.

// Page Dashboard (route principale + alias)
app.get('/', async (c) => {
  return c.html(DASHBOARD_HTML)
})

app.get('/dashboard', async (c) => {
  return c.html(DASHBOARD_HTML)
})

// ---------------------------------------------------------------------------
// HTML du Dashboard — style Shippingbo (clair, flat, épuré)
// ---------------------------------------------------------------------------
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>AutoHub DZ — Dashboard</title>

<!-- Tailwind CDN -->
<script src="https://cdn.tailwindcss.com"></script>
<!-- Lucide icons (style flat moderne, comme Shippingbo) -->
<script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
<!-- Chart.js pour le graphique "Overview of the day" -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<!-- Police Inter -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%233B82F6'/%3E%3Cpath d='M8 14h16M8 18h12M8 22h8' stroke='white' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E">

<script>
  // Configuration Tailwind — palette Shippingbo
  tailwind.config = {
    theme: {
      extend: {
        fontFamily: { sans: ['Inter', 'sans-serif'] },
        colors: {
          brand: {
            sidebar: '#1F2937',
            sidebarHover: '#374151',
            primary: '#3B82F6',
            primaryHover: '#2563EB',
            accent: '#F97316',
            accentHover: '#EA580C',
            bg: '#F7F8FA',
            surface: '#FFFFFF',
            text: '#1F2937',
            muted: '#6B7280',
            border: '#E5E7EB',
          }
        },
        boxShadow: {
          card: '0 1px 3px 0 rgba(0, 0, 0, 0.04), 0 1px 2px 0 rgba(0, 0, 0, 0.03)',
          cardHover: '0 4px 12px 0 rgba(0, 0, 0, 0.08)',
        }
      }
    }
  }
</script>

<link rel="stylesheet" href="/static/dashboard.css" />
</head>
<body class="bg-brand-bg font-sans text-brand-text antialiased">

  <!-- =========================================================
       SIDEBAR (style Shippingbo, bleu nuit)
       ========================================================= -->
  <aside id="sidebar" class="fixed top-0 left-0 h-screen w-60 bg-brand-sidebar text-gray-300 flex flex-col z-40">
    <!-- Logo -->
    <div class="h-16 flex items-center gap-2.5 px-5 border-b border-white/5">
      <div class="w-9 h-9 rounded-lg bg-brand-primary flex items-center justify-center">
        <i data-lucide="truck" class="w-5 h-5 text-white"></i>
      </div>
      <div>
        <div class="text-white font-bold text-sm leading-tight">AutoHub DZ</div>
        <div class="text-[10px] text-gray-400 leading-tight">Order management</div>
      </div>
    </div>

    <!-- Navigation -->
    <nav class="flex-1 py-4 overflow-y-auto">
      <div class="px-5 mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Pilotage</div>
      <a href="#" class="nav-item active" data-view="dashboard">
        <i data-lucide="layout-dashboard" class="w-4 h-4"></i><span>Dashboard</span>
      </a>
      <a href="#" class="nav-item" data-view="commandes">
        <i data-lucide="clipboard-list" class="w-4 h-4"></i><span>Commandes</span>
      </a>
      <a href="#" class="nav-item" data-view="suivi">
        <i data-lucide="map-pin" class="w-4 h-4"></i><span>Suivi</span>
      </a>

      <div class="px-5 mt-5 mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Logistique</div>
      <a href="#" class="nav-item" data-view="stock">
        <i data-lucide="package" class="w-4 h-4"></i><span>Stock</span>
      </a>
      <a href="#" class="nav-item" data-view="wilayas">
        <i data-lucide="map" class="w-4 h-4"></i><span>Wilayas</span>
      </a>
      <a href="#" class="nav-item" data-view="stopdesks">
        <i data-lucide="map-pinned" class="w-4 h-4"></i><span>Points relais</span>
      </a>

      <div class="px-5 mt-5 mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Configuration</div>
      <a href="#" class="nav-item" data-view="boutique">
        <i data-lucide="store" class="w-4 h-4"></i><span>Boutique</span>
      </a>
      <a href="#" class="nav-item" data-view="integration">
        <i data-lucide="plug" class="w-4 h-4"></i><span>Intégrations</span>
      </a>
      <a href="#" class="nav-item" data-view="equipe">
        <i data-lucide="users" class="w-4 h-4"></i><span>Équipe</span>
      </a>
      <a href="#" class="nav-item" data-view="revenus">
        <i data-lucide="trending-up" class="w-4 h-4"></i><span>Revenus</span>
      </a>
    </nav>

    <!-- User profile en bas -->
    <div class="border-t border-white/5 p-4">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 rounded-full bg-gradient-to-br from-blue-400 to-indigo-600 flex items-center justify-center text-white text-xs font-semibold">
          SA
        </div>
        <div class="flex-1 min-w-0">
          <div class="text-xs font-semibold text-white truncate">Sami Admin</div>
          <div class="text-[10px] text-gray-400 truncate">Boutique Alger</div>
        </div>
        <button class="text-gray-400 hover:text-white transition" aria-label="Paramètres">
          <i data-lucide="settings" class="w-4 h-4"></i>
        </button>
      </div>
    </div>
  </aside>

  <!-- =========================================================
       MAIN CONTENT
       ========================================================= -->
  <main class="ml-60 min-h-screen">

    <!-- Top Bar -->
    <header class="bg-white border-b border-brand-border sticky top-0 z-30">
      <div class="flex items-center justify-between px-8 h-16">
        <div class="flex items-center gap-4">
          <h1 class="text-lg font-bold text-brand-text">Dashboard</h1>
          <span class="text-sm text-brand-muted hidden md:inline">|</span>
          <span id="topbar-date" class="text-sm text-brand-muted hidden md:inline"></span>
        </div>

        <div class="flex items-center gap-3">
          <!-- Recherche -->
          <div class="relative hidden lg:block">
            <i data-lucide="search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-brand-muted"></i>
            <input
              type="text"
              placeholder="Rechercher une commande, un client..."
              class="pl-9 pr-4 py-2 w-72 text-sm bg-brand-bg border border-transparent rounded-lg
                     focus:outline-none focus:bg-white focus:border-brand-primary transition" />
          </div>

          <!-- Notifications -->
          <button class="relative p-2 rounded-lg hover:bg-brand-bg transition" aria-label="Notifications">
            <i data-lucide="bell" class="w-5 h-5 text-brand-muted"></i>
            <span class="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full"></span>
          </button>

          <!-- Aide -->
          <button class="p-2 rounded-lg hover:bg-brand-bg transition" aria-label="Aide">
            <i data-lucide="circle-help" class="w-5 h-5 text-brand-muted"></i>
          </button>

          <!-- CTA Abonnement (orange Shippingbo) -->
          <button class="flex items-center gap-2 bg-brand-accent hover:bg-brand-accentHover text-white text-sm font-semibold px-4 py-2 rounded-lg transition shadow-sm">
            <i data-lucide="zap" class="w-4 h-4"></i>
            <span>S'abonner</span>
          </button>
        </div>
      </div>
    </header>

    <!-- Contenu Dashboard -->
    <div class="p-8">

      <!-- Welcome banner -->
      <section class="mb-8">
        <h2 class="text-2xl font-bold text-brand-text">Bonjour Sami 👋</h2>
        <p class="text-sm text-brand-muted mt-1">Voici un aperçu de votre activité aujourd'hui.</p>
      </section>

      <!-- Grille principale : To do (2/3) + In progress (1/3) -->
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

        <!-- =================== À FAIRE (2/3) =================== -->
        <section id="todo-section" class="lg:col-span-2">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-base font-bold text-brand-text flex items-center gap-2">
              <span class="w-1 h-5 bg-brand-primary rounded-full"></span>
              À faire
            </h3>
            <button class="text-xs text-brand-primary hover:text-brand-primaryHover font-medium">
              Voir tout
            </button>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4" id="todo-cards">
            <!-- Cartes injectées par dashboard.js -->
          </div>
        </section>

        <!-- =================== EN COURS (1/3) =================== -->
        <section id="inprogress-section">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-base font-bold text-brand-text flex items-center gap-2">
              <span class="w-1 h-5 bg-orange-500 rounded-full"></span>
              En cours
            </h3>
            <button class="text-xs text-brand-primary hover:text-brand-primaryHover font-medium">
              Détails
            </button>
          </div>

          <div class="bg-white rounded-xl shadow-card border border-brand-border p-5">
            <ul id="inprogress-list" class="divide-y divide-brand-border">
              <!-- Items injectés par dashboard.js -->
            </ul>
          </div>
        </section>
      </div>

      <!-- =================== GRAPHIQUE OVERVIEW =================== -->
      <section class="bg-white rounded-xl shadow-card border border-brand-border p-6">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-3">
          <div>
            <h3 class="text-base font-bold text-brand-text">Aperçu de la journée</h3>
            <p class="text-xs text-brand-muted mt-0.5">Évolution des commandes par tranche horaire</p>
          </div>

          <div class="flex items-center gap-2">
            <button data-period="today" class="period-btn period-btn-active">Aujourd'hui</button>
            <button data-period="week" class="period-btn">7 jours</button>
            <button data-period="month" class="period-btn">30 jours</button>
          </div>
        </div>

        <!-- KPIs au-dessus du graphique -->
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6 pb-6 border-b border-brand-border">
          <div>
            <div class="text-xs text-brand-muted font-medium">Commandes</div>
            <div class="text-xl font-bold text-brand-text mt-1">147</div>
            <div class="text-[11px] text-green-600 font-semibold mt-0.5 flex items-center gap-1">
              <i data-lucide="trending-up" class="w-3 h-3"></i> +12.5%
            </div>
          </div>
          <div>
            <div class="text-xs text-brand-muted font-medium">Confirmées</div>
            <div class="text-xl font-bold text-brand-text mt-1">98</div>
            <div class="text-[11px] text-green-600 font-semibold mt-0.5 flex items-center gap-1">
              <i data-lucide="trending-up" class="w-3 h-3"></i> +8.2%
            </div>
          </div>
          <div>
            <div class="text-xs text-brand-muted font-medium">Livrées</div>
            <div class="text-xl font-bold text-brand-text mt-1">62</div>
            <div class="text-[11px] text-green-600 font-semibold mt-0.5 flex items-center gap-1">
              <i data-lucide="trending-up" class="w-3 h-3"></i> +5.1%
            </div>
          </div>
          <div>
            <div class="text-xs text-brand-muted font-medium">Revenus</div>
            <div class="text-xl font-bold text-brand-text mt-1">486K <span class="text-xs font-medium text-brand-muted">DZD</span></div>
            <div class="text-[11px] text-red-500 font-semibold mt-0.5 flex items-center gap-1">
              <i data-lucide="trending-down" class="w-3 h-3"></i> -2.3%
            </div>
          </div>
        </div>

        <div class="relative" style="height: 320px;">
          <canvas id="overviewChart"></canvas>
        </div>
      </section>

    </div>
  </main>

  <script src="/static/dashboard.js"></script>
  <script>lucide.createIcons();</script>
</body>
</html>`

export default app
