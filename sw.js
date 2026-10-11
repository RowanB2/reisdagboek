// Service worker: ontsleutelt de versleutelde site in de browser.
// De sleutel (niet-exporteerbaar) en de bestandslijst staan in IndexedDB, nooit het wachtwoord zelf.
// Zonder sleutel gaat alles gewoon naar het netwerk, en dat is dan de wachtwoordpagina.

let state = null; // { key, files }

function idbGet() {
  return new Promise((resolve) => {
    const open = indexedDB.open('reisdagboek', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('s');
    open.onerror = () => resolve(null);
    open.onsuccess = () => {
      const req = open.result.transaction('s').objectStore('s').get('state');
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    };
  });
}

function idbPut(value) {
  return new Promise((resolve) => {
    const open = indexedDB.open('reisdagboek', 1);
    open.onsuccess = () => {
      const tx = open.result.transaction('s', 'readwrite');
      tx.objectStore('s').put(value, 'state');
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    };
    open.onerror = () => resolve();
  });
}

async function decrypt(key, buf) {
  const bytes = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
}

// Bij elke paginanavigatie de bestandslijst verversen, zodat na een nieuwe publicatie
// de nieuwste versie wordt getoond. Offline: gewoon de laatst bekende lijst gebruiken.
async function refreshManifest(scope) {
  try {
    const res = await fetch(`${scope}m.bin`, { cache: 'no-cache' });
    if (!res.ok) return;
    const plain = await decrypt(state.key, await res.arrayBuffer());
    const manifest = JSON.parse(new TextDecoder().decode(plain));
    state = { key: state.key, files: manifest.files };
    await idbPut(state);
  } catch {
    /* offline of tijdelijk onbereikbaar: oude lijst blijft */
  }
}

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope).pathname;
  if (url.origin !== location.origin || !url.pathname.startsWith(scope) || event.request.method !== 'GET') return;
  event.respondWith(handle(event.request, url, scope));
});

async function handle(request, url, scope) {
  if (!state) state = await idbGet();
  if (!state) return fetch(request); // nog niet ontgrendeld: wachtwoordpagina

  if (request.mode === 'navigate') await refreshManifest(scope);

  let rel = decodeURIComponent(url.pathname.slice(scope.length));
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  let entry = state.files[rel];
  if (!entry && !rel.split('/').pop().includes('.')) {
    entry = state.files[`${rel}/index.html`];
    if (entry) return Response.redirect(`${url.pathname}/${url.search}`, 301);
  }
  if (!entry) return fetch(request); // bv. meta.json, m.bin, d/*.bin, sw.js

  const res = await fetch(`${scope}d/${entry.id}.bin`);
  if (!res.ok) return fetch(request);
  try {
    const plain = await decrypt(state.key, await res.arrayBuffer());
    return new Response(plain, { headers: { 'Content-Type': entry.t, 'Cache-Control': 'no-store' } });
  } catch {
    // sleutel past niet meer (wachtwoord gewijzigd): terug naar de wachtwoordpagina
    state = null;
    await idbPut(null);
    return fetch(request);
  }
}
