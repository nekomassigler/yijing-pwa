export const SENSOR_CAPTURE_MIN_DURATION_MS = 128;
export const SENSOR_CAPTURE_MAX_DURATION_MS = 256;

// 第2回 iPhone 16 / 対象iOS実測用の暫定値。最終値ではない。
export const SENSOR_MIN_SAMPLE_COUNT = 6;
export const SENSOR_ARMING_DELAY_MS = 600;
export const SENSOR_MOTION_THRESHOLD = 1.2;
export const SENSOR_ROTATION_THRESHOLD = 40;
export const SENSOR_ACTIVE_SAMPLE_COUNT = 2;
export const SENSOR_ACTIVE_WINDOW_MS = 120;
export const SENSOR_WAIT_FOR_MOTION_TIMEOUT_MS = 5000;
export const SENSOR_TUNING_STATUS =
  "provisional-awaiting-second-iphone16-ios-measurement";

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

function largerFinite(current, candidate) {
  if (candidate === null) return current;
  return current === null ? candidate : Math.max(current, candidate);
}

export function measureMotionEvent(event) {
  const values = readMotionValues(event);
  const gravityMagnitude = magnitude(
    [values.gravityX, values.gravityY, values.gravityZ],
    { requireAll: true },
  );
  return {
    accelerationMagnitude: magnitude([
      values.accelerationX,
      values.accelerationY,
      values.accelerationZ,
    ]),
    gravityDeviation:
      gravityMagnitude === null
        ? null
        : Math.abs(gravityMagnitude - STANDARD_GRAVITY),
    rotationMagnitude: magnitude([
      values.rotationAlpha,
      values.rotationBeta,
      values.rotationGamma,
    ]),
  };
}

export class MotionInputError extends Error {
  constructor(
    code,
    message,
    {
      fallbackAllowed = false,
      retryRecommended = false,
      measurement = null,
      cause,
    } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "MotionInputError";
    this.code = code;
    this.fallbackAllowed = fallbackAllowed;
    this.retryRecommended = retryRecommended;
    this.measurement = measurement;
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
  return classifyMotionActivity(event, {
    motionThreshold,
    rotationThreshold,
  }).active;
}

export function classifyMotionActivity(event, {
  motionThreshold = SENSOR_MOTION_THRESHOLD,
  rotationThreshold = SENSOR_ROTATION_THRESHOLD,
} = {}) {
  const metrics = measureMotionEvent(event);
  const reasons = [];
  if (
    metrics.accelerationMagnitude !== null &&
    metrics.accelerationMagnitude >= motionThreshold
  ) {
    reasons.push("acceleration");
  }
  if (
    metrics.gravityDeviation !== null &&
    metrics.gravityDeviation >= motionThreshold
  ) {
    reasons.push("gravity-deviation");
  }
  if (
    metrics.rotationMagnitude !== null &&
    metrics.rotationMagnitude >= rotationThreshold
  ) {
    reasons.push("rotation");
  }
  return { active: reasons.length > 0, reasons, metrics };
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
    armingDelayMs = SENSOR_ARMING_DELAY_MS,
    activeSampleCount = SENSOR_ACTIVE_SAMPLE_COUNT,
    activeWindowMs = SENSOR_ACTIVE_WINDOW_MS,
  } = {}) {
    this.minDurationMs = minDurationMs;
    this.maxDurationMs = maxDurationMs;
    this.minSampleCount = minSampleCount;
    this.motionThreshold = motionThreshold;
    this.rotationThreshold = rotationThreshold;
    this.armingDelayMs = armingDelayMs;
    this.requiredActiveSampleCount = activeSampleCount;
    this.activeWindowLimitMs = activeWindowMs;
    this.phase = "arming-motion";
    this.samples = [];
    this.armingIgnoredSampleCount = 0;
    this.eventCount = 0;
    this.usableEventCount = 0;
    this.startTimeStamp = null;
    this.previousTimeStamp = null;
    this.lastElapsed = null;
    this.maxAccelerationMagnitude = null;
    this.maxGravityDeviation = null;
    this.maxRotationMagnitude = null;
    this.activeSampleCount = 0;
    this.firstActiveTimeStamp = null;
    this.activeWindowElapsedMs = null;
    this.firstActiveAccelerationMagnitude = null;
    this.firstActiveRotationMagnitude = null;
    this.activeReasons = new Set();
    this.detectionStartReason = null;
  }

  resetActiveCandidate() {
    this.activeSampleCount = 0;
    this.firstActiveTimeStamp = null;
    this.activeWindowElapsedMs = null;
    this.firstActiveAccelerationMagnitude = null;
    this.firstActiveRotationMagnitude = null;
    this.activeReasons.clear();
    this.detectionStartReason = null;
  }

  completeArming() {
    if (this.phase !== "arming-motion") {
      throw new MotionInputError(
        "arming-already-completed",
        "モーション入力の準備期間は既に終了しています。",
      );
    }
    clearMotionSamples(this.samples);
    this.eventCount = 0;
    this.usableEventCount = 0;
    this.startTimeStamp = null;
    this.previousTimeStamp = null;
    this.lastElapsed = null;
    this.maxAccelerationMagnitude = null;
    this.maxGravityDeviation = null;
    this.maxRotationMagnitude = null;
    this.resetActiveCandidate();
    this.phase = "waiting-for-motion";
    return this.measurement("arming-completed");
  }

  expireActiveCandidate(timeStamp) {
    if (
      this.activeSampleCount === 0 ||
      this.firstActiveTimeStamp === null ||
      timeStamp === null ||
      timeStamp - this.firstActiveTimeStamp <= this.activeWindowLimitMs
    ) {
      return false;
    }
    this.resetActiveCandidate();
    return true;
  }

  recordActiveSample(timeStamp, activity) {
    this.expireActiveCandidate(timeStamp);
    if (this.activeSampleCount === 0) {
      this.firstActiveTimeStamp = timeStamp;
      this.firstActiveAccelerationMagnitude =
        activity.metrics.accelerationMagnitude;
      this.firstActiveRotationMagnitude = activity.metrics.rotationMagnitude;
    }
    this.activeSampleCount += 1;
    this.activeWindowElapsedMs = timeStamp - this.firstActiveTimeStamp;
    for (const reason of activity.reasons) {
      this.activeReasons.add(reason);
    }
    if (this.activeSampleCount >= this.requiredActiveSampleCount) {
      const reasonOrder = ["acceleration", "gravity-deviation", "rotation"];
      const sources = reasonOrder.filter((reason) => this.activeReasons.has(reason));
      this.detectionStartReason =
        `active-sample-count-met:${sources.join("+")}`;
      return true;
    }
    return false;
  }

  observe(event) {
    const metrics = measureMotionEvent(event);
    this.maxAccelerationMagnitude = largerFinite(
      this.maxAccelerationMagnitude,
      metrics.accelerationMagnitude,
    );
    this.maxGravityDeviation = largerFinite(
      this.maxGravityDeviation,
      metrics.gravityDeviation,
    );
    this.maxRotationMagnitude = largerFinite(
      this.maxRotationMagnitude,
      metrics.rotationMagnitude,
    );
  }

  measurement(completionReason) {
    return {
      inputMode: "motion",
      sampleCount: this.samples.length,
      elapsedMs: this.lastElapsed,
      maxAccelerationMagnitude: this.maxAccelerationMagnitude,
      maxGravityDeviation: this.maxGravityDeviation,
      maxRotationMagnitude: this.maxRotationMagnitude,
      armingDelayMs: this.armingDelayMs,
      armingIgnoredSampleCount: this.armingIgnoredSampleCount,
      activeSampleCount: this.activeSampleCount,
      activeWindowMs: this.activeWindowElapsedMs,
      activeWindowLimitMs: this.activeWindowLimitMs,
      firstActiveAccelerationMagnitude:
        this.firstActiveAccelerationMagnitude,
      firstActiveRotationMagnitude: this.firstActiveRotationMagnitude,
      detectionStartReason: this.detectionStartReason,
      completionReason,
    };
  }

  ingest(event) {
    if (this.phase === "completed" || this.phase === "retry-required") {
      throw new MotionInputError("session-finished", "モーション収集は終了しています。");
    }
    if (this.phase === "arming-motion") {
      this.armingIgnoredSampleCount += 1;
      return {
        status: "arming-motion",
        started: false,
        measurement: this.measurement("arming"),
      };
    }
    this.eventCount += 1;
    this.observe(event);
    const usable = hasUsableMotionValues(event);
    if (usable) {
      this.usableEventCount += 1;
    }

    if (this.phase === "waiting-for-motion") {
      const timeStamp = finiteOrNull(event?.timeStamp);
      const activeWindowExpired = this.expireActiveCandidate(timeStamp);
      if (!usable) {
        return {
          status: this.activeSampleCount > 0
            ? "detecting-motion"
            : "waiting-for-motion",
          started: false,
          activeWindowExpired,
          measurement: this.measurement(
            this.activeSampleCount > 0 ? "active-sample-pending" : "waiting",
          ),
        };
      }
      const activity = classifyMotionActivity(event, {
        motionThreshold: this.motionThreshold,
        rotationThreshold: this.rotationThreshold,
      });
      if (!activity.active) {
        return {
          status: this.activeSampleCount > 0
            ? "detecting-motion"
            : "waiting-for-motion",
          started: false,
          activeWindowExpired,
          measurement: this.measurement(
            this.activeSampleCount > 0 ? "active-sample-pending" : "waiting",
          ),
        };
      }
      if (timeStamp === null) {
        throw new MotionInputError(
          "values-unavailable",
          "有効なモーションイベント時刻を取得できませんでした。",
          {
            fallbackAllowed: true,
            measurement: this.measurement("values-unavailable"),
          },
        );
      }
      if (!this.recordActiveSample(timeStamp, activity)) {
        return {
          status: "detecting-motion",
          started: false,
          measurement: this.measurement("active-sample-pending"),
        };
      }
      this.phase = "collecting-motion";
      this.startTimeStamp = timeStamp;
      this.previousTimeStamp = timeStamp;
      this.lastElapsed = 0;
      this.samples.push(snapshotMotionEvent(event, 0, timeStamp, timeStamp));
      return {
        status: "collecting-motion",
        started: true,
        measurement: this.measurement("collecting"),
      };
    }

    if (!usable) {
      return {
        status: "collecting-motion",
        started: false,
        sampleCount: this.samples.length,
        measurement: this.measurement("collecting"),
      };
    }

    const timeStamp = finiteOrNull(event?.timeStamp);
    if (timeStamp === null) {
      return {
        status: "collecting-motion",
        started: false,
        sampleCount: this.samples.length,
        measurement: this.measurement("collecting"),
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
    this.lastElapsed = elapsed;
    if (
      elapsed >= this.minDurationMs &&
      this.samples.length >= this.minSampleCount
    ) {
      this.phase = "completed";
      return {
        status: "completed",
        samples: this.samples.map((sample) => ({ ...sample })),
        elapsed,
        measurement: this.measurement("requirements-met"),
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
      measurement: this.measurement("collecting"),
    };
  }

  waitingFailure() {
    if (this.eventCount === 0) {
      return new MotionInputError(
        "event-unavailable",
        "モーションイベントを取得できませんでした。",
        {
          fallbackAllowed: true,
          measurement: this.measurement("event-unavailable"),
        },
      );
    }
    if (this.usableEventCount === 0) {
      return new MotionInputError(
        "values-unavailable",
        "モーションイベントは届きましたが、有効な値を取得できませんでした。",
        {
          fallbackAllowed: true,
          measurement: this.measurement("values-unavailable"),
        },
      );
    }
    return new MotionInputError(
      "motion-not-detected",
      "有効な動きを検出できませんでした。強く振らず、もう一度軽く振ってください。",
      {
        retryRecommended: true,
        measurement: this.measurement("motion-not-detected"),
      },
    );
  }

  captureFailure(elapsedMs = this.lastElapsed) {
    const measurement = this.measurement("sample-insufficient");
    measurement.elapsedMs = elapsedMs;
    return new MotionInputError(
      "sample-insufficient",
      `最大${this.maxDurationMs}msまでに必要なモーションsample数を取得できませんでした。もう一度軽く振ってください。`,
      {
        retryRecommended: true,
        measurement,
      },
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
  armingDelayMs = session.armingDelayMs,
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

  if (!Number.isFinite(armingDelayMs) || armingDelayMs < 0) {
    return Promise.reject(
      new MotionInputError(
        "invalid-arming-delay",
        "モーション入力の準備時間が不正です。",
      ),
    );
  }
  session.armingDelayMs = armingDelayMs;

  return new Promise((resolve, reject) => {
    let armingTimer = null;
    let waitTimer = null;
    let captureTimer = null;
    let settled = false;

    const cleanup = () => {
      eventTarget.removeEventListener("devicemotion", handleMotion);
      signal?.removeEventListener?.("abort", handleAbort);
      if (armingTimer !== null) {
        clearTimeoutImplementation(armingTimer);
      }
      if (waitTimer !== null) {
        clearTimeoutImplementation(waitTimer);
      }
      if (captureTimer !== null) {
        clearTimeoutImplementation(captureTimer);
      }
      armingTimer = null;
      waitTimer = null;
      captureTimer = null;
      clearMotionSamples(session.samples);
      session.startTimeStamp = null;
      session.previousTimeStamp = null;
      session.lastElapsed = null;
      session.maxAccelerationMagnitude = null;
      session.maxGravityDeviation = null;
      session.maxRotationMagnitude = null;
      session.armingIgnoredSampleCount = 0;
      session.resetActiveCandidate();
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
      const error = session.captureFailure(session.maxDurationMs);
      onState("validating-motion", error.measurement);
      finishReject(error);
    };
    const handleWaitTimeout = () => {
      finishReject(session.waitingFailure());
    };
    const handleArmingComplete = () => {
      if (settled) return;
      armingTimer = null;
      try {
        const measurement = session.completeArming();
        onState("waiting-for-motion", measurement);
        waitTimer = setTimeoutImplementation(handleWaitTimeout, waitTimeoutMs);
      } catch (error) {
        finishReject(error);
      }
    };
    const handleMotion = (event) => {
      try {
        const outcome = session.ingest(event);
        if (outcome.status === "arming-motion") {
          onState("arming-motion", outcome.measurement);
        } else if (outcome.status === "detecting-motion") {
          onState("detecting-motion", outcome.measurement);
        } else if (
          outcome.status === "waiting-for-motion" &&
          outcome.activeWindowExpired
        ) {
          onState("waiting-for-motion", outcome.measurement);
        }
        if (outcome.started) {
          if (waitTimer !== null) {
            clearTimeoutImplementation(waitTimer);
            waitTimer = null;
          }
          onState("collecting-motion", {
            minSampleCount: session.minSampleCount,
            ...outcome.measurement,
          });
          captureTimer = setTimeoutImplementation(
            handleCaptureTimeout,
            session.maxDurationMs,
          );
        } else if (outcome.status === "collecting-motion") {
          onState("collecting-motion", {
            minSampleCount: session.minSampleCount,
            ...outcome.measurement,
          });
        }
        if (outcome.status === "completed") {
          onState("validating-motion", {
            ...outcome.measurement,
          });
          finishResolve(outcome.samples);
        } else if (outcome.status === "retry-required") {
          onState("retry-required", outcome.error.measurement);
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
    onState("arming-motion", session.measurement("arming"));
    armingTimer = setTimeoutImplementation(handleArmingComplete, armingDelayMs);
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
