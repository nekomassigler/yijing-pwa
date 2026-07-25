import { Hexagram, changingIndexToLineIndex } from "./domain.mjs";
import { loadHexagramData } from "./data.mjs";
import { makeInterpretPrompt, getPromptTemplateHelp } from "./prompt.mjs";
import { createPhysicalInputProvider } from "./physical-source.mjs";
import { performFortune } from "./rng.mjs";
import {
  createTemplateBackup,
  initializeTemplateRepository,
  loadInitialTemplatePayload,
  prepareTemplateImport,
} from "./templates.mjs";

const HEXAGRAM_DATA_URL = new URL("../data/hexagrams.json", import.meta.url);
const INITIAL_TEMPLATES_URL = new URL(
  "../data/prompt_templates.json",
  import.meta.url,
);

export const REQUIRED_ELEMENT_IDS = Object.freeze([
  "app-status",
  "theme-input",
  "fortune-button",
  "fortune-status",
  "pointer-fallback-panel",
  "pointer-fallback-reason",
  "pointer-start-button",
  "pointer-input-area",
  "pointer-status",
  "result-section",
  "primary-name",
  "changing-label",
  "changed-name",
  "primary-diagram-name",
  "changed-diagram-name",
  "primary-lines",
  "changed-lines",
  "primary-kaji",
  "primary-other",
  "primary-yao-summary",
  "primary-yao",
  "primary-yao-other",
  "changed-kaji",
  "changed-other",
  "prompt-section",
  "template-select",
  "template-management-select",
  "prompt-preview",
  "copy-prompt-button",
  "copy-status",
  "template-name-input",
  "template-body-input",
  "template-add-button",
  "template-rename-button",
  "template-save-button",
  "template-delete-button",
  "placeholder-help-list",
  "brace-help",
  "template-export-button",
  "template-import-file",
  "template-import-prepare-button",
  "template-import-summary",
  "template-import-apply-button",
  "template-status",
]);

const LINE_LABELS = Object.freeze(["初爻", "二爻", "三爻", "四爻", "五爻", "上爻"]);

const NOOP_DIAGNOSTICS = Object.freeze({
  begin() {},
  update() {},
  complete() {},
  fail() {},
});

function setStatus(element, message, { error = false, success = false } = {}) {
  element.textContent = error ? `エラー: ${message}` : message;
  element.dataset.state = error ? "error" : success ? "success" : "info";
  element.setAttribute("role", error ? "alert" : "status");
}

function requireDependency(value, name) {
  if (!value) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

export function collectAppElements(documentObject) {
  requireDependency(documentObject, "document");
  return Object.fromEntries(
    REQUIRED_ELEMENT_IDS.map((id) => {
      const element = documentObject.getElementById(id);
      if (!element) {
        throw new Error(`required element is missing: ${id}`);
      }
      return [id, element];
    }),
  );
}

export function renderHexagramLines(
  documentObject,
  container,
  lines,
  changingIndex,
) {
  const changingLineIndex = changingIndexToLineIndex(changingIndex);
  const rendered = [];
  for (let lineIndex = 5; lineIndex >= 0; lineIndex -= 1) {
    const bit = lines[lineIndex];
    const line = documentObject.createElement("div");
    const kind = bit === 0 ? "陽・実線" : "陰・分割線";
    line.classList.add("yao-line", bit === 0 ? "yang" : "yin");
    line.dataset.lineIndex = String(lineIndex);
    line.dataset.bit = String(bit);
    line.setAttribute("role", "img");
    line.setAttribute(
      "aria-label",
      `${LINE_LABELS[lineIndex]}: ${kind}${lineIndex === changingLineIndex ? "、変爻" : ""}`,
    );

    const segmentCount = bit === 0 ? 1 : 2;
    for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
      const segment = documentObject.createElement("span");
      segment.classList.add("yao-segment");
      segment.setAttribute("aria-hidden", "true");
      line.append(segment);
    }
    if (lineIndex === changingLineIndex) {
      line.classList.add("changing");
      const badge = documentObject.createElement("span");
      badge.classList.add("changing-badge");
      badge.textContent = "変";
      badge.setAttribute("aria-hidden", "true");
      line.append(badge);
    }
    rendered.push(line);
  }
  container.replaceChildren(...rendered);
  return rendered;
}

export function downloadTemplateBackup(
  documentObject,
  backup,
  {
    BlobImplementation = globalThis.Blob,
    urlImplementation = globalThis.URL,
  } = {},
) {
  if (
    typeof BlobImplementation !== "function" ||
    typeof urlImplementation?.createObjectURL !== "function" ||
    typeof urlImplementation?.revokeObjectURL !== "function"
  ) {
    throw new Error("この環境ではJSONファイルを作成できません。");
  }
  const blob = new BlobImplementation([backup.text], { type: backup.mimeType });
  const objectUrl = urlImplementation.createObjectURL(blob);
  const link = documentObject.createElement("a");
  link.href = objectUrl;
  link.download = backup.filename;
  link.hidden = true;
  documentObject.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    urlImplementation.revokeObjectURL(objectUrl);
  }
}

export function createApp({
  document: documentObject,
  elements = collectAppElements(documentObject),
  hexagramData,
  templateRepository,
  byteSourceProvider = null,
  diagnostics = null,
  clipboard = globalThis.navigator?.clipboard,
  confirmAction = globalThis.confirm?.bind(globalThis),
  downloadBackup = (backup) => downloadTemplateBackup(documentObject, backup),
} = {}) {
  requireDependency(documentObject, "document");
  requireDependency(hexagramData, "hexagramData");
  requireDependency(templateRepository, "templateRepository");
  const diagnosticView = diagnostics ?? NOOP_DIAGNOSTICS;

  const state = {
    result: null,
    preparedImport: null,
    inputInProgress: false,
    pointerFallbackOffered: false,
  };
  const getHexagramName = hexagramData.getHexagramName.bind(hexagramData);

  const renderPlaceholderHelp = () => {
    const help = getPromptTemplateHelp();
    const rows = [];
    for (const item of help.placeholders) {
      const term = documentObject.createElement("dt");
      term.textContent = item.placeholder;
      const description = documentObject.createElement("dd");
      description.textContent = `${item.label}: ${item.description}`;
      rows.push(term, description);
    }
    elements["placeholder-help-list"].replaceChildren(...rows);
    elements["brace-help"].textContent = `${help.braceEscape.syntax}: ${help.braceEscape.description}`;
  };

  const regeneratePrompt = () => {
    if (!state.result) {
      return false;
    }
    const payload = templateRepository.snapshot();
    try {
      elements["prompt-preview"].value = makeInterpretPrompt(
        state.result,
        payload.templates[payload.selected],
      );
      setStatus(elements["copy-status"], "選択中テンプレートからPromptを生成しました。");
      return true;
    } catch (error) {
      setStatus(elements["copy-status"], error.message, { error: true });
      return false;
    }
  };

  const refreshTemplateControls = ({ updatePrompt = true } = {}) => {
    const payload = templateRepository.snapshot();
    for (const selectId of ["template-select", "template-management-select"]) {
      const options = Object.keys(payload.templates).map((name) => {
        const option = documentObject.createElement("option");
        option.value = name;
        option.textContent = name;
        return option;
      });
      elements[selectId].replaceChildren(...options);
      elements[selectId].value = payload.selected;
    }
    elements["template-name-input"].value = payload.selected;
    elements["template-body-input"].value = payload.templates[payload.selected];
    if (updatePrompt) {
      regeneratePrompt();
    }
  };

  const renderResult = (result) => {
    const changed = new Hexagram(result.lines).changed(result.changing_idx);
    elements["primary-name"].textContent = result.primary;
    elements["changing-label"].textContent = result.var_kanji;
    elements["changed-name"].textContent = result.changed;
    elements["primary-diagram-name"].textContent = result.primary;
    elements["changed-diagram-name"].textContent = result.changed;
    renderHexagramLines(
      documentObject,
      elements["primary-lines"],
      result.lines,
      result.changing_idx,
    );
    renderHexagramLines(
      documentObject,
      elements["changed-lines"],
      changed.yinYang,
      result.changing_idx,
    );

    const primaryDescription = hexagramData.getHexagramDescription(result.primary);
    const yaoDescription = hexagramData.getPrimaryYaoDescription(
      result.primary,
      result.changing_idx,
    );
    const changedDescription = hexagramData.getHexagramDescription(result.changed);
    elements["primary-kaji"].textContent = primaryDescription.kaji;
    elements["primary-other"].textContent = primaryDescription.other;
    elements["primary-yao-summary"].textContent = `本卦の爻辞（${yaoDescription.position}）`;
    elements["primary-yao"].textContent = yaoDescription.yao;
    elements["primary-yao-other"].textContent = yaoDescription.other;
    elements["changed-kaji"].textContent = changedDescription.kaji;
    elements["changed-other"].textContent = changedDescription.other;
    elements["result-section"].hidden = false;
    elements["prompt-section"].hidden = false;
  };

  const runTemplateOperation = (operation, successMessage) => {
    try {
      operation();
      refreshTemplateControls();
      setStatus(elements["template-status"], successMessage, { success: true });
      return true;
    } catch (error) {
      setStatus(elements["template-status"], error.message, { error: true });
      return false;
    }
  };

  const app = {
    get result() {
      return state.result ? { ...state.result, lines: state.result.lines.slice() } : null;
    },

    async runPhysicalFortune(mode) {
      if (typeof byteSourceProvider !== "function") {
        setStatus(
          elements["fortune-status"],
          "物理入力はまだ接続されていません。結果は生成していません。",
          { error: true },
        );
        return null;
      }
      if (state.inputInProgress) {
        setStatus(
          elements["fortune-status"],
          "物理入力を取得中です。完了するまでお待ちください。",
          { error: true },
        );
        return null;
      }
      if (mode === "pointer" && !state.pointerFallbackOffered) {
        setStatus(
          elements["fortune-status"],
          "Pointer入力は、モーションセンサーを利用できない場合にだけ使用できます。",
          { error: true },
        );
        return null;
      }

      state.inputInProgress = true;
      diagnosticView.begin(mode);
      state.result = null;
      elements["fortune-button"].disabled = true;
      elements["pointer-start-button"].disabled = true;
      elements["result-section"].hidden = true;
      elements["prompt-section"].hidden = true;
      elements["prompt-preview"].value = "";
      if (mode === "motion") {
        state.pointerFallbackOffered = false;
        elements["pointer-fallback-panel"].hidden = true;
      }
      setStatus(
        elements["fortune-status"],
        mode === "motion"
          ? "許可確認中: モーションセンサーの利用可否を確認します。"
          : "準備中: Pointer入力を開始します。",
      );

      const onInputState = (inputState, detail = {}) => {
        diagnosticView.update(mode, inputState, detail);
        const messages = {
          "requesting-motion-permission":
            "許可確認中: モーションセンサーの利用許可を確認しています。",
          "arming-motion":
            "準備中: 端末を安定させています。この間に動かしても占いは開始しません。",
          "waiting-for-motion":
            "振る操作待ち: 今、iPhoneを軽く振ってください。強く振る必要はありません。",
          "detecting-motion":
            `動作検出中: active sample ${detail.activeSampleCount ?? 0}件。短時間だけ軽く振り続けてください。`,
          "collecting-motion": `取得中: モーションsample ${detail.sampleCount ?? 0}件を収集中です。`,
          "validating-motion": "計算中: 取得したモーション入力を確認しています。",
          "waiting-for-pointer":
            "Pointer入力待ち: 専用領域を1本の指で短時間なぞってください。",
          "collecting-pointer": `取得中: Pointer sample ${detail.sampleCount ?? 0}件を収集中です。`,
          "validating-pointer": "計算中: 取得したPointer入力を確認しています。",
          "mixing-physical-source":
            "計算中: 物理入力とWeb Cryptoを混合しています。",
        };
        const message = messages[inputState] ?? "物理入力を処理しています。";
        setStatus(elements["fortune-status"], message);
        if (mode === "pointer") {
          setStatus(elements["pointer-status"], message);
        }
      };

      let byteSource = null;
      try {
        byteSource = await byteSourceProvider({ mode, onState: onInputState });
        setStatus(elements["fortune-status"], "計算中: 卦を求めています。");
        const result = await performFortune(
          elements["theme-input"].value,
          byteSource,
          getHexagramName,
        );
        state.result = result;
        renderResult(result);
        regeneratePrompt();
        setStatus(elements["fortune-status"], "完了: 占い結果を表示しました。", {
          success: true,
        });
        if (mode === "pointer") {
          setStatus(elements["pointer-status"], "完了: Pointer入力を使用しました。", {
            success: true,
          });
        }
        diagnosticView.complete(mode);
        return app.result;
      } catch (error) {
        diagnosticView.fail(mode, error);
        setStatus(elements["fortune-status"], error.message, { error: true });
        if (mode === "motion" && error?.fallbackAllowed === true) {
          state.pointerFallbackOffered = true;
          elements["pointer-fallback-panel"].hidden = false;
          setStatus(elements["pointer-fallback-reason"], error.message, {
            error: true,
          });
          setStatus(
            elements["pointer-status"],
            "Pointer入力へ切り替える場合は、下のボタンを押してから専用領域をなぞってください。",
          );
        } else if (mode === "motion" && error?.retryRecommended === true) {
          state.pointerFallbackOffered = false;
          elements["pointer-fallback-panel"].hidden = true;
          setStatus(
            elements["fortune-status"],
            `${error.message} 「占う」を押してモーション入力を再試行してください。`,
            { error: true },
          );
        } else if (mode === "pointer") {
          setStatus(
            elements["pointer-status"],
            `${error.message} Pointer入力を再試行してください。`,
            { error: true },
          );
        }
        return null;
      } finally {
        byteSource?.dispose?.();
        byteSource = null;
        state.inputInProgress = false;
        elements["fortune-button"].disabled = false;
        elements["pointer-start-button"].disabled = false;
      }
    },

    async runFortune() {
      return app.runPhysicalFortune("motion");
    },

    async runPointerFortune() {
      return app.runPhysicalFortune("pointer");
    },

    selectTemplate(name = elements["template-select"].value) {
      return runTemplateOperation(
        () => templateRepository.selectTemplate(name),
        "使用するテンプレートを変更しました。",
      );
    },

    addTemplate() {
      return runTemplateOperation(() => {
        templateRepository.addTemplate(
          elements["template-name-input"].value,
          elements["template-body-input"].value,
          { select: true },
        );
      }, "テンプレートを追加しました。");
    },

    renameTemplate() {
      return runTemplateOperation(() => {
        const selected = templateRepository.snapshot().selected;
        templateRepository.renameTemplate(
          selected,
          elements["template-name-input"].value,
        );
      }, "テンプレート名を変更しました。");
    },

    saveTemplateBody() {
      return runTemplateOperation(() => {
        const selected = templateRepository.snapshot().selected;
        templateRepository.editTemplate(
          selected,
          elements["template-body-input"].value,
        );
      }, "テンプレート本文を保存しました。");
    },

    async deleteTemplate() {
      const selected = templateRepository.snapshot().selected;
      const confirmed =
        typeof confirmAction === "function"
          ? await confirmAction(`「${selected}」を削除しますか？`)
          : false;
      if (!confirmed) {
        setStatus(elements["template-status"], "削除を中止しました。");
        return false;
      }
      return runTemplateOperation(
        () => templateRepository.deleteTemplate(selected, { confirmed: true }),
        "テンプレートを削除しました。",
      );
    },

    async copyPrompt() {
      const text = elements["prompt-preview"].value;
      try {
        if (!clipboard || typeof clipboard.writeText !== "function") {
          throw new Error("Clipboard APIを利用できません。");
        }
        await clipboard.writeText(text);
        setStatus(elements["copy-status"], "Promptをコピーしました。", {
          success: true,
        });
        return true;
      } catch (error) {
        elements["prompt-preview"].focus();
        elements["prompt-preview"].select();
        setStatus(
          elements["copy-status"],
          `コピーできませんでした。Prompt欄を手動でコピーしてください。${error.message ? ` ${error.message}` : ""}`,
          { error: true },
        );
        return false;
      }
    },

    async exportTemplates() {
      try {
        const backup = createTemplateBackup(templateRepository.snapshot());
        await downloadBackup(backup);
        setStatus(elements["template-status"], "JSONバックアップを作成しました。", {
          success: true,
        });
        return backup;
      } catch (error) {
        setStatus(elements["template-status"], error.message, { error: true });
        return null;
      }
    },

    resetPreparedImport() {
      state.preparedImport = null;
      elements["template-import-summary"].hidden = true;
      elements["template-import-summary"].textContent = "";
      elements["template-import-apply-button"].disabled = true;
    },

    async prepareImport() {
      app.resetPreparedImport();
      const files = Array.from(elements["template-import-file"].files ?? []);
      if (files.length !== 1 || typeof files[0].text !== "function") {
        setStatus(
          elements["template-status"],
          "importするJSONファイルを1つ選択してください。",
          { error: true },
        );
        return null;
      }
      try {
        const prepared = prepareTemplateImport(await files[0].text());
        state.preparedImport = prepared;
        elements["template-import-summary"].textContent =
          `検証済み: ${prepared.summary.templateCount}件、選択中「${prepared.summary.selected}」。内容を確認して置換ボタンを押してください。`;
        elements["template-import-summary"].hidden = false;
        elements["template-import-apply-button"].disabled = false;
        setStatus(
          elements["template-status"],
          "JSONの検証が完了しました。まだ保存内容は変更していません。",
        );
        return prepared.summary;
      } catch (error) {
        setStatus(elements["template-status"], error.message, { error: true });
        return null;
      }
    },

    applyImport() {
      if (!state.preparedImport) {
        setStatus(
          elements["template-status"],
          "先にimportするJSONを検証してください。",
          { error: true },
        );
        return false;
      }
      try {
        templateRepository.applyPreparedImport(state.preparedImport, {
          confirmed: true,
        });
        app.resetPreparedImport();
        refreshTemplateControls();
        setStatus(elements["template-status"], "テンプレート一式を置き換えました。", {
          success: true,
        });
        return true;
      } catch (error) {
        setStatus(elements["template-status"], error.message, { error: true });
        return false;
      }
    },
  };

  elements["fortune-button"].addEventListener("click", () => app.runFortune());
  elements["pointer-start-button"].addEventListener("click", () =>
    app.runPointerFortune(),
  );
  elements["template-select"].addEventListener("change", () => app.selectTemplate());
  elements["template-management-select"].addEventListener("change", () =>
    app.selectTemplate(elements["template-management-select"].value),
  );
  elements["copy-prompt-button"].addEventListener("click", () => app.copyPrompt());
  elements["template-add-button"].addEventListener("click", () => app.addTemplate());
  elements["template-rename-button"].addEventListener("click", () => app.renameTemplate());
  elements["template-save-button"].addEventListener("click", () => app.saveTemplateBody());
  elements["template-delete-button"].addEventListener("click", () => app.deleteTemplate());
  elements["template-export-button"].addEventListener("click", () => app.exportTemplates());
  elements["template-import-file"].addEventListener("change", () => app.resetPreparedImport());
  elements["template-import-prepare-button"].addEventListener("click", () => app.prepareImport());
  elements["template-import-apply-button"].addEventListener("click", () => app.applyImport());

  renderPlaceholderHelp();
  refreshTemplateControls({ updatePrompt: false });
  elements["pointer-fallback-panel"].hidden = true;
  setStatus(
    elements["fortune-status"],
    typeof byteSourceProvider === "function"
      ? "準備中: テーマを入力して「占う」を押すと、センサー許可を確認します。"
      : "物理入力が未接続です。結果は生成しません。",
  );
  setStatus(
    elements["app-status"],
    typeof byteSourceProvider === "function"
      ? "準備ができました。テーマを入力して「占う」を押してください。"
      : "準備ができましたが、物理入力が未接続です。通常操作では結果を生成しません。",
  );
  return app;
}

export async function bootstrapApp({
  document: documentObject = globalThis.document,
  fetchImplementation = globalThis.fetch,
  storage,
  clipboard = globalThis.navigator?.clipboard,
  byteSourceProvider = null,
  physicalInputOptions = {},
  confirmAction,
  downloadBackup,
} = {}) {
  const elements = collectAppElements(documentObject);
  const [hexagramData, initializedTemplates] = await Promise.all([
    loadHexagramData(HEXAGRAM_DATA_URL, fetchImplementation),
    initializeTemplateRepository({
      storage,
      loadInitial: () =>
        loadInitialTemplatePayload(INITIAL_TEMPLATES_URL, fetchImplementation),
    }),
  ]);
  const physicalProvider =
    byteSourceProvider ??
    createPhysicalInputProvider({
      pointerElement: elements["pointer-input-area"],
      ...physicalInputOptions,
    });
  return createApp({
    document: documentObject,
    elements,
    hexagramData,
    templateRepository: initializedTemplates.repository,
    byteSourceProvider: physicalProvider,
    clipboard,
    confirmAction,
    downloadBackup,
  });
}

if (typeof document !== "undefined") {
  const start = () => {
    bootstrapApp().catch((error) => {
      const status = document.getElementById("app-status");
      if (status) {
        setStatus(status, `アプリを初期化できませんでした。${error.message}`, {
          error: true,
        });
      }
    });
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
