// 段階6.5の実機調整専用。最新1回分だけをDOMへ表示し、保存・送信しない。
export const STAGE65_DIAGNOSTIC_ELEMENT_IDS = Object.freeze([
  "diagnostics-status",
  "diagnostics-input-mode",
  "diagnostics-reason",
  "diagnostics-sample-count",
  "diagnostics-motion-duration",
  "diagnostics-max-acceleration",
  "diagnostics-max-gravity-deviation",
  "diagnostics-max-rotation",
  "diagnostics-arming-duration",
  "diagnostics-arming-ignored-count",
  "diagnostics-active-sample-count",
  "diagnostics-active-window",
  "diagnostics-first-active-acceleration",
  "diagnostics-first-active-rotation",
  "diagnostics-detection-start-reason",
  "diagnostics-pointer-duration",
  "diagnostics-pointer-move-count",
  "diagnostics-pointer-distance",
  "diagnostics-clear-button",
]);

const EMPTY_VALUE = "—";

const STATE_LABELS = Object.freeze({
  "requesting-motion-permission": "許可確認中",
  "arming-motion": "準備中（arming）",
  "waiting-for-motion": "振る操作待ち",
  "detecting-motion": "動作検出中",
  "collecting-motion": "モーション取得中",
  "validating-motion": "モーション取得内容を確認中",
  "retry-required": "モーション再試行が必要",
  "waiting-for-pointer": "Pointer入力待機中",
  "collecting-pointer": "Pointer取得中",
  "validating-pointer": "Pointer取得内容を確認中",
  "mixing-physical-source": "物理入力を混合中",
});

function formatNumber(value, fractionDigits = 2) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(fractionDigits)
    : EMPTY_VALUE;
}

function formatInteger(value) {
  return Number.isInteger(value) ? String(value) : EMPTY_VALUE;
}

function modeLabel(mode) {
  if (mode === "motion") return "モーション";
  if (mode === "pointer") return "Pointer";
  return EMPTY_VALUE;
}

export function createStage65Diagnostics(elements) {
  for (const id of STAGE65_DIAGNOSTIC_ELEMENT_IDS) {
    if (!elements?.[id]) {
      throw new Error(`stage 6.5 diagnostic element is missing: ${id}`);
    }
  }

  let currentMode = null;
  let currentReason = null;

  const renderMeasurement = (measurement = {}) => {
    if (Object.prototype.hasOwnProperty.call(measurement, "sampleCount")) {
      elements["diagnostics-sample-count"].textContent = formatInteger(
        measurement.sampleCount,
      );
    }
    if (Object.prototype.hasOwnProperty.call(measurement, "elapsedMs")) {
      elements["diagnostics-motion-duration"].textContent = formatNumber(
        measurement.elapsedMs,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(
        measurement,
        "maxAccelerationMagnitude",
      )
    ) {
      elements["diagnostics-max-acceleration"].textContent = formatNumber(
        measurement.maxAccelerationMagnitude,
        3,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(
        measurement,
        "maxGravityDeviation",
      )
    ) {
      elements["diagnostics-max-gravity-deviation"].textContent = formatNumber(
        measurement.maxGravityDeviation,
        3,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(
        measurement,
        "maxRotationMagnitude",
      )
    ) {
      elements["diagnostics-max-rotation"].textContent = formatNumber(
        measurement.maxRotationMagnitude,
        3,
      );
    }
    if (Object.prototype.hasOwnProperty.call(measurement, "armingDelayMs")) {
      elements["diagnostics-arming-duration"].textContent = formatNumber(
        measurement.armingDelayMs,
        0,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(
        measurement,
        "armingIgnoredSampleCount",
      )
    ) {
      elements["diagnostics-arming-ignored-count"].textContent = formatInteger(
        measurement.armingIgnoredSampleCount,
      );
    }
    if (Object.prototype.hasOwnProperty.call(measurement, "activeSampleCount")) {
      elements["diagnostics-active-sample-count"].textContent = formatInteger(
        measurement.activeSampleCount,
      );
    }
    if (Object.prototype.hasOwnProperty.call(measurement, "activeWindowMs")) {
      elements["diagnostics-active-window"].textContent = formatNumber(
        measurement.activeWindowMs,
      );
    }
    if (
      Object.prototype.hasOwnProperty.call(
        measurement,
        "firstActiveAccelerationMagnitude",
      )
    ) {
      elements["diagnostics-first-active-acceleration"].textContent =
        formatNumber(measurement.firstActiveAccelerationMagnitude, 3);
    }
    if (
      Object.prototype.hasOwnProperty.call(
        measurement,
        "firstActiveRotationMagnitude",
      )
    ) {
      elements["diagnostics-first-active-rotation"].textContent =
        formatNumber(measurement.firstActiveRotationMagnitude, 3);
    }
    if (
      Object.prototype.hasOwnProperty.call(
        measurement,
        "detectionStartReason",
      )
    ) {
      elements["diagnostics-detection-start-reason"].textContent =
        typeof measurement.detectionStartReason === "string"
          ? measurement.detectionStartReason
          : EMPTY_VALUE;
    }
    if (Object.prototype.hasOwnProperty.call(measurement, "durationMs")) {
      elements["diagnostics-pointer-duration"].textContent = formatNumber(
        measurement.durationMs,
      );
    }
    if (Object.prototype.hasOwnProperty.call(measurement, "moveCount")) {
      elements["diagnostics-pointer-move-count"].textContent = formatInteger(
        measurement.moveCount,
      );
    }
    if (Object.prototype.hasOwnProperty.call(measurement, "totalDistancePx")) {
      elements["diagnostics-pointer-distance"].textContent = formatNumber(
        measurement.totalDistancePx,
      );
    }
    if (typeof measurement.completionReason === "string") {
      currentReason = measurement.completionReason;
      elements["diagnostics-reason"].textContent = currentReason;
    }
  };

  const diagnostics = {
    clear() {
      currentMode = null;
      currentReason = null;
      elements["diagnostics-status"].textContent = "未測定";
      elements["diagnostics-input-mode"].textContent = EMPTY_VALUE;
      elements["diagnostics-reason"].textContent = EMPTY_VALUE;
      for (const id of [
        "diagnostics-sample-count",
        "diagnostics-motion-duration",
        "diagnostics-max-acceleration",
        "diagnostics-max-gravity-deviation",
        "diagnostics-max-rotation",
        "diagnostics-arming-duration",
        "diagnostics-arming-ignored-count",
        "diagnostics-active-sample-count",
        "diagnostics-active-window",
        "diagnostics-first-active-acceleration",
        "diagnostics-first-active-rotation",
        "diagnostics-detection-start-reason",
        "diagnostics-pointer-duration",
        "diagnostics-pointer-move-count",
        "diagnostics-pointer-distance",
      ]) {
        elements[id].textContent = EMPTY_VALUE;
      }
    },

    begin(mode) {
      diagnostics.clear();
      currentMode = mode;
      elements["diagnostics-input-mode"].textContent = modeLabel(mode);
      elements["diagnostics-status"].textContent = "測定開始";
    },

    update(mode, state, measurement = {}) {
      currentMode = mode;
      elements["diagnostics-input-mode"].textContent = modeLabel(mode);
      elements["diagnostics-status"].textContent =
        STATE_LABELS[state] ?? state;
      renderMeasurement(measurement);
    },

    complete(mode) {
      currentMode = mode;
      elements["diagnostics-input-mode"].textContent = modeLabel(mode);
      elements["diagnostics-status"].textContent = "成功";
      if (currentReason === null || currentReason === "collecting") {
        currentReason = "fortune-completed";
        elements["diagnostics-reason"].textContent = currentReason;
      }
    },

    fail(mode, error) {
      currentMode = mode;
      elements["diagnostics-input-mode"].textContent = modeLabel(mode);
      renderMeasurement(error?.measurement ?? {});
      elements["diagnostics-status"].textContent = "失敗";
      currentReason = `${error?.code ?? "error"}: ${error?.message ?? "不明なエラー"}`;
      elements["diagnostics-reason"].textContent = currentReason;
    },

    snapshot() {
      return {
        mode: currentMode,
        reason: currentReason,
      };
    },
  };

  elements["diagnostics-clear-button"].addEventListener("click", () =>
    diagnostics.clear(),
  );
  diagnostics.clear();
  return diagnostics;
}
