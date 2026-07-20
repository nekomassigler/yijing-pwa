export const SENSOR_CAPTURE_MIN_DURATION_MS = 128;
export const SENSOR_CAPTURE_MAX_DURATION_MS = 256;

// 暫定値。iPhone 16 / 対象iOSでの実測後に確定する。
export const SENSOR_MIN_SAMPLE_COUNT = 6;
export const SENSOR_MOTION_THRESHOLD = 0.75;
export const SENSOR_ROTATION_THRESHOLD = 8;
export const SENSOR_WAIT_FOR_MOTION_TIMEOUT_MS = 5000;
export const SENSOR_TUNING_STATUS =
  "provisional-awaiting-iphone16-ios-measurement";

export const SENSOR_DOMAIN = "yijing-pwa-sensor-v1";
export const SENSOR_CANONICAL_VERSION = 1;

const STANDARD_GRAVITY = 9.80665;
const MOTION_VALUE_FIELDS = Object.freeze([
  "timeStamp",
  "relativeTime",
  "deltaTime",
  "interval",
  "accelerationX",
  "accelerationY",
  "accelerationZ",
  "gravityX",
  "gravityY",
  "gravityZ",
  "rotationAlpha",
  "rotationBeta",
  "rotationGamma",
]);

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function axis(object, name) {
  return finiteOrNull(object?.[name]);
}

function magnitude(values, { requireAll = false } = {}) {
  const finiteValues = values.filter((value) => value !== null);
  if (finiteValues.length === 0 || (requireAll && finiteValues.length !== values.length)) {
    return null;
  }
  return Math.sqrt(
    finiteValues.reduce((sum, value) => sum + value * value, 0),
  );
}

export class MotionInputError extends Error {
  constructor(
    code,
    message,
    { fallbackAllowed = false, retryRecommended = false, cause } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MotionInputError";
    this.code = code;
    this.fallbackAllowed = fallbackAllowed;
    this.retryRecommended = retryRecommended;
  }
}

export function readMotionValues(event) {
  return {
    accelerationX: axis(event?.acceleration, "x"),
    accelerationY: axis(event?.acceleration, "y"),
    accelerationZ: axis(event?.acceleration, "z"),
    gravityX: axis(event?.accelerationIncludingGravity, "x"),
    gravityY: axis(event?.accelerationIncludingGravity, "y"),
    gravityZ: axis(event?.accelerationIncludingGravity, "z"),
    rotationAlpha: axis(event?.rotationRate, "alpha"),
    rotationBeta: axis(event?.rotationRate, "beta"),
    rotationGamma: axis(event?.rotationRate, "gamma"),
  };
}

export function hasUsableMotionValues(event) {
  return Object.values(readMotionValues(event)).some((value) => value !== null);
}

export function isMotionTrigger(event, {
  motionThreshold = SENSOR_MOTION_THRESHOLD,
  rotationThreshold = SENSOR_ROTATION_THRESHOLD,
} = {}) {
  const values = readMotionValues(event);
  const accelerationMagnitude = magnitude([
    values.accelerationX,
    values.accelerationY,
    values.accelerationZ,
  ]);
  const gravityMagnitude = magnitude(
    [values.gravityX, values.gravityY, values.gravityZ],
    { requireAll: true },
  );
  const rotationMagnitude = magnitude([
    values.rotationAlpha,
    values.rotationBeta,
    values.rotationGamma,
  ]);

  return (
    (accelerationMagnitude !== null && accelerationMagnitude >= motionThreshold) ||
    (gravityMagnitude !== null &&
      Math.abs(gravityMagnitude - STANDARD_GRAVITY) >= motionThreshold) ||
    (rotationMagnitude !== null && rotationMagnitude >= rotationThreshold)
  );
}

export function snapshotMotionEvent(
  event,
  sequence,
  startTimeStamp,
  previousTimeStamp,
) {
  const timeStamp = finiteOrNull(event?.timeStamp);
  if (timeStamp === null) {
    throw new MotionInputError(
      "values-unavailable",
      "モーションイベントの時刻を取得できませんでした。",
      { fallbackAllowed: true },
    );
  }
  const values = readMotionValues(event);
  return {
    sequence,
    timeStamp,
    relativeTime: timeStamp - startTimeStamp,
    deltaTime: sequence === 0 ? 0 : timeStamp - previousTimeStamp,
    interval: finiteOrNull(event?.interval),
    ...values,
  };
}

export class MotionCaptureSession {
  constructor({
    minDurationMs = SENSOR_CAPTURE_MIN_DURATION_MS,
    maxDurationMs = SENSOR_CAPTURE_MAX_DURATION_MS,
    minSampleCount = SENSOR_MIN_SAMPLE_COUNT,
    motionThreshold = SENSOR_MOTION_THRESHOLD,
    rotationThreshold = SENSOR_ROTATION_THRESHOLD,
  } = {}) {
    this.minDurationMs = minDurationMs;
    this.maxDurationMs = maxDurationMs;
    this.minSampleCount = minSampleCount;
    this.motionThreshold = motionThreshold;
    this.rotationThreshold = rotationThreshold;
    this.phase = "waiting-for-motion";
    this.samples = [];
    this.eventCount = 0;
    this.usableEventCount = 0;
    this.startTimeStamp = null;
    this.previousTimeStamp = null;
  }

  ingest(event) {
    if (this.phase === "completed" || this.phase === "retry-required") {
      throw new MotionInputError("session-finished", "モーション収集は終了しています。");
    }
    this.eventCount += 1;
    const usable = hasUsableMotionValues(event);
    if (usable) {
      this.usableEventCount += 1;
    }

    if (this.phase === "waiting-for-motion") {
      if (!usable || !isMotionTrigger(event, {
        motionThreshold: this.motionThreshold,
        rotationThreshold: this.rotationThreshold,
      })) {
        return { status: "waiting-for-motion", started: false };
      }
      const timeStamp = finiteOrNull(event?.timeStamp);
      if (timeStamp === null) {
        throw new MotionInputError(
          "values-unavailable",
          "有効なモーションイベント時刻を取得できませんでした。",
          { fallbackAllowed: true },
        );
      }
      this.phase = "collecting-motion";
      this.startTimeStamp = timeStamp;
      this.previousTimeStamp = timeStamp;
      this.samples.push(snapshotMotionEvent(event, 0, timeStamp, timeStamp));
      return { status: "collecting-motion", started: true };
    }

    if (!usable) {
      return {
        status: "collecting-motion",
        started: false,
        sampleCount: this.samples.length,
      };
    }

    const timeStamp = finiteOrNull(event?.timeStamp);
    if (timeStamp === null) {
      return {
        status: "collecting-motion",
        started: false,
        sampleCount: this.samples.length,
      };
    }
    const elapsed = timeStamp - this.startTimeStamp;
    if (elapsed > this.maxDurationMs) {
      this.phase = "retry-required";
      return {
        status: "retry-required",
        error: this.captureFailure(),
      };
    }

    this.samples.push(
      snapshotMotionEvent(
        event,
        this.samples.length,
        this.startTimeStamp,
        this.previousTimeStamp,
      ),
    );
    this.previousTimeStamp = timeStamp;
    if (
      elapsed >= this.minDurationMs &&
      this.samples.length >= this.minSampleCount
    ) {
      this.phase = "completed";
      return {
        status: "completed",
        samples: this.samples.map((sample) => ({ ...sample })),
        elapsed,
      };
    }
    if (elapsed >= this.maxDurationMs) {
      this.phase = "retry-required";
      return {
        status: "retry-required",
        error: this.captureFailure(),
      };
    }
    return {
      status: "collecting-motion",
      started: false,
      sampleCount: this.samples.length,
      elapsed,
    };
  }

  waitingFailure() {
    if (this.eventCount === 0) {
      return new MotionInputError(
        "event-unavailable",
        "モーションイベントを取得できませんでした。",
        { fallbackAllowed: true },
      );
    }
    if (this.usableEventCount === 0) {
      return new MotionInputError(
        "values-unavailable",
        "モーションイベントは届きましたが、有効な値を取得できませんでした。",
        { fallbackAllowed: true },
      );
    }
    return new MotionInputError(
      "motion-not-detected",
      "有効な動きを検出できませんでした。強く振らず、もう一度軽く振ってください。",
      { retryRecommended: true },
    );
  }

  captureFailure() {
    return new MotionInputError(
      "sample-insufficient",
      `最大${this.maxDurationMs}msまでに必要なモーションsample数を取得できませんでした。もう一度軽く振ってください。`,
      { retryRecommended: true },
    );
  }
}

export async function requestMotionPermission({
  deviceMotionEventClass = globalThis.DeviceMotionEvent,
} = {}) {
  if (typeof deviceMotionEventClass !== "function") {
    throw new MotionInputError(
      "api-unavailable",
      "この環境ではDeviceMotion APIを利用できません。",
      { fallbackAllowed: true },
    );
  }
  if (!("requestPermission" in deviceMotionEventClass)) {
    return "not-required";
  }
  if (typeof deviceMotionEventClass.requestPermission !== "function") {
    throw new MotionInputError(
      "permission-api-unavailable",
      "モーションセンサーの許可APIを利用できません。",
      { fallbackAllowed: true },
    );
  }

  let permission;
  try {
    permission = await deviceMotionEventClass.requestPermission();
  } catch (error) {
    throw new MotionInputError(
      "permission-unavailable",
      "モーションセンサーの利用許可を確認できませんでした。",
      { fallbackAllowed: true, cause: error },
    );
  }
  if (permission !== "granted") {
    throw new MotionInputError(
      "permission-denied",
      "モーションセンサーの利用が許可されませんでした。",
      { fallbackAllowed: true },
    );
  }
  return permission;
}

export function collectMotionSamples({
  eventTarget = globalThis.window,
  signal,
  onState = () => {},
  setTimeoutImplementation = globalThis.setTimeout?.bind(globalThis),
  clearTimeoutImplementation = globalThis.clearTimeout?.bind(globalThis),
  session = new MotionCaptureSession(),
  waitTimeoutMs = SENSOR_WAIT_FOR_MOTION_TIMEOUT_MS,
} = {}) {
  if (
    !eventTarget ||
    typeof eventTarget.addEventListener !== "function" ||
    typeof eventTarget.removeEventListener !== "function"
  ) {
    return Promise.reject(
      new MotionInputError(
        "event-unavailable",
        "モーションイベントの取得先を利用できません。",
        { fallbackAllowed: true },
      ),
    );
  }
  if (
    typeof setTimeoutImplementation !== "function" ||
    typeof clearTimeoutImplementation !== "function"
  ) {
    return Promise.reject(
      new MotionInputError("timer-unavailable", "モーション取得用timerを利用できません。"),
    );
  }

  return new Promise((resolve, reject) => {
    let waitTimer = null;
    let captureTimer = null;
    let settled = false;

    const cleanup = () => {
      eventTarget.removeEventListener("devicemotion", handleMotion);
      signal?.removeEventListener?.("abort", handleAbort);
      if (waitTimer !== null) {
        clearTimeoutImplementation(waitTimer);
      }
      if (captureTimer !== null) {
        clearTimeoutImplementation(captureTimer);
      }
      waitTimer = null;
      captureTimer = null;
      clearMotionSamples(session.samples);
      session.startTimeStamp = null;
      session.previousTimeStamp = null;
    };
    const finishResolve = (samples) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(samples);
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => {
      finishReject(
        new MotionInputError("aborted", "モーション入力を中止しました。", {
          retryRecommended: true,
        }),
      );
    };
    const handleCaptureTimeout = () => {
      onState("validating-motion");
      finishReject(session.captureFailure());
    };
    const handleMotion = (event) => {
      try {
        const outcome = session.ingest(event);
        if (outcome.started) {
          if (waitTimer !== null) {
            clearTimeoutImplementation(waitTimer);
            waitTimer = null;
          }
          onState("collecting-motion", {
            sampleCount: 1,
            minSampleCount: session.minSampleCount,
          });
          captureTimer = setTimeoutImplementation(
            handleCaptureTimeout,
            session.maxDurationMs,
          );
        } else if (outcome.status === "collecting-motion") {
          onState("collecting-motion", {
            sampleCount: outcome.sampleCount,
            minSampleCount: session.minSampleCount,
          });
        }
        if (outcome.status === "completed") {
          onState("validating-motion", {
            sampleCount: outcome.samples.length,
            elapsed: outcome.elapsed,
          });
          finishResolve(outcome.samples);
        } else if (outcome.status === "retry-required") {
          onState("retry-required");
          finishReject(outcome.error);
        }
      } catch (error) {
        finishReject(error);
      }
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    eventTarget.addEventListener("devicemotion", handleMotion);
    signal?.addEventListener?.("abort", handleAbort, { once: true });
    onState("waiting-for-motion");
    waitTimer = setTimeoutImplementation(() => {
      finishReject(session.waitingFailure());
    }, waitTimeoutMs);
  });
}

export function encodeMotionSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new MotionInputError("invalid-samples", "モーションsampleがありません。");
  }
  const headerSize = 8;
  const sampleHeaderSize = 8;
  const sampleSize = sampleHeaderSize + MOTION_VALUE_FIELDS.length * 8;
  const bytes = new Uint8Array(headerSize + samples.length * sampleSize);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint16(offset, SENSOR_CANONICAL_VERSION, false);
  offset += 2;
  view.setUint16(offset, MOTION_VALUE_FIELDS.length, false);
  offset += 2;
  view.setUint32(offset, samples.length, false);
  offset += 4;

  samples.forEach((sample, sampleIndex) => {
    if (sample.sequence !== sampleIndex) {
      throw new MotionInputError(
        "invalid-samples",
        "モーションsampleの連番が不正です。",
      );
    }
    view.setUint32(offset, sample.sequence, false);
    offset += 4;
    let availabilityMask = 0;
    MOTION_VALUE_FIELDS.forEach((field, fieldIndex) => {
      const value = sample[field];
      if (value !== null && typeof value === "number" && Number.isFinite(value)) {
        availabilityMask |= 1 << fieldIndex;
      } else if (value !== null) {
        throw new MotionInputError(
          "invalid-samples",
          `モーションsampleの${field}が不正です。`,
        );
      }
    });
    view.setUint16(offset, availabilityMask, false);
    offset += 2;
    view.setUint16(offset, 0, false);
    offset += 2;
    for (const field of MOTION_VALUE_FIELDS) {
      view.setFloat64(offset, sample[field] ?? 0, false);
      offset += 8;
    }
  });
  return bytes;
}

export function clearMotionSamples(samples) {
  if (!Array.isArray(samples)) return;
  for (const sample of samples) {
    for (const field of MOTION_VALUE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(sample, field)) {
        sample[field] = null;
      }
    }
    if (Object.prototype.hasOwnProperty.call(sample, "sequence")) {
      sample.sequence = null;
    }
  }
  samples.length = 0;
}
