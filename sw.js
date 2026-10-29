// オフラインでも起動できるように画面のファイルをキャッシュする。
// つながるときは毎回サーバーの最新版を使い、つながらないときだけキャッシュを使う
// （古いアイコンや画面が残り続けないように）。
const CACHE = 'silent-camera-v8';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.webmanifest',
  './icons/lens-180.png',
  './icons/lens-192.png',
  './icons/lens-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // 同じサイト（github.io）にあるほかのアプリ（ひび手帳・凪・Orb など）のキャッシュは消さない
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('silent-camera-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          event.waitUntil(caches.open(CACHE).then((c) => c.put(request, copy)));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.open(CACHE).then((c) => c.match(request, { ignoreSearch: true }));
        return cached || Response.error();
      }),
  );
});
