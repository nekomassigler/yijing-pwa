import { CHANGE_INDEX_TO_LABEL, changingIndexToLabel } from "./domain.mjs";

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireStringFields(entry, fields, context) {
  if (!isRecord(entry)) {
    throw new TypeError(`${context} must be an object`);
  }
  for (const field of fields) {
    if (typeof entry[field] !== "string") {
      throw new TypeError(`${context}.${field} must be a string`);
    }
  }
  for (const value of Object.values(entry)) {
    if (typeof value !== "string") {
      throw new TypeError(`${context} must contain only string values`);
    }
  }
}

export function validateHexagramPayload(payload) {
  if (!isRecord(payload) || payload.schemaVersion !== 1) {
    throw new TypeError("hexagram data schemaVersion must be 1");
  }
  if (!Array.isArray(payload.hexagrams) || payload.hexagrams.length !== 64) {
    throw new RangeError("hexagrams must contain 64 entries");
  }

  const names = new Set();
  const ids = new Set();
  for (const entry of payload.hexagrams) {
    if (
      !isRecord(entry) ||
      !Number.isInteger(entry.id) ||
      entry.id < 0 ||
      entry.id > 63 ||
      typeof entry.name !== "string"
    ) {
      throw new TypeError("invalid hexagram entry");
    }
    ids.add(entry.id);
    names.add(entry.name);
  }
  if (ids.size !== 64 || names.size !== 64) {
    throw new RangeError("hexagram IDs and names must be unique");
  }

  if (!isRecord(payload.descriptions) || Object.keys(payload.descriptions).length !== 64) {
    throw new RangeError("descriptions must contain 64 entries");
  }
  for (const [name, entry] of Object.entries(payload.descriptions)) {
    requireStringFields(entry, ["kaji", "other"], `descriptions.${name}`);
  }

  if (!isRecord(payload.yaoDescriptions) || Object.keys(payload.yaoDescriptions).length !== 64) {
    throw new RangeError("yaoDescriptions must contain 64 hexagrams");
  }
  let yaoCount = 0;
  for (const [name, table] of Object.entries(payload.yaoDescriptions)) {
    if (!isRecord(table)) {
      throw new TypeError(`yaoDescriptions.${name} must be an object`);
    }
    const positions = Object.keys(table);
    if (
      positions.length !== CHANGE_INDEX_TO_LABEL.length ||
      CHANGE_INDEX_TO_LABEL.some((position) => !hasOwn(table, position))
    ) {
      throw new RangeError(`yaoDescriptions.${name} must contain all six lines`);
    }
    for (const position of CHANGE_INDEX_TO_LABEL) {
      requireStringFields(
        table[position],
        ["yao", "other"],
        `yaoDescriptions.${name}.${position}`,
      );
      yaoCount += 1;
    }
  }
  if (yaoCount !== 384) {
    throw new RangeError("yaoDescriptions must contain 384 entries");
  }

  if (!isRecord(payload.aliases) || Object.keys(payload.aliases).length !== 5) {
    throw new RangeError("aliases must contain 5 entries");
  }
  for (const [name, alias] of Object.entries(payload.aliases)) {
    if (typeof name !== "string" || typeof alias !== "string") {
      throw new TypeError("aliases must contain only strings");
    }
  }
  return payload;
}

export function resolveHexagramTextKey(hexagramName, table, aliases = {}) {
  if (hasOwn(table, hexagramName)) {
    return hexagramName;
  }
  const alias = aliases[hexagramName];
  if (typeof alias === "string" && hasOwn(table, alias)) {
    return alias;
  }
  return hexagramName;
}

export class HexagramData {
  constructor(payload) {
    validateHexagramPayload(payload);
    this.payload = payload;
    this.namesById = new Map(
      payload.hexagrams.map(({ id, name }) => [id, name]),
    );
  }

  getHexagramName(id) {
    if (!Number.isInteger(id) || !this.namesById.has(id)) {
      throw new RangeError("hexagram id must be 0-63");
    }
    return this.namesById.get(id);
  }

  resolveHexagramTextKey(hexagramName, table) {
    return resolveHexagramTextKey(hexagramName, table, this.payload.aliases);
  }

  getHexagramDescription(hexagramName) {
    const key = this.resolveHexagramTextKey(
      hexagramName,
      this.payload.descriptions,
    );
    const data = this.payload.descriptions[key] ?? {};
    return {
      kaji: data.kaji ?? "(卦辞なし)",
      other: data.other ?? "(解説なし)",
    };
  }

  getPrimaryYaoDescription(hexagramName, changingIndex) {
    const key = this.resolveHexagramTextKey(
      hexagramName,
      this.payload.yaoDescriptions,
    );
    const position = changingIndexToLabel(changingIndex);
    const entry = this.payload.yaoDescriptions[key]?.[position] ?? {};
    return {
      position,
      yao: entry.yao ?? "(爻辞なし)",
      other: entry.other ?? "(解説なし)",
    };
  }
}

export function parseHexagramData(text) {
  if (typeof text !== "string") {
    throw new TypeError("hexagram JSON must be a string");
  }
  return new HexagramData(JSON.parse(text));
}

export async function loadHexagramData(url, fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== "function") {
    throw new TypeError("fetch is not available");
  }
  const response = await fetchImplementation(url);
  if (!response.ok) {
    throw new Error(`hexagram data request failed: ${response.status}`);
  }
  return parseHexagramData(await response.text());
}
