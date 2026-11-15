import { getApp } from "./dom.js";

// How wide a progress bar is filled is the one style on the page that has to
// be worked out while it runs. The markup carries the number as data-progress
// and this sets the width through the element's style object after each
// render. A style="width: ..." attribute in the markup is an inline style, and
// the Content-Security-Policy allows none; setting a property from script is
// not one.
export function applyProgressBars() {
  for (const fill of getApp().querySelectorAll("[data-progress]")) {
    const percent = Number(fill.dataset.progress);
    const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
    fill.style.width = `${clamped}%`;
  }
}
