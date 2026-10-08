// Service worker: guarda os arquivos do app para uso sem conexão.
// Arquivos do próprio app: rede primeiro (versão mais nova), cache como reserva.
// Chamadas ao Supabase (outra origem) passam direto; os dados ficam no IndexedDB.
const CACHE = 'rp-shell-v1.3.7-congelamento-compartilhado';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'sw.js', 'css/app.css', 'planilha_modelo.xlsx',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'js/main.js', 'js/db.js', 'js/remote.js', 'js/sync.js', 'js/images.js', 'js/engine.js', 'js/store.js',
  'js/util.js', 'js/access.js', 'js/correlation.js', 'js/settings.js', 'js/compute.js', 'js/worker.js', 'js/backup.js', 'js/export.js',
  'js/model/bt.js', 'js/model/linalg.js', 'js/model/rng.js', 'js/model/pairing.js', 'js/model/stages.js', 'js/model/signals.js',
  'js/ui/common.js', 'js/ui/vote.js', 'js/ui/photo-viewer.js', 'js/ui/photo-framing.js', 'js/ui/image-search.js', 'js/ui/ranking.js', 'js/ui/progress.js', 'js/ui/bracket.js', 'js/ui/history.js',
  'js/ui/participants.js', 'js/ui/versions.js', 'js/ui/settings.js', 'js/ui/method.js', 'js/ui/guests.js', 'js/ui/correlation.js',
  'vendor/supabase.js', 'vendor/fflate.min.js', 'vendor/xlsx.mini.min.js', 'vendor/qrcode.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith('rp-shell-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const res = await fetch(req, { signal: ctrl.signal, cache: 'no-cache' });
      clearTimeout(timer);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      return Response.error();
    }
  })());
});
