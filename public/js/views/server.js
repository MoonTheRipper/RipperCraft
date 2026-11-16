import { renderPageHeader, renderSection } from "../components.js";
import { describeRunState, getServerPermissions } from "../format.js";
import { escapeHtml, icon, labelWithIcon } from "../html.js";
import { state } from "../state.js";
import { renderLogsSection } from "./server-logs.js";
import { renderModsSection } from "./server-mods.js";
import { renderOverviewSection } from "./server-overview.js";
import { renderSettingsSection } from "./server-settings.js";
import { renderWorldsSection } from "./server-worlds.js";

export function renderLockedServerAccess(snapshot) {
  const { server } = snapshot;
  return `
    ${renderSection(
      "lane",
      "enter the server passphrase to continue",
      `
        <p class="muted">this server is locked. once the passphrase is accepted, runtime actions, safe settings, worlds, add-ons, and logs become available for this session.</p>
        <div class="meta-list">
          <div class="meta-row">
            <span>server</span>
            <strong>${escapeHtml(server.name)}</strong>
          </div>
          <div class="meta-row">
            <span>loader</span>
            <strong>${escapeHtml(server.loader)}</strong>
          </div>
          <div class="meta-row">
            <span>minecraft</span>
            <strong>${escapeHtml(server.minecraftVersion || "unknown")}</strong>
          </div>
        </div>
      `
    )}
    <div class="modal-scrim">
      <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="unlock-server-title">
        <p class="brand-line">${labelWithIcon("unlock", "server access")}</p>
        <h2 id="unlock-server-title">${escapeHtml(server.name)}</h2>
        <p class="muted">enter the passphrase for this server before making changes or opening its protected tools.</p>
        <form data-form="unlock-server-popup" class="form-grid">
          <label>
            <span>server passphrase</span>
            <input type="password" name="passphrase" autocomplete="one-time-code" required />
          </label>
          <div class="submit-line">
            <button class="button button--primary" type="submit">${labelWithIcon("unlock", "unlock server")}</button>
          </div>
        </form>
      </section>
    </div>
  `;
}

// The page of a server the dashboard cannot tell the state of: why, and what
// that means. Nothing else of the server is shown, because nothing else of
// it was read: half of a server's page comes out of the folder that is, as
// a rule, the reason.
export function renderStateNotKnown(snapshot) {
  const { server } = snapshot;
  return renderSection(
    "server",
    "state not known",
    `
      <p class="notice notice--error">the dashboard cannot tell whether this server is running. until it can it will not start it, stop it, or change anything in its folder.</p>
      <div class="meta-list">
        <div class="meta-row">
          <span>why</span>
          <strong>${escapeHtml(server.status.unknown)}</strong>
        </div>
        <div class="meta-row">
          <span>directory</span>
          <strong><code>${escapeHtml(server.directory)}</code></strong>
        </div>
      </div>
      <p class="muted">put that right on the machine the dashboard runs on, then press refresh. the other servers are not affected.</p>
    `
  );
}

export function renderServerContent() {
  if (!state.serverSnapshot) {
    return `
      ${renderPageHeader("servers", "no server selected", "pick a server from the tree")}
      <section class="section-block">
        <div class="section-body">
          <p class="muted">the left rail now holds the full server tree. choose a server, then choose overview, settings, worlds, mods, or logs.</p>
        </div>
      </section>
    `;
  }

  const { server, unlocked } = state.serverSnapshot;
  const permissions = getServerPermissions(state.serverSnapshot);
  const pathLabel = `servers / ${server.id} / ${state.serverSection}`;
  const runState = describeRunState(server.status);
  // While a server is stopping there is nothing for either button to do: it
  // cannot be started before it has gone, and it has been told to stop once.
  const held = runState.stopping ? ' disabled title="this server is stopping"' : "";
  // And what is left of its last run has to be stopped before it is started.
  const startHeld = runState.leftover ? ' disabled title="stop this server first: processes from its last run are still there"' : held;
  const actions = `
    <span class="status-inline status-inline--${runState.tone}">${icon("server")}${runState.label}</span>
    <span class="status-inline ${unlocked ? "status-inline--ok" : "status-inline--idle"}">${icon("unlock")}${unlocked ? "unlocked" : "locked"}</span>
    ${permissions.canControlRuntime ? `<button class="button button--primary" data-action="start-server"${startHeld}>${labelWithIcon("start", "start")}</button>` : ""}
    ${permissions.canControlRuntime ? `<button class="button button--quiet" data-action="stop-server"${held}>${labelWithIcon("stop", "stop")}</button>` : ""}
    <button class="button button--quiet" data-action="refresh-server">${labelWithIcon("refresh", "refresh")}</button>
  `;

  let body = "";
  if (runState.unknown) {
    body = renderStateNotKnown(state.serverSnapshot);
  } else if (permissions.requiresUnlock) {
    body = renderLockedServerAccess(state.serverSnapshot);
  } else if (state.serverSection === "settings") {
    body = renderSettingsSection(state.serverSnapshot);
  } else if (state.serverSection === "worlds") {
    body = renderWorldsSection(state.serverSnapshot);
  } else if (state.serverSection === "mods") {
    body = renderModsSection(state.serverSnapshot);
  } else if (state.serverSection === "logs") {
    body = renderLogsSection(state.serverSnapshot);
  } else {
    body = renderOverviewSection(state.serverSnapshot);
  }

  return `
    ${renderPageHeader(pathLabel, server.name, server.description || `${server.loader} server`, actions)}
    ${body}
  `;
}
