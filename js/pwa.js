/* pwa.js — soporte PWA de Flujo: service worker (offline), avisos de actualización, instalación y estado de conexión.
 *
 * Uso mínimo (js/app.js):
 *   import { registerServiceWorker, installPrompt } from './pwa.js';
 *   registerServiceWorker({ onUpdateReady: (apply) => mostrarAviso('Hay una versión nueva', apply) });   // apply() actualiza y recarga
 *   boton.onclick = async () => { if ((await installPrompt()) === false) mostrarAyudaManual(); };
 *
 * <head> recomendado (rutas relativas: la app se publica bajo un subdirectorio, https://usuario.github.io/flujo-app/):
 *   <link rel="manifest" href="manifest.webmanifest">
 *   <meta name="theme-color" content="#0f5257">
 *   <link rel="icon" type="image/png" sizes="32x32" href="icons/favicon-32.png">
 *   <link rel="icon" type="image/svg+xml" href="icons/icon.svg">
 *   <link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
 *   <meta name="apple-mobile-web-app-capable" content="yes"> <meta name="apple-mobile-web-app-title" content="Flujo">
 *   <link rel="stylesheet" href="css/pwa.css">   (si falta, los avisos la cargan solos)
 *
 * El módulo se puede importar en cualquier momento: escucha 'beforeinstallprompt' desde que se evalúa (si se pierde ese
 * evento ya no se puede ofrecer el diálogo nativo de instalación).
 */

const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined';

/* ====================================================================================== estado de conexión */
/** true si el navegador cree que hay red (navigator.onLine; puede dar falsos positivos, nunca falsos negativos). */
export function isOnline() { return typeof navigator === 'undefined' || navigator.onLine !== false; }

/** Llama cb(true|false) cuando se pierde o vuelve la conexión. Devuelve la función para dejar de escuchar. */
export function onConnectionChange(cb) {
  if (!hasDom) return () => {};
  const on = () => cb(true), off = () => cb(false);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
}

/* ====================================================================================== modo de visualización / plataforma */
/** true si la app se abrió instalada (ventana propia / pantalla de inicio) y no en una pestaña del navegador. */
export function isStandalone() {
  if (!hasDom) return false;
  try {
    if (window.navigator.standalone === true) return true;                              // iOS: "Añadir a pantalla de inicio"
    if (typeof document.referrer === 'string' && document.referrer.startsWith('android-app://')) return true;
    if (window.matchMedia) {
      for (const m of ['standalone', 'fullscreen', 'minimal-ui', 'window-controls-overlay']) {
        if (window.matchMedia('(display-mode: ' + m + ')').matches) return true;
      }
    }
  } catch (e) { /* sin matchMedia */ }
  return false;
}

/** iPhone / iPad / iPod (incluido iPadOS, que se presenta como Mac con pantalla táctil). */
export function isIOS() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Safari de iOS/iPadOS (no Chrome, Firefox, Edge u Opera para iOS, que usan otro menú). */
export function isIOSSafari() {
  if (!isIOS()) return false;
  const ua = navigator.userAgent || '';
  return /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|GSA\/|DuckDuckGo/.test(ua);
}

/** En iOS no existe el diálogo nativo de instalación: hay que explicar "Compartir -> Añadir a pantalla de inicio". */
export function needsIosInstallHelp() { return isIOS() && !isStandalone(); }

/* ====================================================================================== instalación (beforeinstallprompt) */
let deferredPrompt = null;
const installSubs = new Set();

function installState() { return { canInstall: canInstall(), installed: isStandalone(), ios: needsIosInstallHelp() }; }
function notifyInstall() { const s = installState(); for (const cb of [...installSubs]) { try { cb(s); } catch (e) { console.warn(e); } } }

if (hasDom) {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();                                        // se guarda para mostrarlo cuando la persona lo pida
    deferredPrompt = e;
    notifyInstall();
  });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; notifyInstall(); });
}

/** true si el navegador ofrece instalar ahora mismo (Chrome, Edge, Samsung Internet, Android...) y la app aún no está instalada. */
export function canInstall() { return !!deferredPrompt && !isStandalone(); }

/**
 * Muestra el diálogo nativo de instalación.
 * @returns {Promise<'accepted'|'dismissed'|false>} false = el navegador no ofrece diálogo (iOS, ya instalada, evento perdido):
 *   enseña instrucciones manuales (showIosInstallHelp() o «Instalar aplicación» del menú del navegador).
 */
export async function installPrompt() {
  const ev = deferredPrompt;
  if (!ev) return false;
  deferredPrompt = null;                                       // el evento solo se puede usar una vez
  try {
    ev.prompt();
    const choice = await ev.userChoice;
    notifyInstall();
    return choice && choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch (e) {
    notifyInstall();
    return false;
  }
}

/** cb({canInstall, installed, ios}) cada vez que cambia la posibilidad de instalar (y una vez al suscribirse). Devuelve la baja. */
export function onInstallStateChange(cb) {
  installSubs.add(cb);
  try { cb(installState()); } catch (e) { console.warn(e); }
  return () => installSubs.delete(cb);
}

/* ====================================================================================== service worker */
let swReg = null;
let updateRequested = false, reloading = false;
let cfg = {};

async function reloadNow() {
  if (reloading) return;
  reloading = true;
  try { if (typeof cfg.beforeReload === 'function') await cfg.beforeReload(); } catch (e) { console.warn(e); }
  location.reload();
}

/**
 * Activa la versión nueva (si hay una esperando) y recarga la página cuando toma el control.
 * Antes de recargar espera a opts.beforeReload() (p. ej. para guardar lo pendiente).
 */
export async function applyUpdate() {
  const reg = swReg || (navigator.serviceWorker && await navigator.serviceWorker.getRegistration());
  const waiting = reg && reg.waiting;
  if (!waiting) { await reloadNow(); return; }
  updateRequested = true;
  waiting.postMessage('skipWaiting');
  setTimeout(() => { if (updateRequested && !reloading) reloadNow(); }, 4000);      // por si el navegador no avisa del cambio
}

/** Pide al navegador que busque un sw.js nuevo. Devuelve true si hay una versión nueva instalándose o esperando. */
export async function checkForUpdate() {
  if (!swReg) return false;
  try { await swReg.update(); } catch (e) { return false; }
  return !!(swReg.waiting || swReg.installing);
}

/** Versión del service worker que controla la página (la constante VERSION de sw.js) o null. */
export function getServiceWorkerVersion(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sw = typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!sw) { resolve(null); return; }
    const ch = new MessageChannel();
    const t = setTimeout(() => resolve(null), timeoutMs);
    ch.port1.onmessage = (e) => { clearTimeout(t); resolve((e.data && e.data.version) || null); };
    sw.postMessage({ type: 'getVersion' }, [ch.port2]);
  });
}

/**
 * Registra sw.js (la ruta se resuelve respecto a este módulo: ../sw.js, así que sirve desde cualquier subdirectorio).
 * @param {object} [opts]
 * @param {(apply:Function, registration:ServiceWorkerRegistration)=>void} [opts.onUpdateReady]
 *        Hay una versión nueva descargada y lista. Llama a apply() cuando la persona acepte (activa y recarga).
 *        Si no se indica, se muestra el aviso «Hay una versión nueva — Actualizar» (showUpdateBanner).
 * @param {()=>void} [opts.onControllerChange] cambió el service worker que controla la página
 * @param {(e:Error)=>void} [opts.onError]
 * @param {()=>Promise|void} [opts.beforeReload] se espera antes de recargar al actualizar (guardar cambios pendientes)
 * @param {string} [opts.swUrl] [opts.scope]
 * @param {number} [opts.checkEveryMs=1800000] mínimo entre comprobaciones de actualización al volver a la pestaña
 * @returns {Promise<ServiceWorkerRegistration|null>} null si el navegador no admite service workers o hubo un error
 */
export async function registerServiceWorker(opts = {}) {
  cfg = opts;
  if (!hasDom || !('serviceWorker' in navigator)) return null;
  try {
    // se espera a 'load' para que la precarga de unos 2 MB no compita con el arranque de la app
    if (document.readyState !== 'complete') await new Promise((res) => window.addEventListener('load', res, { once: true }));
    const url = opts.swUrl || new URL('../sw.js', import.meta.url).href;
    const reg = await navigator.serviceWorker.register(url, Object.assign({ updateViaCache: 'none' }, opts.scope ? { scope: opts.scope } : {}));
    swReg = reg;

    let announced = null;
    const ready = () => {
      if (!reg.waiting || announced === reg.waiting) return;
      announced = reg.waiting;
      const apply = () => applyUpdate();
      if (typeof opts.onUpdateReady === 'function') { try { opts.onUpdateReady(apply, reg); } catch (e) { console.warn(e); } }
      else showUpdateBanner(apply);
    };
    if (reg.waiting && navigator.serviceWorker.controller) ready();            // quedó una versión esperando de una visita anterior
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) ready(); });
    });
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (updateRequested) reloadNow();                                        // en la primera instalación (clients.claim) NO se recarga
      if (typeof opts.onControllerChange === 'function') { try { opts.onControllerChange(); } catch (e) { console.warn(e); } }
    });

    // una pestaña abierta días enteros también debe enterarse de las versiones nuevas
    const every = opts.checkEveryMs == null ? 30 * 60 * 1000 : opts.checkEveryMs;
    let last = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && isOnline() && Date.now() - last > every) { last = Date.now(); reg.update().catch(() => {}); }
    });
    return reg;
  } catch (e) {
    if (typeof opts.onError === 'function') opts.onError(e); else console.warn('[pwa] no se pudo registrar el service worker:', e);
    return null;
  }
}

/* ====================================================================================== avisos (clases fx-pwa-*, css/pwa.css) */
const STORE_INSTALL_DISMISSED = 'fx-pwa-install-dismissed', STORE_IOS_DISMISSED = 'fx-pwa-ios-dismissed';
const DISMISS_DAYS = 14;
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* modo privado */ } };
const recentlyDismissed = (k) => { const t = +lsGet(k); return t > 0 && Date.now() - t < DISMISS_DAYS * 86400000; };

function ensureStyles() {
  if (!hasDom || document.querySelector('link[data-fx-pwa], link[rel="stylesheet"][href*="pwa.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../css/pwa.css', import.meta.url).href;
  l.setAttribute('data-fx-pwa', '');
  document.head.appendChild(l);
}

function host() {
  let h = document.getElementById('fx-pwa-host');
  if (!h) {
    h = document.createElement('div');
    h.id = 'fx-pwa-host';
    h.className = 'fx-pwa-host';
    h.setAttribute('aria-live', 'polite');
    document.body.appendChild(h);
  }
  return h;
}

const SHARE_ICON = '<svg class="fx-pwa-icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Aviso flotante (un solo aviso por id; si ya existe se reemplaza).
 * @param {{id?:string, message?:string, node?:Node, kind?:'info'|'ok'|'warn', actions?:{label:string, primary?:boolean, onClick?:(close:Function, ev:Event)=>void}[], timeoutMs?:number}} o
 * @returns {{close:Function, el:HTMLElement}|null}
 */
export function showToast(o = {}) {
  if (!hasDom) return null;
  ensureStyles();
  const id = o.id || 'toast';
  const h = host();
  const old = h.querySelector('[data-fx-pwa="' + id + '"]');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'fx-pwa-banner fx-pwa-banner--' + (o.kind || 'info');
  el.setAttribute('role', 'status');
  el.setAttribute('data-fx-pwa', id);
  const text = document.createElement('p');
  text.className = 'fx-pwa-text';
  if (o.node) text.appendChild(o.node); else text.textContent = o.message || '';
  el.appendChild(text);
  const close = () => { if (el.parentNode) el.remove(); };
  if (o.actions && o.actions.length) {
    const box = document.createElement('div');
    box.className = 'fx-pwa-actions';
    for (const a of o.actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fx-pwa-btn ' + (a.primary ? 'fx-pwa-btn--primary' : 'fx-pwa-btn--ghost');
      b.textContent = a.label;
      b.addEventListener('click', (ev) => { if (a.onClick) a.onClick(close, ev); else close(); });
      box.appendChild(b);
    }
    el.appendChild(box);
  }
  h.appendChild(el);
  if (o.timeoutMs > 0) setTimeout(close, o.timeoutMs);
  return { close, el };
}

/** «Hay una versión nueva — Actualizar». apply = función que activa la versión nueva (por defecto applyUpdate). */
export function showUpdateBanner(apply = applyUpdate) {
  return showToast({
    id: 'update',
    message: 'Hay una versión nueva de Flujo.',
    actions: [
      { label: 'Actualizar', primary: true, onClick: (close, ev) => { ev.currentTarget.disabled = true; ev.currentTarget.textContent = 'Actualizando…'; Promise.resolve(apply()).catch((e) => console.warn(e)); } },
      { label: 'Más tarde' },
    ],
  });
}

/** Instrucciones para iOS/iPadOS: Compartir → Añadir a pantalla de inicio. */
export function showIosInstallHelp() {
  if (!hasDom) return null;
  const p = document.createElement('span');
  p.innerHTML = 'Para instalar Flujo: toca <strong>Compartir</strong> ' + SHARE_ICON + ' y luego <strong>«Añadir a pantalla de inicio»</strong>.';
  return showToast({
    id: 'ios-install', node: p,
    actions: [{ label: 'Entendido', primary: true, onClick: (close) => { lsSet(STORE_IOS_DISMISSED, String(Date.now())); close(); } }],
  });
}

/**
 * Invita a instalar la app. Con diálogo nativo (Chrome/Edge/Android) muestra «Instalar»; en iOS, las instrucciones.
 * No molesta si ya está instalada ni si se descartó hace menos de 14 días (opts.force lo ignora).
 */
export function showInstallBanner(opts = {}) {
  if (!hasDom || isStandalone()) return null;
  if (canInstall()) {
    if (!opts.force && recentlyDismissed(STORE_INSTALL_DISMISSED)) return null;
    return showToast({
      id: 'install',
      message: 'Instala Flujo en este dispositivo: se abre como una app, también sin internet.',
      actions: [
        { label: 'Instalar', primary: true, onClick: async (close) => { const r = await installPrompt(); if (r) close(); } },
        { label: 'Ahora no', onClick: (close) => { lsSet(STORE_INSTALL_DISMISSED, String(Date.now())); close(); } },
      ],
    });
  }
  if (needsIosInstallHelp()) {
    if (!opts.force && recentlyDismissed(STORE_IOS_DISMISSED)) return null;
    return showIosInstallHelp();
  }
  return null;
}

/**
 * Todo en uno (opcional): registra el service worker y activa los avisos por defecto.
 * @param {{updateBanner?:boolean, installBanner?:boolean, offlineNotice?:boolean}&object} [opts] el resto va a registerServiceWorker
 */
export async function initPwa(opts = {}) {
  const { updateBanner = true, installBanner = true, offlineNotice = false, ...swOpts } = opts;
  if (!updateBanner && !swOpts.onUpdateReady) swOpts.onUpdateReady = () => {};
  const reg = await registerServiceWorker(swOpts);
  if (installBanner && hasDom) {
    onInstallStateChange((s) => { if (s.canInstall) showInstallBanner(); });
    if (needsIosInstallHelp()) setTimeout(() => showInstallBanner(), 4000);
  }
  if (offlineNotice) {
    const apply = (online) => {
      if (online) { const el = document.querySelector('[data-fx-pwa="offline"]'); if (el) { el.remove(); showToast({ id: 'online', message: 'Conexión restablecida.', kind: 'ok', timeoutMs: 2500 }); } }
      else showToast({ id: 'offline', message: 'Sin conexión: Flujo sigue funcionando con los datos de este dispositivo.', kind: 'warn' });
    };
    onConnectionChange(apply);
    if (!isOnline()) apply(false);
  }
  return reg;
}
