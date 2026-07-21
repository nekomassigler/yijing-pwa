// すべて暫定値。iPhone 16 / 対象iOSでの実測後に確定する。
export const POINTER_MIN_DURATION_MS = 96;
export const POINTER_MIN_MOVE_COUNT = 3;
export const POINTER_MIN_DISTANCE_PX = 24;
export const POINTER_TUNING_STATUS =
  "provisional-awaiting-iphone16-ios-measurement";

export const POINTER_DOMAIN = "yijing-pwa-pointer-v1";
export const POINTER_CANONICAL_VERSION = 1;

const POINTER_VALUE_FIELDS = Object.freeze([
  "timeStamp",
  "relativeTime",
  "deltaTime",
  "x",
  "y",
  "pressure",
  "width",
  "height",
  "tiltX",
  "tiltY",
  "twist",
]);

const EVENT_TYPE_CODES = Object.freeze({
  pointerdown: 1,
  pointermove: 2,
  pointerup: 3,
});

const POINTER_TYPE_CODES = Object.freeze({
  touch: 1,
  pen: 2,
  mouse: 3,
});

function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pointerTypeCode(value) {
  return POINTER_TYPE_CODES[value] ?? 0;
}

function snapshotPointerEvent(
  type,
  event,
  sequence,
  startTimeStamp,
  previousTimeStamp,
  rect,
) {
  const timeStamp = finiteOrNull(event?.timeStamp);
  const clientX = finiteOrNull(event?.clientX);
  const clientY = finiteOrNull(event?.clientY);
  if (timeStamp === null || clientX === null || clientY === null) {
    throw new PointerInputError(
      "pointer-values-unavailable",
      "Pointer入力の時刻または座標を取得できませんでした。",
      { retryRecommended: true },
    );
  }
  const left = finiteOrNull(rect?.left) ?? 0;
  const top = finiteOrNull(rect?.top) ?? 0;
  return {
    sequence,
    eventType: type,
    eventTypeCode: EVENT_TYPE_CODES[type],
    pointerId: event.pointerId,
    pointerTypeCode: pointerTypeCode(event.pointerType),
    isPrimary: event.isPrimary !== false,
    timeStamp,
    relativeTime: timeStamp - startTimeStamp,
    deltaTime: sequence === 0 ? 0 : timeStamp - previousTimeStamp,
    x: clientX - left,
    y: clientY - top,
    pressure: finiteOrNull(event.pressure),
    width: finiteOrNull(event.width),
    height: finiteOrNull(event.height),
    tiltX: finiteOrNull(event.tiltX),
    tiltY: finiteOrNull(event.tiltY),
    twist: finiteOrNull(event.twist),
  };
}

export class PointerInputError extends Error {
  constructor(
    code,
    message,
    { retryRecommended = true, measurement = null, cause } = {},
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PointerInputError";
    this.code = code;
    this.retryRecommended = retryRecommended;
    this.fallbackAllowed = false;
    this.measurement = measurement;
  }
}

export class PointerCaptureSession {
  constructor({
    minDurationMs = POINTER_MIN_DURATION_MS,
    minMoveCount = POINTER_MIN_MOVE_COUNT,
    minDistancePx = POINTER_MIN_DISTANCE_PX,
  } = {}) {
    this.minDurationMs = minDurationMs;
    this.minMoveCount = minMoveCount;
    this.minDistancePx = minDistancePx;
    this.phase = "waiting-for-pointer";
    this.pointerId = null;
    this.startTimeStamp = null;
    this.previousTimeStamp = null;
    this.samples = [];
    this.moveCount = 0;
    this.totalDistance = 0;
    this.previousPosition = null;
    this.lastDuration = null;
  }

  measurement(completionReason) {
    return {
      inputMode: "pointer",
      sampleCount: this.samples.length,
      durationMs: this.lastDuration,
      moveCount: this.moveCount,
      totalDistancePx: this.totalDistance,
      completionReason,
    };
  }

  ingest(type, event, rect = { left: 0, top: 0 }) {
    if (!(type in EVENT_TYPE_CODES) && type !== "pointercancel") {
      throw new PointerInputError("pointer-event-invalid", "未対応のPointerイベントです。", {
        measurement: this.measurement("pointer-event-invalid"),
      });
    }
    if (this.phase === "completed" || this.phase === "rejected") {
      throw new PointerInputError("session-finished", "Pointer入力は終了しています。", {
        measurement: this.measurement("session-finished"),
      });
    }
    if (type === "pointercancel") {
      const cancelTimeStamp = finiteOrNull(event?.timeStamp);
      if (this.startTimeStamp !== null && cancelTimeStamp !== null) {
        this.lastDuration = cancelTimeStamp - this.startTimeStamp;
      }
      this.phase = "rejected";
      throw new PointerInputError(
        "pointer-cancelled",
        "Pointer入力が中断されました。もう一度なぞってください。",
        { measurement: this.measurement("pointer-cancelled") },
      );
    }

    if (type === "pointerdown") {
      if (this.phase !== "waiting-for-pointer" || this.pointerId !== null) {
        this.phase = "rejected";
        throw new PointerInputError(
          "multiple-pointers",
          "複数の指が検出されました。1本の指でもう一度なぞってください。",
          { measurement: this.measurement("multiple-pointers") },
        );
      }
      if (event?.isPrimary === false || !Number.isInteger(event?.pointerId)) {
        this.phase = "rejected";
        throw new PointerInputError(
          "multiple-pointers",
          "主Pointer以外は使用できません。1本の指でもう一度なぞってください。",
          { measurement: this.measurement("multiple-pointers") },
        );
      }
      const startTimeStamp = finiteOrNull(event.timeStamp);
      if (startTimeStamp === null) {
        throw new PointerInputError(
          "pointer-values-unavailable",
          "Pointer入力の時刻を取得できませんでした。",
          { measurement: this.measurement("pointer-values-unavailable") },
        );
      }
      this.phase = "collecting-pointer";
      this.pointerId = event.pointerId;
      this.startTimeStamp = startTimeStamp;
      this.previousTimeStamp = startTimeStamp;
      this.lastDuration = 0;
      const sample = snapshotPointerEvent(
        type,
        event,
        0,
        startTimeStamp,
        startTimeStamp,
        rect,
      );
      this.samples.push(sample);
      this.previousPosition = { x: sample.x, y: sample.y };
      return {
        status: "collecting-pointer",
        measurement: this.measurement("collecting"),
      };
    }

    if (this.phase !== "collecting-pointer") {
      throw new PointerInputError(
        "pointer-sequence-invalid",
        "Pointer入力は専用領域内から開始してください。",
        { measurement: this.measurement("pointer-sequence-invalid") },
      );
    }
    if (event?.pointerId !== this.pointerId || event?.isPrimary === false) {
      this.phase = "rejected";
      throw new PointerInputError(
        "multiple-pointers",
        "複数の指が検出されました。1本の指でもう一度なぞってください。",
        { measurement: this.measurement("multiple-pointers") },
      );
    }

    const sample = snapshotPointerEvent(
      type,
      event,
      this.samples.length,
      this.startTimeStamp,
      this.previousTimeStamp,
      rect,
    );
    const distance = Math.hypot(
      sample.x - this.previousPosition.x,
      sample.y - this.previousPosition.y,
    );
    this.totalDistance += distance;
    this.previousPosition = { x: sample.x, y: sample.y };
    this.previousTimeStamp = sample.timeStamp;
    this.samples.push(sample);
    const duration = sample.timeStamp - this.startTimeStamp;
    this.lastDuration = duration;

    if (type === "pointermove") {
      this.moveCount += 1;
      return {
        status: "collecting-pointer",
        measurement: this.measurement("collecting"),
      };
    }

    if (this.moveCount === 0) {
      this.phase = "rejected";
      throw new PointerInputError(
        "pointer-tap-only",
        "単一タップでは入力できません。領域を指で短時間なぞってください。",
        { measurement: this.measurement("pointer-tap-only") },
      );
    }
    if (
      duration < this.minDurationMs ||
      this.moveCount < this.minMoveCount ||
      this.totalDistance < this.minDistancePx
    ) {
      this.phase = "rejected";
      throw new PointerInputError(
        "pointer-input-insufficient",
        "なぞる時間、move件数、または移動量が不足しています。もう一度なぞってください。",
        { measurement: this.measurement("pointer-input-insufficient") },
      );
    }
    this.phase = "completed";
    return {
      status: "completed",
      samples: this.samples.map((item) => ({ ...item })),
      duration,
      moveCount: this.moveCount,
      totalDistance: this.totalDistance,
      measurement: this.measurement("requirements-met"),
    };
  }
}

export function collectPointerSamples({
  element,
  signal,
  onState = () => {},
  session = new PointerCaptureSession(),
} = {}) {
  if (
    !element ||
    typeof element.addEventListener !== "function" ||
    typeof element.removeEventListener !== "function"
  ) {
    return Promise.reject(
      new PointerInputError(
        "pointer-api-unavailable",
        "Pointer入力領域を利用できません。",
      ),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let capturedPointerId = null;
    const eventTypes = ["pointerdown", "pointermove", "pointerup", "pointercancel"];

    const releaseCapture = () => {
      if (capturedPointerId === null) return;
      try {
        if (element.hasPointerCapture?.(capturedPointerId) !== false) {
          element.releasePointerCapture?.(capturedPointerId);
        }
      } catch {
        // captureが既に解放済みでも、listenerの後処理は継続する。
      }
      capturedPointerId = null;
    };
    const cleanup = () => {
      eventTypes.forEach((type) => element.removeEventListener(type, handlePointer));
      signal?.removeEventListener?.("abort", handleAbort);
      releaseCapture();
      clearPointerSamples(session.samples);
      session.pointerId = null;
      session.startTimeStamp = null;
      session.previousTimeStamp = null;
      session.previousPosition = null;
      session.totalDistance = 0;
      session.moveCount = 0;
      session.lastDuration = null;
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
      finishReject(new PointerInputError("aborted", "Pointer入力を中止しました。"));
    };
    const handlePointer = (event) => {
      event.preventDefault?.();
      try {
        if (event.type === "pointerdown" && capturedPointerId === null) {
          element.setPointerCapture?.(event.pointerId);
          capturedPointerId = event.pointerId;
        }
        const outcome = session.ingest(
          event.type,
          event,
          element.getBoundingClientRect?.() ?? { left: 0, top: 0 },
        );
        if (outcome.status === "collecting-pointer") {
          onState("collecting-pointer", {
            ...outcome.measurement,
          });
        } else if (outcome.status === "completed") {
          onState("validating-pointer", {
            ...outcome.measurement,
          });
          finishResolve(outcome.samples);
        }
      } catch (error) {
        finishReject(error);
      }
    };

    if (signal?.aborted) {
      handleAbort();
      return;
    }
    eventTypes.forEach((type) => element.addEventListener(type, handlePointer));
    signal?.addEventListener?.("abort", handleAbort, { once: true });
    onState("waiting-for-pointer");
  });
}

export function encodePointerSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new PointerInputError("invalid-samples", "Pointer sampleがありません。");
  }
  const headerSize = 8;
  const sampleHeaderSize = 16;
  const sampleSize = sampleHeaderSize + POINTER_VALUE_FIELDS.length * 8;
  const bytes = new Uint8Array(headerSize + samples.length * sampleSize);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  view.setUint16(offset, POINTER_CANONICAL_VERSION, false);
  offset += 2;
  view.setUint16(offset, POINTER_VALUE_FIELDS.length, false);
  offset += 2;
  view.setUint32(offset, samples.length, false);
  offset += 4;

  samples.forEach((sample, sampleIndex) => {
    if (
      sample.sequence !== sampleIndex ||
      !Number.isInteger(sample.pointerId) ||
      !(sample.eventType in EVENT_TYPE_CODES) ||
      EVENT_TYPE_CODES[sample.eventType] !== sample.eventTypeCode
    ) {
      throw new PointerInputError("invalid-samples", "Pointer sampleの識別情報が不正です。");
    }
    view.setUint32(offset, sample.sequence, false);
    offset += 4;
    view.setInt32(offset, sample.pointerId, false);
    offset += 4;
    view.setUint8(offset, sample.eventTypeCode);
    offset += 1;
    view.setUint8(offset, sample.pointerTypeCode);
    offset += 1;
    view.setUint8(offset, sample.isPrimary ? 1 : 0);
    offset += 1;
    view.setUint8(offset, 0);
    offset += 1;
    let availabilityMask = 0;
    POINTER_VALUE_FIELDS.forEach((field, fieldIndex) => {
      const value = sample[field];
      if (value !== null && typeof value === "number" && Number.isFinite(value)) {
        availabilityMask |= 1 << fieldIndex;
      } else if (value !== null) {
        throw new PointerInputError(
          "invalid-samples",
          `Pointer sampleの${field}が不正です。`,
        );
      }
    });
    view.setUint16(offset, availabilityMask, false);
    offset += 2;
    view.setUint16(offset, 0, false);
    offset += 2;
    for (const field of POINTER_VALUE_FIELDS) {
      view.setFloat64(offset, sample[field] ?? 0, false);
      offset += 8;
    }
  });
  return bytes;
}

export function clearPointerSamples(samples) {
  if (!Array.isArray(samples)) return;
  for (const sample of samples) {
    for (const field of POINTER_VALUE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(sample, field)) {
        sample[field] = null;
      }
    }
    for (const field of [
      "sequence",
      "eventType",
      "eventTypeCode",
      "pointerId",
      "pointerTypeCode",
      "isPrimary",
    ]) {
      if (Object.prototype.hasOwnProperty.call(sample, field)) {
        sample[field] = null;
      }
    }
  }
  samples.length = 0;
}
