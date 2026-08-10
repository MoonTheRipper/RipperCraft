import { renderVersionDatalist } from "./components.js";
import { getApp } from "./dom.js";
import { escapeHtml } from "./html.js";
import { state } from "./state.js";
import { applyTheme, syncDocumentMeta } from "./theme.js";
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

export function render() {
  const app = getApp();
  applyTheme();
  syncDocumentMeta();
  const nextTheme = state.theme === "light" ? "dark" : "light";

  if (!state.bootstrap) {
    app.innerHTML = `<main class="auth-shell"><section class="auth-panel"><h1>loading...</h1></section></main>`;
    return;
  }

  if (state.bootstrap.needsSetup) {
    app.innerHTML = renderAuth(
      "Create the Owner Account",
      "Set up the first account with full control over servers, passphrase lanes, worlds, add-ons, and admin permissions.",
      "setup"
    );
    return;
  }

  if (!state.bootstrap.loggedIn) {
    app.innerHTML = renderAuth(
      "Are You Worthy",
      "Access your Minecraft server workspace with your username and password. After login, choose a server from the left side and unlock it with its passphrase when required.",
      "login"
    );
    return;
  }

  app.innerHTML = `
    <main class="shell">
      <button class="nav-toggle ${state.navOpen ? "nav-toggle--open" : ""}" data-action="toggle-nav" aria-label="${state.navOpen ? "Close navigation" : "Open navigation"}">
        <span></span>
        <span></span>
        <span></span>
      </button>
      ${state.navOpen ? '<button class="nav-scrim" data-action="close-nav" aria-label="Close navigation"></button>' : ""}
      <button class="theme-toggle" data-action="toggle-theme" title="Switch to ${escapeHtml(nextTheme)} mode" aria-label="Switch to ${escapeHtml(nextTheme)} mode">
        <span class="theme-toggle__track">
          <span class="theme-toggle__sun">
            <span class="theme-toggle__ray theme-toggle__ray--1"></span>
            <span class="theme-toggle__ray theme-toggle__ray--2"></span>
            <span class="theme-toggle__ray theme-toggle__ray--3"></span>
            <span class="theme-toggle__ray theme-toggle__ray--4"></span>
            <span class="theme-toggle__ray theme-toggle__ray--5"></span>
            <span class="theme-toggle__ray theme-toggle__ray--6"></span>
            <span class="theme-toggle__ray theme-toggle__ray--7"></span>
            <span class="theme-toggle__ray theme-toggle__ray--8"></span>
          </span>
          <span class="theme-toggle__moon"></span>
        </span>
      </button>
      ${renderSidebar()}
      <section class="content">
        ${state.notice ? `<div class="notice notice--${escapeHtml(state.notice.type)}">${escapeHtml(state.notice.message)}</div>` : ""}
        ${state.view === "owner" ? renderOwnerContent() : renderServerContent()}
      </section>
    </main>
    ${renderVersionDatalist("minecraft-version-list", false)}
    ${renderVersionDatalist("minecraft-version-list-create", true)}
  `;

  runPostRenderHooks();
}
