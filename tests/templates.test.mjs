import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  getPromptTemplateHelp,
  validatePromptTemplate,
} from "../js/prompt.mjs";
import {
  PROMPT_TEMPLATE_BACKUP_FILENAME,
  PROMPT_TEMPLATE_SCHEMA_VERSION,
  PROMPT_TEMPLATE_STORAGE_KEY,
  TemplateConfirmationError,
  TemplateCorruptionError,
  TemplateLoadError,
  TemplateOperationError,
  TemplateRepository,
  TemplateStorageError,
  TemplateValidationError,
  createTemplateBackup,
  initializeTemplateRepository,
  loadInitialTemplatePayload,
  parseInitialTemplateJson,
  prepareTemplateImport,
  readStoredTemplatePayload,
  writeStoredTemplatePayload,
} from "../js/templates.mjs";

const initialText = await readFile(
  new URL("../data/prompt_templates.json", import.meta.url),
  "utf8",
);
const initialPayload = parseInitialTemplateJson(initialText);

class MemoryStorage {
  constructor(entries = {}) {
    this.values = new Map(
      Object.entries(entries).map(([key, value]) => [key, String(value)]),
    );
    this.getCalls = 0;
    this.setCalls = 0;
    this.failGet = null;
    this.failSet = null;
  }

  getItem(key) {
    this.getCalls += 1;
    if (this.failGet) {
      throw this.failGet;
    }
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.setCalls += 1;
    if (this.failSet) {
      throw this.failSet;
    }
    this.values.set(key, String(value));
  }
}

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

async function initialize(storage = new MemoryStorage()) {
  const initialized = await initializeTemplateRepository({
    storage,
    loadInitial: async () => initialPayload,
  });
  return { storage, ...initialized };
}

test("unversioned distribution JSON is validated and saved as schema version 1", async () => {
  const storage = new MemoryStorage();
  const { source, repository } = await initialize(storage);
  assert.equal(source, "initial");
  assert.equal(initialPayload.schemaVersion, PROMPT_TEMPLATE_SCHEMA_VERSION);
  assert.equal(initialPayload.selected, "標準");
  assert.equal(Object.keys(initialPayload.templates).length, 2);

  const stored = JSON.parse(storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY));
  assert.deepEqual(Object.keys(stored).sort(), [
    "schemaVersion",
    "selected",
    "templates",
  ]);
  assert.deepEqual(repository.snapshot(), stored);
});

test("an existing localStorage payload wins over updated static defaults", async () => {
  const storage = new MemoryStorage();
  const userPayload = {
    schemaVersion: 1,
    selected: "利用者版",
    templates: { "利用者版": "利用者の本文 {theme}" },
  };
  writeStoredTemplatePayload(storage, userPayload);
  const writesBeforeInitialization = storage.setCalls;
  let initialLoadCalls = 0;

  const initialized = await initializeTemplateRepository({
    storage,
    loadInitial: async () => {
      initialLoadCalls += 1;
      return {
        schemaVersion: 1,
        selected: "更新版",
        templates: { "更新版": "上書きしてはいけない" },
      };
    },
  });

  assert.equal(initialized.source, "storage");
  assert.equal(initialLoadCalls, 0);
  assert.equal(storage.setCalls, writesBeforeInitialization);
  assert.deepEqual(initialized.repository.snapshot(), userPayload);
});

test("CRUD normalizes only name edges and trailing body whitespace, then persists", async () => {
  const { storage, repository } = await initialize();
  const specialBody =
    "一行目「引用」\n二行目　{{波括弧}} {theme} {primary} {var_kanji} {changed}  \n\t";

  repository.addTemplate("　仕事相談　", specialBody);
  assert.equal(
    repository.snapshot().templates["仕事相談"],
    "一行目「引用」\n二行目　{{波括弧}} {theme} {primary} {var_kanji} {changed}",
  );
  repository.selectTemplate("仕事相談");
  repository.renameTemplate("仕事相談", "　重要相談　");
  assert.equal(repository.snapshot().selected, "重要相談");
  repository.editTemplate(
    "重要相談",
    "編集後\n『日本語』 {{ と }} {theme}",
  );
  assert.equal(
    JSON.parse(storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY)).selected,
    "重要相談",
  );

  const beforeUnconfirmedDelete = storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY);
  assert.throws(
    () => repository.deleteTemplate("重要相談"),
    TemplateConfirmationError,
  );
  assert.equal(storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), beforeUnconfirmedDelete);

  repository.deleteTemplate("重要相談", { confirmed: true });
  assert.equal(repository.snapshot().selected, "標準");
  repository.deleteTemplate("資産購入判断", { confirmed: true });
  assert.throws(
    () => repository.deleteTemplate("標準", { confirmed: true }),
    TemplateOperationError,
  );

  const reloaded = await initializeTemplateRepository({
    storage,
    loadInitial: async () => {
      throw new Error("stored data should be used");
    },
  });
  assert.deepEqual(reloaded.repository.snapshot(), repository.snapshot());

  const unchanged = storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY);
  assert.throws(() => repository.addTemplate("　", "本文"), TemplateValidationError);
  assert.throws(() => repository.addTemplate("標準", "本文"), TemplateOperationError);
  assert.throws(
    () => repository.editTemplate("標準", "{unsupported}"),
    TemplateValidationError,
  );
  assert.throws(() => repository.selectTemplate("不存在"), TemplateOperationError);
  assert.equal(storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), unchanged);
});

test("backup export and confirmed import preserve Japanese text code point for code point", async () => {
  const source = await initialize();
  const body =
    "日本語の一行目「引用」\n二行目　{{literal}} {theme}\n三行目 {primary}{var_kanji}→{changed}";
  source.repository.addTemplate("旧字体・新字体", body);
  source.repository.selectTemplate("旧字体・新字体");
  const backup = createTemplateBackup(source.repository.snapshot());

  assert.equal(backup.filename, PROMPT_TEMPLATE_BACKUP_FILENAME);
  assert.match(backup.mimeType, /^application\/json/);
  assert.doesNotMatch(backup.text, /\\u[0-9a-fA-F]{4}/);
  const exported = JSON.parse(backup.text);
  assert.deepEqual(Object.keys(exported).sort(), [
    "schemaVersion",
    "selected",
    "templates",
  ]);
  assert.equal(exported.templates["旧字体・新字体"], body);

  const target = await initialize();
  const beforeImport = target.storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY);
  const prepared = prepareTemplateImport(backup.text);
  assert.equal(prepared.summary.templateCount, 3);
  assert.equal(prepared.summary.selected, "旧字体・新字体");
  assert.equal(target.storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), beforeImport);
  assert.throws(
    () => target.repository.applyPreparedImport(prepared),
    TemplateConfirmationError,
  );
  assert.equal(target.storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), beforeImport);

  target.repository.applyPreparedImport(prepared, { confirmed: true });
  assert.deepEqual(target.repository.snapshot(), source.repository.snapshot());
  assert.deepEqual(
    [...target.repository.snapshot().templates["旧字体・新字体"]],
    [...body],
  );
  assert.equal(
    createTemplateBackup(target.repository.snapshot()).text,
    backup.text,
  );
});

test("invalid imports are fully rejected before any localStorage change", async () => {
  const target = await initialize();
  const before = target.storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY);
  const invalidPayloads = [
    "{",
    JSON.stringify({ selected: "標準", templates: { "標準": "{theme}" } }),
    JSON.stringify({ schemaVersion: 2, selected: "標準", templates: { "標準": "{theme}" } }),
    JSON.stringify({ schemaVersion: 1, selected: "標準", templates: {} }),
    JSON.stringify({ schemaVersion: 1, selected: "不存在", templates: { "標準": "{theme}" } }),
    JSON.stringify({ schemaVersion: 1, selected: "標準", templates: { "標準": 1 } }),
    JSON.stringify({ schemaVersion: 1, selected: "標準", templates: { "標準": "{unknown}" } }),
    JSON.stringify({
      schemaVersion: 1,
      selected: "標準",
      templates: { "標準": "{theme}", "　標準　": "{primary}" },
    }),
    JSON.stringify({
      schemaVersion: 1,
      selected: "標準",
      templates: { "標準": "{theme}" },
      history: [],
    }),
    '{"schemaVersion":1,"selected":"標準","templates":{"標準":"{theme}","標準":"{primary}"}}',
  ];

  for (const text of invalidPayloads) {
    assert.throws(() => prepareTemplateImport(text), TemplateValidationError);
    assert.equal(target.storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY), before);
  }
});

test("raw JSON duplicate detection decodes keys and does not inspect string contents", () => {
  const escapedDuplicate =
    '{"schemaVersion":1,"selected":"標準","templates":{"標準":"{theme}","\\u6a19\\u6e96":"{primary}"}}';
  assert.throws(
    () => prepareTemplateImport(escapedDuplicate),
    TemplateValidationError,
  );

  const apparentDuplicateInsideBody = JSON.stringify({
    schemaVersion: 1,
    selected: "標準",
    templates: {
      "標準": '本文内の文字列: "標準":"A", "標準":"B" {theme}',
    },
  });
  const prepared = prepareTemplateImport(apparentDuplicateInsideBody);
  assert.equal(prepared.summary.templateCount, 1);
});

test("corrupt reads and SecurityError or QuotaExceededError never overwrite state", async () => {
  const corruptStorage = new MemoryStorage({
    [PROMPT_TEMPLATE_STORAGE_KEY]: "{broken",
  });
  let initialLoadCalls = 0;
  await assert.rejects(
    initializeTemplateRepository({
      storage: corruptStorage,
      loadInitial: async () => {
        initialLoadCalls += 1;
        return initialPayload;
      },
    }),
    TemplateCorruptionError,
  );
  assert.equal(initialLoadCalls, 0);
  assert.equal(corruptStorage.setCalls, 0);
  assert.equal(corruptStorage.values.get(PROMPT_TEMPLATE_STORAGE_KEY), "{broken");

  const unreadableStorage = new MemoryStorage();
  unreadableStorage.failGet = namedError("SecurityError", "blocked");
  await assert.rejects(
    initializeTemplateRepository({
      storage: unreadableStorage,
      loadInitial: async () => initialPayload,
    }),
    TemplateStorageError,
  );
  assert.equal(unreadableStorage.setCalls, 0);

  const initialized = await initialize();
  const snapshotBeforeFailure = initialized.repository.snapshot();
  const rawBeforeFailure = initialized.storage.getItem(PROMPT_TEMPLATE_STORAGE_KEY);
  initialized.storage.failSet = namedError("QuotaExceededError", "full");
  assert.throws(
    () => initialized.repository.selectTemplate("資産購入判断"),
    TemplateStorageError,
  );
  assert.deepEqual(initialized.repository.snapshot(), snapshotBeforeFailure);
  assert.equal(
    initialized.storage.values.get(PROMPT_TEMPLATE_STORAGE_KEY),
    rawBeforeFailure,
  );

  const fullStorage = new MemoryStorage();
  fullStorage.failSet = namedError("QuotaExceededError", "full");
  await assert.rejects(
    initializeTemplateRepository({
      storage: fullStorage,
      loadInitial: async () => initialPayload,
    }),
    TemplateStorageError,
  );
  assert.equal(fullStorage.values.has(PROMPT_TEMPLATE_STORAGE_KEY), false);
});

test("initial JSON fetch reports transport, HTTP, and content errors", async () => {
  const loaded = await loadInitialTemplatePayload(
    "./data/prompt_templates.json",
    async (url) => {
      assert.equal(url, "./data/prompt_templates.json");
      return { ok: true, status: 200, text: async () => initialText };
    },
  );
  assert.deepEqual(loaded, initialPayload);

  await assert.rejects(
    loadInitialTemplatePayload("missing.json", async () => ({
      ok: false,
      status: 404,
      text: async () => "",
    })),
    TemplateLoadError,
  );
  await assert.rejects(
    loadInitialTemplatePayload("broken.json", async () => ({
      ok: true,
      status: 200,
      text: async () => "{",
    })),
    TemplateLoadError,
  );
  await assert.rejects(
    loadInitialTemplatePayload("unreadable.json", async () => ({
      ok: true,
      status: 200,
      text: async () => {
        throw new Error("read failed");
      },
    })),
    TemplateLoadError,
  );
  await assert.rejects(
    loadInitialTemplatePayload("offline.json", async () => {
      throw new Error("offline");
    }),
    TemplateLoadError,
  );
});

test("placeholder help exposes exactly four supported values and brace escaping", () => {
  const help = getPromptTemplateHelp();
  assert.deepEqual(
    help.placeholders.map(({ placeholder }) => placeholder),
    ["{theme}", "{primary}", "{var_kanji}", "{changed}"],
  );
  for (const entry of help.placeholders) {
    assert.equal(typeof entry.label, "string");
    assert.notEqual(entry.label, "");
    assert.equal(typeof entry.description, "string");
    assert.notEqual(entry.description, "");
  }
  assert.match(help.braceEscape.syntax, /\{\{/);
  assert.equal(validatePromptTemplate("{{文字}} {theme}"), true);
  assert.throws(() => validatePromptTemplate("{theme:>10}"));
});

test("storage and backup schemas contain no history or physical-input fields", () => {
  const storage = new MemoryStorage();
  writeStoredTemplatePayload(storage, initialPayload);
  const stored = readStoredTemplatePayload(storage);
  const backup = JSON.parse(createTemplateBackup(stored).text);
  for (const payload of [stored, backup]) {
    assert.deepEqual(Object.keys(payload).sort(), [
      "schemaVersion",
      "selected",
      "templates",
    ]);
    for (const forbidden of [
      "history",
      "theme",
      "result",
      "lines",
      "sensor",
      "motion",
      "pointer",
      "timestamp",
    ]) {
      assert.equal(Object.prototype.hasOwnProperty.call(payload, forbidden), false);
    }
  }
});
