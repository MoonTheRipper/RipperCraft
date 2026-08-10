import { renderPageHeader, renderSection } from "../components.js";
import { getServerPermissions } from "../format.js";
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
  const actions = `
    <span class="status-inline ${server.status.running ? "status-inline--ok" : "status-inline--idle"}">${icon("server")}${server.status.running ? "online" : "offline"}</span>
    <span class="status-inline ${unlocked ? "status-inline--ok" : "status-inline--idle"}">${icon("unlock")}${unlocked ? "unlocked" : "locked"}</span>
    ${permissions.canControlRuntime ? `<button class="button button--primary" data-action="start-server">${labelWithIcon("start", "start")}</button>` : ""}
    ${permissions.canControlRuntime ? `<button class="button button--quiet" data-action="stop-server">${labelWithIcon("stop", "stop")}</button>` : ""}
    <button class="button button--quiet" data-action="refresh-server">${labelWithIcon("refresh", "refresh")}</button>
  `;

  let body = "";
  if (permissions.requiresUnlock) {
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
