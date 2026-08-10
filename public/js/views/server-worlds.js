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
              <input name="name" placeholder="new world name" required />
              <input name="seed" placeholder="seed (optional)" />
              <select name="levelType">
                <option value="minecraft:normal">normal</option>
                <option value="minecraft:flat">flat</option>
                <option value="minecraft:large_biomes">large biomes</option>
                <option value="minecraft:amplified">amplified</option>
              </select>
              <select name="generateStructures">
                <option value="true">structures on</option>
                <option value="false">structures off</option>
              </select>
              <button class="button button--quiet" type="submit">${labelWithIcon("worlds", "create new world")}</button>
            </form>
          `
          : `
            <p class="muted">new world creation is only available to owners or admins who were granted that trait for this server.</p>
          `}
        <form data-form="capture-world" class="form-inline">
          <input name="label" placeholder="archive label" />
          <button class="button button--quiet" type="submit">${labelWithIcon("worlds", "capture active world")}</button>
        </form>
        <form data-form="import-world" class="form-inline" enctype="multipart/form-data">
          <input type="file" name="archive" accept=".zip" required />
          <button class="button button--quiet" type="submit">${labelWithIcon("worlds", "import zip")}</button>
        </form>
        <a class="button button--quiet" href="/api/servers/${encodeURIComponent(server.id)}/worlds/export-active">${labelWithIcon("worlds", "export active world")}</a>
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
                          <button class="button button--quiet" data-action="activate-world" data-archive-name="${escapeHtml(world.name)}">${labelWithIcon("start", "activate")}</button>
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
            <select name="levelType">
              ${renderSelectOptions(["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified"], worldRules?.levelType || "minecraft:normal")}
            </select>
            <select name="generateStructures">
              ${renderSelectOptions(["true", "false"], worldRules?.generateStructures || "true")}
            </select>
            <select name="forceGamemode">
              ${renderSelectOptions(["false", "true"], worldRules?.forceGamemode || "false")}
            </select>
            <button class="button button--quiet" type="submit">${labelWithIcon("settings", "apply world rules")}</button>
          </form>
        `
        : ""}
    `
  );
}
