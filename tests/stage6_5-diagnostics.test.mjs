import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  STAGE65_DIAGNOSTIC_ELEMENT_IDS,
  createStage65Diagnostics,
} from "../js/stage6_5-diagnostics.mjs";

const source = await readFile(
  new URL("../js/stage6_5-diagnostics.mjs", import.meta.url),
  "utf8",
);

class FakeElement {
  constructor() {
    this.textContent = "";
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  dispatch(type) {
    this.listeners.get(type)?.();
  }
}

function createElements() {
  return Object.fromEntries(
    STAGE65_DIAGNOSTIC_ELEMENT_IDS.map((id) => [id, new FakeElement()]),
  );
}

test("stage 6.5 diagnostics have no storage, network, log, or URL channel", () => {
  assert.doesNotMatch(
    source,
    /localStorage|sessionStorage|indexedDB|fetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|console\.|URLSearchParams/,
  );
});

test("motion measurements are formatted in the visible latest-run fields", () => {
  const elements = createElements();
  const diagnostics = createStage65Diagnostics(elements);
  diagnostics.begin("motion");
  diagnostics.update("motion", "validating-motion", {
    sampleCount: 9,
    elapsedMs: 133.25,
    maxAccelerationMagnitude: 1.23456,
    maxGravityDeviation: 0,
    maxRotationMagnitude: 12.34567,
    armingDelayMs: 600,
    armingIgnoredSampleCount: 38,
    activeSampleCount: 2,
    activeWindowMs: 18.5,
    firstActiveAccelerationMagnitude: 1.4567,
    firstActiveRotationMagnitude: 42.6789,
    detectionStartReason: "active-sample-count-met:acceleration+rotation",
    completionReason: "requirements-met",
  });
  diagnostics.complete("motion");

  assert.equal(elements["diagnostics-status"].textContent, "成功");
  assert.equal(elements["diagnostics-input-mode"].textContent, "モーション");
  assert.equal(elements["diagnostics-reason"].textContent, "requirements-met");
  assert.equal(elements["diagnostics-sample-count"].textContent, "9");
  assert.equal(elements["diagnostics-motion-duration"].textContent, "133.25");
  assert.equal(elements["diagnostics-max-acceleration"].textContent, "1.235");
  assert.equal(elements["diagnostics-max-gravity-deviation"].textContent, "0.000");
  assert.equal(elements["diagnostics-max-rotation"].textContent, "12.346");
  assert.equal(elements["diagnostics-arming-duration"].textContent, "600");
  assert.equal(elements["diagnostics-arming-ignored-count"].textContent, "38");
  assert.equal(elements["diagnostics-active-sample-count"].textContent, "2");
  assert.equal(elements["diagnostics-active-window"].textContent, "18.50");
  assert.equal(
    elements["diagnostics-first-active-acceleration"].textContent,
    "1.457",
  );
  assert.equal(
    elements["diagnostics-first-active-rotation"].textContent,
    "42.679",
  );
  assert.equal(
    elements["diagnostics-detection-start-reason"].textContent,
    "active-sample-count-met:acceleration+rotation",
  );
});

test("pointer failure stays transient and clear removes the displayed values", () => {
  const elements = createElements();
  const diagnostics = createStage65Diagnostics(elements);
  diagnostics.begin("pointer");
  diagnostics.fail("pointer", {
    code: "pointer-input-insufficient",
    message: "入力が不足しています。",
    measurement: {
      sampleCount: 4,
      durationMs: 80,
      moveCount: 2,
      totalDistancePx: 18.75,
      completionReason: "pointer-input-insufficient",
    },
  });

  assert.equal(elements["diagnostics-status"].textContent, "失敗");
  assert.equal(elements["diagnostics-input-mode"].textContent, "Pointer");
  assert.equal(elements["diagnostics-pointer-duration"].textContent, "80.00");
  assert.equal(elements["diagnostics-pointer-move-count"].textContent, "2");
  assert.equal(elements["diagnostics-pointer-distance"].textContent, "18.75");
  assert.match(elements["diagnostics-reason"].textContent, /pointer-input-insufficient/);

  elements["diagnostics-clear-button"].dispatch("click");
  assert.equal(elements["diagnostics-status"].textContent, "未測定");
  assert.equal(elements["diagnostics-pointer-duration"].textContent, "—");
  assert.equal(elements["diagnostics-active-sample-count"].textContent, "—");
  assert.deepEqual(diagnostics.snapshot(), { mode: null, reason: null });
});
