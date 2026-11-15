import { ICONS } from "./icons.js";

// What a value from a response is shown as. Text, numbers and booleans are
// spelled out; null and undefined mean "nothing here". `value || ""` used to
// swallow 0 and false as well, which blanked out any server property
// legitimately set to 0 and saved it back as an empty string.
//
// An object or a list where text was expected is shown as nothing. This page
// has no use for one, String() would print "[object Object]", and on an object
// that carries its own toString it throws - which, from inside render(), took
// the whole page down with it.
function toText(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return "";
}

export function escapeHtml(value) {
  return toText(value)
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
  const raw = toText(value).trim();
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
//
// The marker is a Symbol that never leaves this module. It used to be a
// property called __html, which anything could carry: a value saved through
// the API as {"__html": "<script>..."} came back in a response and was
// rendered as markup in the owner's session. A response is JSON, and JSON
// cannot hold a Symbol; no other module can name this one either. So the only
// way to make a value this function trusts is to call rawHtml() from code.
const TRUSTED_MARKUP = Symbol("trusted markup");

export function rawHtml(markup) {
  return Object.freeze({ [TRUSTED_MARKUP]: toText(markup) });
}

function isTrustedMarkup(value) {
  return typeof value === "object" && value !== null && Object.hasOwn(value, TRUSTED_MARKUP);
}

export function renderValue(value) {
  return isTrustedMarkup(value) ? value[TRUSTED_MARKUP] : escapeHtml(value);
}

export function icon(name, label = "") {
  return `<span class="icon"${label ? ` aria-label="${escapeHtml(label)}"` : ""}>${ICONS[name] || ""}</span>`;
}

export function labelWithIcon(name, text, extraClass = "") {
  return `<span class="label-with-icon ${extraClass}">${icon(name)}<span>${escapeHtml(text)}</span></span>`;
}

export function renderSelectOptions(options, selectedValue) {
  return options
    .map((option) => `<option value="${escapeHtml(option)}" ${toText(selectedValue) === option ? "selected" : ""}>${escapeHtml(option)}</option>`)
    .join("");
}
