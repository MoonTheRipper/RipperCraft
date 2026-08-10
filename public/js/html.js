import { ICONS } from "./icons.js";

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function icon(name, label = "") {
  return `<span class="icon"${label ? ` aria-label="${escapeHtml(label)}"` : ""}>${ICONS[name] || ""}</span>`;
}

export function labelWithIcon(name, text, extraClass = "") {
  return `<span class="label-with-icon ${extraClass}">${icon(name)}<span>${escapeHtml(text)}</span></span>`;
}

export function renderSelectOptions(options, selectedValue) {
  return options
    .map((option) => `<option value="${escapeHtml(option)}" ${String(selectedValue) === option ? "selected" : ""}>${escapeHtml(option)}</option>`)
    .join("");
}
