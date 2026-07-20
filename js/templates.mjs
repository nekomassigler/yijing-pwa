import { pythonStrip } from "./domain.mjs";
import { validatePromptTemplate } from "./prompt.mjs";

export const PROMPT_TEMPLATE_SCHEMA_VERSION = 1;
export const PROMPT_TEMPLATE_STORAGE_KEY = "yijing.pwa.promptTemplates.v1";
export const PROMPT_TEMPLATE_BACKUP_FILENAME = "yijing-prompt-templates.json";
export const PROMPT_TEMPLATE_BACKUP_MIME_TYPE =
  "application/json;charset=UTF-8";

const ROOT_FIELDS = Object.freeze(["schemaVersion", "selected", "templates"]);
const INITIAL_ROOT_FIELDS = Object.freeze(["selected", "templates"]);
const PREPARED_IMPORT = Symbol("preparedTemplateImport");
const PYTHON_TRAILING_WHITESPACE =
  /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clonePayload(payload) {
  return {
    schemaVersion: payload.schemaVersion,
    selected: payload.selected,
    templates: Object.fromEntries(Object.entries(payload.templates)),
  };
}

function freezePayload(payload) {
  Object.freeze(payload.templates);
  return Object.freeze(payload);
}

function exactFields(object, expectedFields) {
  const actual = Object.keys(object).sort();
  const expected = [...expectedFields].sort();
  return (
    actual.length === expected.length &&
    actual.every((field, index) => field === expected[index])
  );
}

export class TemplateError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class TemplateValidationError extends TemplateError {}
export class TemplateOperationError extends TemplateError {}
export class TemplateConfirmationError extends TemplateError {}
export class TemplateStorageError extends TemplateError {}
export class TemplateCorruptionError extends TemplateStorageError {}
export class TemplateLoadError extends TemplateError {}

function normalizeName(name) {
  if (typeof name !== "string") {
    throw new TemplateValidationError("テンプレート名は文字列で指定してください。");
  }
  const normalized = pythonStrip(name);
  if (!normalized) {
    throw new TemplateValidationError("テンプレート名を入力してください。");
  }
  return normalized;
}

function normalizeBody(body, name = "テンプレート") {
  if (typeof body !== "string") {
    throw new TemplateValidationError(`${name}の本文は文字列で指定してください。`);
  }
  const normalized = body.replace(PYTHON_TRAILING_WHITESPACE, "");
  try {
    validatePromptTemplate(normalized);
  } catch (error) {
    throw new TemplateValidationError(
      `${name}の本文を保存できません: ${error.message}`,
      { cause: error },
    );
  }
  return normalized;
}

function assertNoDuplicateJsonKeys(text) {
  let index = 0;

  const fail = (message) => {
    throw new TemplateValidationError(message);
  };
  const skipWhitespace = () => {
    while (/[\u0009\u000a\u000d\u0020]/.test(text[index] ?? "")) {
      index += 1;
    }
  };
  const parseString = () => {
    if (text[index] !== '"') {
      fail("JSONの文字列を読み取れませんでした。");
    }
    const start = index;
    index += 1;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
        continue;
      }
      if (text[index] === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      index += 1;
    }
    fail("JSONの文字列が閉じられていません。");
  };
  const parseValue = () => {
    skipWhitespace();
    if (text[index] === "{") {
      index += 1;
      skipWhitespace();
      const keys = new Set();
      if (text[index] === "}") {
        index += 1;
        return;
      }
      while (index < text.length) {
        const key = parseString();
        if (keys.has(key)) {
          fail(`JSON内に同名の項目があります: ${key}`);
        }
        keys.add(key);
        skipWhitespace();
        if (text[index] !== ":") {
          fail("JSON objectの区切りが不正です。");
        }
        index += 1;
        parseValue();
        skipWhitespace();
        if (text[index] === "}") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          fail("JSON objectの区切りが不正です。");
        }
        index += 1;
        skipWhitespace();
      }
      fail("JSON objectが閉じられていません。");
    }
    if (text[index] === "[") {
      index += 1;
      skipWhitespace();
      if (text[index] === "]") {
        index += 1;
        return;
      }
      while (index < text.length) {
        parseValue();
        skipWhitespace();
        if (text[index] === "]") {
          index += 1;
          return;
        }
        if (text[index] !== ",") {
          fail("JSON arrayの区切りが不正です。");
        }
        index += 1;
      }
      fail("JSON arrayが閉じられていません。");
    }
    if (text[index] === '"') {
      parseString();
      return;
    }
    const remainder = text.slice(index);
    const primitive = remainder.match(
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
    );
    if (!primitive) {
      fail("JSONの値を読み取れませんでした。");
    }
    index += primitive[0].length;
  };

  parseValue();
  skipWhitespace();
  if (index !== text.length) {
    fail("JSON末尾に余分なデータがあります。");
  }
}

export function validateTemplatePayload(rawPayload, { allowUnversioned = false } = {}) {
  if (!isRecord(rawPayload)) {
    throw new TemplateValidationError("テンプレートデータのルートはobjectである必要があります。");
  }

  const hasSchemaVersion = hasOwn(rawPayload, "schemaVersion");
  const expectedFields = hasSchemaVersion ? ROOT_FIELDS : INITIAL_ROOT_FIELDS;
  if (!hasSchemaVersion && !allowUnversioned) {
    throw new TemplateValidationError("schemaVersionがありません。");
  }
  if (!exactFields(rawPayload, expectedFields)) {
    throw new TemplateValidationError("テンプレートデータに未対応の項目があります。");
  }
  if (
    hasSchemaVersion &&
    rawPayload.schemaVersion !== PROMPT_TEMPLATE_SCHEMA_VERSION
  ) {
    throw new TemplateValidationError(
      `未対応のschemaVersionです: ${rawPayload.schemaVersion}`,
    );
  }
  if (!isRecord(rawPayload.templates)) {
    throw new TemplateValidationError("templatesはobjectである必要があります。");
  }

  const entries = [];
  const normalizedNames = new Set();
  for (const [rawName, rawBody] of Object.entries(rawPayload.templates)) {
    const name = normalizeName(rawName);
    if (normalizedNames.has(name)) {
      throw new TemplateValidationError(`同名テンプレートがあります: ${name}`);
    }
    normalizedNames.add(name);
    entries.push([name, normalizeBody(rawBody, name)]);
  }
  if (entries.length === 0) {
    throw new TemplateValidationError("テンプレートを1件以上登録してください。");
  }

  const selected = normalizeName(rawPayload.selected);
  if (!normalizedNames.has(selected)) {
    throw new TemplateValidationError("選択中のテンプレートがtemplates内にありません。");
  }

  return {
    schemaVersion: PROMPT_TEMPLATE_SCHEMA_VERSION,
    selected,
    templates: Object.fromEntries(entries),
  };
}

function parseTemplateJson(text, options = {}) {
  if (typeof text !== "string") {
    throw new TemplateValidationError("JSONは文字列で指定してください。");
  }

  assertNoDuplicateJsonKeys(text);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TemplateValidationError("テンプレートJSONを解析できませんでした。", {
      cause: error,
    });
  }
  return validateTemplatePayload(parsed, options);
}

export function parseInitialTemplateJson(text) {
  return parseTemplateJson(text, { allowUnversioned: true });
}

export async function loadInitialTemplatePayload(
  url,
  fetchImplementation = globalThis.fetch,
) {
  if (typeof fetchImplementation !== "function") {
    throw new TemplateLoadError("初期テンプレートを読み込むfetchが利用できません。");
  }

  let response;
  try {
    response = await fetchImplementation(url);
  } catch (error) {
    throw new TemplateLoadError("初期テンプレートの読込に失敗しました。", {
      cause: error,
    });
  }
  if (!response?.ok || typeof response.text !== "function") {
    throw new TemplateLoadError(
      `初期テンプレートの取得に失敗しました: ${response?.status ?? "unknown"}`,
    );
  }

  let text;
  try {
    text = await response.text();
  } catch (error) {
    throw new TemplateLoadError("初期テンプレート本文を読み込めませんでした。", {
      cause: error,
    });
  }
  try {
    return parseInitialTemplateJson(text);
  } catch (error) {
    throw new TemplateLoadError("初期テンプレートの内容が不正です。", {
      cause: error,
    });
  }
}

function resolveStorage(storage) {
  let target = storage;
  if (target === undefined) {
    try {
      target = globalThis.localStorage;
    } catch (error) {
      throw new TemplateStorageError("localStorageを利用できません。", {
        cause: error,
      });
    }
  }
  if (
    !target ||
    typeof target.getItem !== "function" ||
    typeof target.setItem !== "function"
  ) {
    throw new TemplateStorageError("localStorageを利用できません。");
  }
  return target;
}

export function readStoredTemplatePayload(
  storage,
  storageKey = PROMPT_TEMPLATE_STORAGE_KEY,
) {
  const target = resolveStorage(storage);
  let text;
  try {
    text = target.getItem(storageKey);
  } catch (error) {
    throw new TemplateStorageError("テンプレート保存データを読み込めませんでした。", {
      cause: error,
    });
  }
  if (text === null) {
    return null;
  }

  try {
    return parseTemplateJson(text);
  } catch (error) {
    throw new TemplateCorruptionError(
      "保存済みテンプレートが破損しています。自動的には上書きしません。",
      { cause: error },
    );
  }
}

export function writeStoredTemplatePayload(
  storage,
  payload,
  storageKey = PROMPT_TEMPLATE_STORAGE_KEY,
) {
  const target = resolveStorage(storage);
  const validated = validateTemplatePayload(payload);
  try {
    target.setItem(storageKey, JSON.stringify(validated));
  } catch (error) {
    throw new TemplateStorageError("テンプレートをlocalStorageへ保存できませんでした。", {
      cause: error,
    });
  }
  return clonePayload(validated);
}

export async function initializeTemplateRepository({
  storage,
  storageKey = PROMPT_TEMPLATE_STORAGE_KEY,
  loadInitial,
} = {}) {
  const target = resolveStorage(storage);
  const stored = readStoredTemplatePayload(target, storageKey);
  if (stored !== null) {
    return {
      source: "storage",
      repository: new TemplateRepository(target, stored, storageKey),
    };
  }
  if (typeof loadInitial !== "function") {
    throw new TemplateLoadError("初期テンプレートの読込処理が指定されていません。");
  }

  let initial;
  try {
    const loaded = await loadInitial();
    initial = validateTemplatePayload(loaded, { allowUnversioned: true });
  } catch (error) {
    if (error instanceof TemplateError) {
      throw error;
    }
    throw new TemplateLoadError("初期テンプレートの読込に失敗しました。", {
      cause: error,
    });
  }
  const persisted = writeStoredTemplatePayload(target, initial, storageKey);
  return {
    source: "initial",
    repository: new TemplateRepository(target, persisted, storageKey),
  };
}

export function createTemplateBackup(payload) {
  const validated = validateTemplatePayload(payload);
  return {
    filename: PROMPT_TEMPLATE_BACKUP_FILENAME,
    mimeType: PROMPT_TEMPLATE_BACKUP_MIME_TYPE,
    text: `${JSON.stringify(validated, null, 2)}\n`,
  };
}

export function prepareTemplateImport(text) {
  const payload = freezePayload(parseTemplateJson(text));
  const prepared = {
    payload,
    summary: Object.freeze({
      templateCount: Object.keys(payload.templates).length,
      selected: payload.selected,
    }),
  };
  Object.defineProperty(prepared, PREPARED_IMPORT, { value: true });
  return Object.freeze(prepared);
}

export class TemplateRepository {
  constructor(
    storage,
    payload,
    storageKey = PROMPT_TEMPLATE_STORAGE_KEY,
  ) {
    this.storage = resolveStorage(storage);
    this.storageKey = storageKey;
    this._payload = validateTemplatePayload(payload);
  }

  snapshot() {
    return clonePayload(this._payload);
  }

  _commit(candidate) {
    const persisted = writeStoredTemplatePayload(
      this.storage,
      candidate,
      this.storageKey,
    );
    this._payload = persisted;
    return this.snapshot();
  }

  addTemplate(name, body, { select = false } = {}) {
    const normalizedName = normalizeName(name);
    if (hasOwn(this._payload.templates, normalizedName)) {
      throw new TemplateOperationError("同名テンプレートは追加できません。");
    }
    const templates = Object.fromEntries([
      ...Object.entries(this._payload.templates),
      [normalizedName, normalizeBody(body, normalizedName)],
    ]);
    return this._commit({
      ...this._payload,
      selected: select ? normalizedName : this._payload.selected,
      templates,
    });
  }

  renameTemplate(currentName, newName) {
    if (!hasOwn(this._payload.templates, currentName)) {
      throw new TemplateOperationError("変更元のテンプレートがありません。");
    }
    const normalizedName = normalizeName(newName);
    if (
      normalizedName !== currentName &&
      hasOwn(this._payload.templates, normalizedName)
    ) {
      throw new TemplateOperationError("同名テンプレートへ変更できません。");
    }
    if (normalizedName === currentName) {
      return this.snapshot();
    }

    const templates = Object.fromEntries(
      Object.entries(this._payload.templates).map(([name, body]) =>
        name === currentName ? [normalizedName, body] : [name, body],
      ),
    );
    return this._commit({
      ...this._payload,
      selected:
        this._payload.selected === currentName
          ? normalizedName
          : this._payload.selected,
      templates,
    });
  }

  editTemplate(name, body) {
    if (!hasOwn(this._payload.templates, name)) {
      throw new TemplateOperationError("編集するテンプレートがありません。");
    }
    const templates = Object.fromEntries(
      Object.entries(this._payload.templates).map(([templateName, value]) =>
        templateName === name
          ? [templateName, normalizeBody(body, name)]
          : [templateName, value],
      ),
    );
    return this._commit({ ...this._payload, templates });
  }

  deleteTemplate(name, { confirmed = false } = {}) {
    if (!hasOwn(this._payload.templates, name)) {
      throw new TemplateOperationError("削除するテンプレートがありません。");
    }
    if (!confirmed) {
      throw new TemplateConfirmationError("テンプレート削除の確認が必要です。");
    }
    if (Object.keys(this._payload.templates).length === 1) {
      throw new TemplateOperationError("最後のテンプレートは削除できません。");
    }

    const templates = Object.fromEntries(
      Object.entries(this._payload.templates).filter(
        ([templateName]) => templateName !== name,
      ),
    );
    const selected =
      this._payload.selected === name
        ? Object.keys(templates)[0]
        : this._payload.selected;
    return this._commit({ ...this._payload, selected, templates });
  }

  selectTemplate(name) {
    if (!hasOwn(this._payload.templates, name)) {
      throw new TemplateOperationError("選択するテンプレートがありません。");
    }
    if (this._payload.selected === name) {
      return this.snapshot();
    }
    return this._commit({ ...this._payload, selected: name });
  }

  applyPreparedImport(prepared, { confirmed = false } = {}) {
    if (!prepared || prepared[PREPARED_IMPORT] !== true) {
      throw new TemplateValidationError("検証済みのimportデータではありません。");
    }
    const payload = validateTemplatePayload(prepared.payload);
    if (!confirmed) {
      throw new TemplateConfirmationError("テンプレートimportの確認が必要です。");
    }
    return this._commit(payload);
  }
}
