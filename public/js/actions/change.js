import { createLoaderNote } from "../loaders.js";

export function handleAppChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }

  if (target.form?.dataset.form !== "create-server" || (target.name !== "mode" && target.name !== "loader")) {
    return;
  }

  const loaderSelect = target.form.querySelector('select[name="loader"]');
  const loaderNote = target.form.querySelector("[data-create-loader-note]");
  const modeSelect = target.form.querySelector('select[name="mode"]');
  const mode = modeSelect instanceof HTMLSelectElement ? modeSelect.value : "managed";
  const loader = loaderSelect instanceof HTMLSelectElement ? loaderSelect.value : "vanilla";
  const isExistingMode = mode === "existing";

  if (loaderNote) {
    loaderNote.textContent = createLoaderNote(isExistingMode ? "existing" : "managed", loader);
  }
}
