/* sw.js — service worker de Flujo: la app abre y funciona sin conexión.
 *
 * PARA PUBLICAR UNA VERSIÓN NUEVA
 *   1. Cambia VERSION (p. ej. 'v2'). El navegador detecta el sw.js nuevo, lo instala y vuelve a precargar el "app shell".
 *   2. Si añades o quitas archivos de index.html, css/, js/, vendor/ o icons/, edita APP_SHELL (abajo).
 *   El SW nuevo queda "en espera": NO toma el control hasta que la app lo pida con postMessage('skipWaiting')
 *   (js/pwa.js lo hace cuando la persona pulsa "Actualizar"), así no se corta una sesión de edición.
 *
 * ESTRATEGIAS (solo peticiones GET del mismo origen y dentro de la carpeta de la app; todo se resuelve con
 * self.registration.scope, así que funciona bajo un subdirectorio como https://usuario.github.io/flujo-app/)
 *   - navegación (index.html) y js/css/manifest:  red primero (para que las actualizaciones lleguen en cuanto hay internet),
 *     con respaldo en caché si no hay red, falla o tarda más de NETWORK_TIMEOUT_MS. Sin red, cualquier navegación
 *     sin copia propia recibe index.html (la app es de una sola página).
 *   - vendor/* e icons/*: caché primero (no cambian entre versiones; si cambian, sube VERSION).
 *   - NUNCA se tocan: peticiones a otros orígenes (api.github.com, CDN, etc.), métodos que no sean GET, peticiones con
 *     Range y las rutas data/ (los datos viven en IndexedDB, no en la caché del navegador).
 */
'use strict';

const VERSION = 'v2';

/* "App shell" que se precarga al instalar. Rutas relativas a la carpeta de sw.js. Si algún archivo no existe (todavía)
 * se avisa en la consola pero la instalación sigue: lo importante es que una errata no deje la app sin service worker. */
const APP_SHELL = [
  'index.html',
  'manifest.webmanifest',
  // estilos
  'css/app.css', 'css/grid.css', 'css/sync.css', 'css/pwa.css', 'css/ledger.css', 'css/dashboard.css', 'css/quick.css',
  // módulos
  'js/app.js', 'js/catalog.js', 'js/engine.js', 'js/export.js', 'js/format.js', 'js/grid.js', 'js/pwa.js',
  'js/settings-ui.js', 'js/store.js', 'js/sync-github.js', 'js/ui.js', 'js/ledger.js', 'js/dashboard.js', 'js/quick.js',
  // bibliotecas
  'vendor/hyperformula.full.min.js', 'vendor/ssf.js', 'vendor/xlsx.full.min.js',
  // iconos
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png', 'icons/favicon-32.png',
];

const NETWORK_TIMEOUT_MS = 4000;                               // red lenta: se sirve la copia guardada mientras la red sigue intentando
const SCOPE_URL = new URL(self.registration.scope);
const SCOPE_PATH = SCOPE_URL.pathname;                          // "/flujo-app/" o "/"
const CACHE_PREFIX = 'flujoweb:' + SCOPE_PATH + ':';           // incluye la ruta: otras apps del mismo usuario en github.io no se tocan
const CACHE_NAME = CACHE_PREFIX + VERSION;
const SHELL_URLS = APP_SHELL.map((p) => new URL(p, SCOPE_URL).href);
const INDEX_URL = new URL('index.html', SCOPE_URL).href;

/* ------------------------------------------------------------------------------------------------- ciclo de vida */
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // cache:'reload' salta la caché HTTP del navegador (GitHub Pages sirve con max-age=600): se precarga lo último publicado
    const results = await Promise.allSettled(SHELL_URLS.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    const failed = SHELL_URLS.filter((u, i) => results[i].status === 'rejected');
    if (failed.length) console.warn('[sw ' + VERSION + '] no se pudieron precargar ' + failed.length + ' archivo(s):', failed);
  })());
  // sin skipWaiting aquí: el SW nuevo espera a que la app lo pida
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const d = event.data;
  const type = typeof d === 'string' ? d : (d && d.type);
  if (type === 'skipWaiting' || type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (type === 'getVersion') {
    const reply = { type: 'version', version: VERSION, cache: CACHE_NAME };
    if (event.ports && event.ports[0]) event.ports[0].postMessage(reply);
    else if (event.source && event.source.postMessage) event.source.postMessage(reply);
  }
});

/* ------------------------------------------------------------------------------------------------- peticiones */
/** 'navigate' | 'network-first' | 'cache-first' | null (null = no intervenir: el navegador la resuelve por su cuenta) */
function routeFor(request) {
  if (request.method !== 'GET') return null;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return null;
  if (request.headers.has('range')) return null;                // respuestas parciales (audio/vídeo): no se pueden guardar
  let url;
  try { url = new URL(request.url); } catch (e) { return null; }
  if (url.origin !== self.location.origin) return null;         // otros orígenes (api.github.com...) NUNCA
  if (!url.pathname.startsWith(SCOPE_PATH)) return null;        // fuera de la carpeta de la app
  const rel = url.pathname.slice(SCOPE_PATH.length);
  if (rel === 'sw.js' || rel.startsWith('data/')) return null;  // los datos viven en IndexedDB
  if (request.mode === 'navigate') return 'navigate';
  if (rel.startsWith('vendor/') || rel.startsWith('icons/')) return 'cache-first';
  return 'network-first';
}

self.addEventListener('fetch', (event) => {
  const route = routeFor(event.request);
  if (route === null) return;
  event.respondWith(route === 'cache-first' ? cacheFirst(event.request) : networkFirst(event, route === 'navigate'));
});

const cacheable = (res) => !!res && res.status === 200 && res.type === 'basic';

async function store(request, res) {
  if (!cacheable(res)) return;
  const copy = res.clone();                                     // se clona ANTES de que la página lea el cuerpo
  try { await (await caches.open(CACHE_NAME)).put(request, copy); } catch (e) { /* cuota llena o Vary:* -> sin copia */ }
}

async function fromCache(request, isNavigation) {
  const cache = await caches.open(CACHE_NAME);
  let hit = await cache.match(request, { ignoreSearch: true });
  if (!hit && isNavigation) hit = await cache.match(INDEX_URL);
  return hit || null;
}

function fetchFresh(request, isNavigation) {
  // no-cache = revalidar con el servidor (304 si no cambió) en vez de fiarse de la caché HTTP de 10 min de GitHub Pages
  if (!isNavigation) {
    try { return fetch(new Request(request, { cache: 'no-cache' })); } catch (e) { /* cae a la petición original */ }
  }
  return fetch(request);
}

function networkFirst(event, isNavigation) {
  const request = event.request;
  const fresh = fetchFresh(request, isNavigation);
  event.waitUntil(fresh.then((res) => store(request, res), () => {}));   // guarda la copia nueva sin retrasar la respuesta
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(async () => { const hit = await fromCache(request, isNavigation); if (hit) done(resolve, hit); }, NETWORK_TIMEOUT_MS);
    fresh.then(async (res) => {
      if (res.status >= 500) { const hit = await fromCache(request, isNavigation); if (hit) return done(resolve, hit); }   // servidor caído: mejor la copia
      done(resolve, res);
    }, async (err) => {
      const hit = await fromCache(request, isNavigation);
      if (hit) done(resolve, hit); else done(reject, err);
    });
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  await store(request, res);
  return res;
}
