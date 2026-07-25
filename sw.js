const CACHE_PREFIX = "yijing-pwa-";
const CACHE_VERSION = "v1";
const CACHE_NAME = `${CACHE_PREFIX}${CACHE_VERSION}`;

const PRECACHE_URLS = Object.freeze([
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.mjs",
  "./js/data.mjs",
  "./js/domain.mjs",
  "./js/physical-source.mjs",
  "./js/pointer.mjs",
  "./js/prompt.mjs",
  "./js/register-sw.mjs",
  "./js/rng.mjs",
  "./js/sensor.mjs",
  "./js/templates.mjs",
  "./data/hexagrams.json",
  "./data/prompt_templates.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
]);

const APP_SHELL_URL = new URL("./index.html", self.registration.scope).href;
const APP_START_URL = new URL("./", self.registration.scope).href;
const PRECACHE_URL_SET = new Set(
  PRECACHE_URLS.map((path) => new URL(path, self.registration.scope).href),
);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter(
            (name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME,
          )
          .map((name) => caches.delete(name)),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    if (url.href !== APP_START_URL && url.href !== APP_SHELL_URL) return;
    event.respondWith(
      caches.match(APP_SHELL_URL).then((cached) => cached ?? fetch(request)),
    );
    return;
  }

  if (!PRECACHE_URL_SET.has(url.href)) return;
  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request)),
  );
});
