import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CHANGE_INDEX_TO_LINE_INDEX,
  Hexagram,
  changingIndexToLabel,
} from "../js/domain.mjs";
import {
  HexagramData,
  loadHexagramData,
  parseHexagramData,
} from "../js/data.mjs";
import {
  ArrayByteSource,
  getRandomBit,
  performFortune,
} from "../js/rng.mjs";

const dataUrl = new URL("../data/hexagrams.json", import.meta.url);
const goldenUrl = new URL("./golden_vectors.json", import.meta.url);
const dataText = await readFile(dataUrl, "utf8");
const goldenText = await readFile(goldenUrl, "utf8");
const payload = JSON.parse(dataText);
const golden = JSON.parse(goldenText);
const repository = new HexagramData(payload);
const getHexagramName = repository.getHexagramName.bind(repository);

async function assertFortuneVector(vector) {
  const source = new ArrayByteSource(vector.inputBytes);
  const result = await performFortune(
    vector.theme,
    source,
    getHexagramName,
  );
  const primary = new Hexagram(result.lines);
  const changed = primary.changed(result.changing_idx);

  assert.deepEqual(result, {
    theme: vector.theme,
    lines: vector.lines,
    primary: vector.primary,
    changed: vector.changed,
    var_kanji: vector.var_kanji,
    changing_idx: vector.changing_idx,
  });
  assert.equal(primary.toId(), vector.primaryId);
  assert.deepEqual(changed.yinYang, vector.changedLines);
  assert.equal(changed.toId(), vector.changedId);
  assert.equal(source.consumedBytes, vector.consumedBytes);
  assert.deepEqual(source.requestSizes, vector.requestSizes);
  assert.equal(source.remainingBytes, 0);
}

test("generated hexagram JSON is accepted without changing its strings", () => {
  assert.deepEqual(golden.counts, {
    byteParity: 256,
    requiredCases: 3,
    hexagramCases: 64,
    changeCases: 384,
    rejectionCases: 6,
    themeCases: 1,
    aliasCases: 5,
    lookupCases: 64,
    promptCases: 2,
  });
  const parsedRepository = parseHexagramData(dataText);
  assert.equal(parsedRepository.getHexagramName(27), "震為雷");
  assert.deepEqual(JSON.parse(JSON.stringify(payload)), payload);
  assert.equal(payload.hexagrams.length, 64);
  assert.equal(Object.keys(payload.descriptions).length, 64);
  assert.equal(Object.keys(payload.yaoDescriptions).length, 64);
  assert.equal(
    Object.values(payload.yaoDescriptions).reduce(
      (count, table) => count + Object.keys(table).length,
      0,
    ),
    384,
  );
});

test("hexagram JSON loading accepts an injected same-origin fetch function", async () => {
  const loaded = await loadHexagramData("./data/hexagrams.json", async (url) => {
    assert.equal(url, "./data/hexagrams.json");
    return {
      ok: true,
      status: 200,
      text: async () => dataText,
    };
  });
  assert.equal(loaded.getHexagramName(27), "震為雷");
});

test("all 256 input bytes use the Python byte & 1 mapping", async () => {
  assert.equal(golden.byteParity.length, 256);
  for (const vector of golden.byteParity) {
    const source = new ArrayByteSource([vector.byte]);
    assert.equal(await getRandomBit(source), vector.bit);
    assert.equal(source.consumedBytes, 1);
  }
});

test("Python golden vectors match including byte consumption", async () => {
  const groups = [
    golden.requiredCases,
    golden.hexagramCases,
    golden.changeCases,
    golden.rejectionCases,
    golden.themeCases,
  ];
  for (const group of groups) {
    for (const vector of group) {
      await assertFortuneVector(vector);
    }
  }
});

test("performFortune applies the same Python strip operation to the input theme", async () => {
  const vector = golden.themeCases[0];
  const source = new ArrayByteSource(vector.inputBytes);
  const result = await performFortune(
    "\u3000 相談テーマ \t\n",
    source,
    getHexagramName,
  );
  assert.equal(result.theme, vector.theme);
  assert.equal(source.consumedBytes, vector.consumedBytes);
});

test("all 64 by 6 changes preserve the independent Python index mapping", () => {
  assert.equal(golden.changeCases.length, 64 * 6);
  for (const vector of golden.changeCases) {
    const differingIndexes = vector.lines
      .map((bit, index) => bit !== vector.changedLines[index] ? index : -1)
      .filter((index) => index !== -1);
    assert.deepEqual(differingIndexes, [CHANGE_INDEX_TO_LINE_INDEX[vector.changing_idx]]);
    assert.equal(changingIndexToLabel(vector.changing_idx), vector.var_kanji);
  }

  const original = new Hexagram([0, 0, 0, 0, 0, 0]);
  original.changed(0);
  assert.deepEqual(original.yinYang, [0, 0, 0, 0, 0, 0]);
});

test("the rejection boundary consumes the same bytes as Python", () => {
  assert.deepEqual(
    golden.rejectionCases.map(({ name, consumedBytes, changing_idx }) => ({
      name,
      consumedBytes,
      changing_idx,
    })),
    [
      { name: "accept_251", consumedBytes: 7, changing_idx: 5 },
      { name: "reject_252_then_0", consumedBytes: 8, changing_idx: 0 },
      { name: "reject_253_then_1", consumedBytes: 8, changing_idx: 1 },
      { name: "reject_254_then_2", consumedBytes: 8, changing_idx: 2 },
      { name: "reject_255_then_3", consumedBytes: 8, changing_idx: 3 },
      {
        name: "reject_252_253_254_255_then_5",
        consumedBytes: 11,
        changing_idx: 5,
      },
    ],
  );
});

test("all canonical and alias description lookups match Python", () => {
  assert.equal(golden.lookupCases.length, 64);
  for (const vector of golden.lookupCases) {
    assert.equal(repository.getHexagramName(vector.id), vector.name);
    assert.equal(
      repository.resolveHexagramTextKey(vector.name, payload.descriptions),
      vector.descriptionKey,
    );
    assert.equal(
      repository.resolveHexagramTextKey(vector.name, payload.yaoDescriptions),
      vector.yaoKey,
    );
    assert.equal(vector.descriptionKey in payload.descriptions, vector.hasDescription);
    assert.equal(vector.yaoKey in payload.yaoDescriptions, vector.hasYao);
  }

  assert.equal(golden.aliasCases.length, 5);
  for (const vector of golden.aliasCases) {
    assert.equal(
      repository.resolveHexagramTextKey(vector.name, payload.descriptions),
      vector.descriptionKey,
    );
    assert.equal(
      repository.resolveHexagramTextKey(vector.name, payload.yaoDescriptions),
      vector.yaoKey,
    );
  }
});

test("the corrected 51st hexagram resolves all six yao entries", () => {
  const lookup = golden.lookupCases.find(({ id }) => id === 27);
  assert.deepEqual(lookup, {
    id: 27,
    name: "震為雷",
    descriptionKey: "震為雷",
    yaoKey: "震為雷",
    hasDescription: true,
    hasYao: true,
  });
  for (let changingIndex = 0; changingIndex < 6; changingIndex += 1) {
    const entry = repository.getPrimaryYaoDescription("震為雷", changingIndex);
    assert.equal(entry.position, changingIndexToLabel(changingIndex));
    assert.notEqual(entry.yao, "(爻辞なし)");
    assert.notEqual(entry.other, "(解説なし)");
  }
});
