import { renderAddonIcon, renderAddonSideBadge, renderSection } from "../components.js";
import { getServerPermissions } from "../format.js";
import { escapeHtml, labelWithIcon, safeUrl } from "../html.js";
import { state } from "../state.js";

// Renders a provider link only when the URL is an absolute http(s) one. A
// rejected or missing link degrades to a plain instruction rather than an
// anchor that does nothing (or worse, runs a javascript: URL).
export function renderProviderLink(url, label) {
  const href = safeUrl(url);
  if (!href) {
    return `<span class="muted">no usable link was supplied — search for it on curseforge.com</span>`;
  }
  return `<a class="button button--quiet" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${labelWithIcon("mods", label)}</a>`;
}

// Update entries are keyed by filename only, so a check run against one server
// would otherwise light up an identically named jar on another. The results
// carry the server they were fetched for and are ignored anywhere else.
export function currentModUpdates() {
  return state.modUpdates && state.modUpdates.serverId === state.selectedServerId ? state.modUpdates : null;
}

export function findAddonUpdate(fileName) {
  const updates = currentModUpdates();
  if (!updates) {
    return null;
  }
  return updates.entries.find((entry) => entry.fileName === fileName) || null;
}

export function renderAddonUpdateLabel(update) {
  if (!update) {
    return "";
  }
  if (update.status === "update-available") {
    return ` • <strong>update: ${escapeHtml(update.latestFileName)}</strong>`;
  }
  if (update.status === "up-to-date") {
    return " • up to date";
  }
  if (update.status === "untracked") {
    return " • untracked";
  }
  if (update.status === "error") {
    return ` • check failed: ${escapeHtml(update.reason || "")}`;
  }
  return " • no provider";
}

export function renderAddonUpdatePanel() {
  const updates = currentModUpdates();
  if (!updates) {
    return "";
  }

  const counts = updates.entries.reduce((totals, entry) => {
    totals[entry.status] = (totals[entry.status] || 0) + 1;
    return totals;
  }, {});
  const summary = [
    `${counts["update-available"] || 0} with updates`,
    `${counts["up-to-date"] || 0} up to date`,
    `${counts.unsupported || 0} manual`,
    `${counts.untracked || 0} untracked`,
    `${counts.error || 0} failed`
  ].join(" • ");

  return `
    <div class="list-row ${updates.updatable ? "list-row--notice" : ""}">
      <div class="list-row__main">
        <strong>add-on updates for ${escapeHtml(updates.loader)} ${escapeHtml(updates.gameVersion || "unknown")}</strong>
        <p class="muted">${escapeHtml(summary)}</p>
        <p class="muted">updates stay on minecraft ${escapeHtml(updates.gameVersion || "")} — the game version is never changed here. the server is stopped before any jar is swapped.</p>
      </div>
      <div class="row-actions">
        ${updates.updatable
          ? `<button class="button button--primary" data-action="update-all-mods">${labelWithIcon("refresh", `update all (${updates.updatable})`)}</button>`
          : ""}
        <button class="button button--quiet" data-action="dismiss-mod-updates">${labelWithIcon("stop", "hide")}</button>
      </div>
    </div>
  `;
}

export function renderModsSection(snapshot) {
  const { server, mods, runtime, addonCompatibility } = snapshot;
  const permissions = getServerPermissions(snapshot);
  const providers = state.bootstrap.providers;
  const canUseCurseforge = providers.curseforge && addonCompatibility.supportsCurseforge;
  // Keep the chosen provider across the re-render that follows a search, and
  // never leave curseforge selected on a server that cannot use it.
  const activeProvider = state.modProvider === "curseforge" && canUseCurseforge ? "curseforge" : "modrinth";
  const results = state.modResults.length
    ? `
        <div class="list-rows">
          ${state.modResults
            .map(
              (result) => `
                <div class="list-row list-row--media">
                  ${renderAddonIcon(result.iconUrl, result.title)}
                  <div class="list-row__main">
                    <strong>${escapeHtml(result.title)}</strong>
                    <p class="muted">${escapeHtml(result.provider)} • ${escapeHtml(result.author || "unknown author")} • ${Number(result.downloads || 0).toLocaleString()} downloads</p>
                    <p class="badge-row">${renderAddonSideBadge(result.clientSide, result.serverSide)}</p>
                    ${result.compatibilityLabel ? `<p class="muted">${escapeHtml(result.compatibilityLabel)}</p>` : ""}
                    <p class="muted">${escapeHtml(result.description || "")}</p>
                    ${result.manualDownloadOnly
                      ? `<p class="muted">manual download only — this author disabled third-party downloads.</p>`
                      : ""}
                  </div>
                  <div class="row-actions">
                    ${result.manualDownloadOnly
                      ? renderProviderLink(result.pageUrl, "open curseforge")
                      : `<button
                      class="button button--quiet"
                      data-action="install-result"
                      data-provider="${escapeHtml(result.provider)}"
                      data-id="${escapeHtml(result.id)}"
                    >
                      ${labelWithIcon("mods", "install")}
                    </button>`}
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `
    : `<p class="muted">only compatibility-matching add-ons are listed here for ${escapeHtml(server.loader)} on ${escapeHtml(server.minecraftVersion || "unknown")}.</p>`;

  const handoff = state.manualDownload;
  const manualDownload = handoff
    ? `
        <div class="list-row list-row--notice">
          <div class="list-row__main">
            <strong>manual download required</strong>
            <p class="muted">${escapeHtml(handoff.modName)} cannot be fetched automatically. its author disabled third-party downloads on curseforge.</p>
            ${handoff.fileName ? `<p class="muted">file: <code>${escapeHtml(handoff.fileName)}</code></p>` : ""}
            <p class="muted">download it, then add it below with "upload file".</p>
          </div>
          <div class="row-actions">
            ${renderProviderLink(handoff.pageUrl, "open curseforge")}
            <button class="button button--quiet" data-action="dismiss-manual-download">${labelWithIcon("stop", "dismiss")}</button>
          </div>
        </div>
      `
    : "";

  return renderSection(
    "mods",
    `installed to ${runtime.modsDir}`,
    `
      <p class="muted">server type: ${escapeHtml(addonCompatibility.installKind)} • loader: ${escapeHtml(addonCompatibility.loader || "unknown")} • version: ${escapeHtml(addonCompatibility.gameVersion || "unknown")}</p>
      <div class="tool-stack">
        ${addonCompatibility.installKind !== "unsupported"
          ? `
            <form data-form="search-mods" class="form-inline">
              <label class="visually-hidden" for="mod-search-provider">add-on source</label>
              <select id="mod-search-provider" name="provider">
                <option value="modrinth"${activeProvider === "modrinth" ? " selected" : ""}>modrinth</option>
                ${canUseCurseforge ? `<option value="curseforge"${activeProvider === "curseforge" ? " selected" : ""}>curseforge</option>` : ""}
              </select>
              <label class="visually-hidden" for="mod-search-query">search mods or plugins</label>
              <input id="mod-search-query" name="query" value="${escapeHtml(state.modQuery)}" placeholder="search mods or plugins" required />
              <button class="button button--primary" type="submit">${labelWithIcon("search", "search")}</button>
            </form>
          `
          : `<p class="muted">compatibility-checked add-on installs are disabled until this server uses a supported loader.</p>`}
        ${permissions.canUseManualAddons && addonCompatibility.installKind !== "unsupported"
          ? `
            <form data-form="install-direct" class="form-inline">
              <label class="visually-hidden" for="mod-direct-url">direct .jar url</label>
              <input id="mod-direct-url" name="url" type="url" placeholder="direct .jar url" required />
              <input type="hidden" name="confirmManualCompatibility" value="true" />
              <button class="button button--quiet" type="submit">${labelWithIcon("mods", "install url")}</button>
            </form>
            <form data-form="upload-mod" class="form-inline" enctype="multipart/form-data">
              <label class="visually-hidden" for="mod-upload-file">add-on .jar file to upload</label>
              <input id="mod-upload-file" type="file" name="file" accept=".jar" required />
              <input type="hidden" name="confirmManualCompatibility" value="true" />
              <button class="button button--quiet" type="submit">${labelWithIcon("mods", "upload file")}</button>
            </form>
            <p class="muted">manual add-on installs require add-on management permission and explicit compatibility confirmation.</p>
          `
          : `
            <p class="muted">direct urls and uploads stay hidden unless this account can manage add-ons and the server uses a supported add-on loader.</p>
          `}
      </div>
      ${manualDownload}
      ${results}
      ${renderAddonUpdatePanel()}
      <div class="list-rows">
        <div class="list-row list-row--header">
          <strong>installed</strong>
          <div class="row-actions">
            ${permissions.canManageAddonSettings
              ? `
                <button class="button button--quiet" data-action="check-mod-updates">${labelWithIcon("refresh", currentModUpdates() ? "re-check updates" : "check for updates")}</button>
                <button class="button button--quiet" data-action="refresh-mod-details">${labelWithIcon("image", "refresh icons & sides")}</button>
              `
              : ""}
            <a class="button button--quiet" href="/api/servers/${encodeURIComponent(server.id)}/mods/client-list">${labelWithIcon("logs", "client list (.txt)")}</a>
            <a class="button button--quiet" href="/api/servers/${encodeURIComponent(server.id)}/mods/modpack">${labelWithIcon("mods", "client modpack (.mrpack)")}</a>
          </div>
        </div>
        ${mods.length
          ? mods
              .map(
                (item) => {
                  const entry = typeof item === "string" ? { enabled: true, fileName: item } : item;
                  const fileName = entry.fileName;
                  const enabled = entry.enabled !== false;
                  const update = findAddonUpdate(fileName);
                  // Untracked jars were dropped in by hand, so there is no
                  // project behind them and nothing truthful to show but the
                  // file itself.
                  const heading = entry.title
                    ? `<strong>${escapeHtml(entry.title)}</strong><code class="addon-file">${escapeHtml(fileName)}</code>`
                    : `<code>${escapeHtml(fileName)}</code>`;
                  return `
                  <div class="list-row list-row--media ${update && update.status === "update-available" ? "list-row--notice" : ""}">
                    ${renderAddonIcon(entry.iconUrl, entry.title || fileName)}
                    <div class="list-row__main">
                      ${heading}
                      <p class="muted">${enabled ? "enabled" : "disabled"}${entry.tracked === false ? " • untracked" : ""}${renderAddonUpdateLabel(update)}</p>
                      ${entry.tracked === false
                        ? ""
                        : `<p class="badge-row">${renderAddonSideBadge(entry.clientSide, entry.serverSide)}</p>`}
                    </div>
                    ${permissions.canManageAddonSettings
                      ? `
                        <div class="row-actions">
                          ${update && update.status === "update-available"
                            ? `<button class="button button--primary" data-action="update-mod" data-file-name="${escapeHtml(fileName)}">${labelWithIcon("refresh", "update")}</button>`
                            : ""}
                          <button class="button button--quiet" data-action="toggle-mod" data-file-name="${escapeHtml(fileName)}" data-enabled="${enabled ? "true" : "false"}">${labelWithIcon(enabled ? "stop" : "start", enabled ? "disable" : "enable")}</button>
                          <button class="button button--quiet" data-action="remove-mod" data-file-name="${escapeHtml(fileName)}">${labelWithIcon("stop", "remove")}</button>
                        </div>
                      `
                      : ""}
                  </div>
                `;
                }
              )
              .join("")
          : `<p class="muted">nothing installed yet</p>`}
      </div>
    `
  );
}
