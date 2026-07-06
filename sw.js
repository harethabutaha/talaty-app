/* ══════════════════════════════════════════════════════════════
   Talaty — Service Worker  v2.0
   Strategy:
     • App shell (HTML/CSS/JS)  → Cache-First (instant load)
     • Google Sheet CSV         → Network-First, cache on success,
                                  serve stale on network failure
     • Google Fonts / Analytics → Network-only pass-through
   Bump CACHE_VERSION to force a full refresh on all clients.
══════════════════════════════════════════════════════════════ */

'use strict';

var CACHE_VERSION = 'talaty-v3';

var SHELL_URLS = [
  './',
  './index.html',
  './style.css',
  './script.js',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js'
];

var PASSTHROUGH_HOSTS = [
  'www.googletagmanager.com',
  'www.google-analytics.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

/* ── INSTALL — pre-cache the app shell ────────────────────── */
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function(cache) { return cache.addAll(SHELL_URLS); })
      .then(function() { return self.skipWaiting(); })
  );
});

/* ── ACTIVATE — purge stale caches ───────────────────────── */
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_VERSION; })
            .map(function(k)   { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

/* ── FETCH ────────────────────────────────────────────────── */
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;

  var url = new URL(event.request.url);

  /* 1. Pass-through: analytics & fonts */
  if (PASSTHROUGH_HOSTS.indexOf(url.hostname) !== -1) return;

  /* 2. Google Sheets CSV → Network-First, cache the response */
  if (url.hostname === 'docs.google.com' && url.pathname.indexOf('/spreadsheets/') !== -1) {
    event.respondWith(
      fetch(event.request).then(function(networkRes) {
        var clone = networkRes.clone();
        caches.open(CACHE_VERSION).then(function(c) { c.put(event.request, clone); });
        return networkRes;
      }).catch(function() {
        return caches.match(event.request).then(function(cached) {
          return cached || Response.error();
        });
      })
    );
    return;
  }

  /* 3. App shell → Cache-First (instant, no network round-trip) */
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) return cached;
      return fetch(event.request).then(function(networkRes) {
        var clone = networkRes.clone();
        caches.open(CACHE_VERSION).then(function(c) { c.put(event.request, clone); });
        return networkRes;
      }).catch(function() {
        return caches.match('./index.html');
      });
    })
  );
});
