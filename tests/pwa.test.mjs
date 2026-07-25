import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const PWA_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const REPOSITORY_ROOT = path.dirname(PWA_ROOT);

const [manifestText, swSource, indexHtml, diagnosticsHtml, css, workflow] =
  await Promise.all([
    readFile(path.join(PWA_ROOT, "manifest.webmanifest"), "utf8"),
    readFile(path.join(PWA_ROOT, "sw.js"), "utf8"),
    readFile(path.join(PWA_ROOT, "index.html"), "utf8"),
    readFile(path.join(PWA_ROOT, "diagnostics.html"), "utf8"),
    readFile(path.join(PWA_ROOT, "styles.css"), "utf8"),
    readFile(path.join(REPOSITORY_ROOT, ".github/workflows/pages.yml"), "utf8"),
  ]);
const manifest = JSON.parse(manifestText);

function parsePrecacheUrls(source) {
  const match = source.match(
    /const PRECACHE_URLS = Object\.freeze\(\[([\s\S]*?)\]\);/,
  );
  assert.notEqual(match, null, "PRECACHE_URLS must be a frozen literal array");
  return [...match[1].matchAll(/"(\.\/[^"\\]+)"/g)].map((item) => item[1]);
}

function relativeFile(url) {
  assert.match(url, /^\.\//);
  return path.join(PWA_ROOT, url.slice(2));
}

async function assertFile(url) {
  assert.equal((await stat(relativeFile(url))).isFile(), true, `${url} must exist`);
}

function pngDimensions(bytes) {
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [137, 80, 78, 71, 13, 10, 26, 10],
    "PNG signature",
  );
  assert.equal(bytes.subarray(12, 16).toString("ascii"), "IHDR");
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function createServiceWorkerHarness({ installFailure = null } = {}) {
  const listeners = new Map();
  const deleted = [];
  const addAllCalls = [];
  const scope = "https://example.test/project/pwa/";
  const shellUrl = new URL("./index.html", scope).href;
  const dataUrl = new URL("./data/hexagrams.json", scope).href;
  const cached = new Map([
    [shellUrl, { kind: "cached-shell" }],
    [dataUrl, { kind: "cached-data" }],
  ]);
  const cache = {
    async addAll(urls) {
      addAllCalls.push([...urls]);
      if (installFailure) throw installFailure;
    },
  };
  const caches = {
    async open() {
      return cache;
    },
    async keys() {
      return [
        "yijing-pwa-20260725-02",
        "yijing-pwa-20260725-03",
        "another-app-v8",
      ];
    },
    async delete(name) {
      deleted.push(name);
      return true;
    },
    async match(request) {
      const url = typeof request === "string" ? request : request.url;
      return cached.get(url);
    },
  };
  const self = {
    registration: { scope },
    location: { origin: "https://example.test" },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };
  const context = {
    URL,
    Set,
    Promise,
    caches,
    fetch: async () => {
      throw new Error("offline");
    },
    self,
  };
  vm.runInNewContext(swSource, context, { filename: "sw.js" });
  return { addAllCalls, deleted, listeners };
}

function dispatchExtendable(listener) {
  let promise = null;
  listener({ waitUntil(value) { promise = value; } });
  assert.notEqual(promise, null);
  return promise;
}

test("manifest uses project-relative URLs and complete icon metadata", async () => {
  assert.equal(manifest.lang, "ja");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.orientation, "portrait-primary");
  for (const key of [
    "name",
    "short_name",
    "description",
    "background_color",
    "theme_color",
  ]) {
    assert.equal(typeof manifest[key], "string");
    assert.notEqual(manifest[key].length, 0);
  }
  assert.deepEqual(
    manifest.icons.map(({ sizes, type, purpose }) => ({ sizes, type, purpose })),
    [
      { sizes: "192x192", type: "image/png", purpose: "any" },
      { sizes: "512x512", type: "image/png", purpose: "any" },
      { sizes: "192x192", type: "image/png", purpose: "maskable" },
      { sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  );
  await Promise.all(manifest.icons.map(({ src }) => assertFile(src)));
});

test("icon files are valid PNGs with fixed dimensions and editable sources", async () => {
  const expected = new Map([
    ["./icons/icon-192.png", 192],
    ["./icons/icon-512.png", 512],
    ["./icons/icon-maskable-192.png", 192],
    ["./icons/icon-maskable-512.png", 512],
    ["./icons/apple-touch-icon.png", 180],
  ]);
  for (const [url, size] of expected) {
    const dimensions = pngDimensions(await readFile(relativeFile(url)));
    assert.deepEqual(dimensions, { width: size, height: size });
  }
  await assertFile("./icons/app-icon.svg");
  await assertFile("./tools/generate_icons.py");
  const svg = await readFile(relativeFile("./icons/app-icon.svg"), "utf8");
  assert.match(svg, /viewBox="0 0 512 512"/);
  assert.equal((svg.match(/fill="#e8c469"/g) ?? []).length, 2);
  assert.equal((svg.match(/<rect /g) ?? []).length, 9);
});

test("precache is unique, complete, and excludes developer diagnostics", async () => {
  const urls = parsePrecacheUrls(swSource);
  assert.equal(new Set(urls).size, urls.length);
  await Promise.all(urls.map(assertFile));

  const required = [
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
    "./icons/apple-touch-icon.png",
    ...manifest.icons.map(({ src }) => src),
  ];
  for (const url of required) assert.equal(urls.includes(url), true, url);
  for (const diagnosticUrl of [
    "./diagnostics.html",
    "./js/diagnostics-app.mjs",
    "./js/diagnostics.mjs",
  ]) {
    assert.equal(urls.includes(diagnosticUrl), false, diagnosticUrl);
  }
});

test("service worker has isolated versioning and conservative update rules", () => {
  assert.match(swSource, /const CACHE_PREFIX = "yijing-pwa-";/);
  assert.match(swSource, /const CACHE_VERSION = "20260725-03";/);
  assert.match(swSource, /cache\.addAll\(PRECACHE_URLS\)/);
  assert.doesNotMatch(swSource, /skipWaiting\s*\(|clients\.claim\s*\(/);
  assert.match(
    swSource,
    /name\.startsWith\(CACHE_PREFIX\) && name !== CACHE_NAME/,
  );
  assert.match(swSource, /request\.method !== "GET"/);
  assert.match(swSource, /url\.origin !== self\.location\.origin/);
});

test("install failure propagates and activate deletes only an old app cache", async () => {
  const ok = createServiceWorkerHarness();
  await dispatchExtendable(ok.listeners.get("install"));
  assert.deepEqual(ok.addAllCalls, [parsePrecacheUrls(swSource)]);
  await dispatchExtendable(ok.listeners.get("activate"));
  assert.deepEqual(ok.deleted, ["yijing-pwa-20260725-02"]);

  const failure = new Error("missing precache file");
  const broken = createServiceWorkerHarness({ installFailure: failure });
  await assert.rejects(
    dispatchExtendable(broken.listeners.get("install")),
    failure,
  );
});

test("offline fetch serves navigation and precached data but ignores POST and external URLs", async () => {
  const { listeners } = createServiceWorkerHarness();
  const fetchListener = listeners.get("fetch");
  const dispatchFetch = async (request) => {
    let responsePromise = null;
    fetchListener({ request, respondWith(value) { responsePromise = value; } });
    return responsePromise === null ? null : responsePromise;
  };

  assert.deepEqual(
    await dispatchFetch({
      method: "GET",
      mode: "navigate",
      url: "https://example.test/project/pwa/",
    }),
    { kind: "cached-shell" },
  );
  assert.deepEqual(
    await dispatchFetch({
      method: "GET",
      mode: "cors",
      url: "https://example.test/project/pwa/data/hexagrams.json",
    }),
    { kind: "cached-data" },
  );
  assert.equal(
    await dispatchFetch({
      method: "GET",
      mode: "navigate",
      url: "https://example.test/project/pwa/diagnostics.html",
    }),
    null,
  );
  assert.equal(
    await dispatchFetch({
      method: "POST",
      mode: "same-origin",
      url: "https://example.test/project/pwa/index.html",
    }),
    null,
  );
  assert.equal(
    await dispatchFetch({
      method: "GET",
      mode: "cors",
      url: "https://external.example/data.json",
    }),
    null,
  );
});

test("internal resource references are relative and contain no deployment identity", async () => {
  const pwaFiles = [
    "index.html",
    "diagnostics.html",
    "manifest.webmanifest",
    "sw.js",
    "styles.css",
    ...(await readdir(path.join(PWA_ROOT, "js"))).map((name) => `js/${name}`),
  ];
  const sources = await Promise.all(
    pwaFiles.map((name) => readFile(path.join(PWA_ROOT, name), "utf8")),
  );
  const combined = sources.join("\n");
  for (const html of [indexHtml, diagnosticsHtml]) {
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      assert.match(match[1], /^\.\//, match[1]);
    }
  }
  for (const url of [manifest.start_url, manifest.scope, ...manifest.icons.map(({ src }) => src), ...parsePrecacheUrls(swSource)]) {
    assert.match(url, /^\.\//, url);
  }
  for (const source of sources) {
    for (const match of source.matchAll(
      /(?:from\s+|import\s*)["']([^"']+)["']|new URL\(\s*["']([^"']+)["']/g,
    )) {
      const url = match[1] ?? match[2];
      assert.match(url, /^\.\.?\//, url);
    }
  }
  assert.doesNotMatch(combined, /https?:\/\/|github\.io|trycloudflare|\/home\//i);
  assert.doesNotMatch(css, /url\(\s*["']?\//);
});

test("Pages workflow publishes only pwa and supports the working branch and manual runs", () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /branches:\s*\n\s*- pwa-migration/);
  assert.match(workflow, /path: \.\/pwa/);
  assert.doesNotMatch(workflow, /path:\s*\.\/(?:windows|doc|\.venv)/);
  assert.doesNotMatch(workflow, /github\.io|trycloudflare|username|repository:/i);
});
