export async function registerServiceWorker({
  serviceWorker = globalThis.navigator?.serviceWorker,
} = {}) {
  if (!serviceWorker || typeof serviceWorker.register !== "function") {
    return null;
  }
  return serviceWorker.register("./sw.js", { scope: "./" });
}

function reportRegistrationFailure(error) {
  const status = globalThis.document?.getElementById("app-status");
  if (!status) return;
  status.textContent =
    `オフライン利用の準備に失敗しました。オンラインのまま利用できます。${error?.message ? ` ${error.message}` : ""}`;
  status.dataset.state = "error";
  status.setAttribute("role", "alert");
}

if (typeof globalThis.window !== "undefined") {
  globalThis.window.addEventListener(
    "load",
    () => {
      registerServiceWorker().catch(reportRegistrationFailure);
    },
    { once: true },
  );
}
