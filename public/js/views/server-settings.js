import { renderJavaBinNote, renderJavaBinSelect, renderSafeSettingField, renderSection } from "../components.js";
import { getServerPermissions } from "../format.js";
import { escapeHtml, labelWithIcon } from "../html.js";
import { ALL_LOADERS } from "../state.js";

// Catches the silent failure where the loader label says forge but the runtime
// on disk is vanilla: the server boots fine and loads no mods at all.
export function renderLoaderMismatchWarning(server) {
  const runtime = server.managedRuntime;
  if (!runtime || !runtime.kind) {
    return "";
  }

  const declared = String(server.loader || "").toLowerCase();
  const actual = String(runtime.kind).toLowerCase();
  if (declared === actual) {
    return "";
  }

  return `
    <div class="list-row list-row--notice">
      <div class="list-row__main">
        <strong>loader mismatch</strong>
        <p class="muted">this server is labelled <code>${escapeHtml(declared || "unset")}</code> but the runtime installed on disk is <code>${escapeHtml(actual)}</code>${runtime.loaderVersion ? ` (${escapeHtml(runtime.loaderVersion)})` : ""}.</p>
        <p class="muted">the label only changes which folder add-ons install into. it does not install a loader, so ${escapeHtml(declared || "that loader")} mods will not load. recreate this server with the ${escapeHtml(declared || "intended")} loader, or set the label back to <code>${escapeHtml(actual)}</code>.</p>
      </div>
    </div>
  `;
}

export function renderSettingsSection(snapshot) {
  const permissions = getServerPermissions(snapshot);
  if (!permissions.canAccessDangerousSettings) {
    return renderAdminSettingsSection(snapshot);
  }

  const { server, propertiesText } = snapshot;
  return renderSection(
    "settings",
    "metadata and server.properties",
    `
      ${renderLoaderMismatchWarning(server)}
      <form data-form="save-settings" class="form-grid">
        <div class="input-grid">
          <label>
            <span>name</span>
            <input name="name" value="${escapeHtml(server.name)}" />
          </label>
          <label>
            <span>loader</span>
            <select name="loader">
              ${ALL_LOADERS
                .map((loader) => `<option value="${loader}" ${server.loader === loader ? "selected" : ""}>${loader}</option>`)
                .join("")}
            </select>
          </label>
          <label>
            <span>minecraft version</span>
            <input name="minecraftVersion" list="minecraft-version-list" value="${escapeHtml(server.minecraftVersion || "")}" />
          </label>
          <label>
            <span>min memory</span>
            <input name="minMemory" value="${escapeHtml(server.minMemory || "2G")}" />
          </label>
          <label>
            <span>max memory</span>
            <input name="maxMemory" value="${escapeHtml(server.maxMemory || "4G")}" />
          </label>
          <label>
            <span>start command</span>
            <input name="startCommand" value="${escapeHtml(server.startCommand || "./launch-server.sh")}" />
          </label>
          <label>
            <span>java version</span>
            ${renderJavaBinSelect(server)}
          </label>
        </div>
        ${renderJavaBinNote(server)}
        <label>
          <span>description</span>
          <input name="description" value="${escapeHtml(server.description || "")}" />
        </label>
        <label>
          <span>new passphrase</span>
          <input type="password" name="passphrase" placeholder="leave blank to keep current value" />
        </label>
        <label>
          <span>server.properties</span>
          <textarea name="propertiesText" rows="18">${escapeHtml(propertiesText || "")}</textarea>
        </label>
        <div class="submit-line">
          <button class="button button--primary" type="submit">${labelWithIcon("settings", "save settings")}</button>
        </div>
      </form>
      ${renderServerOperatorsPanel(snapshot)}
    `
  );
}

export function renderServerOperatorsPanel(snapshot) {
  const operators = snapshot.operators || [];
  const broken = operators.filter((operator) => operator.uuidMatchesServerMode === false);
  return `
    <div class="subpanel">
      <div class="section-heading">
        <div>
          <p class="brand-line">server admins</p>
          <h3>in-game operators</h3>
        </div>
      </div>
      ${broken.length
        ? `
          <div class="list-row list-row--notice">
            <div class="list-row__main">
              <strong>${broken.length} operator${broken.length === 1 ? "" : "s"} cannot take effect</strong>
              <p class="muted">${escapeHtml(broken.map((operator) => operator.name).join(", "))} — the stored uuid is the wrong kind for this server's <code>online-mode</code>, so minecraft ignores the entry and the player has no powers in game.</p>
            </div>
            <div class="row-actions">
              <button class="button button--primary" type="button" data-action="repair-operators">${labelWithIcon("refresh", "fix uuids")}</button>
            </div>
          </div>
        `
        : ""}
      <form data-form="add-server-operator" class="form-grid">
        <div class="input-grid">
          <label>
            <span>player name</span>
            <input name="name" placeholder="RipperMoon" required />
          </label>
          <label>
            <span>uuid</span>
            <input name="uuid" placeholder="resolved automatically" disabled />
          </label>
          <label>
            <span>op level</span>
            <select name="level">
              <option value="4">4 - owner</option>
              <option value="3">3 - admin</option>
              <option value="2">2 - moderator</option>
              <option value="1">1 - helper</option>
            </select>
          </label>
          <label class="checkbox-line">
            <input type="checkbox" name="bypassesPlayerLimit" />
            <span>bypass player limit</span>
          </label>
        </div>
        <div class="submit-line">
          <button class="button button--primary" type="submit">${labelWithIcon("admin", "add admin")}</button>
        </div>
      </form>
      <div class="list-stack">
        ${operators.length
          ? operators
              .map((operator) => `
                <div class="list-row admin-row ${operator.uuidMatchesServerMode === false ? "list-row--notice" : ""}">
                  <div>
                    <strong>${escapeHtml(operator.name)}</strong>
                    <p class="muted">${escapeHtml(operator.uuid)} • level ${escapeHtml(String(operator.level || 4))}${operator.bypassesPlayerLimit ? " • bypasses limit" : ""}${operator.uuidKind ? ` • ${escapeHtml(operator.uuidKind)} uuid` : ""}${operator.uuidMatchesServerMode === false ? " • <strong>not active in game</strong>" : ""}</p>
                  </div>
                  <button class="button button--quiet button--compact" type="button" data-action="remove-server-operator" data-uuid="${escapeHtml(operator.uuid)}">${labelWithIcon("delete", "remove")}</button>
                </div>
              `)
              .join("")
          : `<p class="muted">no in-game operators are configured for this server.</p>`}
      </div>
    </div>
  `;
}

export function renderAdminSettingsSection(snapshot) {
  const { server, safeProperties, safePropertyDefinitions } = snapshot;
  const permissions = getServerPermissions(snapshot);
  return renderSection(
    "settings",
    "safe server settings. add-on loader can be changed here when this admin can manage add-ons.",
    `
      ${permissions.canManageAddonSettings
        ? `
          <form data-form="save-addon-settings" class="form-grid">
            <div class="input-grid">
              <label>
                <span>add-on loader</span>
                <select name="loader">
                  ${ALL_LOADERS
                    .map((loader) => `<option value="${loader}" ${server.loader === loader ? "selected" : ""}>${loader}</option>`)
                    .join("")}
                </select>
              </label>
              <label>
                <span>minecraft version</span>
                <input name="minecraftVersion" list="minecraft-version-list" value="${escapeHtml(server.minecraftVersion || "")}" />
              </label>
            </div>
            <div class="submit-line">
              <button class="button button--primary" type="submit">${labelWithIcon("mods", "save add-on settings")}</button>
            </div>
          </form>
        `
        : ""}
      <form data-form="save-safe-settings" class="form-grid">
        <div class="input-grid">
          ${safePropertyDefinitions
            .map((definition) => renderSafeSettingField(definition, safeProperties ? safeProperties[definition.key] : definition.defaultValue))
            .join("")}
        </div>
        <div class="submit-line">
          <button class="button button--primary" type="submit">${labelWithIcon("settings", "save safe settings")}</button>
        </div>
      </form>
    `
  );
}
