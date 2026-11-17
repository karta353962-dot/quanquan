/* =========================================================
   券券日記・Service Worker（階段四）
   - 離線：App 本體先快取，沒有網路也能打開、查看已存的票券與 QR Code
   - 更新：有網路時優先抓最新版，抓不到才用快取
   - 推播：顯示到期提醒，點通知打開「即將到期」列表
   - 分享選單：接收其他 App 分享的圖片或網址（支援的裝置才有）
   ========================================================= */
const VERSION = 'qq-v4.0';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const SHARE = 'qq-share-inbox';
const ASSETS = [
  './', './index.html', './config.js', './sync.js', './recognize.js', './extras.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
];
const CDN = /^https:\/\/(cdn\.jsdelivr\.net|fonts\.googleapis\.com|fonts\.gstatic\.com|tessdata\.projectnaptha\.com)\//;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).catch(() => {}));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== RUNTIME && k !== SHARE) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// 有網路先拿新的（最多等 4 秒），失敗再用快取
async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await Promise.race([fetch(req), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('./index.html'));
    return hit || new Response('離線中，而且這個檔案還沒有快取', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
// 外部函式庫、字型：有快取就直接用
async function cacheFirst(req) {
  const cache = await caches.open(RUNTIME);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}

// 分享選單：把收到的圖片與網址暫存，再打開新增頁
async function receiveShare(req) {
  const form = await req.formData();
  const cache = await caches.open(SHARE);
  const files = form.getAll('images').filter(f => f && typeof f !== 'string');
  const meta = { at: Date.now(), title: form.get('title') || '', text: form.get('text') || '', url: form.get('url') || '', count: files.length };
  await cache.put('./__share/meta', new Response(JSON.stringify(meta), { headers: { 'Content-Type': 'application/json' } }));
  for (let i = 0; i < files.length; i++) {
    await cache.put(`./__share/file-${i}`, new Response(files[i], { headers: { 'Content-Type': files[i].type || 'image/jpeg', 'X-Name': encodeURIComponent(files[i].name || 'shared') } }));
  }
  return Response.redirect('./#add-shared', 303);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method === 'POST' && url.origin === location.origin && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  if (/\.supabase\.co$/.test(url.hostname) || url.hostname.includes('googleapis.com') && !url.hostname.startsWith('fonts')) return;  // 雲端 API 不快取
  if (url.origin === location.origin) { event.respondWith(networkFirst(req)); return; }
  if (CDN.test(req.url)) event.respondWith(cacheFirst(req));
});

/* ---------- 推播 ---------- */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }
  // iOS 規定：收到推播一定要顯示通知
  event.waitUntil(self.registration.showNotification(data.title || '券券日記', {
    body: data.body || '有票券快到期了，記得使用喔！',
    tag: data.tag || 'qq-reminder',
    renotify: true,
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    data: { url: data.url || './#soon' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || './#soon', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) { await w.focus(); try { await w.navigate(target); } catch { w.postMessage({ type: 'open', url: target }); } return; }
    }
    await self.clients.openWindow(target);
  })());
});
