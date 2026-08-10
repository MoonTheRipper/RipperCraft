import { state } from "./state.js";

export function applyTheme() {
  document.documentElement.dataset.theme = state.theme === "light" ? "light" : "dark";
}

export function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  localStorage.setItem("rippermoonstash-theme", state.theme);
  applyTheme();
}
