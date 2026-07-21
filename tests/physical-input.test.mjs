import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { HexagramData } from "../js/data.mjs";
import {
  MixedPhysicalByteSource,
  computePhysicalDigest,
  createPhysicalInputProvider,
} from "../js/physical-source.mjs";
import {
  POINTER_DOMAIN,
  PointerCaptureSession,
  collectPointerSamples,
  encodePointerSamples,
} from "../js/pointer.mjs";
import { performFortune } from "../js/rng.mjs";
import {
  SENSOR_ACTIVE_SAMPLE_COUNT,
  SENSOR_ACTIVE_WINDOW_MS,
  SENSOR_ARMING_DELAY_MS,
  SENSOR_CAPTURE_MAX_DURATION_MS,
  SENSOR_CAPTURE_MIN_DURATION_MS,
  SENSOR_DOMAIN,
  SENSOR_MOTION_THRESHOLD,
  SENSOR_ROTATION_THRESHOLD,
  MotionCaptureSession,
  collectMotionSamples,
  encodeMotionSamples,
  requestMotionPermission,
} from "../js/sensor.mjs";

const [golden, hexagramPayload, physicalSourceText] = await Promise.all([
  readFile(new URL("./golden_vectors.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/hexagrams.json", import.meta.url), "utf8").then(JSON.parse),
  Promise.all(
    ["sensor.mjs", "pointer.mjs", "physical-source.mjs"].map((name) =>
      readFile(new URL(`../js/${name}`, import.meta.url), "utf8"),
    ),
  ).then((items) => items.join("\n")),
]);

function motionEvent(timeStamp, {
  acceleration = { x: 1, y: 0, z: 0 },
  gravity = { x: 0, y: 0, z: 9.80665 },
  rotation = { alpha: 0, beta: 0, gamma: 0 },
  interval = 16,
} = {}) {
  return {
    type: "devicemotion",
    timeStamp,
    interval,
    acceleration,
    accelerationIncludingGravity: gravity,
    rotationRate: rotation,
  };
}

function activeMotionEvent(timeStamp, overrides = {}) {
  return motionEvent(timeStamp, {
    acceleration: { x: 2, y: 0, z: 0 },
    rotation: { alpha: 0, beta: 0, gamma: 50 },
    ...overrides,
  });
}

function armSession(session) {
  session.completeArming();
  return session;
}

function pointerEvent(type, timeStamp, x, y, overrides = {}) {
  return {
    type,
    timeStamp,
    clientX: x,
    clientY: y,
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    pressure: 0.5,
    width: 9,
    height: 10,
    tiltX: 0,
    tiltY: 0,
    twist: 0,
    preventDefault() {},
    ...overrides,
  };
}

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
    this.captured = new Set();
    this.released = [];
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(event) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener(event);
    }
  }

  listenerCount() {
    return [...this.listeners.values()].reduce((sum, item) => sum + item.size, 0);
  }

  setPointerCapture(pointerId) {
    this.captured.add(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.captured.has(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.captured.delete(pointerId);
    this.released.push(pointerId);
  }

  getBoundingClientRect() {
    return { left: 10, top: 20 };
  }
}

function digestWithNode(input) {
  return createHash("sha256").update(input).digest();
}

function allMotionFields(overrides = {}) {
  return {
    sequence: 0,
    timeStamp: 1000,
    relativeTime: 0,
    deltaTime: 0,
    interval: 16,
    accelerationX: 1,
    accelerationY: 0,
    accelerationZ: null,
    gravityX: 0,
    gravityY: 0,
    gravityZ: 9.80665,
    rotationAlpha: 0,
    rotationBeta: null,
    rotationGamma: 8,
    ...overrides,
  };
}

test("physical modules have no persistence, hidden fixed input, or forbidden randomness", () => {
  assert.doesNotMatch(
    physicalSourceText,
    /Math\.random|localStorage|sessionStorage|indexedDB|URLSearchParams|ArrayByteSource|console\./,
  );
  assert.doesNotMatch(
    physicalSourceText,
    /performFortune|changingIndex|changing_idx|value\s*%\s*6|&\s*1/,
  );
  assert.equal(SENSOR_ARMING_DELAY_MS, 600);
  assert.equal(SENSOR_ACTIVE_SAMPLE_COUNT, 2);
  assert.equal(SENSOR_ACTIVE_WINDOW_MS, 120);
  assert.equal(SENSOR_MOTION_THRESHOLD, 1.2);
  assert.equal(SENSOR_ROTATION_THRESHOLD, 40);
});

test("arming ignores threshold crossings and discards their samples and maxima", () => {
  const session = new MotionCaptureSession();
  const ignored = session.ingest(activeMotionEvent(10, {
    acceleration: { x: 99, y: 0, z: 0 },
    rotation: { alpha: 0, beta: 0, gamma: 999 },
  }));
  assert.equal(ignored.status, "arming-motion");
  assert.equal(ignored.started, false);
  assert.equal(session.samples.length, 0);
  assert.equal(session.maxAccelerationMagnitude, null);
  assert.equal(session.maxRotationMagnitude, null);

  // arming中の一時状態が将来追加されても、完了時に必ず破棄されることを固定する。
  session.samples.push({ sequence: 0, accelerationX: 99 });
  session.startTimeStamp = 10;
  session.previousTimeStamp = 10;
  session.lastElapsed = 10;
  session.maxAccelerationMagnitude = 99;
  session.maxGravityDeviation = 99;
  session.maxRotationMagnitude = 999;

  const armed = session.completeArming();
  assert.equal(session.phase, "waiting-for-motion");
  assert.equal(armed.armingIgnoredSampleCount, 1);
  assert.equal(armed.sampleCount, 0);
  assert.equal(armed.maxAccelerationMagnitude, null);
  assert.equal(armed.maxRotationMagnitude, null);
  assert.equal(armed.elapsedMs, null);
});

test("one active sample does not start, but two within the active window do", () => {
  const session = armSession(new MotionCaptureSession());
  const first = session.ingest(activeMotionEvent(1000));
  assert.equal(first.status, "detecting-motion");
  assert.equal(first.started, false);
  assert.equal(first.measurement.activeSampleCount, 1);
  assert.equal(session.samples.length, 0);

  const confirmed = session.ingest(activeMotionEvent(1100));
  assert.equal(confirmed.status, "collecting-motion");
  assert.equal(confirmed.started, true);
  assert.equal(session.samples.length, 1);
  assert.equal(session.samples[0].timeStamp, 1100);
  assert.equal(confirmed.measurement.activeSampleCount, 2);
  assert.equal(confirmed.measurement.activeWindowMs, 100);
  assert.equal(confirmed.measurement.firstActiveAccelerationMagnitude, 2);
  assert.equal(confirmed.measurement.firstActiveRotationMagnitude, 50);
  assert.match(
    confirmed.measurement.detectionStartReason,
    /^active-sample-count-met:/,
  );
});

test("active samples farther apart than the active window do not start", () => {
  const session = armSession(new MotionCaptureSession());
  session.ingest(activeMotionEvent(1000));
  const tooLate = session.ingest(
    activeMotionEvent(1000 + SENSOR_ACTIVE_WINDOW_MS + 1),
  );
  assert.equal(tooLate.status, "detecting-motion");
  assert.equal(tooLate.started, false);
  assert.equal(tooLate.measurement.activeSampleCount, 1);
  assert.equal(tooLate.measurement.activeWindowMs, 0);
  assert.equal(session.samples.length, 0);
});

test("confirmed motion collection includes the confirming event and keeps 128ms minimum", () => {
  const session = armSession(new MotionCaptureSession({
    minDurationMs: SENSOR_CAPTURE_MIN_DURATION_MS,
    maxDurationMs: SENSOR_CAPTURE_MAX_DURATION_MS,
    minSampleCount: 3,
    motionThreshold: 0.5,
  }));

  assert.equal(session.ingest(motionEvent(900)).started, false);
  assert.equal(session.ingest(motionEvent(1000)).started, true);
  assert.equal(session.samples.length, 1);
  assert.equal(session.samples[0].timeStamp, 1000);
  assert.equal(session.samples[0].accelerationX, 1);
  assert.equal(session.ingest(motionEvent(1064)).status, "collecting-motion");
  assert.equal(session.ingest(motionEvent(1127)).status, "collecting-motion");
  const completed = session.ingest(motionEvent(1128));
  assert.equal(completed.status, "completed");
  assert.equal(completed.elapsed, 128);
  assert.equal(completed.samples.length, 4);
  assert.equal(completed.measurement.sampleCount, 4);
  assert.equal(completed.measurement.elapsedMs, 128);
  assert.equal(completed.measurement.activeSampleCount, 2);
  assert.equal(completed.measurement.completionReason, "requirements-met");
});

test("motion collection requires retry when samples are short at 256ms", () => {
  const session = armSession(new MotionCaptureSession({
    minDurationMs: 128,
    maxDurationMs: 256,
    minSampleCount: 6,
    motionThreshold: 0.5,
  }));
  session.ingest(motionEvent(-50));
  session.ingest(motionEvent(0));
  session.ingest(motionEvent(128));
  const outcome = session.ingest(motionEvent(256));
  assert.equal(outcome.status, "retry-required");
  assert.equal(outcome.error.code, "sample-insufficient");
  assert.equal(outcome.error.retryRecommended, true);
  assert.equal(outcome.error.fallbackAllowed, false);
  assert.equal(outcome.error.measurement.sampleCount, 3);
  assert.equal(outcome.error.measurement.elapsedMs, 256);
  assert.equal(
    outcome.error.measurement.completionReason,
    "sample-insufficient",
  );
});

test("motion permission and waiting failures keep fallback and retry reasons distinct", async () => {
  await assert.rejects(
    requestMotionPermission({ deviceMotionEventClass: undefined }),
    (error) => error.code === "api-unavailable" && error.fallbackAllowed,
  );
  class DeniedDeviceMotion {}
  DeniedDeviceMotion.requestPermission = async () => "denied";
  await assert.rejects(
    requestMotionPermission({ deviceMotionEventClass: DeniedDeviceMotion }),
    (error) => error.code === "permission-denied" && error.fallbackAllowed,
  );

  const noEvents = armSession(new MotionCaptureSession());
  assert.equal(noEvents.waitingFailure().code, "event-unavailable");
  assert.equal(noEvents.waitingFailure().fallbackAllowed, true);
  const noValues = armSession(new MotionCaptureSession());
  noValues.ingest(motionEvent(0, {
    acceleration: null,
    gravity: null,
    rotation: null,
  }));
  assert.equal(noValues.waitingFailure().code, "values-unavailable");
  assert.equal(noValues.waitingFailure().fallbackAllowed, true);
  const weakMotion = armSession(new MotionCaptureSession());
  weakMotion.ingest(motionEvent(0, {
    acceleration: { x: 0, y: 0, z: 0 },
    rotation: { alpha: 0, beta: 0, gamma: 0 },
  }));
  assert.equal(weakMotion.waitingFailure().code, "motion-not-detected");
  assert.equal(weakMotion.waitingFailure().retryRecommended, true);
  assert.equal(weakMotion.waitingFailure().fallbackAllowed, false);
  assert.equal(
    weakMotion.waitingFailure().measurement.completionReason,
    "motion-not-detected",
  );
  assert.equal(
    weakMotion.waitingFailure().measurement.maxAccelerationMagnitude,
    0,
  );
});

test("motion listeners and timers are removed on successful collection", async () => {
  const eventTarget = new FakeEventTarget();
  const states = [];
  const promise = collectMotionSamples({
    eventTarget,
    onState: (state) => states.push(state),
    session: new MotionCaptureSession({
      minDurationMs: 128,
      maxDurationMs: 256,
      minSampleCount: 3,
      armingDelayMs: 0,
    }),
    waitTimeoutMs: 1000,
  });
  eventTarget.dispatch(activeMotionEvent(-10));
  await new Promise((resolve) => setTimeout(resolve, 0));
  eventTarget.dispatch(activeMotionEvent(0));
  eventTarget.dispatch(activeMotionEvent(50));
  eventTarget.dispatch(motionEvent(114));
  eventTarget.dispatch(motionEvent(178));
  const samples = await promise;
  assert.equal(samples.length, 3);
  assert.equal(samples[0].timeStamp, 50);
  assert.equal(eventTarget.listenerCount(), 0);
  assert.deepEqual(states, [
    "arming-motion",
    "arming-motion",
    "waiting-for-motion",
    "detecting-motion",
    "collecting-motion",
    "collecting-motion",
    "validating-motion",
  ]);
});

test("motion timeout retry also removes listeners and pending timers", async () => {
  const eventTarget = new FakeEventTarget();
  const timers = new Map();
  let nextTimerId = 1;
  const setTimeoutImplementation = (callback, delay) => {
    const id = nextTimerId;
    nextTimerId += 1;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeoutImplementation = (id) => timers.delete(id);
  const pending = collectMotionSamples({
    eventTarget,
    session: new MotionCaptureSession({ minSampleCount: 20 }),
    setTimeoutImplementation,
    clearTimeoutImplementation,
  });
  eventTarget.dispatch(activeMotionEvent(-1));
  assert.equal(
    [...timers.values()].some(
      ({ delay }) => delay === SENSOR_CAPTURE_MAX_DURATION_MS,
    ),
    false,
  );
  const armingTimerEntry = [...timers.entries()].find(
    ([, { delay }]) => delay === SENSOR_ARMING_DELAY_MS,
  );
  assert.notEqual(armingTimerEntry, undefined);
  timers.delete(armingTimerEntry[0]);
  armingTimerEntry[1].callback();
  eventTarget.dispatch(activeMotionEvent(0));
  eventTarget.dispatch(activeMotionEvent(50));
  const captureTimerEntry = [...timers.entries()].find(
    ([, { delay }]) => delay === SENSOR_CAPTURE_MAX_DURATION_MS,
  );
  assert.notEqual(captureTimerEntry, undefined);
  timers.delete(captureTimerEntry[0]);
  captureTimerEntry[1].callback();
  await assert.rejects(pending, (error) => error.code === "sample-insufficient");
  assert.equal(eventTarget.listenerCount(), 0);
  assert.equal(timers.size, 0);
});

test("motion abort removes its event listener", async () => {
  const eventTarget = new FakeEventTarget();
  const controller = new AbortController();
  const pending = collectMotionSamples({
    eventTarget,
    signal: controller.signal,
    waitTimeoutMs: 1000,
  });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === "aborted");
  assert.equal(eventTarget.listenerCount(), 0);
});

test("motion canonical encoding is deterministic and distinguishes null from zero", () => {
  const sample = allMotionFields();
  const first = encodeMotionSamples([sample]);
  const second = encodeMotionSamples([{ ...sample }]);
  assert.deepEqual(second, first);
  assert.equal(first.length, 120);
  const view = new DataView(first.buffer, first.byteOffset, first.byteLength);
  assert.equal(view.getUint16(0, false), 1);
  assert.equal(view.getUint16(2, false), 13);
  assert.equal(view.getUint32(4, false), 1);
  assert.equal(view.getUint32(8, false), 0);
  assert.equal(view.getUint16(12, false), 0x17bf);
  assert.equal(
    createHash("sha256").update(first).digest("hex"),
    "dfb3c996abbabd4f527061cf450586b4cd8f98098c3c0231a9dfbe968b87cfd4",
  );

  const nullInterval = encodeMotionSamples([allMotionFields({ interval: null })]);
  const zeroInterval = encodeMotionSamples([allMotionFields({ interval: 0 })]);
  assert.notDeepEqual(nullInterval, zeroInterval);
  assert.equal(new DataView(nullInterval.buffer).getFloat64(40, false), 0);
  assert.equal(new DataView(zeroInterval.buffer).getFloat64(40, false), 0);
});

test("physical digest includes one domain and changes when one value changes", async () => {
  const canonicalA = encodeMotionSamples([allMotionFields()]);
  const canonicalB = encodeMotionSamples([allMotionFields({ accelerationX: 1.25 })]);
  const seenInputs = [];
  const digestImplementation = (input) => {
    seenInputs.push(new Uint8Array(input));
    return digestWithNode(input);
  };
  const digestA = await computePhysicalDigest({
    domain: SENSOR_DOMAIN,
    canonicalBytes: canonicalA,
    counter: 0,
    digestImplementation,
  });
  const digestB = await computePhysicalDigest({
    domain: SENSOR_DOMAIN,
    canonicalBytes: canonicalB,
    counter: 0,
    digestImplementation,
  });
  assert.notDeepEqual(digestA, digestB);

  const domainBytes = new TextEncoder().encode(SENSOR_DOMAIN);
  assert.deepEqual(seenInputs[0].slice(0, domainBytes.length), domainBytes);
  assert.deepEqual(
    seenInputs[0].slice(domainBytes.length, -4),
    canonicalA,
  );
  assert.deepEqual(seenInputs[0].slice(-4), new Uint8Array([0, 0, 0, 0]));
  assert.equal(
    Buffer.from(canonicalA).includes(Buffer.from(SENSOR_DOMAIN, "utf8")),
    false,
  );
});

test("pointer rejects a tap, accepts a trace, and uses a deterministic encoding", () => {
  const tap = new PointerCaptureSession({
    minDurationMs: 0,
    minMoveCount: 1,
    minDistancePx: 1,
  });
  tap.ingest("pointerdown", pointerEvent("pointerdown", 0, 10, 20));
  assert.throws(
    () => tap.ingest("pointerup", pointerEvent("pointerup", 20, 10, 20)),
    (error) =>
      error.code === "pointer-tap-only" &&
      error.measurement.durationMs === 20 &&
      error.measurement.moveCount === 0,
  );

  const trace = new PointerCaptureSession({
    minDurationMs: 96,
    minMoveCount: 3,
    minDistancePx: 24,
  });
  trace.ingest("pointerdown", pointerEvent("pointerdown", 0, 10, 20));
  trace.ingest("pointermove", pointerEvent("pointermove", 32, 20, 20));
  trace.ingest("pointermove", pointerEvent("pointermove", 64, 30, 20));
  trace.ingest("pointermove", pointerEvent("pointermove", 80, 40, 20));
  const completed = trace.ingest(
    "pointerup",
    pointerEvent("pointerup", 96, 45, 20),
  );
  assert.equal(completed.status, "completed");
  assert.equal(completed.moveCount, 3);
  assert.equal(completed.samples.length, 5);
  assert.equal(completed.measurement.durationMs, 96);
  assert.equal(completed.measurement.moveCount, 3);
  assert.equal(completed.measurement.totalDistancePx, 35);
  assert.equal(completed.measurement.completionReason, "requirements-met");
  const encoded = encodePointerSamples(completed.samples);
  assert.deepEqual(
    encoded,
    encodePointerSamples(completed.samples.map((sample) => ({ ...sample }))),
  );
  assert.equal(
    createHash("sha256").update(encoded).digest("hex"),
    "d21351d89be7c5d293c6496d479465929ac8a573926b4961a3ea7606b648eb46",
  );
  const pressureNullSamples = completed.samples.map((sample) => ({ ...sample }));
  const pressureZeroSamples = completed.samples.map((sample) => ({ ...sample }));
  pressureNullSamples[0].pressure = null;
  pressureZeroSamples[0].pressure = 0;
  const pressureNull = encodePointerSamples(pressureNullSamples);
  const pressureZero = encodePointerSamples(pressureZeroSamples);
  assert.notDeepEqual(pressureNull, pressureZero);
  assert.equal(new DataView(pressureNull.buffer).getFloat64(64, false), 0);
  assert.equal(new DataView(pressureZero.buffer).getFloat64(64, false), 0);
});

test("pointercancel and multiple pointers reject the entire trace", () => {
  const cancelled = new PointerCaptureSession();
  cancelled.ingest("pointerdown", pointerEvent("pointerdown", 0, 0, 0));
  assert.throws(
    () => cancelled.ingest("pointercancel", pointerEvent("pointercancel", 10, 1, 1)),
    (error) =>
      error.code === "pointer-cancelled" &&
      error.measurement.durationMs === 10 &&
      error.measurement.completionReason === "pointer-cancelled",
  );

  const mixed = new PointerCaptureSession();
  mixed.ingest("pointerdown", pointerEvent("pointerdown", 0, 0, 0));
  assert.throws(
    () =>
      mixed.ingest(
        "pointermove",
        pointerEvent("pointermove", 10, 1, 1, { pointerId: 8 }),
      ),
    (error) => error.code === "multiple-pointers",
  );
});

test("pointer collector releases capture and listeners on success and cancel", async () => {
  const successElement = new FakeEventTarget();
  const success = collectPointerSamples({
    element: successElement,
    session: new PointerCaptureSession({
      minDurationMs: 30,
      minMoveCount: 2,
      minDistancePx: 5,
    }),
  });
  successElement.dispatch(pointerEvent("pointerdown", 0, 10, 20));
  successElement.dispatch(pointerEvent("pointermove", 10, 14, 20));
  successElement.dispatch(pointerEvent("pointermove", 20, 18, 20));
  successElement.dispatch(pointerEvent("pointerup", 30, 20, 20));
  assert.equal((await success).length, 4);
  assert.deepEqual(successElement.released, [7]);
  assert.equal(successElement.listenerCount(), 0);

  const cancelElement = new FakeEventTarget();
  const cancelled = collectPointerSamples({ element: cancelElement });
  cancelElement.dispatch(pointerEvent("pointerdown", 0, 10, 20));
  cancelElement.dispatch(pointerEvent("pointercancel", 10, 11, 21));
  await assert.rejects(cancelled, (error) => error.code === "pointer-cancelled");
  assert.deepEqual(cancelElement.released, [7]);
  assert.equal(cancelElement.listenerCount(), 0);
});

test("motion and pointer have different domains", () => {
  assert.notEqual(SENSOR_DOMAIN, POINTER_DOMAIN);
});

test("fixed physical and crypto blocks XOR exactly and extend past 32 bytes", async () => {
  const physicalBlock = Uint8Array.from({ length: 32 }, (_, index) => index);
  const cryptoBlock = Uint8Array.from({ length: 32 }, (_, index) => 255 - index);
  let digestCalls = 0;
  let randomCalls = 0;
  const digestInputs = [];
  const source = new MixedPhysicalByteSource({
    domain: SENSOR_DOMAIN,
    canonicalBytes: new Uint8Array([1, 2, 3]),
    digestImplementation: async (input) => {
      digestCalls += 1;
      digestInputs.push(new Uint8Array(input));
      return physicalBlock;
    },
    randomBlockProvider: async () => {
      randomCalls += 1;
      return cryptoBlock;
    },
  });
  assert.equal(randomCalls, 0);
  const values = [];
  for (let index = 0; index < 33; index += 1) {
    values.push(await source.nextByte());
  }
  assert.deepEqual(values.slice(0, 32), new Array(32).fill(255));
  assert.equal(values[32], 255);
  assert.equal(digestCalls, 2);
  assert.equal(randomCalls, 2);
  assert.equal(source.generatedBlockCount, 2);
  assert.deepEqual(digestInputs[0].slice(-4), new Uint8Array([0, 0, 0, 0]));
  assert.deepEqual(digestInputs[1].slice(-4), new Uint8Array([0, 0, 0, 1]));
  source.dispose();
});

test("provider never requests crypto before valid physical input and has no crypto-only path", async () => {
  let releaseSamples;
  const pendingSamples = new Promise((resolve) => {
    releaseSamples = resolve;
  });
  let randomCalls = 0;
  const sample = allMotionFields();
  const provider = createPhysicalInputProvider({
    requestMotionPermissionImplementation: async () => "granted",
    collectMotionSamplesImplementation: async () => pendingSamples,
    digestImplementation: async () => new Uint8Array(32),
    randomBlockProvider: async () => {
      randomCalls += 1;
      return new Uint8Array(32);
    },
  });
  const pendingSource = provider({ mode: "motion" });
  await Promise.resolve();
  assert.equal(randomCalls, 0);
  releaseSamples([sample]);
  const source = await pendingSource;
  assert.equal(randomCalls, 0);
  await source.nextByte();
  assert.equal(randomCalls, 1);
  source.dispose();

  const invalidProvider = createPhysicalInputProvider({
    requestMotionPermissionImplementation: async () => "granted",
    collectMotionSamplesImplementation: async () => {
      throw Object.assign(new Error("値なし"), { fallbackAllowed: true });
    },
    digestImplementation: async () => new Uint8Array(32),
    randomBlockProvider: async () => {
      randomCalls += 1;
      return new Uint8Array(32);
    },
  });
  await assert.rejects(invalidProvider({ mode: "motion" }), /値なし/);
  assert.equal(randomCalls, 1);
});

test("mixed physical ByteSource reproduces the existing golden fortune", async () => {
  const vector = golden.requiredCases.find(({ name }) => name === "requirement_mapping");
  const physicalBlock = Uint8Array.from({ length: 32 }, (_, index) => index * 3);
  const desiredMixed = new Uint8Array(32);
  desiredMixed.set(vector.inputBytes);
  const cryptoBlock = Uint8Array.from(
    physicalBlock,
    (value, index) => value ^ desiredMixed[index],
  );
  const source = new MixedPhysicalByteSource({
    domain: SENSOR_DOMAIN,
    canonicalBytes: new Uint8Array([1]),
    digestImplementation: async () => physicalBlock,
    randomBlockProvider: async () => cryptoBlock,
  });
  const data = new HexagramData(hexagramPayload);
  const result = await performFortune("", source, data.getHexagramName.bind(data));
  assert.equal(result.primary, vector.primary);
  assert.equal(result.var_kanji, vector.var_kanji);
  assert.equal(result.changed, vector.changed);
  assert.deepEqual(result.lines, vector.lines);
  source.dispose();
});
