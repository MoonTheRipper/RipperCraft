import { render } from "./render.js";
import { state } from "./state.js";

// Every operation reports through here, and the visible banner is redrawn from
// scratch on each render - a live region created together with its own text is
// not reliably announced. The announcer therefore lives outside #app, survives
// every render, and is the single copy of the message in the accessibility
// tree (the visible banner is aria-hidden, so nothing is read twice).
function announce(type, message) {
  const region = typeof document === "undefined" ? null : document.getElementById("notice-live");
  if (!region) {
    return;
  }
  region.setAttribute("aria-live", type === "error" ? "assertive" : "polite");
  // Writing identical text changes nothing in the DOM and is not announced, so
  // repeating the same message still has to look like a change.
  region.textContent = region.textContent === message ? `${message} ` : message;
}

export function setNotice(type, message) {
  state.notice = { type, message };
  announce(type, message);
  render();
}

export function clearNotice() {
  state.notice = null;
  announce("success", "");
}
