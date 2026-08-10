import { renderVersionDatalist } from "./components.js";
import { getApp } from "./dom.js";
import { escapeHtml } from "./html.js";
import { captureUiState, restoreUiState } from "./preserve.js";
import { state } from "./state.js";
import { applyTheme } from "./theme.js";
import { renderAuth } from "./views/auth.js";
import { renderSidebar } from "./views/nav.js";
import { renderOwnerContent } from "./views/owner.js";
import { renderServerContent } from "./views/server.js";

// The live-log module needs render() to redraw fresh log output, and render()
// needs the live-log module to re-pin scroll and start/stop polling once the
// new markup is in place. Importing both ways would be a cycle, so render()
// owns nothing but this hook list and the entry module registers the log hooks
// into it. The dependency then only ever points logs-live.js -> render.js.
const postRenderHooks = [];

export function registerPostRender(hook) {
  postRenderHooks.push(hook);
}

function runPostRenderHooks() {
  for (const hook of postRenderHooks) {
    hook();
  }
}

function buildHtml() {
  if (!state.bootstrap) {
    return `<main class="auth-shell"><section class="auth-panel"><h1>loading...</h1></section></main>`;
  }

  if (state.bootstrap.needsSetup) {
    return renderAuth("Create the Owner Account", "setup");
  }

  if (!state.bootstrap.loggedIn) {
    return renderAuth("Are You Worthy", "login");
  }

  const nextTheme = state.theme === "light" ? "dark" : "light";

  return `
    <main class="shell">
      <button
        class="nav-toggle ${state.navOpen ? "nav-toggle--open" : ""}"
        type="button"
        data-action="toggle-nav"
        aria-label="${state.navOpen ? "Close navigation" : "Open navigation"}"
        aria-expanded="${state.navOpen ? "true" : "false"}"
        aria-controls="primary-nav"
      >
        <span></span>
        <span></span>
        <span></span>
      </button>
      ${state.navOpen ? '<button class="nav-scrim" type="button" data-action="close-nav" aria-label="Close navigation"></button>' : ""}
      ${renderSidebar(nextTheme)}
      <section class="content">
        ${state.notice
          ? `<div class="notice notice--${escapeHtml(state.notice.type)}" aria-hidden="true">${escapeHtml(state.notice.message)}</div>`
          : ""}
        ${state.view === "owner" ? renderOwnerContent() : renderServerContent()}
      </section>
    </main>
    ${renderVersionDatalist("minecraft-version-list", false)}
  `;
}

export function render() {
  const app = getApp();
  applyTheme();

  // Replacing innerHTML discards every piece of DOM-only state. Snapshot it
  // first and put it back after, so an unrelated re-render (theme toggle, nav
  // toggle, the three-second log poll) cannot throw away what someone typed or
  // where their focus was.
  const uiState = captureUiState(app);
  app.innerHTML = buildHtml();
  restoreUiState(app, uiState);

  runPostRenderHooks();
}
