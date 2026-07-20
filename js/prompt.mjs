import { pythonStrip } from "./domain.mjs";

export const SUPPORTED_PROMPT_PLACEHOLDERS = Object.freeze([
  "theme",
  "primary",
  "var_kanji",
  "changed",
]);

export const DEFAULT_PROMPT_TEMPLATE =
  "{theme}について占ったところ、本卦：{primary}{var_kanji}（之卦：{changed}）を得ました。どう解釈すべきでしょうか？";

const SUPPORTED_PLACEHOLDERS = new Set(SUPPORTED_PROMPT_PLACEHOLDERS);

function promptValue(result, placeholder) {
  const value = result[placeholder];
  return value === undefined || value === null ? "" : String(value);
}

export function formatPromptTemplate(template, result) {
  if (typeof template !== "string") {
    throw new TypeError("template must be a string");
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new TypeError("result must be an object");
  }

  let output = "";
  let index = 0;
  while (index < template.length) {
    const character = template[index];
    if (character === "{") {
      if (template[index + 1] === "{") {
        output += "{";
        index += 2;
        continue;
      }
      const closingIndex = template.indexOf("}", index + 1);
      if (closingIndex === -1) {
        throw new Error("対応していない単独の波括弧があります。");
      }
      const placeholder = template.slice(index + 1, closingIndex);
      if (!SUPPORTED_PLACEHOLDERS.has(placeholder)) {
        throw new Error(`未対応のプレースホルダです: ${placeholder}`);
      }
      output += promptValue(result, placeholder);
      index = closingIndex + 1;
      continue;
    }
    if (character === "}") {
      if (template[index + 1] === "}") {
        output += "}";
        index += 2;
        continue;
      }
      throw new Error("対応していない単独の波括弧があります。");
    }
    output += character;
    index += 1;
  }
  return output;
}

export function makeInterpretPrompt(
  result,
  template,
  defaultTemplate = DEFAULT_PROMPT_TEMPLATE,
) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length === 0
  ) {
    throw new Error("先に占ってください。");
  }
  if (typeof template !== "string" || typeof defaultTemplate !== "string") {
    throw new TypeError("template must be a string");
  }

  const strippedTemplate = pythonStrip(template);
  const format = strippedTemplate || defaultTemplate;
  return formatPromptTemplate(format, result);
}
