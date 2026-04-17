<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AutoHub DZ - Plateforme logistique e-commerce n°1 en Algérie</title>
<meta name="description" content="AutoHub DZ connecte votre boutique e-commerce (Shopify, YouCan, WooCommerce, EcoManager) aux meilleurs transporteurs algériens (Yalidine, ZR Express) pour automatiser vos livraisons en Algérie.">
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
  background: #ffffff;
  color: #1e293b;
  overflow-x: hidden;
}

/* ==================== TOP NAV ==================== */
.top-nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  background: rgba(255,255,255,0.85);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(226,232,240,0.8);
  padding: 16px 0;
}
.nav-container {
  max-width: 1280px;
  margin: 0 auto;
  padding: 0 24px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.nav-logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
  font-size: 20px;
  color: #0B1120;
}
.nav-logo-badge {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 12px rgba(99,102,241,0.3);
}
.nav-links {
  display: flex;
  gap: 32px;
  align-items: center;
}
.nav-link {
  color: #475569;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  transition: color 0.2s;
}
.nav-link:hover { color: #6366f1; }
.nav-btn {
  padding: 10px 22px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.3s;
  display: inline-block;
}
.nav-btn-ghost {
  color: #0B1120;
  border: 1px solid #e2e8f0;
  background: #fff;
}
.nav-btn-ghost:hover { border-color: #6366f1; color: #6366f1; }
.nav-btn-primary {
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: #fff;
  box-shadow: 0 4px 14px rgba(99,102,241,0.35);
}
.nav-btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 8px 24px rgba(99,102,241,0.45);
}

/* ==================== HERO ==================== */
.hero {
  min-height: 100vh;
  padding: 100px 24px 60px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 60px;
  align-items: center;
  max-width: 1280px;
  margin: 0 auto;
  position: relative;
}
.hero::before {
  content: '';
  position: absolute;
  top: 10%;
  left: -10%;
  width: 400px;
  height: 400px;
  background: radial-gradient(circle, rgba(99,102,241,0.12) 0%, transparent 70%);
  border-radius: 50%;
  pointer-events: none;
  z-index: -1;
}
.hero::after {
  content: '';
  position: absolute;
  bottom: 10%;
  right: -5%;
  width: 300px;
  height: 300px;
  background: radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%);
  border-radius: 50%;
  pointer-events: none;
  z-index: -1;
}
.hero-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  background: rgba(99,102,241,0.1);
  border: 1px solid rgba(99,102,241,0.2);
  border-radius: 100px;
  color: #4f46e5;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 24px;
}
.hero-badge-dot {
  width: 8px;
  height: 8px;
  background: #10b981;
  border-radius: 50%;
  animation: pulse 2s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}
.hero-title {
  font-size: 56px;
  font-weight: 900;
  line-height: 1.1;
  color: #0B1120;
  margin-bottom: 24px;
  letter-spacing: -1.5px;
}
.hero-title .highlight {
  background: linear-gradient(135deg, #6366f1 0%, #4f46e5 50%, #3730a3 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.hero-subtitle {
  font-size: 18px;
  line-height: 1.6;
  color: #64748b;
  margin-bottom: 32px;
  max-width: 540px;
}
.hero-actions {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 40px;
}
.btn-hero {
  padding: 14px 28px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  transition: all 0.3s;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  border: none;
  cursor: pointer;
}
.btn-hero-primary {
  background: linear-gradient(135deg, #6366f1, #4f46e5);
  color: #fff;
  box-shadow: 0 8px 24px rgba(99,102,241,0.35);
}
.btn-hero-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(99,102,241,0.45);
}
.btn-hero-ghost {
  background: #fff;
  color: #0B1120;
  border: 1px solid #e2e8f0;
}
.btn-hero-ghost:hover {
  border-color: #6366f1;
  color: #6366f1;
}
.hero-stats {
  display: flex;
  gap: 40px;
  padding-top: 24px;
  border-top: 1px solid #e2e8f0;
}
.hero-stat {
  display: flex;
  flex-direction: column;
}
.hero-stat-value {
  font-size: 28px;
  font-weight: 800;
  color: #0B1120;
}
.hero-stat-label {
  font-size: 13px;
  color: #64748b;
  font-weight: 500;
}

/* ==================== DIAGRAM (Central logo + surrounding logos) ==================== */
.diagram {
  position: relative;
  width: 100%;
  max-width: 560px;
  height: 560px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Dotted background */
.diagram::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(99,102,241,0.15) 1.5px, transparent 1.5px);
  background-size: 24px 24px;
  border-radius: 50%;
  mask: radial-gradient(circle, black 0%, black 50%, transparent 75%);
  -webkit-mask: radial-gradient(circle, black 0%, black 50%, transparent 75%);
  pointer-events: none;
}

/* Central logo AutoHub DZ */
.diagram-center {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 180px;
  height: 180px;
  background: linear-gradient(135deg, #0B1120 0%, #1e1b4b 40%, #3730a3 100%);
  border-radius: 50%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  box-shadow:
    0 0 0 8px rgba(99,102,241,0.08),
    0 0 0 18px rgba(99,102,241,0.04),
    0 20px 60px rgba(99,102,241,0.4);
  z-index: 10;
  animation: centerPulse 3s ease-in-out infinite;
}
@keyframes centerPulse {
  0%, 100% { box-shadow: 0 0 0 8px rgba(99,102,241,0.08), 0 0 0 18px rgba(99,102,241,0.04), 0 20px 60px rgba(99,102,241,0.4); }
  50% { box-shadow: 0 0 0 14px rgba(99,102,241,0.12), 0 0 0 28px rgba(99,102,241,0.06), 0 20px 60px rgba(99,102,241,0.5); }
}
.diagram-center-icon {
  width: 56px;
  height: 56px;
  margin-bottom: 8px;
}
.diagram-center-text {
  color: #fff;
  font-size: 17px;
  font-weight: 800;
  text-align: center;
  line-height: 1.1;
}
.diagram-center-text .dz {
  color: #a5b4fc;
}
.diagram-center-subtext {
  color: rgba(165,180,252,0.85);
  font-size: 10px;
  font-weight: 500;
  margin-top: 2px;
  letter-spacing: 0.5px;
}

/* Surrounding logo cards */
.logo-card {
  position: absolute;
  width: 92px;
  height: 92px;
  background: #fff;
  border-radius: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 8px 24px rgba(15,23,42,0.08), 0 2px 6px rgba(15,23,42,0.04);
  border: 1px solid rgba(226,232,240,0.9);
  transition: transform 0.4s ease, box-shadow 0.4s ease;
  z-index: 5;
  padding: 12px;
}
.logo-card:hover {
  transform: scale(1.1);
  box-shadow: 0 12px 36px rgba(99,102,241,0.25), 0 4px 12px rgba(15,23,42,0.08);
  z-index: 11;
}
.logo-card img,
.logo-card svg {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

/* Positions around the center - 6 logos */
/* Left side: Shopify, YouCan, WooCommerce */
.logo-pos-1 { top: 8%;  left: 6%; }            /* top-left */
.logo-pos-2 { top: 44%; left: -2%; }           /* middle-left */
.logo-pos-3 { bottom: 8%; left: 6%; }          /* bottom-left */
/* Right side: Yalidine, ZR Express, EcoManager */
.logo-pos-4 { top: 8%;  right: 6%; }           /* top-right */
.logo-pos-5 { top: 44%; right: -2%; }          /* middle-right */
.logo-pos-6 { bottom: 8%; right: 6%; }         /* bottom-right */

/* Animated connection lines (SVG overlay) */
.diagram-lines {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}
.diagram-line {
  stroke: #c7d2fe;
  stroke-width: 1.5;
  stroke-dasharray: 4 4;
  fill: none;
  opacity: 0.7;
}
.diagram-line-animated {
  stroke-dasharray: 4 4;
  animation: dash 20s linear infinite;
}
@keyframes dash {
  to { stroke-dashoffset: -200; }
}

/* Labels floating near logos */
.logo-label {
  position: absolute;
  font-size: 11px;
  font-weight: 600;
  color: #475569;
  background: #fff;
  padding: 3px 8px;
  border-radius: 6px;
  box-shadow: 0 2px 6px rgba(15,23,42,0.08);
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s;
}
.logo-card:hover + .logo-label { opacity: 1; }

/* Floating animation for logo cards */
.logo-card { animation: floatLogo 6s ease-in-out infinite; }
.logo-pos-1 { animation-delay: 0s; }
.logo-pos-2 { animation-delay: 1s; }
.logo-pos-3 { animation-delay: 2s; }
.logo-pos-4 { animation-delay: 0.5s; }
.logo-pos-5 { animation-delay: 1.5s; }
.logo-pos-6 { animation-delay: 2.5s; }
@keyframes floatLogo {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-8px); }
}
.logo-card:hover { animation-play-state: paused; }

/* ==================== SECTIONS ==================== */
.section {
  padding: 80px 24px;
  max-width: 1280px;
  margin: 0 auto;
}
.section-head {
  text-align: center;
  margin-bottom: 56px;
}
.section-eyebrow {
  display: inline-block;
  color: #4f46e5;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 2px;
  text-transform: uppercase;
  margin-bottom: 12px;
}
.section-title {
  font-size: 40px;
  font-weight: 800;
  color: #0B1120;
  line-height: 1.2;
  margin-bottom: 16px;
  letter-spacing: -1px;
}
.section-subtitle {
  font-size: 17px;
  color: #64748b;
  max-width: 640px;
  margin: 0 auto;
  line-height: 1.6;
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 24px;
}
.feature-card {
  background: #fff;
  border: 1px solid #e2e8f0;
  border-radius: 20px;
  padding: 32px;
  transition: all 0.3s;
}
.feature-card:hover {
  transform: translateY(-4px);
  border-color: #c7d2fe;
  box-shadow: 0 20px 40px rgba(99,102,241,0.1);
}
.feature-icon {
  width: 56px;
  height: 56px;
  background: linear-gradient(135deg, #eef2ff, #e0e7ff);
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #4f46e5;
  font-size: 24px;
  margin-bottom: 20px;
}
.feature-title {
  font-size: 18px;
  font-weight: 700;
  color: #0B1120;
  margin-bottom: 8px;
}
.feature-desc {
  font-size: 14px;
  color: #64748b;
  line-height: 1.6;
}

/* ==================== CTA section ==================== */
.cta-section {
  background: linear-gradient(135deg, #0B1120 0%, #1e1b4b 40%, #3730a3 100%);
  border-radius: 24px;
  padding: 64px 40px;
  text-align: center;
  position: relative;
  overflow: hidden;
}
.cta-section::before {
  content: '';
  position: absolute;
  inset: 0;
  background-image: radial-gradient(rgba(255,255,255,0.08) 1px, transparent 1px);
  background-size: 28px 28px;
  pointer-events: none;
}
.cta-title {
  color: #fff;
  font-size: 36px;
  font-weight: 800;
  margin-bottom: 16px;
  position: relative;
  z-index: 1;
}
.cta-subtitle {
  color: rgba(255,255,255,0.75);
  font-size: 17px;
  margin-bottom: 32px;
  max-width: 600px;
  margin-left: auto;
  margin-right: auto;
  position: relative;
  z-index: 1;
}
.cta-btn {
  padding: 16px 36px;
  background: #fff;
  color: #4f46e5;
  border-radius: 12px;
  font-weight: 700;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  transition: all 0.3s;
  position: relative;
  z-index: 1;
  box-shadow: 0 8px 24px rgba(0,0,0,0.2);
}
.cta-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(0,0,0,0.3);
}

/* ==================== FOOTER ==================== */
footer {
  padding: 40px 24px;
  border-top: 1px solid #e2e8f0;
  text-align: center;
  color: #64748b;
  font-size: 14px;
}
footer a { color: #4f46e5; text-decoration: none; font-weight: 500; }
footer a:hover { text-decoration: underline; }

/* ==================== RESPONSIVE ==================== */
@media (max-width: 1024px) {
  .hero { grid-template-columns: 1fr; padding: 100px 24px 40px; text-align: center; }
  .hero-subtitle { margin-left: auto; margin-right: auto; }
  .hero-actions { justify-content: center; }
  .hero-stats { justify-content: center; }
  .diagram { max-width: 480px; height: 480px; margin-top: 40px; }
}
@media (max-width: 768px) {
  .nav-links { display: none; }
  .hero-title { font-size: 38px; }
  .hero-subtitle { font-size: 16px; }
  .section-title { font-size: 30px; }
  .features-grid { grid-template-columns: 1fr; }
  .diagram { max-width: 360px; height: 360px; }
  .diagram-center { width: 130px; height: 130px; }
  .diagram-center-icon { width: 40px; height: 40px; }
  .diagram-center-text { font-size: 13px; }
  .logo-card { width: 68px; height: 68px; padding: 8px; border-radius: 14px; }
  .cta-title { font-size: 26px; }
  .hero-stats { flex-wrap: wrap; gap: 20px; }
  .hero-stat-value { font-size: 22px; }
}

/* Fade-in animation on scroll */
.fade-in {
  opacity: 0;
  transform: translateY(24px);
  transition: opacity 0.8s ease, transform 0.8s ease;
}
.fade-in.visible {
  opacity: 1;
  transform: translateY(0);
}
</style>
</head>
<body>

<!-- ==================== TOP NAV ==================== -->
<nav class="top-nav">
  <div class="nav-container">
    <div class="nav-logo">
      <div class="nav-logo-badge">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="white"/></svg>
      </div>
      <span>AutoHub <span style="color:#6366f1">DZ</span></span>
    </div>
    <div class="nav-links">
      <a href="#features" class="nav-link">Fonctionnalités</a>
      <a href="#integrations" class="nav-link">Intégrations</a>
      <a href="#stats" class="nav-link">Pourquoi nous</a>
    </div>
    <div style="display:flex; gap:12px; align-items:center;">
      <a href="/login" class="nav-btn nav-btn-ghost">Connexion</a>
      <a href="/register" class="nav-btn nav-btn-primary">
        <i class="fas fa-rocket"></i> Commencer
      </a>
    </div>
  </div>
</nav>

<!-- ==================== HERO ==================== -->
<section class="hero">
  <!-- LEFT: Text -->
  <div>
    <div class="hero-badge">
      <span class="hero-badge-dot"></span>
      Plateforme logistique n°1 en Algérie
    </div>
    <h1 class="hero-title">
      Connectez votre boutique aux <span class="highlight">meilleurs transporteurs</span> algériens
    </h1>
    <p class="hero-subtitle">
      AutoHub DZ synchronise vos commandes Shopify, YouCan, WooCommerce et EcoManager avec Yalidine et ZR Express. Automatisez vos livraisons dans les 58 wilayas, en quelques clics.
    </p>
    <div class="hero-actions">
      <a href="/register" class="btn-hero btn-hero-primary">
        <i class="fas fa-rocket"></i> Créer mon compte gratuit
      </a>
      <a href="/login" class="btn-hero btn-hero-ghost">
        <i class="fas fa-arrow-right-to-bracket"></i> Se connecter
      </a>
    </div>
    <div class="hero-stats">
      <div class="hero-stat">
        <span class="hero-stat-value">58</span>
        <span class="hero-stat-label">Wilayas couvertes</span>
      </div>
      <div class="hero-stat">
        <span class="hero-stat-value">6+</span>
        <span class="hero-stat-label">Intégrations</span>
      </div>
      <div class="hero-stat">
        <span class="hero-stat-value">100%</span>
        <span class="hero-stat-label">Sécurisé</span>
      </div>
    </div>
  </div>

  <!-- RIGHT: Diagram with central logo + 6 surrounding e-commerce/transport logos -->
  <div class="diagram">
    <!-- Animated connecting lines -->
    <svg class="diagram-lines" viewBox="0 0 560 560" preserveAspectRatio="none">
      <!-- Left logos → center -->
      <line class="diagram-line diagram-line-animated" x1="85"  y1="85"  x2="280" y2="280"/>
      <line class="diagram-line diagram-line-animated" x1="45"  y1="280" x2="280" y2="280"/>
      <line class="diagram-line diagram-line-animated" x1="85"  y1="475" x2="280" y2="280"/>
      <!-- Right logos → center -->
      <line class="diagram-line diagram-line-animated" x1="475" y1="85"  x2="280" y2="280"/>
      <line class="diagram-line diagram-line-animated" x1="515" y1="280" x2="280" y2="280"/>
      <line class="diagram-line diagram-line-animated" x1="475" y1="475" x2="280" y2="280"/>
    </svg>

    <!-- LEFT SIDE: E-COMMERCE PLATFORMS -->
    <!-- Shopify -->
    <div class="logo-card logo-pos-1" title="Shopify">
      <svg viewBox="0 0 109 124" xmlns="http://www.w3.org/2000/svg">
        <path d="M74.7 23.2s-1.4.4-3.6 1.1c-.4-1.2-1-2.7-1.8-4.1-2.7-5.1-6.5-7.8-11.2-7.8-.3 0-.7 0-1 .1-.1-.2-.3-.3-.4-.5-2.1-2.2-4.7-3.3-7.9-3.2-6.2.2-12.4 4.7-17.4 12.6-3.5 5.6-6.2 12.6-7 18-7.2 2.2-12.2 3.8-12.3 3.8-3.6 1.1-3.7 1.2-4.2 4.6-.3 2.5-9.8 75.9-9.8 75.9l79.4 13.7 34.4-8.5S74.8 23 74.7 23.2zM56.9 17.7c-1.6.5-3.4 1.1-5.3 1.7 0-2.7-.4-6.5-1.6-9.8 4.1.8 6.1 5.4 6.9 8.1zm-8.9 2.8c-3.6 1.1-7.5 2.3-11.4 3.5 1.1-4.2 3.2-8.3 5.7-11 1-1 2.3-2.2 3.8-2.8 1.4 3 1.8 7.2 1.9 10.3zm-7.4-14.2c1.2 0 2.3.3 3.2.8-1.4.7-2.8 1.8-4.1 3.2-3.4 3.7-6 9.4-7.1 14.9-3.3 1-6.5 2-9.5 2.9 1.9-8.9 9.3-21.5 17.5-21.8z" fill="#95BF47"/>
        <path d="M71.1 24.3l-34.4 8.5 9.8 75.9 34.4-8.5-9.8-75.9z" fill="#5E8E3E"/>
        <path d="M58.3 52.2l-4.3 16c-2.6-1.2-4.7-2-7.4-2-4 0-4.2 2.5-4.2 3.1 0 3.4 8.9 4.7 8.9 12.7 0 6.3-4 10.4-9.4 10.4-6.5 0-9.8-4-9.8-4l1.7-5.8s3.4 2.9 6.3 2.9c1.9 0 2.7-1.5 2.7-2.6 0-4.4-7.3-4.6-7.3-11.9 0-6.2 4.4-12.2 13.4-12.2 3.5 0 5.2 1 5.2 1l4.2-7.6z" fill="#FFF"/>
      </svg>
    </div>

    <!-- YouCan -->
    <div class="logo-card logo-pos-2" title="YouCan" style="background:linear-gradient(135deg, #4F46E5, #6366F1);">
      <div style="color:#fff; font-weight:900; font-size:15px; text-align:center; line-height:1;">
        <div style="font-size:22px; font-weight:900;">Y</div>
        <div style="font-size:9px; letter-spacing:1px; margin-top:2px;">YOUCAN</div>
      </div>
    </div>

    <!-- WooCommerce -->
    <div class="logo-card logo-pos-3" title="WooCommerce">
      <svg viewBox="0 0 256 153" xmlns="http://www.w3.org/2000/svg">
        <path d="M23.76 0h208.38c13.15 0 23.81 10.66 23.81 23.81v79.37c0 13.15-10.66 23.81-23.81 23.81h-74.72l10.27 25.15-45.17-25.15H23.87c-13.15 0-23.81-10.66-23.81-23.81V23.81C-.05 10.72 10.61.06 23.76 0z" fill="#7F54B3"/>
        <path d="M14.54 21.68c1.46-1.97 3.63-3.01 6.52-3.24 5.27-.41 8.25 2.07 8.96 7.44 3.11 20.93 6.51 38.65 10.15 53.18L62.34 38.31c2.01-3.81 4.53-5.81 7.54-5.99 4.43-.28 7.17 2.53 8.25 8.43 2.42 12.89 5.48 23.83 9.14 33c2.5-24.43 6.77-42.03 12.77-52.88.96-1.78 2.35-2.94 4.26-3.34 3.97-.67 7.11 1.45 7.98 5.42.41 1.49.19 3-.62 4.62-3.64 6.77-6.65 18.11-9.05 33.99-2.32 15.4-3.17 27.4-2.58 36 .18 2.35-.19 4.44-1.1 6.22-1.09 2.07-2.72 3.17-4.86 3.34-2.41.19-4.9-.92-7.3-3.34-8.58-8.77-15.4-21.87-20.42-39.29-6.03 11.91-10.52 20.84-13.45 26.8-5.54 10.61-10.25 16.04-14.19 16.31-2.54.19-4.72-1.97-6.59-6.48-4.79-12.31-9.98-36.12-15.55-71.41-.37-2.48.17-4.63 1.59-6.41z" fill="#FFF"/>
      </svg>
    </div>

    <!-- RIGHT SIDE: TRANSPORT / ERP -->
    <!-- Yalidine -->
    <div class="logo-card logo-pos-4" title="Yalidine" style="background:#dc2626;">
      <div style="color:#fff; font-weight:900; font-size:12px; text-align:center; line-height:1.1;">
        <i class="fas fa-bolt" style="font-size:16px; margin-bottom:2px;"></i>
        <div style="font-weight:900; font-size:11px;">YALIDINE</div>
        <div style="font-size:8px; font-weight:600; opacity:0.9;">EXPRESS</div>
      </div>
    </div>

    <!-- ZR Express -->
    <div class="logo-card logo-pos-5" title="ZR Express" style="background:#1a1a1a;">
      <div style="text-align:center; line-height:1;">
        <div style="color:#fbbf24; font-weight:900; font-size:18px; font-style:italic;">ZR</div>
        <div style="color:#fff; font-weight:800; font-size:9px; letter-spacing:0.5px; margin-top:2px;">EXPRESS</div>
        <div style="color:#fbbf24; font-size:7px; margin-top:1px;">LOGISTIQUE</div>
      </div>
    </div>

    <!-- EcoManager -->
    <div class="logo-card logo-pos-6" title="EcoManager" style="background:linear-gradient(135deg, #059669, #10b981);">
      <div style="color:#fff; text-align:center; line-height:1;">
        <i class="fas fa-leaf" style="font-size:18px; margin-bottom:3px;"></i>
        <div style="font-weight:800; font-size:9px; letter-spacing:0.5px;">ECO</div>
        <div style="font-weight:800; font-size:9px; letter-spacing:0.5px;">MANAGER</div>
      </div>
    </div>

    <!-- Central logo AutoHub DZ -->
    <div class="diagram-center">
      <svg class="diagram-center-icon" viewBox="0 0 24 24" fill="none">
        <path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="2" stroke-linejoin="round"/>
        <circle cx="12" cy="12" r="3" fill="white"/>
        <line x1="12" y1="2" x2="12" y2="9" stroke="white" stroke-width="1.5"/>
        <line x1="12" y1="15" x2="12" y2="22" stroke="white" stroke-width="1.5"/>
        <line x1="3" y1="7" x2="9" y2="10" stroke="white" stroke-width="1.5"/>
        <line x1="15" y1="14" x2="21" y2="17" stroke="white" stroke-width="1.5"/>
        <line x1="21" y1="7" x2="15" y2="10" stroke="white" stroke-width="1.5"/>
        <line x1="9" y1="14" x2="3" y2="17" stroke="white" stroke-width="1.5"/>
      </svg>
      <div class="diagram-center-text">AutoHub <span class="dz">DZ</span></div>
      <div class="diagram-center-subtext">HUB CENTRAL</div>
    </div>
  </div>
</section>

<!-- ==================== INTEGRATIONS ==================== -->
<section class="section" id="integrations">
  <div class="section-head">
    <span class="section-eyebrow">Intégrations</span>
    <h2 class="section-title">Toutes vos plateformes <br/>connectées en un clic</h2>
    <p class="section-subtitle">
      AutoHub DZ se connecte nativement aux plus grandes plateformes e-commerce et aux principaux transporteurs algériens.
    </p>
  </div>

  <div style="display:grid; grid-template-columns: repeat(6, 1fr); gap: 20px; margin-top: 40px;" id="int-grid">
    <!-- Shopify -->
    <div class="feature-card" style="padding:24px; text-align:center;">
      <div style="height:50px; display:flex; align-items:center; justify-content:center; margin-bottom:12px;">
        <svg viewBox="0 0 109 124" style="height:44px;"><path d="M74.7 23.2s-1.4.4-3.6 1.1c-.4-1.2-1-2.7-1.8-4.1-2.7-5.1-6.5-7.8-11.2-7.8-.3 0-.7 0-1 .1-.1-.2-.3-.3-.4-.5-2.1-2.2-4.7-3.3-7.9-3.2-6.2.2-12.4 4.7-17.4 12.6-3.5 5.6-6.2 12.6-7 18-7.2 2.2-12.2 3.8-12.3 3.8-3.6 1.1-3.7 1.2-4.2 4.6-.3 2.5-9.8 75.9-9.8 75.9l79.4 13.7 34.4-8.5S74.8 23 74.7 23.2z" fill="#95BF47"/><path d="M71.1 24.3l-34.4 8.5 9.8 75.9 34.4-8.5-9.8-75.9z" fill="#5E8E3E"/><path d="M58.3 52.2l-4.3 16c-2.6-1.2-4.7-2-7.4-2-4 0-4.2 2.5-4.2 3.1 0 3.4 8.9 4.7 8.9 12.7 0 6.3-4 10.4-9.4 10.4-6.5 0-9.8-4-9.8-4l1.7-5.8s3.4 2.9 6.3 2.9c1.9 0 2.7-1.5 2.7-2.6 0-4.4-7.3-4.6-7.3-11.9 0-6.2 4.4-12.2 13.4-12.2 3.5 0 5.2 1 5.2 1l4.2-7.6z" fill="#FFF"/></svg>
      </div>
      <div style="font-weight:700; color:#0B1120; font-size:14px;">Shopify</div>
      <div style="font-size:11px; color:#64748b; margin-top:4px;">E-commerce</div>
    </div>

    <!-- YouCan -->
    <div class="feature-card" style="padding:24px; text-align:center;">
      <div style="height:50px; display:flex; align-items:center; justify-content:center; margin-bottom:12px;">
        <div style="width:44px; height:44px; background:linear-gradient(135deg, #4F46E5, #6366F1); border-radius:10px; display:flex; align-items:center; justify-content:center; color:#fff; font-weight:900; font-size:22px;">Y</div>
      </div>
      <div style="font-weight:700; color:#0B1120; font-size:14px;">YouCan</div>
      <div style="font-size:11px; color:#64748b; margin-top:4px;">E-commerce</div>
    </div>

    <!-- WooCommerce -->
    <div class="feature-card" style="padding:24px; text-align:center;">
      <div style="height:50px; display:flex; align-items:center; justify-content:center; margin-bottom:12px;">
        <svg viewBox="0 0 256 153" style="height:40px;"><path d="M23.76 0h208.38c13.15 0 23.81 10.66 23.81 23.81v79.37c0 13.15-10.66 23.81-23.81 23.81h-74.72l10.27 25.15-45.17-25.15H23.87c-13.15 0-23.81-10.66-23.81-23.81V23.81C-.05 10.72 10.61.06 23.76 0z" fill="#7F54B3"/><path d="M14.54 21.68c1.46-1.97 3.63-3.01 6.52-3.24 5.27-.41 8.25 2.07 8.96 7.44 3.11 20.93 6.51 38.65 10.15 53.18L62.34 38.31c2.01-3.81 4.53-5.81 7.54-5.99 4.43-.28 7.17 2.53 8.25 8.43 2.42 12.89 5.48 23.83 9.14 33c2.5-24.43 6.77-42.03 12.77-52.88.96-1.78 2.35-2.94 4.26-3.34 3.97-.67 7.11 1.45 7.98 5.42.41 1.49.19 3-.62 4.62-3.64 6.77-6.65 18.11-9.05 33.99-2.32 15.4-3.17 27.4-2.58 36 .18 2.35-.19 4.44-1.1 6.22-1.09 2.07-2.72 3.17-4.86 3.34-2.41.19-4.9-.92-7.3-3.34-8.58-8.77-15.4-21.87-20.42-39.29-6.03 11.91-10.52 20.84-13.45 26.8-5.54 10.61-10.25 16.04-14.19 16.31-2.54.19-4.72-1.97-6.59-6.48-4.79-12.31-9.98-36.12-15.55-71.41-.37-2.48.17-4.63 1.59-6.41z" fill="#FFF"/></svg>
      </div>
      <div style="font-weight:700; color:#0B1120; font-size:14px;">WooCommerce</div>
      <div style="font-size:11px; color:#64748b; margin-top:4px;">E-commerce</div>
    </div>

    <!-- Yalidine -->
    <div class="feature-card" style="padding:24px; text-align:center;">
      <div style="height:50px; display:flex; align-items:center; justify-content:center; margin-bottom:12px;">
        <div style="width:44px; height:44px; background:#dc2626; border-radius:10px; display:flex; align-items:center; justify-content:center; color:#fff;">
          <i class="fas fa-bolt" style="font-size:22px;"></i>
        </div>
      </div>
      <div style="font-weight:700; color:#0B1120; font-size:14px;">Yalidine</div>
      <div style="font-size:11px; color:#64748b; margin-top:4px;">Transporteur</div>
    </div>

    <!-- ZR Express -->
    <div class="feature-card" style="padding:24px; text-align:center;">
      <div style="height:50px; display:flex; align-items:center; justify-content:center; margin-bottom:12px;">
        <div style="width:44px; height:44px; background:#1a1a1a; border-radius:10px; display:flex; align-items:center; justify-content:center; line-height:1;">
          <span style="color:#fbbf24; font-weight:900; font-size:18px; font-style:italic;">ZR</span>
        </div>
      </div>
      <div style="font-weight:700; color:#0B1120; font-size:14px;">ZR Express</div>
      <div style="font-size:11px; color:#64748b; margin-top:4px;">Transporteur</div>
    </div>

    <!-- EcoManager -->
    <div class="feature-card" style="padding:24px; text-align:center;">
      <div style="height:50px; display:flex; align-items:center; justify-content:center; margin-bottom:12px;">
        <div style="width:44px; height:44px; background:linear-gradient(135deg, #059669, #10b981); border-radius:10px; display:flex; align-items:center; justify-content:center; color:#fff;">
          <i class="fas fa-leaf" style="font-size:20px;"></i>
        </div>
      </div>
      <div style="font-weight:700; color:#0B1120; font-size:14px;">EcoManager</div>
      <div style="font-size:11px; color:#64748b; margin-top:4px;">ERP</div>
    </div>
  </div>
</section>

<!-- ==================== FEATURES ==================== -->
<section class="section" id="features">
  <div class="section-head">
    <span class="section-eyebrow">Fonctionnalités</span>
    <h2 class="section-title">Tout ce qu'il vous faut <br/>pour livrer en Algérie</h2>
    <p class="section-subtitle">
      Une plateforme complète pour automatiser vos livraisons, suivre vos colis et centraliser vos commandes.
    </p>
  </div>

  <div class="features-grid">
    <div class="feature-card">
      <div class="feature-icon"><i class="fas fa-truck-fast"></i></div>
      <div class="feature-title">Multi-Transporteurs</div>
      <div class="feature-desc">Yalidine, ZR Express, Ecotrack pdex, DHD et NOEST — tous vos transporteurs en un seul dashboard.</div>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><i class="fas fa-store"></i></div>
      <div class="feature-title">Synchronisation e-commerce</div>
      <div class="feature-desc">Importez automatiquement vos commandes depuis Shopify, YouCan, WooCommerce et EcoManager.</div>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><i class="fas fa-map-marked-alt"></i></div>
      <div class="feature-title">58 Wilayas</div>
      <div class="feature-desc">Couverture nationale complète avec calcul automatique des frais de livraison par wilaya.</div>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><i class="fas fa-chart-line"></i></div>
      <div class="feature-title">Statistiques en temps réel</div>
      <div class="feature-desc">Suivez vos ventes, taux de livraison, retours et encaissements dans un dashboard clair.</div>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><i class="fas fa-boxes-stacked"></i></div>
      <div class="feature-title">Gestion de stock</div>
      <div class="feature-desc">Stock en temps réel, seuils d'alerte et réapprovisionnement automatique intégrés.</div>
    </div>
    <div class="feature-card">
      <div class="feature-icon"><i class="fas fa-shield-halved"></i></div>
      <div class="feature-title">100% Sécurisé</div>
      <div class="feature-desc">Données chiffrées, authentification forte, clés API stockées de manière sécurisée.</div>
    </div>
  </div>
</section>

<!-- ==================== CTA ==================== -->
<section class="section" id="stats">
  <div class="cta-section">
    <h2 class="cta-title">Prêt à automatiser votre logistique ?</h2>
    <p class="cta-subtitle">
      Rejoignez les e-commerçants algériens qui font confiance à AutoHub DZ pour gérer leurs livraisons au quotidien.
    </p>
    <a href="/register" class="cta-btn">
      <i class="fas fa-rocket"></i> Créer mon compte gratuit
    </a>
  </div>
</section>

<!-- ==================== FOOTER ==================== -->
<footer>
  <div style="max-width:1280px; margin:0 auto;">
    <div style="display:flex; align-items:center; justify-content:center; gap:10px; margin-bottom:12px;">
      <div class="nav-logo-badge" style="width:28px; height:28px; border-radius:8px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 2L3 7V17L12 22L21 17V7L12 2Z" stroke="white" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="3" fill="white"/></svg>
      </div>
      <span style="font-weight:800; color:#0B1120;">AutoHub <span style="color:#6366f1">DZ</span></span>
    </div>
    <p>© 2026 AutoHub DZ — La plateforme logistique e-commerce n°1 en Algérie.</p>
    <p style="margin-top:8px;">
      <a href="/login">Connexion</a> · <a href="/register">Inscription</a>
    </p>
  </div>
</footer>

<script>
// Fade-in on scroll
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) entry.target.classList.add('visible');
  });
}, { threshold: 0.1 });

document.querySelectorAll('.feature-card, .section-head').forEach(el => {
  el.classList.add('fade-in');
  observer.observe(el);
});

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) {
      e.preventDefault();
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});

// Redirect to /app if already logged in
fetch('/api/auth/check').then(r => r.json()).then(d => {
  if (d.authenticated) {
    // User is logged in - could show a "Go to dashboard" banner or auto-redirect
    // For now just update the CTA buttons
    document.querySelectorAll('a[href="/register"], a[href="/login"]').forEach(a => {
      a.setAttribute('href', '/app');
      if (a.textContent.includes('Commencer') || a.textContent.includes('gratuit') || a.textContent.includes('connecter')) {
        a.innerHTML = '<i class="fas fa-gauge-high"></i> Accéder au dashboard';
      }
    });
  }
}).catch(() => {});
</script>

</body>
</html>
