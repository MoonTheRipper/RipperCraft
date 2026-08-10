import { getApp } from "./dom.js";
import { render } from "./render.js";
import { state } from "./state.js";

// The three dialogs (server unlock gate, user editor, password reset) were
// markup only: aria-modal with nothing behind it. No initial focus, no Escape,
// no focus trap, and the whole sidebar still tabbable behind the scrim - which
// meant a keyboard user had to tab through the entire rail to reach the unlock
// passphrase field. This module supplies the behaviour those roles promise.

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Where focus goes when a dialog closes, as a selector for the control that
// opened it. Without it, closing drops a keyboard user back on the document
// body at the top of the page with no idea where they were.
let returnFocusSelector = null;

export function rememberReturnFocus(selector) {
  returnFocusSelector = selector;
}

export function releaseReturnFocus() {
  const selector = returnFocusSelector;
  returnFocusSelector = null;
  if (!selector) {
    return;
  }
  const element = getApp().querySelector(selector);
  if (element) {
    element.focus();
  }
}

export function currentModalPanel(container = getApp()) {
  const panels = container.querySelectorAll(".modal-scrim .modal-panel");
  // The last one wins: only one is ever rendered at a time, and if that ever
  // changes the most recently opened is the one on top.
  return panels.length ? panels[panels.length - 1] : null;
}

function focusableWithin(panel) {
  return Array.from(panel.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (element) => !element.hasAttribute("inert") && element.getAttribute("aria-hidden") !== "true"
  );
}

// Everything outside the dialog subtree is made inert, so the background is
// unreachable by keyboard, pointer and assistive tech alike. No cleanup pass is
// needed: render() replaces the whole of #app, so the flags die with the nodes.
function inertBackground(container, panel) {
  let node = panel.closest(".modal-scrim") || panel;
  while (node && node !== container) {
    const parent = node.parentElement;
    if (!parent) {
      return;
    }
    for (const sibling of parent.children) {
      if (sibling !== node) {
        sibling.setAttribute("inert", "");
      }
    }
    node = parent;
  }
}

// Runs after every render. Only moves focus when it is not already inside the
// dialog, so restoring a caret mid-typing is never overridden.
export function applyModalBehaviour() {
  const container = getApp();
  const panel = currentModalPanel(container);
  if (!panel) {
    return;
  }

  inertBackground(container, panel);

  if (panel.contains(document.activeElement)) {
    return;
  }
  const focusable = focusableWithin(panel);
  const first = focusable.find((element) => element.tagName === "INPUT" || element.tagName === "TEXTAREA") || focusable[0];
  if (first) {
    first.focus();
  }
}

function trapTab(event, panel) {
  const focusable = focusableWithin(panel);
  if (!focusable.length) {
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && (active === first || !panel.contains(active))) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

// Returns true when the key was consumed.
function closeTopLayer() {
  if (state.createVersionOpen) {
    state.createVersionOpen = false;
    render();
    return true;
  }
  if (state.editingUserId) {
    state.editingUserId = null;
    render();
    releaseReturnFocus();
    return true;
  }
  if (state.resettingUserId) {
    state.resettingUserId = null;
    render();
    releaseReturnFocus();
    return true;
  }
  if (state.navOpen) {
    state.navOpen = false;
    render();
    return true;
  }
  // The unlock gate is deliberately not escapable: there is nothing behind it
  // for this server until the passphrase is accepted.
  return false;
}

export function handleAppKeydown(event) {
  if (event.key === "Escape") {
    if (closeTopLayer()) {
      event.preventDefault();
    }
    return;
  }

  if (event.key === "Tab") {
    const panel = currentModalPanel();
    if (panel) {
      trapTab(event, panel);
    }
  }
}
