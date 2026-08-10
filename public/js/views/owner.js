import { renderCreateVersionPicker, renderJavaBinSelect, renderPageHeader, renderSection } from "../components.js";
import { escapeHtml, labelWithIcon } from "../html.js";
import { createLoaderNote, isInstallableLoader } from "../loaders.js";
import { ALL_LOADERS, state } from "../state.js";

export function renderCreateProgress() {
  const job = state.createJob;
  if (!job) {
    return "";
  }

  const percent = Math.round((job.progress || 0) * 100);
  // The installer step can hold for ~25s; an elapsed counter keeps it from
  // looking frozen while the bar is stationary.
  const elapsedSeconds = Math.max(0, Math.round((Date.now() - new Date(job.createdAt).getTime()) / 1000));
  return renderSection(
    "creating server",
    `step ${job.stepIndex} of ${job.totalSteps} • ${elapsedSeconds}s elapsed`,
    `
      <p>${escapeHtml(job.step || "working")}…</p>
      <div class="progress-track" role="progressbar" aria-valuenow="${percent}" aria-valuemin="0" aria-valuemax="100">
        <div class="progress-track__fill" style="width: ${percent}%"></div>
      </div>
      <p class="muted">${percent}% • forge and neoforge run a real installer, so that step alone takes about 25 seconds. leaving this page does not cancel it.</p>
    `
  );
}

export function renderOwnerServers() {
  return `
    ${renderCreateProgress()}
    ${renderSection(
      "create or register server",
      "create a managed server folder or register an existing one",
      `
        <form data-form="create-server" class="form-grid">
          <div class="input-grid">
            <label>
              <span>name</span>
              <input name="name" required />
            </label>
            <label>
              <span>server id / directory</span>
              <input name="directoryName" placeholder="moon-lab" required />
            </label>
            <label>
              <span>mode</span>
              <select name="mode">
                <option value="managed">create managed server folder</option>
                <option value="existing">register existing server folder</option>
              </select>
            </label>
            <label>
              <span>loader</span>
              <select name="loader">
                ${ALL_LOADERS.map(
                  (loader) =>
                    `<option value="${loader}">${loader}${isInstallableLoader(loader) ? "" : " (existing folders only)"}</option>`
                ).join("")}
              </select>
            </label>
            <label>
              <span>java version</span>
              ${renderJavaBinSelect({ javaBin: "" })}
            </label>
            <label>
              <span>passphrase</span>
              <input type="password" name="passphrase" />
            </label>
          </div>
          ${renderCreateVersionPicker()}
          <p class="muted" data-create-loader-note>${escapeHtml(createLoaderNote("managed", "vanilla"))}</p>
          <label>
            <span>description</span>
            <input name="description" />
          </label>
          <div class="submit-line">
            <button class="button button--primary" type="submit">${labelWithIcon("server", "create server")}</button>
          </div>
        </form>
      `
    )}
    ${renderSection(
      "current servers",
      "registered server folders",
      `
        <div class="list-rows">
          ${state.servers.length
            ? state.servers
                .map(
                  (server) => `
                    <div class="list-row">
                      <div class="list-row__main">
                        <strong>${escapeHtml(server.name)}</strong>
                        <p class="muted">${escapeHtml(server.loader)} • ${escapeHtml(server.minecraftVersion || "unknown")} • ${escapeHtml(server.directory)}</p>
                      </div>
                      <div class="row-actions">
                        <button class="button button--quiet" data-action="owner-open-server" data-server-id="${escapeHtml(server.id)}">${labelWithIcon("overview", "open")}</button>
                        <button class="button button--danger" data-action="delete-server" data-server-id="${escapeHtml(server.id)}" data-server-name="${escapeHtml(server.name)}">${labelWithIcon("stop", "delete")}</button>
                      </div>
                    </div>
                  `
                )
                .join("")
            : `<p class="muted">no servers yet</p>`}
        </div>
      `
    )}
  `;
}

export function renderOwnerAdmins() {
  const editingUser = state.users.find((user) => user.id === state.editingUserId);
  const resettingUser = state.users.find((user) => user.id === state.resettingUserId);

  function renderPermissionMatrix(user = null) {
    const accessibleServers = new Set(user?.servers || []);
    const worldServers = new Set(user?.permissions?.createWorldServers || []);
    return `
      <div class="permission-matrix">
        <div class="permission-matrix__row permission-matrix__row--header">
          <span>server</span>
          <span>access</span>
          <span>world creation</span>
        </div>
        ${state.servers.length
          ? state.servers
              .map(
                (server) => `
                  <div class="permission-matrix__row">
                    <strong>${escapeHtml(server.name)}</strong>
                    <label class="check-cell">
                      <input type="checkbox" name="servers" value="${escapeHtml(server.id)}" ${accessibleServers.has(server.id) ? "checked" : ""} />
                      <span>allow</span>
                    </label>
                    <label class="check-cell">
                      <input type="checkbox" name="createWorldServers" value="${escapeHtml(server.id)}" ${worldServers.has(server.id) ? "checked" : ""} />
                      <span>allow</span>
                    </label>
                  </div>
                `
              )
              .join("")
          : `<p class="muted">create a server before assigning admin access.</p>`}
      </div>
    `;
  }

  function renderAdminAccessSummary(user) {
    const accessCount = user.servers?.length || 0;
    const worldCount = user.permissions?.createWorldServers?.length || 0;
    if (user.role === "owner") {
      return "super access";
    }
    if (!accessCount && !worldCount) {
      return "no assigned servers";
    }
    return `${accessCount} server${accessCount === 1 ? "" : "s"} • ${worldCount} world trait${worldCount === 1 ? "" : "s"}`;
  }

  function renderUserEditor(user) {
    if (!user) {
      return "";
    }

    return `
      <div class="modal-scrim">
        <section class="modal-panel modal-panel--wide" role="dialog" aria-modal="true" aria-labelledby="edit-user-title">
          <div class="modal-heading">
            <div>
              <p class="brand-line">admin settings</p>
              <h2 id="edit-user-title">${escapeHtml(user.displayName)}</h2>
            </div>
            <button class="button button--quiet button--compact" type="button" data-action="close-user-editor">close</button>
          </div>
          <form data-form="update-user" class="form-grid">
            <input type="hidden" name="userId" value="${escapeHtml(user.id)}" />
            <div class="input-grid input-grid--compact">
              <label>
                <span>display name</span>
                <input name="displayName" value="${escapeHtml(user.displayName)}" />
              </label>
              <label>
                <span>username</span>
                <input name="username" value="${escapeHtml(user.username)}" />
              </label>
              <label>
                <span>new password</span>
                <input type="password" name="password" placeholder="leave blank to keep current" />
              </label>
              <label>
                <span>role</span>
                <select name="role">
                  <option value="admin" ${user.role === "admin" ? "selected" : ""}>admin</option>
                  <option value="owner" ${user.role === "owner" ? "selected" : ""}>owner</option>
                </select>
              </label>
            </div>
            <div>
              <p class="permission-title">server permissions</p>
              <p class="muted">world creation automatically includes server access for that server.</p>
              ${renderPermissionMatrix(user)}
            </div>
            <div class="submit-line submit-line--split">
              <button class="button button--quiet" type="button" data-action="close-user-editor">cancel</button>
              <button class="button button--primary" type="submit">${labelWithIcon("settings", "save admin")}</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  function renderPasswordReset(user) {
    if (!user) {
      return "";
    }

    return `
      <div class="modal-scrim">
        <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="reset-user-title">
          <div class="modal-heading">
            <div>
              <p class="brand-line">password reset</p>
              <h2 id="reset-user-title">${escapeHtml(user.displayName)}</h2>
              <p class="muted">${escapeHtml(user.username)} requested a password reset.</p>
            </div>
            <button class="button button--quiet button--compact" type="button" data-action="close-password-reset">close</button>
          </div>
          <form data-form="reset-user-password" class="form-grid">
            <input type="hidden" name="userId" value="${escapeHtml(user.id)}" />
            <label>
              <span>new temporary password</span>
              <input type="password" name="password" autocomplete="new-password" required />
            </label>
            <div class="submit-line submit-line--split">
              <button class="button button--quiet" type="button" data-action="close-password-reset">cancel</button>
              <button class="button button--primary" type="submit">${labelWithIcon("unlock", "reset password")}</button>
            </div>
          </form>
        </section>
      </div>
    `;
  }

  return `
    ${renderSection(
      "create admin",
      "owner accounts keep super access across all servers",
      `
        <form data-form="create-user" class="form-grid">
          <div class="input-grid">
            <label>
              <span>username</span>
              <input name="username" required />
            </label>
            <label>
              <span>display name</span>
              <input name="displayName" required />
            </label>
            <label>
              <span>password</span>
              <input type="password" name="password" required />
            </label>
            <label>
              <span>role</span>
              <select name="role">
                <option value="admin">admin</option>
                <option value="owner">owner</option>
              </select>
            </label>
          </div>
          <div>
            <p class="permission-title">server permissions</p>
            <p class="muted">world creation automatically includes server access for that server.</p>
            ${renderPermissionMatrix()}
          </div>
          <div class="submit-line">
            <button class="button button--primary" type="submit">${labelWithIcon("admin", "create user")}</button>
          </div>
        </form>
      `
    )}
    ${renderSection(
      "existing users",
      "edit access and credentials",
      `
        <div class="list-rows">
          ${state.users
            .map(
              (user) => `
                <div class="list-row admin-row">
                  <div class="list-row__main">
                    <strong>${escapeHtml(user.displayName)}</strong>
                    <p class="muted">${escapeHtml(user.username)} • ${escapeHtml(user.role)}</p>
                    <p class="muted">${escapeHtml(renderAdminAccessSummary(user))}</p>
                  </div>
                  <div class="row-actions">
                    <button class="button button--quiet button--compact" type="button" data-action="reset-user-password" data-user-id="${escapeHtml(user.id)}">${labelWithIcon("unlock", "reset password")}</button>
                    <button class="button button--quiet button--compact" type="button" data-action="edit-user" data-user-id="${escapeHtml(user.id)}">${labelWithIcon("settings", "edit")}</button>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `
    )}
    ${renderUserEditor(editingUser)}
    ${renderPasswordReset(resettingUser)}
  `;
}

export const OWNER_PAGE_COPY = {
  admins: ["owner / admins", "manage who can see and control each server"],
  integrations: ["owner / integrations", "api credentials shared by every server on this dashboard"],
  servers: ["owner / server registry", "create new server entries and review what is registered"]
};

export function renderOwnerContent() {
  const [title, subtitle] = OWNER_PAGE_COPY[state.ownerSection] || OWNER_PAGE_COPY.servers;
  const body =
    state.ownerSection === "admins"
      ? renderOwnerAdmins()
      : state.ownerSection === "integrations"
        ? renderOwnerIntegrations()
        : renderOwnerServers();

  return `
    ${renderPageHeader(title, "owner controls", subtitle)}
    ${body}
  `;
}

export function renderOwnerIntegrations() {
  const curseforge = state.integrations?.curseforge;
  if (!curseforge) {
    return renderSection("integrations", "loading", `<p class="muted">loading credentials…</p>`);
  }

  const override = curseforge.envOverride;
  const statusLine = curseforge.stored
    ? `<p class="muted">a key is saved in this dashboard${curseforge.hint ? ` • ends in <code>${escapeHtml(curseforge.hint)}</code>` : ""}</p>`
    : `<p class="muted">no key is saved in this dashboard.</p>`;

  // When an environment variable is in force, saving here still works but has
  // no effect until it is removed - so spell out the file, line and command.
  const overrideNotice = override
    ? `
      <div class="list-row list-row--notice">
        <div class="list-row__main">
          <strong>an environment variable is in control</strong>
          <p class="muted">the active key comes from <code>${escapeHtml(override.variable)}</code> in this service's environment, which overrides anything saved below.</p>
          <p class="muted">to manage the key from this page instead, remove that line and restart:</p>
          <pre>sudo nano ${escapeHtml(override.envFile)}
# delete the ${escapeHtml(override.variable)}=... line, save, then:
sudo systemctl restart ${escapeHtml(override.service)}</pre>
          <p class="muted">if the variable is set somewhere else, check <code>systemctl cat ${escapeHtml(override.service)}</code> for other <code>Environment=</code> or <code>EnvironmentFile=</code> lines.</p>
        </div>
      </div>
    `
    : "";

  return renderSection(
    "curseforge",
    curseforge.configured ? `connected via ${curseforge.source}` : "not connected",
    `
      ${overrideNotice}
      ${statusLine}
      <form data-form="save-integration" class="form-grid">
        <label>
          api key
          <input name="curseforgeApiKey" type="password" autocomplete="off" placeholder="paste a key from console.curseforge.com" />
        </label>
        <p class="muted">the key is verified against curseforge before it is saved, and is never sent back to this page. get one at <code>console.curseforge.com</code> → api keys.</p>
        <div class="row-actions">
          <button class="button button--primary" type="submit">${labelWithIcon("mods", "save key")}</button>
          ${curseforge.configured
            ? `<button class="button button--quiet" type="button" data-action="test-integration">${labelWithIcon("search", "test connection")}</button>`
            : ""}
          ${curseforge.stored
            ? `<button class="button button--danger" type="button" data-action="clear-integration">${labelWithIcon("stop", "remove saved key")}</button>`
            : ""}
        </div>
      </form>
    `
  );
}
