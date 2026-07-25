import { createPhysicalInputProvider } from "./physical-source.mjs";
import {
  STAGE65_DIAGNOSTIC_ELEMENT_IDS,
  createStage65Diagnostics,
} from "./diagnostics.mjs";

export const DIAGNOSTICS_PAGE_ELEMENT_IDS = Object.freeze([
  "diagnostics-motion-button",
  "diagnostics-operation-status",
  "diagnostics-pointer-panel",
  "diagnostics-pointer-reason",
  "diagnostics-pointer-button",
  "diagnostics-pointer-area",
  ...STAGE65_DIAGNOSTIC_ELEMENT_IDS,
]);

function collectElements(documentObject) {
  return Object.fromEntries(
    DIAGNOSTICS_PAGE_ELEMENT_IDS.map((id) => {
      const element = documentObject.getElementById(id);
      if (!element) throw new Error(`diagnostic element is missing: ${id}`);
      return [id, element];
    }),
  );
}

function setStatus(element, message, { error = false, success = false } = {}) {
  element.textContent = error ? `エラー: ${message}` : message;
  element.dataset.state = error ? "error" : success ? "success" : "info";
  element.setAttribute("role", error ? "alert" : "status");
}

export function createDiagnosticsApp({
  document: documentObject,
  elements = collectElements(documentObject),
  byteSourceProvider = createPhysicalInputProvider({
    pointerElement: elements["diagnostics-pointer-area"],
  }),
} = {}) {
  const diagnosticView = createStage65Diagnostics(elements);
  const state = { inProgress: false, pointerFallbackOffered: false };

  const onInputState = (mode, inputState, detail = {}) => {
    diagnosticView.update(mode, inputState, detail);
    const messages = {
      "requesting-motion-permission": "許可確認中です。",
      "arming-motion": "準備中です。この間の動きは判定に使いません。",
      "waiting-for-motion": "今、iPhoneを軽く振ってください。",
      "detecting-motion": `動作検出中です。active sample ${detail.activeSampleCount ?? 0}件。`,
      "collecting-motion": `モーションsample ${detail.sampleCount ?? 0}件を収集中です。`,
      "validating-motion": "モーション入力を確認しています。",
      "waiting-for-pointer": "専用領域を1本の指で短時間なぞってください。",
      "collecting-pointer": `Pointer sample ${detail.sampleCount ?? 0}件を収集中です。`,
      "validating-pointer": "Pointer入力を確認しています。",
      "mixing-physical-source": "物理入力とWeb Cryptoを混合しています。",
    };
    setStatus(
      elements["diagnostics-operation-status"],
      messages[inputState] ?? "物理入力を処理しています。",
    );
  };

  const app = {
    async run(mode) {
      if (state.inProgress) return false;
      if (mode === "pointer" && !state.pointerFallbackOffered) {
        setStatus(
          elements["diagnostics-operation-status"],
          "Pointer診断はモーションセンサーを利用できない場合にだけ開始できます。",
          { error: true },
        );
        return false;
      }

      state.inProgress = true;
      elements["diagnostics-motion-button"].disabled = true;
      elements["diagnostics-pointer-button"].disabled = true;
      diagnosticView.begin(mode);
      if (mode === "motion") {
        state.pointerFallbackOffered = false;
        elements["diagnostics-pointer-panel"].hidden = true;
      }

      let source = null;
      try {
        source = await byteSourceProvider({
          mode,
          onState: (inputState, detail) =>
            onInputState(mode, inputState, detail),
        });
        await source.nextByte();
        diagnosticView.complete(mode);
        setStatus(
          elements["diagnostics-operation-status"],
          "完了しました。物理入力は占い結果やPromptへ使用していません。",
          { success: true },
        );
        return true;
      } catch (error) {
        diagnosticView.fail(mode, error);
        setStatus(elements["diagnostics-operation-status"], error.message, {
          error: true,
        });
        if (mode === "motion" && error?.fallbackAllowed === true) {
          state.pointerFallbackOffered = true;
          elements["diagnostics-pointer-panel"].hidden = false;
          setStatus(elements["diagnostics-pointer-reason"], error.message, {
            error: true,
          });
        }
        return false;
      } finally {
        source?.dispose?.();
        source = null;
        state.inProgress = false;
        elements["diagnostics-motion-button"].disabled = false;
        elements["diagnostics-pointer-button"].disabled = false;
      }
    },
  };

  elements["diagnostics-motion-button"].addEventListener("click", () =>
    app.run("motion"),
  );
  elements["diagnostics-pointer-button"].addEventListener("click", () =>
    app.run("pointer"),
  );
  elements["diagnostics-pointer-panel"].hidden = true;
  return app;
}

if (typeof document !== "undefined") {
  const start = () => {
    try {
      createDiagnosticsApp({ document });
    } catch (error) {
      const status = document.getElementById("diagnostics-operation-status");
      if (status) setStatus(status, error.message, { error: true });
    }
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
