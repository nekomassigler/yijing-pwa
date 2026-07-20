import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  REQUIRED_ELEMENT_IDS,
  bootstrapApp,
  collectAppElements,
  createApp,
} from "../js/app.mjs";
import { HexagramData } from "../js/data.mjs";
import { makeInterpretPrompt } from "../js/prompt.mjs";
import { createPhysicalInputProvider } from "../js/physical-source.mjs";
import { ArrayByteSource } from "../js/rng.mjs";
import {
  PROMPT_TEMPLATE_STORAGE_KEY,
  createTemplateBackup,
  initializeTemplateRepository,
  parseInitialTemplateJson,
} from "../js/templates.mjs";

const [html, css, appSource, hexagramPayload, initialTemplateText, golden] =
  await Promise.all([
    readFile(new URL("../index.html", import.meta.url), "utf8"),
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("../js/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../data/hexagrams.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../data/prompt_templates.json", import.meta.url), "utf8"),
    readFile(new URL("./golden_vectors.json", import.meta.url), "utf8").then(JSON.parse),
  ]);

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...names) {
    for (const name of names) {
      this.values.add(name);
    }
  }

  contains(name) {
    return this.values.has(name);
  }
}

class FakeElement {
  constructor(tagName = "div", id = "") {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.value = "";
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.files = [];
    this.dataset = {};
    this.children = [];
    this.attributes = new Map();
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.focused = false;
    this.selected = false;
    this.parentNode = null;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }

  async dispatch(type) {
    for (const listener of this.listeners.get(type) ?? []) {
      await listener({ type, target: this, preventDefault() {} });
    }
  }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  focus() {
    this.focused = true;
  }

  select() {
    this.selected = true;
  }

  click() {
    return this.dispatch("click");
  }

  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter(
        (child) => child !== this,
      );
      this.parentNode = null;
    }
  }
}

class FakeDocument {
  constructor() {
    this.elements = new Map(
      REQUIRED_ELEMENT_IDS.map((id) => [id, new FakeElement("div", id)]),
    );
    this.body = new FakeElement("body", "body");
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }
}

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

async function createHarness({ withByteSource = false, byteSourceProvider } = {}) {
  const documentObject = new FakeDocument();
  const elements = collectAppElements(documentObject);
  elements["result-section"].hidden = true;
  elements["prompt-section"].hidden = true;
  elements["template-import-summary"].hidden = true;
  elements["template-import-apply-button"].disabled = true;

  const storage = new MemoryStorage();
  const initialized = await initializeTemplateRepository({
    storage,
    loadInitial: async () => parseInitialTemplateJson(initialTemplateText),
  });
  const clipboardState = { texts: [], fail: false };
  const clipboard = {
    async writeText(value) {
      if (clipboardState.fail) {
        throw new Error("clipboard blocked");
      }
      clipboardState.texts.push(value);
    },
  };
  const downloadState = { backups: [] };
  const controls = { confirmDelete: true, sourceCalls: 0 };
  const vector = golden.requiredCases.find(
    ({ name }) => name === "requirement_mapping",
  );
  const app = createApp({
    document: documentObject,
    elements,
    hexagramData: new HexagramData(hexagramPayload),
    templateRepository: initialized.repository,
    byteSourceProvider:
      byteSourceProvider ??
      (withByteSource
        ? async () => {
            controls.sourceCalls += 1;
            return new ArrayByteSource(vector.inputBytes);
          }
        : null),
    clipboard,
    confirmAction: async () => controls.confirmDelete,
    downloadBackup: async (backup) => downloadState.backups.push(backup),
  });
  return {
    app,
    clipboardState,
    controls,
    documentObject,
    downloadState,
    elements,
    repository: initialized.repository,
    storage,
    vector,
  };
}

test("the static UI is UTF-8, accessible, one-column, and contains only stage 6 wiring", () => {
  assert.match(html, /<meta charset="UTF-8">/);
  assert.match(html, /viewport-fit=cover/);
  assert.match(css, /env\(safe-area-inset-top\)/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /touch-action: none/);
  assert.doesNotMatch(css, /1024px|768px/);

  for (const id of REQUIRED_ELEMENT_IDS) {
    assert.equal(
      (html.match(new RegExp(`id="${id}"`, "g")) ?? []).length,
      1,
      `${id} must appear exactly once`,
    );
  }
  for (const controlId of [
    "theme-input",
    "template-select",
    "template-management-select",
    "prompt-preview",
    "template-name-input",
    "template-body-input",
    "template-import-file",
  ]) {
    assert.match(html, new RegExp(`<label[^>]+for="${controlId}"`));
  }
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-describedby="template-import-summary"/);
  assert.doesNotMatch(html, /manifest|service-worker|固定結果/iu);
  assert.doesNotMatch(html, /履歴|保存先|重複警告|コイン|手入力/u);
  assert.match(html, /サイコロを振る代わりに/);
  assert.match(html, /強く振る必要はありません/);
  assert.match(html, /落としたり周囲へぶつけたりしないよう/);
  assert.doesNotMatch(appSource, /ArrayByteSource|Math\.random|URLSearchParams/);
  assert.match(appSource, /createPhysicalInputProvider/);
  assert.doesNotMatch(appSource, /navigator\.serviceWorker/);
});

test("bootstrap loads only same-origin static JSON and initializes templates", async () => {
  const documentObject = new FakeDocument();
  const storage = new MemoryStorage();
  const requestedPaths = [];
  const fetchImplementation = async (url) => {
    const path = new URL(url).pathname;
    requestedPaths.push(path);
    const text = path.endsWith("/hexagrams.json")
      ? JSON.stringify(hexagramPayload)
      : initialTemplateText;
    return { ok: true, status: 200, text: async () => text };
  };

  const app = await bootstrapApp({
    document: documentObject,
    fetchImplementation,
    storage,
    clipboard: { writeText: async () => {} },
    confirmAction: async () => false,
    downloadBackup: async () => {},
  });
  assert.equal(app.result, null);
  assert.deepEqual(
    requestedPaths
      .map((path) => path.split("/").slice(-2).join("/"))
      .sort(),
    ["data/hexagrams.json", "data/prompt_templates.json"],
  );
  assert.notEqual(storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), null);
  assert.match(
    documentObject.getElementById("app-status").textContent,
    /テーマを入力して「占う」/,
  );

  documentObject.getElementById("theme-input").value = "接続確認";
  assert.equal(await app.runFortune(), null);
  assert.equal(app.result, null);
  assert.equal(documentObject.getElementById("result-section").hidden, true);
  assert.equal(
    documentObject.getElementById("pointer-fallback-panel").hidden,
    false,
  );
  assert.match(
    documentObject.getElementById("pointer-fallback-reason").textContent,
    /DeviceMotion API/,
  );
});

test("production construction has no byte source and never generates a hidden fixed result", async () => {
  const { app, elements } = await createHarness();
  elements["theme-input"].value = "相談テーマ";
  assert.equal(await app.runFortune(), null);
  assert.equal(app.result, null);
  assert.equal(elements["result-section"].hidden, true);
  assert.match(elements["fortune-status"].textContent, /結果は生成していません/);
});

test("the production physical provider reaches result and Prompt only after physical input", async () => {
  const vector = golden.requiredCases.find(
    ({ name }) => name === "requirement_mapping",
  );
  const physicalBlock = Uint8Array.from({ length: 32 }, (_, index) => index * 5);
  const desiredMixed = new Uint8Array(32);
  desiredMixed.set(vector.inputBytes);
  const cryptoBlock = Uint8Array.from(
    physicalBlock,
    (value, index) => value ^ desiredMixed[index],
  );
  const observed = { permissionCalls: 0, randomCalls: 0, states: [] };
  const physicalProvider = createPhysicalInputProvider({
    requestMotionPermissionImplementation: async () => {
      observed.permissionCalls += 1;
      return "granted";
    },
    collectMotionSamplesImplementation: async ({ onState }) => {
      onState("waiting-for-motion");
      onState("collecting-motion", { sampleCount: 1 });
      return [{
        sequence: 0,
        timeStamp: 1000,
        relativeTime: 0,
        deltaTime: 0,
        interval: 16,
        accelerationX: 1,
        accelerationY: 0,
        accelerationZ: 0,
        gravityX: 0,
        gravityY: 0,
        gravityZ: 9.80665,
        rotationAlpha: 0,
        rotationBeta: 0,
        rotationGamma: 8,
      }];
    },
    digestImplementation: async () => physicalBlock,
    randomBlockProvider: async () => {
      observed.randomCalls += 1;
      return cryptoBlock;
    },
  });
  const wrappedProvider = (options) => {
    const originalOnState = options.onState;
    return physicalProvider({
      ...options,
      onState(state, detail) {
        observed.states.push(state);
        originalOnState(state, detail);
      },
    });
  };
  const { app, elements } = await createHarness({
    byteSourceProvider: wrappedProvider,
  });
  elements["theme-input"].value = "物理入力接続";

  assert.equal(observed.randomCalls, 0);
  const result = await app.runFortune();
  assert.equal(observed.permissionCalls, 1);
  assert.equal(observed.randomCalls, 1);
  assert.deepEqual(
    observed.states,
    [
      "requesting-motion-permission",
      "waiting-for-motion",
      "collecting-motion",
      "mixing-physical-source",
    ],
  );
  assert.equal(result.primary, vector.primary);
  assert.equal(result.changed, vector.changed);
  assert.equal(elements["result-section"].hidden, false);
  assert.equal(elements["prompt-section"].hidden, false);
  assert.match(elements["prompt-preview"].value, /物理入力接続/);
  assert.match(elements["fortune-status"].textContent, /完了/);
});

test("pointer fallback is explicit and motion shortage stays on motion retry", async () => {
  const vector = golden.requiredCases.find(
    ({ name }) => name === "requirement_mapping",
  );
  const modes = [];
  const fallbackProvider = async ({ mode }) => {
    modes.push(mode);
    if (mode === "motion") {
      throw Object.assign(new Error("モーション値を取得できません。"), {
        code: "values-unavailable",
        fallbackAllowed: true,
      });
    }
    return new ArrayByteSource(vector.inputBytes);
  };
  const fallbackHarness = await createHarness({
    byteSourceProvider: fallbackProvider,
  });
  assert.equal(await fallbackHarness.app.runFortune(), null);
  assert.deepEqual(modes, ["motion"]);
  assert.equal(
    fallbackHarness.elements["pointer-fallback-panel"].hidden,
    false,
  );
  assert.match(
    fallbackHarness.elements["pointer-fallback-reason"].textContent,
    /モーション値/,
  );
  const pointerResult = await fallbackHarness.app.runPointerFortune();
  assert.equal(pointerResult.primary, vector.primary);
  assert.deepEqual(modes, ["motion", "pointer"]);

  const retryHarness = await createHarness({
    byteSourceProvider: async () => {
      throw Object.assign(new Error("sample数が不足しています。"), {
        code: "sample-insufficient",
        retryRecommended: true,
        fallbackAllowed: false,
      });
    },
  });
  assert.equal(await retryHarness.app.runFortune(), null);
  assert.equal(retryHarness.elements["pointer-fallback-panel"].hidden, true);
  assert.match(retryHarness.elements["fortune-status"].textContent, /再試行/);
});

test("double execution is blocked while physical input is pending", async () => {
  const vector = golden.requiredCases.find(
    ({ name }) => name === "requirement_mapping",
  );
  let releaseSource;
  let providerCalls = 0;
  const provider = async () => {
    providerCalls += 1;
    return new Promise((resolve) => {
      releaseSource = () => resolve(new ArrayByteSource(vector.inputBytes));
    });
  };
  const { app, elements } = await createHarness({ byteSourceProvider: provider });
  const first = app.runFortune();
  assert.equal(elements["fortune-button"].disabled, true);
  assert.equal(await app.runFortune(), null);
  assert.equal(providerCalls, 1);
  releaseSource();
  assert.notEqual(await first, null);
  assert.equal(elements["fortune-button"].disabled, false);
});

test("test-only injected bytes render the Python result, six lines, descriptions, and Prompt", async () => {
  const harness = await createHarness({ withByteSource: true });
  const { app, controls, elements, repository, vector } = harness;
  elements["theme-input"].value = "　検討テーマ　";
  const result = await app.runFortune();

  assert.equal(controls.sourceCalls, 1);
  assert.equal(result.theme, "検討テーマ");
  assert.equal(result.primary, vector.primary);
  assert.equal(result.var_kanji, vector.var_kanji);
  assert.equal(result.changed, vector.changed);
  assert.equal(elements["result-section"].hidden, false);
  assert.equal(elements["prompt-section"].hidden, false);
  assert.equal(elements["primary-name"].textContent, vector.primary);
  assert.equal(elements["changing-label"].textContent, vector.var_kanji);
  assert.equal(elements["changed-name"].textContent, vector.changed);

  const expectedLineIndexes = [5, 4, 3, 2, 1, 0];
  for (const [containerId, expectedLines] of [
    ["primary-lines", vector.lines],
    ["changed-lines", vector.changedLines],
  ]) {
    const rendered = elements[containerId].children;
    assert.deepEqual(
      rendered.map(({ dataset }) => Number(dataset.lineIndex)),
      expectedLineIndexes,
    );
    for (const line of rendered) {
      const lineIndex = Number(line.dataset.lineIndex);
      const bit = expectedLines[lineIndex];
      assert.equal(Number(line.dataset.bit), bit);
      assert.equal(line.classList.contains(bit === 0 ? "yang" : "yin"), true);
      const segmentCount = line.children.filter((child) =>
        child.classList.contains("yao-segment"),
      ).length;
      assert.equal(segmentCount, bit === 0 ? 1 : 2);
    }
    const changingLines = rendered.filter((line) =>
      line.classList.contains("changing"),
    );
    assert.equal(changingLines.length, 1);
    assert.equal(changingLines[0].dataset.lineIndex, "4");
    assert.match(changingLines[0].getAttribute("aria-label"), /五爻.*変爻/);
  }

  const data = new HexagramData(hexagramPayload);
  assert.equal(
    elements["primary-kaji"].textContent,
    data.getHexagramDescription(vector.primary).kaji,
  );
  assert.equal(
    elements["primary-yao"].textContent,
    data.getPrimaryYaoDescription(vector.primary, vector.changing_idx).yao,
  );
  assert.equal(
    elements["changed-kaji"].textContent,
    data.getHexagramDescription(vector.changed).kaji,
  );

  const selected = repository.snapshot();
  assert.equal(
    elements["prompt-preview"].value,
    makeInterpretPrompt(result, selected.templates[selected.selected]),
  );
});

test("template changes regenerate the current Prompt while copy uses the edited preview", async () => {
  const harness = await createHarness({ withByteSource: true });
  const { app, clipboardState, elements, repository } = harness;
  elements["theme-input"].value = "購入判断";
  await app.runFortune();

  assert.equal(app.selectTemplate("資産購入判断"), true);
  let payload = repository.snapshot();
  assert.equal(payload.selected, "資産購入判断");
  assert.equal(
    elements["prompt-preview"].value,
    makeInterpretPrompt(app.result, payload.templates[payload.selected]),
  );

  elements["template-body-input"].value =
    "編集版\n{theme}／{primary}／{var_kanji}／{changed} {{確認}}";
  assert.equal(app.saveTemplateBody(), true);
  assert.equal(
    elements["prompt-preview"].value,
    "編集版\n購入判断／山火賁／五爻／風火家人 {確認}",
  );

  const manuallyEdited = `${elements["prompt-preview"].value}\n利用者追記「このままコピー」`;
  elements["prompt-preview"].value = manuallyEdited;
  assert.equal(await app.copyPrompt(), true);
  assert.deepEqual(clipboardState.texts, [manuallyEdited]);

  clipboardState.fail = true;
  assert.equal(await app.copyPrompt(), false);
  assert.equal(elements["prompt-preview"].value, manuallyEdited);
  assert.equal(elements["prompt-preview"].focused, true);
  assert.equal(elements["prompt-preview"].selected, true);
  assert.match(elements["copy-status"].textContent, /手動でコピー/);
});

test("template CRUD and two-step backup import work through UI actions", async () => {
  const harness = await createHarness();
  const {
    app,
    controls,
    downloadState,
    elements,
    repository,
    storage,
  } = harness;
  elements["template-management-select"].value = "資産購入判断";
  await elements["template-management-select"].dispatch("change");
  assert.equal(repository.snapshot().selected, "資産購入判断");
  assert.equal(elements["template-select"].value, "資産購入判断");

  elements["template-name-input"].value = "　相談用　";
  elements["template-body-input"].value =
    "一行目「引用」\n二行目　{{波括弧}} {theme}";
  assert.equal(app.addTemplate(), true);
  assert.equal(repository.snapshot().selected, "相談用");

  elements["template-name-input"].value = "相談用・改";
  assert.equal(app.renameTemplate(), true);
  elements["template-body-input"].value = "更新本文 {primary}{var_kanji} {changed}";
  assert.equal(app.saveTemplateBody(), true);
  assert.equal(
    repository.snapshot().templates["相談用・改"],
    "更新本文 {primary}{var_kanji} {changed}",
  );

  controls.confirmDelete = false;
  assert.equal(await app.deleteTemplate(), false);
  assert.equal("相談用・改" in repository.snapshot().templates, true);
  controls.confirmDelete = true;
  assert.equal(await app.deleteTemplate(), true);
  assert.equal("相談用・改" in repository.snapshot().templates, false);

  const backup = await app.exportTemplates();
  assert.equal(downloadState.backups.length, 1);
  assert.equal(downloadState.backups[0].text, backup.text);

  const importPayload = {
    schemaVersion: 1,
    selected: "導入テンプレート",
    templates: {
      "導入テンプレート": "導入\n{theme}「引用」{{文字}}",
    },
  };
  elements["template-import-file"].files = [
    { text: async () => `${JSON.stringify(importPayload, null, 2)}\n` },
  ];
  const beforePrepare = storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY);
  const summary = await app.prepareImport();
  assert.deepEqual(summary, { templateCount: 1, selected: "導入テンプレート" });
  assert.equal(storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), beforePrepare);
  assert.equal(elements["template-import-summary"].hidden, false);
  assert.equal(elements["template-import-apply-button"].disabled, false);

  assert.equal(app.applyImport(), true);
  assert.deepEqual(repository.snapshot(), importPayload);
  assert.equal(elements["template-import-apply-button"].disabled, true);
  assert.equal(elements["template-select"].value, "導入テンプレート");

  const validBackup = createTemplateBackup(repository.snapshot());
  elements["template-import-file"].files = [
    { text: async () => validBackup.text.replace('"schemaVersion": 1', '"schemaVersion": 2') },
  ];
  const beforeInvalid = storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY);
  assert.equal(await app.prepareImport(), null);
  assert.equal(storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), beforeInvalid);
});
