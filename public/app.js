const state = {
  bootstrap: null,
  selectedServerId: null,
  serverSnapshot: null,
  servers: [],
  users: [],
  view: "server",
  serverSection: "overview",
  ownerSection: "servers",
  createServerMinecraftVersion: "latest",
  createVersionOpen: false,
  editingUserId: null,
  createJob: null,
  integrations: null,
  logAutoRefresh: localStorage.getItem("rippermoonstash-log-auto") !== "off",
  modUpdates: null,
  logOrder: localStorage.getItem("rippermoonstash-log-order") === "newest" ? "newest" : "oldest",
  javaRuntimes: [],
  manualDownload: null,
  modProvider: "modrinth",
  modQuery: "",
  modResults: [],
  navOpen: false,
  notice: null,
  theme: localStorage.getItem("rippermoonstash-theme") || "dark",
  updatePlan: null,
  versionCatalog: null,
  resettingUserId: null
};

const app = document.getElementById("app");

const SERVER_SECTIONS = [
  ["overview", "overview"],
  ["settings", "settings"],
  ["worlds", "worlds"],
  ["mods", "mods"],
  ["logs", "logs"]
];

const OWNER_SECTIONS = [
  ["servers", "server registry"],
  ["admins", "admins"],
  ["integrations", "integrations"]
];

// Every loader that can be set as a label. Which of these can actually be
// provisioned comes from the backend - see installableLoaders().
const ALL_LOADERS = ["vanilla", "fabric", "forge", "neoforge", "quilt", "paper", "purpur", "custom"];

const ICONS = {
  admin: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm-4.5 10a4.5 4.5 0 1 1 9 0v.8h-9Z" fill="currentColor"/></svg>',
  logs: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 2.5h10v11H3Zm2 2h6v1H5Zm0 3h6v1H5Zm0 3h4v1H5Z" fill="currentColor"/></svg>',
  mods: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.2 2.5h3.6L11 4.1h1.5v3.2l-1.2 1.1v3.1H4.7V8.4L3.5 7.3V4.1H5Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>',
  overview: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.5h11v9h-11Zm2 2h7v1h-7Zm0 3h5v1h-5Z" fill="currentColor"/></svg>',
  owner: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m8 2.2 1.6 1.4 2.1-.1.6 2 1.8 1-1 1.8.4 2.1-2 .5L10.3 13 8 12.3 5.7 13l-1.2-1.8-2-.5.4-2.1-1-1.8 1.8-1 .6-2 2.1.1Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
  refresh: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M12.4 5.1A4.8 4.8 0 1 0 13 8h-1.3a3.5 3.5 0 1 1-.5-1.8L9.7 7.7H14V3.4Z" fill="currentColor"/></svg>',
  search: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 2.5a4.3 4.3 0 1 1 0 8.6 4.3 4.3 0 0 1 0-8.6Zm3.4 7.1 2.8 2.8-.9.9-2.8-2.8Z" fill="currentColor"/></svg>',
  server: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3h11v3h-11Zm0 4.5h11v3h-11Zm0 4.5h11v1.5h-11Z" fill="currentColor"/></svg>',
  settings: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6.8 2.5h2.4l.4 1.6 1.4.6 1.4-.8 1.2 1.7-1.1 1 .1 1.5 1.4.9-.8 2-1.7-.3-1.2.9-.3 1.7h-2l-.6-1.5-1.4-.5-1.4.8-1.2-1.7 1.1-1.1-.1-1.5-1.4-.8.8-2 1.7.3 1.2-.9Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/></svg>',
  start: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.2 12 8l-7 4.8Z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 4.2h7.6v7.6H4.2Z" fill="currentColor"/></svg>',
  theme: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a5.8 5.8 0 1 0 0 11.6 4.4 4.4 0 0 1 0-11.6Z" fill="currentColor"/></svg>',
  unlock: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 7V5.7a3 3 0 1 1 6 0" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 7h8v5.5H4Z" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="8" cy="9.6" r=".9" fill="currentColor"/></svg>',
  worlds: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2c3.2 0 5.8 2.6 5.8 5.8S11.2 13.8 8 13.8 2.2 11.2 2.2 8 4.8 2.2 8 2.2Zm0 1.3a4.5 4.5 0 0 0 0 9 4.5 4.5 0 0 0 0-9Zm-2.5 4h5v1h-5Z" fill="currentColor"/></svg>'
};

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function icon(name, label = "") {
  return `<span class="icon"${label ? ` aria-label="${escapeHtml(label)}"` : ""}>${ICONS[name] || ""}</span>`;
}

function labelWithIcon(name, text, extraClass = "") {
  return `<span class="label-with-icon ${extraClass}">${icon(name)}<span>${escapeHtml(text)}</span></span>`;
}

function syncDocumentMeta() {
  const titleBase = "RipperMoonStash";
  let title = `${titleBase} | Minimal Minecraft Server Dashboard`;
  let description =
    "RipperMoonStash is a minimal Minecraft server dashboard for managing servers, mods, worlds, logs, admin access, and start-stop controls from the browser.";

  if (state.bootstrap?.loggedIn && state.view === "owner") {
    title = `${titleBase} | Owner Controls`;
    description = "Owner controls for Minecraft server registry, admin roles, server access lanes, and dashboard configuration.";
  } else if (state.bootstrap?.loggedIn && state.serverSnapshot?.server) {
    const server = state.serverSnapshot.server;
    title = `${titleBase} | ${server.name}`;
    description = `${server.name} on RipperMoonStash. Manage settings, worlds, mods, logs, and protected admin actions from one minimal interface.`;
  }

  document.title = title;

  const pairs = [
    ['meta[name="description"]', description],
    ['meta[property="og:title"]', title],
    ['meta[property="og:description"]', description],
    ['meta[name="twitter:title"]', title],
    ['meta[name="twitter:description"]', description]
  ];

  for (const [selector, value] of pairs) {
    const element = document.querySelector(selector);
    if (element) {
      element.setAttribute("content", value);
    }
  }
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    },
    method: options.method || "GET",
    body:
      options.body instanceof FormData
        ? options.body
        : options.body
          ? JSON.stringify(options.body)
          : undefined
  });

  if (response.status === 204) {
    return null;
  }

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error((payload && payload.error) || payload || "Request failed.");
    if (payload && payload.code) {
      error.code = payload.code;
    }
    if (payload && payload.manualDownload) {
      error.manualDownload = payload.manualDownload;
    }
    throw error;
  }

  return payload;
}

function setNotice(type, message) {
  state.notice = { type, message };
  render();
}

function clearNotice() {
  state.notice = null;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme === "light" ? "light" : "dark";
}

function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  localStorage.setItem("rippermoonstash-theme", state.theme);
  applyTheme();
}

function formatDate(value) {
  if (!value) {
    return "unknown";
  }
  return new Date(value).toLocaleString();
}

function getServerPermissions(snapshot = state.serverSnapshot) {
  return (
    snapshot?.server?.permissions || {
      canAccessDangerousSettings: false,
      canManageAddonSettings: false,
      canApplyCombinedUpdates: false,
      canCreateWorlds: false,
      canControlRuntime: false,
      canUseManualAddons: false,
      canViewProtectedTools: false,
      canWriteSafeSettings: false,
      requiresUnlock: false,
      unlocked: false
    }
  );
}

function isServerLocked(snapshot = state.serverSnapshot) {
  return Boolean(getServerPermissions(snapshot).requiresUnlock);
}

function renderSelectOptions(options, selectedValue) {
  return options
    .map((option) => `<option value="${escapeHtml(option)}" ${String(selectedValue) === option ? "selected" : ""}>${escapeHtml(option)}</option>`)
    .join("");
}

function renderSafeSettingField(definition, value) {
  if (definition.type === "boolean") {
    return `
      <label>
        <span>${escapeHtml(definition.key)}</span>
        <select name="${escapeHtml(definition.key)}">
          ${renderSelectOptions(["true", "false"], value)}
        </select>
      </label>
    `;
  }

  if (definition.type === "enum") {
    return `
      <label>
        <span>${escapeHtml(definition.key)}</span>
        <select name="${escapeHtml(definition.key)}">
          ${renderSelectOptions(definition.options || [], value)}
        </select>
      </label>
    `;
  }

  return `
    <label>
      <span>${escapeHtml(definition.key)}</span>
      <input name="${escapeHtml(definition.key)}" value="${escapeHtml(value || "")}" ${definition.type === "number" ? 'inputmode="numeric"' : ""} />
    </label>
  `;
}

function renderVersionDatalist(listId, includeLatest = false) {
  const versions = state.versionCatalog?.versions || [];
  if (!versions.length) {
    return "";
  }

  return `
    <datalist id="${escapeHtml(listId)}">
      ${includeLatest ? '<option value="latest" label="latest release"></option>' : ""}
      ${versions
        .map(
          (version) => `
            <option
              value="${escapeHtml(version.id)}"
              label="${escapeHtml(`${version.type} · ${new Date(version.releaseTime).toLocaleDateString()}`)}"
            ></option>
          `
        )
        .join("")}
    </datalist>
  `;
}

function renderMinecraftVersionOptions(includeLatest = false) {
  const versions = state.versionCatalog?.versions || [];
  return `
    ${includeLatest ? '<option value="latest">latest release</option>' : ""}
    ${versions
      .map(
        (version) => `
          <option value="${escapeHtml(version.id)}">
            ${escapeHtml(version.id)} ${version.type === "release" ? "release" : "snapshot"}
          </option>
        `
      )
      .join("")}
  `;
}

function renderCreateVersionPicker() {
  const selected = state.createServerMinecraftVersion || "latest";
  const versions = [
    ...(state.versionCatalog?.latest?.release ? [{ id: "latest", label: `latest release (${state.versionCatalog.latest.release})` }] : [{ id: "latest", label: "latest release" }]),
    ...((state.versionCatalog?.versions || []).map((version) => ({
      id: version.id,
      label: `${version.id} ${version.type === "release" ? "release" : "snapshot"}`
    })))
  ];
  const selectedVersion = versions.find((version) => version.id === selected) || versions[0] || { id: "latest", label: "latest release" };

  return `
    <div class="version-picker ${state.createVersionOpen ? "version-picker--open" : ""}" data-version-picker>
      <input type="hidden" name="minecraftVersion" value="${escapeHtml(selectedVersion.id)}" />
      <button class="version-picker__button" type="button" data-action="toggle-create-version-picker" aria-expanded="${state.createVersionOpen ? "true" : "false"}">
        <span>
          <span class="version-picker__label">minecraft version</span>
          <strong>${escapeHtml(selectedVersion.label)}</strong>
        </span>
        <span class="version-picker__chevron">⌄</span>
      </button>
      ${state.createVersionOpen
        ? `
          <div class="version-picker__menu">
            ${versions
              .map(
                (version) => `
                  <button
                    class="version-picker__option ${version.id === selectedVersion.id ? "version-picker__option--active" : ""}"
                    type="button"
                    data-action="select-create-version"
                    data-version="${escapeHtml(version.id)}"
                  >
                    ${escapeHtml(version.label)}
                  </button>
                `
              )
              .join("")}
          </div>
        `
        : ""}
    </div>
  `;
}

async function loadBootstrap() {
  state.bootstrap = await api("/api/bootstrap");
}

async function loadServers() {
  const payload = await api("/api/servers");
  state.servers = payload.servers;
  if (!state.selectedServerId && state.servers.length) {
    state.selectedServerId = state.servers[0].id;
  }
}

async function loadSnapshot() {
  if (!state.selectedServerId) {
    state.serverSnapshot = null;
    return;
  }
  state.updatePlan = null;
  state.serverSnapshot = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}`);
}

async function loadUsers() {
  if (!state.bootstrap?.user || state.bootstrap.user.role !== "owner") {
    state.users = [];
    return;
  }
  const payload = await api("/api/users");
  state.users = payload.users;
}

async function loadVersionCatalog() {
  if (!state.bootstrap?.loggedIn || state.bootstrap.user.role !== "owner") {
    state.versionCatalog = null;
    return;
  }
  state.versionCatalog = await api("/api/minecraft/versions");
}

async function loadIntegrations() {
  if (!state.bootstrap?.user || state.bootstrap.user.role !== "owner") {
    state.integrations = null;
    return;
  }
  const payload = await api("/api/settings/integrations");
  state.integrations = payload.integrations;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Polls a provisioning job to completion, re-rendering on each step so the
// progress panel actually moves during a long Forge install.
async function pollCreateJob(jobId) {
  for (;;) {
    await wait(1000);

    let payload;
    try {
      payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    } catch (error) {
      state.createJob = null;
      setNotice("error", `lost track of the creation job: ${error.message}`);
      return;
    }

    state.createJob = payload.job;

    if (payload.job.status === "succeeded") {
      const created = payload.job.result && payload.job.result.server;
      state.createJob = null;
      state.createVersionOpen = false;
      state.createServerMinecraftVersion = "latest";
      if (created) {
        state.selectedServerId = created.id;
        state.view = "server";
        state.serverSection = "overview";
      }
      setNotice("success", created ? `created ${created.name}` : "server created");
      await refreshAll();
      return;
    }

    if (payload.job.status === "failed") {
      state.createJob = null;
      setNotice("error", payload.job.error || "server creation failed");
      return;
    }

    render();
  }
}

async function loadJavaRuntimes() {
  if (!state.bootstrap?.user || state.bootstrap.user.role !== "owner") {
    state.javaRuntimes = [];
    return;
  }
  const payload = await api("/api/java-runtimes");
  state.javaRuntimes = payload.runtimes || [];
}

async function refreshAll() {
  await loadBootstrap();
  if (state.bootstrap.loggedIn) {
    await loadServers();
    await loadSnapshot();
    await loadUsers();
    await loadIntegrations();
    await loadJavaRuntimes();
    await loadVersionCatalog();
  } else {
    state.servers = [];
    state.serverSnapshot = null;
    state.users = [];
    state.integrations = null;
    state.javaRuntimes = [];
    state.versionCatalog = null;
    state.updatePlan = null;
  }
  render();
}

function renderAuth(title, subtitle, mode) {
  const isSetup = mode === "setup";
  return `
    <main class="auth-shell">
      <figure class="auth-quote">
        <blockquote>with great power comes great responsibility</blockquote>
        <figcaption>Uncle Ben</figcaption>
      </figure>
      <section class="auth-panel">
        <p class="brand-line brand-inline">RipperMoonStash</p>
        <h1>${escapeHtml(title)}</h1>
        <form data-form="${isSetup ? "setup" : "login"}" class="form-grid">
          <label>
            <span>Username</span>
            <input name="username" autocomplete="username" required />
          </label>
          ${isSetup
            ? `
              <label>
                <span>Display Name</span>
                <input name="displayName" placeholder="Ripper Moon" />
              </label>
            `
            : ""}
          <label>
            <span>Password</span>
            <input type="password" name="password" autocomplete="${isSetup ? "new-password" : "current-password"}" required />
          </label>
          <button class="button button--primary" type="submit">${labelWithIcon("unlock", isSetup ? "Create Owner Account" : "Log In")}</button>
        </form>
      </section>
    </main>
  `;
}

function renderServerTree() {
  return `
    <section class="tree-block">
      <button class="tree-root ${state.view === "server" ? "tree-root--active" : ""}" data-action="show-servers">${labelWithIcon("server", "servers")}</button>
      <div class="tree-branch tree-branch--root">
        ${state.servers.length
          ? state.servers
              .map((server) => {
                const selected = server.id === state.selectedServerId;
                const expanded = selected && state.view === "server";
                return `
                  <div class="tree-group">
                    <button
                      class="tree-node ${expanded ? "tree-node--active" : ""}"
                      data-action="select-server"
                      data-server-id="${escapeHtml(server.id)}"
                    >
                      ${labelWithIcon("server", server.name)}
                      <span class="tree-meta">${server.status.running ? "up" : "down"}</span>
                    </button>
                    ${expanded
                      ? `
                        <div class="tree-branch">
                          ${SERVER_SECTIONS.map(
                            ([sectionId, label]) => `
                              <button
                                class="tree-leaf ${state.serverSection === sectionId ? "tree-leaf--active" : ""}"
                                data-action="select-server-section"
                                data-section="${sectionId}"
                              >
                                ${labelWithIcon(sectionId, label)}
                              </button>
                            `
                          ).join("")}
                        </div>
                      `
                      : ""}
                  </div>
                `;
              })
              .join("")
          : `<p class="tree-empty">no servers yet</p>`}
      </div>
    </section>
  `;
}

function renderOwnerTree() {
  if (state.bootstrap.user.role !== "owner") {
    return "";
  }

  return `
    <section class="tree-block">
      <button class="tree-root ${state.view === "owner" ? "tree-root--active" : ""}" data-action="show-owner">${labelWithIcon("owner", "owner")}</button>
      <div class="tree-branch tree-branch--root">
        ${OWNER_SECTIONS.map(
          ([sectionId, label]) => `
            <button
              class="tree-leaf ${state.view === "owner" && state.ownerSection === sectionId ? "tree-leaf--active" : ""}"
              data-action="select-owner-section"
              data-owner-section="${sectionId}"
            >
              ${labelWithIcon(sectionId === "admins" ? "admin" : "server", label)}
            </button>
          `
        ).join("")}
      </div>
    </section>
  `;
}

function renderSidebar() {
  return `
    <aside class="rail ${state.navOpen ? "rail--open" : ""}">
      <div class="rail-top">
        <p class="brand-line">${labelWithIcon("server", "RipperMoonStash", "brand-inline")}</p>
        <p class="session-line">${escapeHtml(state.bootstrap.user.username)} <span>${escapeHtml(state.bootstrap.user.role)}</span></p>
      </div>
      <nav class="tree-nav">
        ${renderServerTree()}
        ${renderOwnerTree()}
      </nav>
      <div class="rail-bottom">
        <button class="button button--quiet" data-action="logout">${labelWithIcon("stop", "log out")}</button>
      </div>
    </aside>
  `;
}

function renderPageHeader(pathLabel, title, subtitle, actions = "") {
  return `
    <header class="page-header">
      <p class="path-line">${escapeHtml(pathLabel)}</p>
      <div class="page-header__top">
        <div>
          <h1>${escapeHtml(title)}</h1>
          <p class="muted copy">${escapeHtml(subtitle || "")}</p>
        </div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ""}
      </div>
    </header>
  `;
}

function renderMetaRows(rows) {
  return `
    <div class="meta-list">
      ${rows
        .map(
          ([label, value]) => `
            <div class="meta-row">
              <span>${escapeHtml(label)}</span>
              <strong>${value}</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderSection(title, subtitle, body) {
  const sectionIcon =
    title === "lane" ? "unlock" :
    title === "eula" ? "overview" :
    title === "server" ? "server" :
    title === "settings" ? "settings" :
    title === "worlds" ? "worlds" :
    title === "mods" ? "mods" :
    title === "logs" ? "logs" :
    title === "updates" ? "refresh" :
    title.includes("server") ? "server" :
    title.includes("user") ? "admin" :
    title.includes("admin") ? "admin" :
    "overview";

  return `
    <section class="section-block">
      <div class="section-heading">
        <h2>${labelWithIcon(sectionIcon, title)}</h2>
        ${subtitle ? `<p class="muted">${escapeHtml(subtitle)}</p>` : ""}
      </div>
      <div class="section-body">
        ${body}
      </div>
    </section>
  `;
}

function renderOverviewSection(snapshot) {
  const { server, worlds, mods, runtime, unlocked } = snapshot;
  const unlockBody = `
    <div class="inline-note">
      <span class="status-inline ${unlocked ? "status-inline--ok" : "status-inline--idle"}">${icon("unlock")}${unlocked ? "lane unlocked" : "lane locked"}</span>
      <span class="muted">${server.passphraseConfigured ? "passphrase required for edits and installs" : "no passphrase set yet"}</span>
    </div>
    <form data-form="unlock-server" class="form-inline">
      <input type="password" name="passphrase" placeholder="server passphrase" ${state.bootstrap.user.role === "owner" ? "" : "required"} />
      <button class="button button--primary" type="submit">${labelWithIcon("unlock", state.bootstrap.user.role === "owner" ? "owner unlock" : "unlock")}</button>
    </form>
  `;

  const infoBody = `
    ${renderMetaRows([
      ["status", escapeHtml(server.status.running ? "online" : "offline")],
      ["eula", escapeHtml(server.eulaAccepted ? "accepted" : "pending")],
      ["loader", escapeHtml(server.loader)],
      ["minecraft", escapeHtml(server.minecraftVersion || "unknown")],
      ["directory", `<code>${escapeHtml(server.directory)}</code>`],
      ["addons dir", `<code>${escapeHtml(runtime.modsDir)}</code>`],
      ["world archives", escapeHtml(String(worlds.length))],
      ["installed addons", escapeHtml(String(mods.length))]
    ])}
  `;

  const eulaBody = `
    <div class="inline-note">
      <span class="status-inline ${server.eulaAccepted ? "status-inline--ok" : "status-inline--danger"}">${icon("overview")}${server.eulaAccepted ? "accepted" : "action required"}</span>
      <span class="muted">${server.eulaAccepted ? "the server can pass the EULA gate." : "minecraft will refuse to start until the EULA is accepted."}</span>
    </div>
    ${state.bootstrap.user.role === "owner" && !server.eulaAccepted
      ? `
        <form data-form="accept-eula" class="form-inline">
          <button class="button button--primary" type="submit">${labelWithIcon("unlock", "accept eula")}</button>
          <span class="muted">by using this button, the owner confirms acceptance of Mojang's Minecraft server EULA for this server.</span>
        </form>
      `
      : ""}
  `;

  return `
    ${renderSection("lane", "unlock before sensitive actions", unlockBody)}
    ${renderSection("eula", "minecraft startup requirement", eulaBody)}
    ${renderSection("server", "current server state", infoBody)}
    ${state.bootstrap.user.role === "owner" ? renderUpdatesSection(snapshot) : ""}
  `;
}

function renderUpdatePlanSummary(plan, server) {
  if (!plan) {
    return "";
  }

  const blocked = plan.blockedReasons?.length
    ? `
        <div class="list-rows">
          ${plan.blockedReasons
            .map(
              (reason) => `
                <div class="list-row">
                  <div class="list-row__main">
                    <strong>blocked</strong>
                    <p class="muted">${escapeHtml(reason)}</p>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `
    : "";

  const updates = plan.addons?.updates?.length
    ? `
        <div class="list-rows">
          ${plan.addons.updates
            .map(
              (entry) => `
                <div class="list-row">
                  <div class="list-row__main">
                    <strong>${escapeHtml(entry.fileName)}</strong>
                    <p class="muted">${escapeHtml(entry.provider)} • ${escapeHtml(entry.sourceId)}</p>
                    <p class="muted">${escapeHtml(entry.fromFileName || "new dependency")} → ${escapeHtml(entry.fileName)}</p>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `
    : `<p class="muted">no managed add-ons need a file change for this target.</p>`;

  return `
    <div class="tool-stack">
      <div class="inline-note">
        <span class="status-inline ${plan.safe ? "status-inline--ok" : "status-inline--danger"}">${icon("refresh")}${plan.safe ? "safe to apply" : "blocked"}</span>
        <span class="muted">target ${escapeHtml(plan.targetVersion || server.minecraftVersion || "current version")}</span>
      </div>
      ${blocked}
      ${renderMetaRows([
        ["runtime", escapeHtml(plan.runtime?.runtimeKind || server.loader)],
        ["managed add-ons", escapeHtml(String(plan.addons?.managedCount || 0))],
        ["manual add-ons", escapeHtml(String(plan.addons?.manualCount || 0))],
        ["untracked files", escapeHtml(String((plan.addons?.untrackedFiles || []).length))]
      ])}
      ${updates}
    </div>
  `;
}

function renderUpdatesSection(snapshot) {
  const { server } = snapshot;
  const support = server.updateSupport || { supported: false, reason: "Combined safe updates are unavailable for this server." };
  const plan = state.updatePlan && state.updatePlan.serverId === server.id ? state.updatePlan.plan : null;
  const applyAction =
    plan && plan.safe
      ? `<button class="button button--primary" type="button" data-action="apply-update">${labelWithIcon("refresh", "apply safe update")}</button>`
      : "";

  return renderSection(
    "updates",
    "owner-only combined runtime and add-on updates",
    `
      <p class="muted">the server must be stopped. every add-on must be tracked by the dashboard, and a compatible build must exist for the selected Minecraft version before the update button appears.</p>
      <form data-form="plan-update" class="form-inline">
        <input
          name="targetVersion"
          list="minecraft-version-list"
          placeholder="${escapeHtml(server.minecraftVersion || "choose target version")}"
        />
        <button class="button button--quiet" type="submit">${labelWithIcon("refresh", "check update safety")}</button>
        ${applyAction}
      </form>
      ${support.supported ? "" : `<p class="muted">${escapeHtml(support.reason)}</p>`}
      ${renderUpdatePlanSummary(plan, server)}
    `
  );
}

function renderJavaBinSelect(server) {
  const runtimes = Array.isArray(state.javaRuntimes) ? state.javaRuntimes : [];
  const current = server.javaBin || "";
  const known = runtimes.some((runtime) => runtime.path === current);

  return `
    <select name="javaBin">
      <option value=""${current ? "" : " selected"}>use dashboard default</option>
      ${runtimes
        .map(
          (runtime) =>
            `<option value="${escapeHtml(runtime.path)}"${runtime.path === current ? " selected" : ""}>${escapeHtml(runtime.label)}</option>`
        )
        .join("")}
      ${current && !known
        ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (not detected)</option>`
        : ""}
    </select>
  `;
}

function renderJavaBinNote(server) {
  const runtimes = Array.isArray(state.javaRuntimes) ? state.javaRuntimes : [];
  const current = server.javaBin || "";
  const known = runtimes.some((runtime) => runtime.path === current);

  if (!runtimes.length) {
    return `<p class="muted">no java installations were detected on this machine. the dashboard default will be used.</p>`;
  }
  if (current && !known) {
    return `<p class="muted">this server points at <code>${escapeHtml(current)}</code>, which was not found on this machine. the server will fail to start until you pick a detected version.</p>`;
  }
  return `<p class="muted">only set this when a server needs a different jdk from the rest, for example forge 1.20.1 wants java 17 while newer versions want java 21+. detected from this machine: ${runtimes.map((runtime) => escapeHtml(String(runtime.major ?? "?"))).join(", ")}.</p>`;
}

// Catches the silent failure where the loader label says forge but the runtime
// on disk is vanilla: the server boots fine and loads no mods at all.
function renderLoaderMismatchWarning(server) {
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

function renderSettingsSection(snapshot) {
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

function renderServerOperatorsPanel(snapshot) {
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

function renderAdminSettingsSection(snapshot) {
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

function renderWorldsSection(snapshot) {
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

function findAddonUpdate(fileName) {
  if (!state.modUpdates) {
    return null;
  }
  return state.modUpdates.entries.find((entry) => entry.fileName === fileName) || null;
}

function renderAddonUpdateLabel(update) {
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

function renderAddonUpdatePanel() {
  const updates = state.modUpdates;
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

function renderModsSection(snapshot) {
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
                <div class="list-row">
                  <div class="list-row__main">
                    <strong>${escapeHtml(result.title)}</strong>
                    <p class="muted">${escapeHtml(result.provider)} • ${escapeHtml(result.author || "unknown author")} • ${Number(result.downloads || 0).toLocaleString()} downloads</p>
                    ${result.compatibilityLabel ? `<p class="muted">${escapeHtml(result.compatibilityLabel)}</p>` : ""}
                    <p class="muted">${escapeHtml(result.description || "")}</p>
                    ${result.manualDownloadOnly
                      ? `<p class="muted">manual download only — this author disabled third-party downloads.</p>`
                      : ""}
                  </div>
                  <div class="row-actions">
                    ${result.manualDownloadOnly
                      ? (result.pageUrl
                          ? `<a class="button button--quiet" href="${escapeHtml(result.pageUrl)}" target="_blank" rel="noopener noreferrer">${labelWithIcon("mods", "open curseforge")}</a>`
                          : "")
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
            ${handoff.pageUrl
              ? `<a class="button button--quiet" href="${escapeHtml(handoff.pageUrl)}" target="_blank" rel="noopener noreferrer">${labelWithIcon("mods", "open curseforge")}</a>`
              : ""}
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
              <select name="provider">
                <option value="modrinth"${activeProvider === "modrinth" ? " selected" : ""}>modrinth</option>
                ${canUseCurseforge ? `<option value="curseforge"${activeProvider === "curseforge" ? " selected" : ""}>curseforge</option>` : ""}
              </select>
              <input name="query" value="${escapeHtml(state.modQuery)}" placeholder="search mods or plugins" required />
              <button class="button button--primary" type="submit">${labelWithIcon("search", "search")}</button>
            </form>
          `
          : `<p class="muted">compatibility-checked add-on installs are disabled until this server uses a supported loader.</p>`}
        ${permissions.canUseManualAddons && addonCompatibility.installKind !== "unsupported"
          ? `
            <form data-form="install-direct" class="form-inline">
              <input name="url" placeholder="direct .jar url" required />
              <input type="hidden" name="confirmManualCompatibility" value="true" />
              <button class="button button--quiet" type="submit">${labelWithIcon("mods", "install url")}</button>
            </form>
            <form data-form="upload-mod" class="form-inline" enctype="multipart/form-data">
              <input type="file" name="file" accept=".jar" required />
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
              ? `<button class="button button--quiet" data-action="check-mod-updates">${labelWithIcon("refresh", state.modUpdates ? "re-check updates" : "check for updates")}</button>`
              : ""}
            <a class="button button--quiet" href="/api/servers/${encodeURIComponent(server.id)}/mods/client-list">${labelWithIcon("logs", "client list (.txt)")}</a>
            <a class="button button--quiet" href="/api/servers/${encodeURIComponent(server.id)}/mods/modpack">${labelWithIcon("mods", "client modpack (.mrpack)")}</a>
          </div>
        </div>
        ${mods.length
          ? mods
              .map(
                (item) => {
                  const fileName = typeof item === "string" ? item : item.fileName;
                  const enabled = typeof item === "string" ? true : item.enabled !== false;
                  const update = findAddonUpdate(fileName);
                  return `
                  <div class="list-row ${update && update.status === "update-available" ? "list-row--notice" : ""}">
                    <div class="list-row__main">
                      <code>${escapeHtml(fileName)}</code>
                      <p class="muted">${enabled ? "enabled" : "disabled"}${renderAddonUpdateLabel(update)}</p>
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

const LOG_LINE_LIMIT = 500;

// Keeps the tail, not the head: an 800-line log should open on the newest
// output, and the oldest lines are the ones worth dropping.
function prepareLogText(raw, emptyMessage) {
  const text = String(raw || "").replace(/\s+$/, "");
  if (!text) {
    return { hiddenLines: 0, text: emptyMessage, totalLines: 0 };
  }

  const lines = text.split("\n");
  const kept = lines.slice(-LOG_LINE_LIMIT);
  if (state.logOrder === "newest") {
    kept.reverse();
  }
  return {
    hiddenLines: lines.length - kept.length,
    text: kept.join("\n"),
    totalLines: lines.length
  };
}

function renderLogPane(key, label, raw, emptyMessage) {
  const prepared = prepareLogText(raw, emptyMessage);
  const meta = prepared.totalLines
    ? `${prepared.totalLines} lines${prepared.hiddenLines ? ` • oldest ${prepared.hiddenLines} hidden` : ""}`
    : "empty";

  return `
    <div class="log-pane">
      <p class="log-label">${escapeHtml(label)} <span class="muted">${escapeHtml(meta)}</span></p>
      <pre data-log-pane="${escapeHtml(key)}">${escapeHtml(prepared.text)}</pre>
    </div>
  `;
}

function renderLogsSection(snapshot) {
  const { logs } = snapshot;
  const newestFirst = state.logOrder === "newest";
  return renderSection(
    "logs",
    "latest.log and runtime.log",
    `
      <div class="submit-line">
        <button class="button button--quiet" data-action="refresh-logs">${labelWithIcon("refresh", "refresh logs")}</button>
        <button class="button ${state.logAutoRefresh ? "button--primary" : "button--quiet"}" data-action="toggle-log-auto">
          ${labelWithIcon("refresh", state.logAutoRefresh ? "live: on" : "live: off")}
        </button>
        <button class="button button--quiet" data-action="toggle-log-order">
          ${labelWithIcon("settings", newestFirst ? "switch to oldest first" : "switch to newest first")}
        </button>
        ${newestFirst ? "" : `<button class="button button--quiet" data-action="jump-to-latest">${labelWithIcon("refresh", "jump to latest")}</button>`}
      </div>
      <p class="muted">${state.logAutoRefresh ? `refreshing every ${LOG_POLL_INTERVAL_MS / 1000}s while this tab is open. ` : ""}${newestFirst ? "reversed: the newest line is at the top." : `opens at the newest output. showing at most the last ${LOG_LINE_LIMIT} lines.`}</p>
      <div class="log-grid">
        ${renderLogPane("latest", "latest.log", logs.latestLog, "No latest.log content yet.")}
        ${renderLogPane("runtime", "runtime.log", logs.runtimeLog, "No runtime log content yet.")}
      </div>
    `
  );
}

function renderLockedServerAccess(snapshot) {
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

function renderServerContent() {
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

// The backend is the authority on what it can provision; fall back to the
// conservative original set if bootstrap has not landed yet.
function installableLoaders() {
  const fromServer = state.bootstrap?.installableLoaders;
  return Array.isArray(fromServer) && fromServer.length ? fromServer : ["vanilla", "paper", "purpur"];
}

function isInstallableLoader(loader) {
  return installableLoaders().includes(String(loader || "").toLowerCase());
}

function createLoaderNote(mode, loader) {
  if (mode === "existing") {
    return `existing mode will register the folder as a ${loader} server. nothing is downloaded or installed.`;
  }
  if (isInstallableLoader(loader)) {
    return `managed mode will provision a ${loader} server for the selected minecraft version.`;
  }
  return `${loader} cannot be provisioned automatically. install it yourself and switch to existing mode, otherwise you get a vanilla server labelled ${loader} that loads no mods.`;
}

function renderCreateProgress() {
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

function renderOwnerServers() {
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

function renderOwnerAdmins() {
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

const OWNER_PAGE_COPY = {
  admins: ["owner / admins", "manage who can see and control each server"],
  integrations: ["owner / integrations", "api credentials shared by every server on this dashboard"],
  servers: ["owner / server registry", "create new server entries and review what is registered"]
};

function renderOwnerContent() {
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

function renderOwnerIntegrations() {
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

function render() {
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

  applyLogScroll();
  syncLogPolling();
}

const LOG_POLL_INTERVAL_MS = 3000;
let logPollTimer = null;
let logPollInFlight = false;
let logPollFailures = 0;

function logsTabIsOpen() {
  return (
    state.view === "server" &&
    state.serverSection === "logs" &&
    Boolean(state.selectedServerId) &&
    Boolean(state.serverSnapshot)
  );
}

// Only polls while the logs tab is actually on screen, so navigating away or
// switching servers stops the background requests.
function syncLogPolling() {
  const shouldPoll = state.logAutoRefresh && logsTabIsOpen();

  if (!shouldPoll) {
    if (logPollTimer) {
      clearInterval(logPollTimer);
      logPollTimer = null;
    }
    return;
  }

  if (logPollTimer) {
    return;
  }

  logPollFailures = 0;
  logPollTimer = setInterval(pollLogsOnce, LOG_POLL_INTERVAL_MS);
}

async function pollLogsOnce() {
  // Skip while the tab is in the background; the next tick after it is visible
  // again picks straight back up.
  if (logPollInFlight || document.hidden || !logsTabIsOpen()) {
    return;
  }
  logPollInFlight = true;

  const serverId = state.selectedServerId;
  try {
    const logs = await api(`/api/servers/${encodeURIComponent(serverId)}/logs`);
    logPollFailures = 0;

    // The server may have changed under us while the request was in flight.
    if (serverId !== state.selectedServerId || !state.serverSnapshot) {
      return;
    }

    const current = state.serverSnapshot.logs || {};
    if (current.latestLog === logs.latestLog && current.runtimeLog === logs.runtimeLog) {
      return; // Nothing new: skip the re-render so the view does not flicker.
    }

    state.serverSnapshot.logs = logs;
    render();
  } catch (error) {
    logPollFailures += 1;
    // Three consecutive failures means something real is wrong (server down,
    // session expired). Stop hammering it and say so once.
    if (logPollFailures >= 3) {
      state.logAutoRefresh = false;
      localStorage.setItem("rippermoonstash-log-auto", "off");
      syncLogPolling();
      setNotice("error", `log auto refresh stopped: ${error.message}`);
    }
  } finally {
    logPollInFlight = false;
  }
}

// render() replaces innerHTML, which resets scroll to the top - the reason logs
// always opened on the oldest lines. Re-pin each pane to the newest output
// unless the reader has deliberately scrolled up.
const logScrollPinned = { latest: true, runtime: true };

function applyLogScroll() {
  for (const pane of app.querySelectorAll("[data-log-pane]")) {
    const key = pane.dataset.logPane;
    if (state.logOrder === "newest") {
      pane.scrollTop = 0;
    } else if (logScrollPinned[key] !== false) {
      pane.scrollTop = pane.scrollHeight;
    }

    pane.addEventListener("scroll", () => {
      const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      logScrollPinned[key] = distanceFromBottom < 40;
    });
  }
}

function selectedValues(select) {
  return Array.from(select.selectedOptions).map((option) => option.value);
}

function checkedValues(form, name) {
  return Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map((input) => input.value);
}

function normalizeAccessSelection(accessServers, worldServers) {
  return [...new Set([...(accessServers || []), ...(worldServers || [])])];
}

app.addEventListener("click", async (event) => {
  if (state.createVersionOpen && !event.target.closest("[data-version-picker]")) {
    state.createVersionOpen = false;
    render();
    return;
  }

  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  try {
    const action = target.dataset.action;

    if (action === "logout") {
      await api("/api/logout", { method: "POST" });
      state.selectedServerId = null;
      clearNotice();
      await refreshAll();
      return;
    }

    if (action === "toggle-theme") {
      toggleTheme();
      render();
      return;
    }

    if (action === "toggle-nav") {
      state.navOpen = !state.navOpen;
      render();
      return;
    }

    if (action === "close-nav") {
      state.navOpen = false;
      render();
      return;
    }

    if (action === "toggle-create-version-picker") {
      state.createVersionOpen = !state.createVersionOpen;
      render();
      return;
    }

    if (action === "edit-user") {
      state.editingUserId = target.dataset.userId;
      state.resettingUserId = null;
      render();
      return;
    }

    if (action === "close-user-editor") {
      state.editingUserId = null;
      render();
      return;
    }

    if (action === "reset-user-password") {
      state.resettingUserId = target.dataset.userId;
      state.editingUserId = null;
      render();
      return;
    }

    if (action === "close-password-reset") {
      state.resettingUserId = null;
      render();
      return;
    }

    if (action === "select-create-version") {
      state.createServerMinecraftVersion = target.dataset.version || "latest";
      state.createVersionOpen = false;
      render();
      return;
    }

    if (action === "show-owner") {
      state.view = "owner";
      state.ownerSection = state.ownerSection || "servers";
      state.navOpen = false;
      render();
      return;
    }

    if (action === "show-servers") {
      state.view = "server";
      state.serverSection = state.serverSection || "overview";
      state.navOpen = false;
      render();
      return;
    }

    if (action === "select-server") {
      state.view = "server";
      state.selectedServerId = target.dataset.serverId;
      state.serverSection = "overview";
      state.modResults = [];
      state.updatePlan = null;
      state.navOpen = false;
      await loadSnapshot();
      render();
      return;
    }

    if (action === "select-server-section") {
      state.view = "server";
      state.serverSection = target.dataset.section;
      state.navOpen = false;
      render();
      return;
    }

    if (action === "select-owner-section") {
      state.view = "owner";
      state.ownerSection = target.dataset.ownerSection;
      state.navOpen = false;
      render();
      return;
    }

    if (action === "start-server") {
      state.updatePlan = null;
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/start`, { method: "POST" });
      setNotice("success", "server start command sent");
      await loadServers();
      await loadSnapshot();
      render();
      return;
    }

    if (action === "stop-server") {
      state.updatePlan = null;
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/stop`, { method: "POST" });
      setNotice("success", "server stop command sent");
      await loadServers();
      await loadSnapshot();
      render();
      return;
    }

    if (action === "refresh-server" || action === "refresh-logs") {
      state.updatePlan = null;
      await loadServers();
      await loadSnapshot();
      render();
      return;
    }

    if (action === "delete-world") {
      const archiveName = target.dataset.archiveName;
      // Unrecoverable: no trash, no undo. Make the name explicit in the prompt.
      if (
        !window.confirm(
          `Permanently delete the world archive "${archiveName}" (${target.dataset.size})?\n\nThis cannot be undone. The active world is not affected.`
        )
      ) {
        return;
      }
      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/delete`, {
        method: "POST",
        body: { archiveName }
      });
      if (state.serverSnapshot) {
        state.serverSnapshot.worlds = payload.worlds;
      }
      setNotice("success", `deleted archive ${payload.deleted}`);
      await loadSnapshot();
      render();
      return;
    }

    if (action === "activate-world") {
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/activate`, {
        method: "POST",
        body: { archiveName: target.dataset.archiveName }
      });
      setNotice("success", `activated world ${target.dataset.archiveName}`);
      await loadSnapshot();
      render();
      return;
    }

    if (action === "toggle-log-auto") {
      state.logAutoRefresh = !state.logAutoRefresh;
      localStorage.setItem("rippermoonstash-log-auto", state.logAutoRefresh ? "on" : "off");
      render();
      return;
    }

    if (action === "toggle-log-order") {
      state.logOrder = state.logOrder === "newest" ? "oldest" : "newest";
      localStorage.setItem("rippermoonstash-log-order", state.logOrder);
      logScrollPinned.latest = true;
      logScrollPinned.runtime = true;
      render();
      return;
    }

    if (action === "jump-to-latest") {
      logScrollPinned.latest = true;
      logScrollPinned.runtime = true;
      applyLogScroll();
      return;
    }

    if (action === "repair-operators") {
      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/operators/repair`, {
        method: "POST"
      });
      setNotice(
        payload.failures.length ? "error" : "success",
        payload.failures.length
          ? `some uuids could not be resolved: ${payload.failures.map((f) => `${f.name} (${f.reason})`).join("; ")}`
          : "operator uuids fixed — restart the server for minecraft to reload ops.json"
      );
      await loadSnapshot();
      render();
      return;
    }

    if (action === "test-integration") {
      const payload = await api("/api/settings/integrations/test", { method: "POST" });
      setNotice(payload.result.ok ? "success" : "error", payload.result.reason);
      return;
    }

    if (action === "clear-integration") {
      if (!window.confirm("Remove the stored CurseForge key? Search and installs will be disabled.")) {
        return;
      }
      const payload = await api("/api/settings/integrations", {
        method: "PUT",
        body: { curseforgeApiKey: "" }
      });
      state.integrations = payload.integrations;
      await loadBootstrap();
      setNotice("success", "curseforge key removed");
      return;
    }

    if (action === "dismiss-manual-download") {
      state.manualDownload = null;
      render();
      return;
    }

    if (action === "install-result") {
      state.updatePlan = null;
      state.manualDownload = null;
      const payload =
        target.dataset.provider === "curseforge"
          ? { provider: "curseforge", modId: target.dataset.id }
          : { provider: "modrinth", projectId: target.dataset.id };
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/install`, {
        method: "POST",
        body: payload
      });
      setNotice("success", "install completed");
      await loadSnapshot();
      await loadServers();
      render();
      return;
    }

    if (action === "check-mod-updates") {
      setNotice("success", "checking every tracked add-on against its provider…");
      state.modUpdates = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/updates`);
      setNotice(
        state.modUpdates.updatable ? "success" : "success",
        state.modUpdates.updatable
          ? `${state.modUpdates.updatable} add-on update(s) available`
          : "every tracked add-on is up to date"
      );
      return;
    }

    if (action === "dismiss-mod-updates") {
      state.modUpdates = null;
      render();
      return;
    }

    if (action === "update-mod" || action === "update-all-mods") {
      const single = action === "update-mod" ? target.dataset.fileName : null;
      const fileNames = single
        ? [single]
        : (state.modUpdates?.entries || [])
            .filter((entry) => entry.status === "update-available")
            .map((entry) => entry.fileName);

      if (!fileNames.length) {
        setNotice("error", "nothing to update");
        return;
      }
      if (
        !window.confirm(
          `Update ${fileNames.length} add-on(s)?\n\nThe server will be stopped first if it is running. Minecraft stays on ${state.modUpdates?.gameVersion || "the current version"}.`
        )
      ) {
        return;
      }

      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/update`, {
        method: "POST",
        body: { fileNames }
      });

      const failed = payload.results.filter((entry) => !entry.ok);
      const changed = payload.results.filter((entry) => entry.ok && entry.changed);
      setNotice(
        failed.length ? "error" : "success",
        failed.length
          ? `updated ${changed.length}, failed ${failed.length}: ${failed.map((entry) => `${entry.fileName} (${entry.error})`).join("; ")}`
          : `updated ${changed.length} add-on(s)`
      );

      // Re-check so the panel reflects the new state rather than stale results.
      state.modUpdates = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/updates`);
      await loadSnapshot();
      render();
      return;
    }

    if (action === "remove-mod") {
      state.updatePlan = null;
      const fileName = target.dataset.fileName;
      if (!window.confirm(`Remove ${fileName} from this server?`)) {
        return;
      }
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/remove`, {
        method: "POST",
        body: { fileName }
      });
      setNotice("success", "add-on removed");
      await loadSnapshot();
      await loadServers();
      render();
      return;
    }

    if (action === "toggle-mod") {
      state.updatePlan = null;
      const fileName = target.dataset.fileName;
      const currentlyEnabled = target.dataset.enabled === "true";
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/toggle`, {
        method: "POST",
        body: {
          enabled: !currentlyEnabled,
          fileName
        }
      });
      setNotice("success", currentlyEnabled ? "add-on disabled" : "add-on enabled");
      await loadSnapshot();
      await loadServers();
      render();
      return;
    }

    if (action === "remove-server-operator") {
      const uuid = target.dataset.uuid;
      if (!uuid || !window.confirm("Remove this in-game operator from the server?")) {
        return;
      }
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/operators/${encodeURIComponent(uuid)}`, {
        method: "DELETE"
      });
      setNotice("success", "server admin removed");
      await loadSnapshot();
      render();
      return;
    }

    if (action === "owner-open-server") {
      state.view = "server";
      state.selectedServerId = target.dataset.serverId;
      state.serverSection = "overview";
      state.modResults = [];
      state.updatePlan = null;
      await loadSnapshot();
      render();
      return;
    }

    if (action === "delete-server") {
      const serverId = target.dataset.serverId;
      const serverName = target.dataset.serverName || serverId;
      const confirmation = window.prompt(
        `Type ${serverId} to delete ${serverName}. This removes the server folder and its dashboard record.`,
        ""
      );
      if (confirmation !== serverId) {
        setNotice("error", "server deletion cancelled");
        return;
      }

      await api(`/api/servers/${encodeURIComponent(serverId)}`, {
        method: "DELETE",
        body: { confirmServerId: serverId }
      });
      if (state.selectedServerId === serverId) {
        state.selectedServerId = null;
        state.serverSnapshot = null;
        state.updatePlan = null;
      }
      setNotice("success", "server deleted");
      await refreshAll();
      return;
    }

    if (action === "apply-update") {
      if (!state.updatePlan?.plan?.safe) {
        setNotice("error", "run the update safety check first");
        return;
      }

      const targetVersion = state.updatePlan.plan.targetVersion || state.serverSnapshot?.server?.minecraftVersion || "";
      const confirmed = window.confirm(
        `Apply the safe combined update for ${state.serverSnapshot.server.name} to ${targetVersion}? The server must remain stopped during the update.`
      );
      if (!confirmed) {
        return;
      }

      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/updates/apply`, {
        method: "POST",
        body: { targetVersion }
      });
      state.serverSnapshot = payload.snapshot;
      state.updatePlan = { plan: payload.plan, serverId: state.selectedServerId };
      setNotice("success", "combined server update applied");
      await loadServers();
      render();
      return;
    }
  } catch (error) {
    if (error.manualDownload) {
      state.manualDownload = error.manualDownload;
    }
    setNotice("error", error.message);
  }
});

app.addEventListener("submit", async (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  event.preventDefault();

  try {
    switch (form.dataset.form) {
      case "login": {
        await api("/api/login", {
          method: "POST",
          body: Object.fromEntries(new FormData(form).entries())
        });
        clearNotice();
        await refreshAll();
        break;
      }
      case "setup": {
        await api("/api/setup-owner", {
          method: "POST",
          body: Object.fromEntries(new FormData(form).entries())
        });
        clearNotice();
        await refreshAll();
        break;
      }
      case "unlock-server": {
        const passphrase = new FormData(form).get("passphrase");
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/unlock`, {
          method: "POST",
          body: { passphrase }
        });
        setNotice("success", "server lane unlocked");
        await loadSnapshot();
        render();
        break;
      }
      case "unlock-server-popup": {
        const passphrase = new FormData(form).get("passphrase");
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/unlock`, {
          method: "POST",
          body: { passphrase }
        });
        setNotice("success", "server lane unlocked");
        await loadSnapshot();
        render();
        break;
      }
      case "save-settings": {
        const data = Object.fromEntries(new FormData(form).entries());
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/settings`, {
          method: "PUT",
          body: data
        });
        setNotice("success", "settings saved");
        await loadServers();
        await loadSnapshot();
        render();
        break;
      }
      case "save-safe-settings": {
        const formData = new FormData(form);
        const safeProperties = Object.fromEntries(formData.entries());
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/settings`, {
          method: "PUT",
          body: { safeProperties }
        });
        setNotice("success", "safe settings saved");
        await loadSnapshot();
        render();
        break;
      }
      case "save-addon-settings": {
        const formData = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/settings`, {
          method: "PUT",
          body: {
            addonSettings: {
              loader: formData.get("loader"),
              minecraftVersion: formData.get("minecraftVersion")
            }
          }
        });
        setNotice("success", "add-on settings saved");
        state.modResults = [];
        await loadServers();
        await loadSnapshot();
        render();
        break;
      }
      case "add-server-operator": {
        const formData = new FormData(form);
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/operators`, {
          method: "POST",
          body: {
            bypassesPlayerLimit: formData.get("bypassesPlayerLimit") === "on",
            level: formData.get("level"),
            name: formData.get("name")
          }
        });
        setNotice("success", "server admin added");
        form.reset();
        await loadSnapshot();
        render();
        break;
      }
      case "capture-world": {
        const data = Object.fromEntries(new FormData(form).entries());
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/capture`, {
          method: "POST",
          body: data
        });
        setNotice("success", "active world archived");
        await loadSnapshot();
        render();
        break;
      }
      case "create-world": {
        const formData = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/create`, {
          method: "POST",
          body: {
            generateStructures: formData.get("generateStructures") === "true",
            levelType: formData.get("levelType"),
            name: formData.get("name"),
            seed: formData.get("seed")
          }
        });
        setNotice("success", "new world prepared. start the server to generate it");
        await loadSnapshot();
        render();
        break;
      }
      case "save-world-rules": {
        const formData = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/rules`, {
          method: "POST",
          body: {
            forceGamemode: formData.get("forceGamemode") === "true",
            generateStructures: formData.get("generateStructures") === "true",
            levelType: formData.get("levelType")
          }
        });
        setNotice("success", "world rules saved");
        await loadSnapshot();
        render();
        break;
      }
      case "import-world": {
        const data = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/import`, {
          method: "POST",
          body: data
        });
        setNotice("success", "world archive imported");
        await loadSnapshot();
        render();
        break;
      }
      case "save-integration": {
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = await api("/api/settings/integrations", {
          method: "PUT",
          body: { curseforgeApiKey: data.curseforgeApiKey || "" }
        });
        state.integrations = payload.integrations;
        form.reset();
        // Provider availability gates the curseforge option in mod search.
        await loadBootstrap();
        setNotice(
          "success",
          payload.integrations.curseforge.envOverride
            ? "key verified and saved, but an environment variable is still overriding it"
            : "curseforge key verified and saved"
        );
        render();
        break;
      }
      case "search-mods": {
        const data = Object.fromEntries(new FormData(form).entries());
        state.modProvider = data.provider === "curseforge" ? "curseforge" : "modrinth";
        state.modQuery = data.query || "";
        const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/search`, {
          method: "POST",
          body: data
        });
        state.modResults = payload.results;
        setNotice("success", `found ${payload.results.length} results`);
        render();
        break;
      }
      case "install-direct": {
        const data = Object.fromEntries(new FormData(form).entries());
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/install`, {
          method: "POST",
          body: {
            confirmManualCompatibility: data.confirmManualCompatibility === "true",
            provider: "direct",
            url: data.url
          }
        });
        setNotice("success", "direct download installed");
        await loadSnapshot();
        await loadServers();
        render();
        break;
      }
      case "upload-mod": {
        const data = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/upload`, {
          method: "POST",
          body: data
        });
        setNotice("success", "file uploaded");
        await loadSnapshot();
        await loadServers();
        render();
        break;
      }
      case "create-server": {
        const formData = new FormData(form);
        const mode = String(formData.get("mode") || "managed");
        const loader = String(formData.get("loader") || "vanilla");
        if (mode !== "existing" && !isInstallableLoader(loader)) {
          throw new Error(
            `Managed server creation cannot provision the ${loader} loader. Supported loaders are ${installableLoaders().join(", ")}. Switch to existing mode to register a folder you installed yourself.`
          );
        }
        state.updatePlan = null;
        const payload = await api("/api/servers", {
          method: "POST",
          body: Object.fromEntries(formData.entries())
        });
        // A backend that has not been restarted yet still answers 201 with the
        // finished server instead of 202 with a job. Handle both so a stale
        // service produces a working create rather than a crash.
        if (payload && payload.job && payload.job.id) {
          state.createJob = payload.job;
          render();
          await pollCreateJob(payload.job.id);
          break;
        }

        state.createVersionOpen = false;
        state.createServerMinecraftVersion = "latest";
        if (payload && payload.server) {
          state.selectedServerId = payload.server.id;
          state.view = "server";
          state.serverSection = "overview";
          setNotice("success", `created ${payload.server.name}`);
        } else {
          setNotice("success", "server created");
        }
        await refreshAll();
        break;
      }
      case "plan-update": {
        const formData = new FormData(form);
        const targetVersion = String(formData.get("targetVersion") || "").trim();
        const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/updates/plan`, {
          method: "POST",
          body: { targetVersion }
        });
        state.updatePlan = {
          plan: payload.plan,
          serverId: state.selectedServerId
        };
        setNotice(payload.plan.safe ? "success" : "error", payload.plan.safe ? "safe update is ready" : (payload.plan.blockedReasons?.[0] || "combined update is blocked"));
        render();
        break;
      }
      case "accept-eula": {
        const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/eula`, {
          method: "POST",
          body: { accepted: true }
        });
        state.serverSnapshot = payload.snapshot;
        setNotice("success", "server eula accepted");
        render();
        break;
      }
      case "create-user": {
        const formData = new FormData(form);
        const createWorldServers = checkedValues(form, "createWorldServers");
        const servers = normalizeAccessSelection(checkedValues(form, "servers"), createWorldServers);
        state.view = "owner";
        state.ownerSection = "admins";
        await api("/api/users", {
          method: "POST",
          body: {
            displayName: formData.get("displayName"),
            password: formData.get("password"),
            permissions: {
              createWorldServers
            },
            role: formData.get("role"),
            servers,
            username: formData.get("username")
          }
        });
        setNotice("success", "user created");
        await refreshAll();
        break;
      }
      case "update-user": {
        const formData = new FormData(form);
        const userId = formData.get("userId");
        const createWorldServers = checkedValues(form, "createWorldServers");
        const servers = normalizeAccessSelection(checkedValues(form, "servers"), createWorldServers);
        state.view = "owner";
        state.ownerSection = "admins";
        await api(`/api/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: {
            displayName: formData.get("displayName"),
            password: formData.get("password"),
            permissions: {
              createWorldServers
            },
            role: formData.get("role"),
            servers,
            username: formData.get("username")
          }
        });
        setNotice("success", "user updated");
        state.editingUserId = null;
        await refreshAll();
        break;
      }
      case "reset-user-password": {
        const formData = new FormData(form);
        const userId = formData.get("userId");
        state.view = "owner";
        state.ownerSection = "admins";
        await api(`/api/users/${encodeURIComponent(userId)}/reset-password`, {
          method: "POST",
          body: {
            password: formData.get("password")
          }
        });
        setNotice("success", "password reset");
        state.resettingUserId = null;
        await refreshAll();
        break;
      }
      default:
        break;
    }
  } catch (error) {
    if (error.manualDownload) {
      state.manualDownload = error.manualDownload;
    }
    setNotice("error", error.message);
  }
});

app.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLSelectElement)) {
    return;
  }

  if (target.form?.dataset.form !== "create-server" || (target.name !== "mode" && target.name !== "loader")) {
    return;
  }

  const loaderSelect = target.form.querySelector('select[name="loader"]');
  const loaderNote = target.form.querySelector("[data-create-loader-note]");
  const modeSelect = target.form.querySelector('select[name="mode"]');
  const mode = modeSelect instanceof HTMLSelectElement ? modeSelect.value : "managed";
  const loader = loaderSelect instanceof HTMLSelectElement ? loaderSelect.value : "vanilla";
  const isExistingMode = mode === "existing";

  if (loaderNote) {
    loaderNote.textContent = createLoaderNote(isExistingMode ? "existing" : "managed", loader);
  }
});

refreshAll().catch((error) => {
  setNotice("error", error.message);
});
