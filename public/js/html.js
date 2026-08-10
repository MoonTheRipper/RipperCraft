import { ICONS } from "./icons.js";

// null and undefined are the only values that mean "nothing here". `value || ""`
// used to swallow 0 and false as well, which blanked out any server property
// legitimately set to 0 and saved it back as an empty string.
export function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Anything that reaches an href can come from a provider search response or an
// error payload, and escapeHtml only stops attribute breakout - it happily
// passes `javascript:alert(1)` through. Everything that is not an absolute
// http(s) URL is rejected, and callers render a plain note instead of a link.
export function safeUrl(value) {
  const raw = String(value === null || value === undefined ? "" : value).trim();
  if (!raw) {
    return "";
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return "";
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : "";
}

// Opt-in marker for the few places that genuinely pass markup to a renderer
// which escapes by default. Anything not wrapped in this is treated as text.
export function rawHtml(markup) {
  return { __html: String(markup === null || markup === undefined ? "" : markup) };
}

export function renderValue(value) {
  return value && typeof value === "object" && "__html" in value ? value.__html : escapeHtml(value);
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
