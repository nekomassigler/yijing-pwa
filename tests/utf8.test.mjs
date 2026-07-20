import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { pythonStrip } from "../js/domain.mjs";
import {
  DEFAULT_PROMPT_TEMPLATE,
  formatPromptTemplate,
  makeInterpretPrompt,
} from "../js/prompt.mjs";

const hexagramsUrl = new URL("../data/hexagrams.json", import.meta.url);
const templatesUrl = new URL("../data/prompt_templates.json", import.meta.url);
const goldenUrl = new URL("./golden_vectors.json", import.meta.url);
const [hexagramsText, templatesText, goldenText] = await Promise.all([
  readFile(hexagramsUrl, "utf8"),
  readFile(templatesUrl, "utf8"),
  readFile(goldenUrl, "utf8"),
]);
const templatesPayload = JSON.parse(templatesText);
const golden = JSON.parse(goldenText);

test("generated JSON stays readable UTF-8 without BOM or unicode escape output", () => {
  for (const text of [hexagramsText, templatesText, goldenText]) {
    assert.equal(text.startsWith("\uFEFF"), false);
    assert.match(text, /[一-龠ぁ-んァ-ヶ]/u);
    assert.doesNotMatch(text, /\\u[0-9a-fA-F]{4}/);
    assert.equal(text.includes("\r\n"), false);
  }
});

test("JSON parse and stringify preserve all Japanese data values", () => {
  for (const text of [hexagramsText, templatesText, goldenText]) {
    const parsed = JSON.parse(text);
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
  }
  assert.match(hexagramsText, /震為雷/);
  assert.match(hexagramsText, /風地觀/);
  assert.match(hexagramsText, /風地観/);

  const fixture = {
    oldAndNewForms: "風地觀／風地観、雷沢歸妹／雷沢帰妹。",
    fullWidthSpace: "前　後",
    multilinePrompt: "一行目\n二行目「引用」{{波括弧}}",
  };
  assert.deepEqual(JSON.parse(JSON.stringify(fixture)), fixture);
});

test("both distributed templates reproduce the Python prompts exactly", () => {
  assert.equal(golden.promptCases.length, 2);
  for (const vector of golden.promptCases) {
    assert.equal(templatesPayload.templates[vector.templateName], vector.template);
    assert.equal(
      makeInterpretPrompt(vector.result, vector.template),
      vector.prompt,
    );
  }
});

test("only the four approved placeholders and escaped braces are accepted", () => {
  const result = {
    theme: "相談「引用」\n二行目　",
    primary: "雷沢歸妹",
    var_kanji: "五爻",
    changed: "火地晉",
  };
  assert.equal(
    formatPromptTemplate(
      "{{テーマ}}={theme}\n{primary}／{var_kanji}／{changed}",
      result,
    ),
    "{テーマ}=相談「引用」\n二行目　\n雷沢歸妹／五爻／火地晉",
  );
  assert.equal(
    formatPromptTemplate("{{{theme}}}", result),
    "{相談「引用」\n二行目　}",
  );

  for (const invalid of [
    "{unknown}",
    "{theme:>10}",
    "{theme!r}",
    "{theme.value}",
    "{theme[0]}",
    "{",
    "}",
  ]) {
    assert.throws(() => formatPromptTemplate(invalid, result));
  }
});

test("blank templates use the exact Windows default and Python strip behavior", () => {
  const result = golden.promptCases[0].result;
  assert.equal(
    makeInterpretPrompt(result, "\u3000 \t\n"),
    formatPromptTemplate(DEFAULT_PROMPT_TEMPLATE, result),
  );
  assert.equal(pythonStrip("\u001c\u3000相談\u0085\u001f"), "相談");
  assert.equal(pythonStrip("\uFEFF相談\uFEFF"), "\uFEFF相談\uFEFF");
  assert.throws(() => makeInterpretPrompt(null, "{theme}"));
  assert.throws(() => makeInterpretPrompt({}, "{theme}"));
});
