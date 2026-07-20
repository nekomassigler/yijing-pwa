export const CHANGE_INDEX_TO_LINE_INDEX = Object.freeze([5, 0, 1, 2, 3, 4]);
export const CHANGE_INDEX_TO_LABEL = Object.freeze([
  "上爻",
  "初爻",
  "二爻",
  "三爻",
  "四爻",
  "五爻",
]);

const PYTHON_WHITESPACE =
  "[\\u0009-\\u000d\\u001c-\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PYTHON_STRIP_PATTERN = new RegExp(
  `^${PYTHON_WHITESPACE}+|${PYTHON_WHITESPACE}+$`,
  "g",
);

export function pythonStrip(value) {
  if (typeof value !== "string") {
    throw new TypeError("value must be a string");
  }
  return value.replace(PYTHON_STRIP_PATTERN, "");
}

function validateLines(lines) {
  if (!Array.isArray(lines) && !(lines instanceof Uint8Array)) {
    throw new TypeError("yin_yang must be an array");
  }
  if (lines.length !== 6) {
    throw new RangeError("yin_yang must be length 6");
  }
  if (Array.from(lines).some((bit) => bit !== 0 && bit !== 1)) {
    throw new RangeError("yin_yang must contain only 0 or 1");
  }
}

export function changingIndexToLineIndex(changingIndex) {
  if (!Number.isInteger(changingIndex) || changingIndex < 0 || changingIndex > 5) {
    throw new RangeError("changing_index must be 0-5");
  }
  return CHANGE_INDEX_TO_LINE_INDEX[changingIndex];
}

export function changingIndexToLabel(changingIndex) {
  if (!Number.isInteger(changingIndex) || changingIndex < 0 || changingIndex > 5) {
    throw new RangeError("changing_index must be 0-5");
  }
  return CHANGE_INDEX_TO_LABEL[changingIndex];
}

export class Hexagram {
  constructor(yinYang) {
    validateLines(yinYang);
    this.yinYang = Array.from(yinYang);
  }

  static toId(lines) {
    validateLines(lines);
    const lower = lines[0] * 4 + lines[1] * 2 + lines[2];
    const upper = lines[3] * 4 + lines[4] * 2 + lines[5];
    return lower * 8 + upper;
  }

  toId() {
    return Hexagram.toId(this.yinYang);
  }

  name(getHexagramName) {
    if (typeof getHexagramName !== "function") {
      throw new TypeError("getHexagramName must be a function");
    }
    return getHexagramName(this.toId());
  }

  changed(changingIndex) {
    const lineIndex = changingIndexToLineIndex(changingIndex);
    const changedLines = this.yinYang.slice();
    changedLines[lineIndex] = 1 - changedLines[lineIndex];
    return new Hexagram(changedLines);
  }
}

export function createFortuneResult(theme, lines, changingIndex, getHexagramName) {
  if (typeof theme !== "string") {
    throw new TypeError("theme must be a string");
  }

  const primaryHexagram = new Hexagram(lines);
  const changedHexagram = primaryHexagram.changed(changingIndex);
  return {
    theme: pythonStrip(theme),
    lines: primaryHexagram.yinYang.slice(),
    primary: primaryHexagram.name(getHexagramName),
    changed: changedHexagram.name(getHexagramName),
    var_kanji: changingIndexToLabel(changingIndex),
    changing_idx: changingIndex,
  };
}
