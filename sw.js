// ============================================================================
//  Service Worker — Band Admin (PWA)
//  Cachet de app-bestanden ("app shell") zodat de app ook zonder internet laadt.
//  Firestore/Auth-verkeer wordt met rust gelaten: de Firebase SDK regelt zijn
//  eigen offline-persistentie via IndexedDB.
// ============================================================================

const VERSION = "v48";
const APP_SHELL_CACHE = `band-admin-shell-${VERSION}`;
const RUNTIME_CACHE = `band-admin-runtime-${VERSION}`;

// Lokale bestanden die de app nodig heeft om te starten.
const APP_SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/theme-bandadmin.css",
  "/logo-small.png",
  "/js/app.js",
  "/js/auth.js",
  "/js/chord-diagram.js",
  "/js/piano-chord.js",
  "/js/firestore.js",
  "/js/firebase-config.js",
  "/js/song-format.js",
  "/js/pdf-import.js",
  "/js/seed-data.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

// CDN-hosts die we bij runtime mogen cachen (Firebase SDK, Tailwind, fonts).
const CDN_HOSTS = [
  "www.gstatic.com",
  "cdn.tailwindcss.com",
  "cdn.jsdelivr.net",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
];

// Hosts die NOOIT gecachet worden (live Firebase-data/-auth).
const BYPASS_HOSTS = [
  "firestore.googleapis.com",
  "firebaseinstallations.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== APP_SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // schrijfacties nooit onderscheppen

  const url = new URL(req.url);
  if (BYPASS_HOSTS.some((h) => url.hostname.includes(h))) return; // live data → netwerk

  const cacheable =
    url.origin === self.location.origin || CDN_HOSTS.some((h) => url.hostname.includes(h));

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (cacheable && res && res.status === 200) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => {
          // Offline en niets in cache: voor navigaties val terug op de app-shell.
          if (req.mode === "navigate") return caches.match("/index.html");
          return cached;
        });
      // Cache-first: toon direct de cache indien aanwezig, anders het netwerk.
      return cached || network;
    })
  );
});
