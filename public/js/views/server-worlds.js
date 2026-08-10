import { renderSection } from "../components.js";
import { formatDate, getServerPermissions } from "../format.js";
import { escapeHtml, labelWithIcon, renderSelectOptions } from "../html.js";

export function renderWorldsSection(snapshot) {
  const { server, worlds, worldRules } = snapshot;
  const permissions = getServerPermissions(snapshot);
  return renderSection(
    "worlds",
    "import, archive, activate, export",
    `
      <div class="tool-stack">
        ${permissions.canCreateWorlds
          ? `
            <form data-form="create-world" class="form-inline">
              <label class="visually-hidden" for="world-new-name">new world name</label>
              <input id="world-new-name" name="name" placeholder="new world name" required />
              <label class="visually-hidden" for="world-new-seed">world seed (optional)</label>
              <input id="world-new-seed" name="seed" placeholder="seed (optional)" />
              <label class="visually-hidden" for="world-new-type">world type</label>
              <select id="world-new-type" name="levelType">
                <option value="minecraft:normal">normal</option>
                <option value="minecraft:flat">flat</option>
                <option value="minecraft:large_biomes">large biomes</option>
                <option value="minecraft:amplified">amplified</option>
              </select>
              <label class="visually-hidden" for="world-new-structures">structure generation</label>
              <select id="world-new-structures" name="generateStructures">
                <option value="true">structures on</option>
                <option value="false">structures off</option>
              </select>
              <button class="button button--quiet" type="submit">${labelWithIcon("worlds", "create new world")}</button>
            </form>
            <p class="muted">creating a world stops the server first, archives the world that is live now, and points the server at the new one.</p>
          `
          : `
            <p class="muted">new world creation is only available to owners or admins who were granted that trait for this server.</p>
          `}
        <form data-form="capture-world" class="form-inline">
          <label class="visually-hidden" for="world-archive-label">archive label</label>
          <input id="world-archive-label" name="label" placeholder="archive label" />
          <button class="button button--quiet" type="submit">${labelWithIcon("worlds", "back up active world")}</button>
        </form>
        <p class="muted">backing up and exporting both stop the server first so the world files are not written to mid-copy.</p>
        <form data-form="import-world" class="form-inline" enctype="multipart/form-data">
          <label class="visually-hidden" for="world-import-file">world .zip file to import</label>
          <input id="world-import-file" type="file" name="archive" accept=".zip" required />
          <button class="button button--quiet" type="submit">${labelWithIcon("worlds", "import zip")}</button>
        </form>
        <a
          class="button button--quiet"
          data-action="export-active-world"
          href="/api/servers/${encodeURIComponent(server.id)}/worlds/export-active"
        >${labelWithIcon("worlds", "export active world")}</a>
      </div>
      <div class="list-rows">
        ${worlds.length
          ? worlds
              .map(
                (world) => `
                  <div class="list-row ${world.active ? "list-row--active" : ""}">
                    <div class="list-row__main">
                      <strong>${escapeHtml(world.name)}${world.active ? ' <span class="status-inline status-inline--ok">active</span>' : ""}</strong>
                      <p class="muted">${formatDate(world.modifiedAt)}${world.size ? ` • ${(world.size / 1024 / 1024).toFixed(2)} MB` : ""}</p>
                    </div>
                    <div class="row-actions">
                      ${world.active
                        ? ""
                        : `
                          <button class="button button--quiet" data-action="activate-world" data-archive-name="${escapeHtml(world.name)}">${labelWithIcon("start", "restore")}</button>
                          <a class="button button--quiet" href="/api/servers/${encodeURIComponent(server.id)}/worlds/download?name=${encodeURIComponent(world.name)}">${labelWithIcon("overview", "download")}</a>
                          ${permissions.canCreateWorlds
                            ? `<button class="button button--danger" data-action="delete-world" data-archive-name="${escapeHtml(world.name)}" data-size="${escapeHtml(world.size ? `${(world.size / 1024 / 1024).toFixed(2)} MB` : "unknown size")}">${labelWithIcon("stop", "delete")}</button>`
                            : ""}
                        `}
                    </div>
                  </div>
                `
              )
              .join("")
          : `<p class="muted">no archived worlds yet</p>`}
      </div>
      ${permissions.canCreateWorlds
        ? `
          <form data-form="save-world-rules" class="form-inline">
            <label class="visually-hidden" for="world-rules-type">default world type</label>
            <select id="world-rules-type" name="levelType">
              ${renderSelectOptions(["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified"], worldRules?.levelType || "minecraft:normal")}
            </select>
            <label class="visually-hidden" for="world-rules-structures">generate structures</label>
            <select id="world-rules-structures" name="generateStructures">
              ${renderSelectOptions(["true", "false"], worldRules?.generateStructures || "true")}
            </select>
            <label class="visually-hidden" for="world-rules-gamemode">force gamemode</label>
            <select id="world-rules-gamemode" name="forceGamemode">
              ${renderSelectOptions(["false", "true"], worldRules?.forceGamemode || "false")}
            </select>
            <button class="button button--quiet" type="submit">${labelWithIcon("settings", "apply world rules")}</button>
          </form>
        `
        : ""}
    `
  );
}
