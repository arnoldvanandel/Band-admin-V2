// ============================================================================
//  Firebase configuratie — VOORBEELD
// ----------------------------------------------------------------------------
//  Kopieer dit bestand naar:  js/firebase-config.js
//  En vul de waarden in uit:
//  Firebase Console -> Projectinstellingen -> Je apps -> SDK setup & config
//
//  js/firebase-config.js is lokaal en staat in .gitignore, zodat je
//  projectgegevens niet in een openbare repository terechtkomen.
//
//  Onderstaand patroon ondersteunt twee Hosting-sites binnen één project:
//  per hostname wordt de juiste appId gekozen (test vs live). De rest van
//  de config is voor beide sites identiek.
// ============================================================================

const COMMON_CONFIG = {
  apiKey: "JOUW_API_KEY",
  authDomain: "JOUW_PROJECT.firebaseapp.com",
  projectId: "JOUW_PROJECT_ID",
  storageBucket: "JOUW_PROJECT.firebasestorage.app",
  messagingSenderId: "JOUW_SENDER_ID",
};

const SITE_CONFIGS = {
  "JOUW_LIVE_DOMEIN": {
    appId: "JOUW_APP_ID_LIVE",
  },
  "JOUW_TEST_DOMEIN": {
    appId: "JOUW_APP_ID_TEST",
  },
};

const hostname = window.location.hostname;
const firebaseConfig = {
  ...COMMON_CONFIG,
  ...(SITE_CONFIGS[hostname] || SITE_CONFIGS["JOUW_TEST_DOMEIN"]),
};

// De rest van dit bestand (initialisatie + exports) staat in het échte
// js/firebase-config.js en hoef je niet te wijzigen.
