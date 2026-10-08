/* 강의/발표 플랫폼 서비스 워커 — 오프라인에서도 앱이 열리고 동작하도록 필요한 파일을 캐시한다.
 *
 * - 앱 본문(index.html): 온라인이면 항상 최신을 받고(받은 것을 캐시에 갱신), 오프라인이면 캐시에서 연다.
 * - 외부 라이브러리/글꼴/모델(CDN): 버전이 주소에 박혀 있어 한 번 받으면 캐시에서 바로 쓴다.
 * - TTS/음성 API 같은 그 밖의 요청은 건드리지 않는다(항상 네트워크).
 * 처음 한 번은 온라인으로 열어야 하고, 그 뒤로 오프라인에서 쓸 수 있다. 버전을 올리면 옛 캐시는 지운다. */
const VERSION = 'v4';
const CACHE = 'lecture-video-' + VERSION;

// 앱이 시작할 때 꼭 필요한 파일: 설치(첫 접속) 때 미리 받아 둔다.
const CORE = [
  './', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png',
  './remote.webmanifest', './icons/icon-remote-192.png', './icons/icon-remote-512.png'
];
const CDN_CORE = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css'
];

/** 캐시해도 되는 외부 주소인지(CDN 라이브러리·글꼴·웹캠 배경제거 모델). TTS 등 API는 제외. */
function isCacheableCrossOrigin(url) {
  if (url.hostname === 'cdnjs.cloudflare.com' || url.hostname === 'cdn.jsdelivr.net') return true;
  return url.hostname === 'storage.googleapis.com' && url.pathname.startsWith('/mediapipe-models/');
}

const FONT_CSS = 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css';
const FONT_WEIGHTS = /Pretendard-(Regular|Medium|SemiBold|Bold|ExtraBold|Black)\.woff2/; // 화면에서 쓰는 굵기만(약 400~900)

/** 글꼴 CSS를 읽어서 쓰는 굵기의 woff2 파일을 미리 받아 둔다(CSS만 캐시하면 글꼴 파일이 없어 오프라인에서 기본 글꼴로 보인다). */
async function cacheFonts(cache) {
  try {
    const css = await (await cache.match(FONT_CSS))?.text();
    if (!css) return;
    const urls = [...css.matchAll(/url\(([^)]+?)\)/g)]
      .map((m) => new URL(m[1].replace(/["']/g, ''), FONT_CSS).href)
      .filter((u) => FONT_WEIGHTS.test(u));
    await Promise.allSettled([...new Set(urls)].map((u) => cache.match(u).then((hit) => hit || cache.add(u))));
  } catch (e) { /* 글꼴은 못 받아도 앱은 기본 글꼴로 동작 */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 하나가 실패해도 설치 전체가 실패하지 않게 따로 받는다.
    await Promise.allSettled([...CORE, ...CDN_CORE].map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    await cacheFonts(cache);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('lecture-video-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !isCacheableCrossOrigin(url)) return;

  // 페이지 이동: 네트워크 우선(최신 버전), 실패하면 캐시된 앱.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok) cache.put('./', res.clone());
        return res;
      } catch (e) {
        return (await cache.match('./')) || (await cache.match(req, { ignoreSearch: true })) || Response.error();
      }
    })());
    return;
  }

  // 그 밖의 파일: 캐시 우선, 없으면 받아서 저장(주소에 버전이 있는 것들이라 안전).
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // 불투명(no-cors) 응답(status 0)도 스크립트/글꼴에는 그대로 쓸 수 있으므로 저장한다.
      if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
      return res;
    } catch (e) {
      return (await cache.match(req, { ignoreSearch: true })) || Response.error();
    }
  })());
});

// 페이지가 "이미 불러온 외부 자원 목록"을 보내오면(글꼴 파일·웹캠 모델 등), 아직 없는 것을 받아서 저장한다.
// → 첫 접속에서 서비스 워커가 켜지기 전에 로드된 자원도 오프라인용으로 확보된다.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'warm' || !Array.isArray(data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const u of data.urls.slice(0, 200)) {
      try {
        const url = new URL(u);
        if (url.origin !== self.location.origin && !isCacheableCrossOrigin(url)) continue;
        if (await cache.match(u)) continue;
        const res = await fetch(u);
        if (res.ok) await cache.put(u, res);
      } catch (e) { /* 못 받은 것은 다음에 */ }
    }
  })());
});
