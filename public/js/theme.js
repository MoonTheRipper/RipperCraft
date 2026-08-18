import { state, writeStored } from "./state.js";

export function applyTheme() {
  document.documentElement.dataset.theme = state.theme === "light" ? "light" : "dark";
}

export function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  writeStored("theme", state.theme);
  applyTheme();
}
