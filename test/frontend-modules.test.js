const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const publicRoot = path.join(__dirname, "..", "public");
const jsRoot = path.join(publicRoot, "js");

// The browser modules read localStorage and look up the #app element while they
// load, exactly as the single-file build did. These stubs are the smallest set
// that lets node import them; anything more would be testing the stub, not the
// modules.
const stubbedGlobals = ["localStorage", "document", "window", "fetch"];
const originalGlobals = new Map(
  stubbedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)])
);

const appElement = {
  innerHTML: "",
  addEventListener() {},
  querySelectorAll() {
    return [];
  }
};

globalThis.localStorage = {
  getItem() {
    return null;
  },
  setItem() {},
  removeItem() {}
};

globalThis.document = {
  documentElement: { dataset: {} },
  hidden: false,
  title: "",
  getElementById(id) {
    return id === "app" ? appElement : null;
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  }
};

globalThis.window = {
  confirm() {
    return false;
  },
  prompt() {
    return null;
  }
};

// public/app.js kicks off refreshAll() on load. A 204 keeps that path short and
// entirely inside the module's own error handling.
globalThis.fetch = async () => ({
  ok: true,
  status: 204,
  headers: {
    get() {
      return "";
    }
  }
});

function listModuleFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listModuleFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      found.push(full);
    }
  }
  return found.sort();
}

function load(absolutePath) {
  return import(pathToFileURL(absolutePath).href);
}

test.after(() => {
  for (const name of stubbedGlobals) {
    const descriptor = originalGlobals.get(name);
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete globalThis[name];
    }
  }
});

test("every public/js module imports cleanly under node", async () => {
  const files = listModuleFiles(jsRoot);
  assert.ok(files.length >= 20, `expected the split modules, found ${files.length}`);

  for (const file of files) {
    const namespace = await load(file);
    assert.equal(typeof namespace, "object", `${path.relative(publicRoot, file)} did not produce a module namespace`);
  }
});

test("public/app.js imports cleanly and wires the app element", async () => {
  const namespace = await load(path.join(publicRoot, "app.js"));
  assert.equal(typeof namespace, "object");
  // refreshAll() is fired on load; let its rejection land in the module's own
  // catch before the test finishes.
  await new Promise((resolve) => setImmediate(resolve));
});

test("state module exposes the shared state and section tables", async () => {
  const { state, SERVER_SECTIONS, OWNER_SECTIONS, ALL_LOADERS } = await load(path.join(jsRoot, "state.js"));
  assert.equal(typeof state, "object");
  assert.equal(state.view, "server");
  assert.equal(state.serverSection, "overview");
  assert.ok(Array.isArray(SERVER_SECTIONS));
  assert.equal(SERVER_SECTIONS.length, 5);
  assert.ok(Array.isArray(OWNER_SECTIONS));
  assert.equal(OWNER_SECTIONS.length, 3);
  assert.ok(Array.isArray(ALL_LOADERS));
  assert.ok(ALL_LOADERS.includes("vanilla"));
});

test("html helpers escape and wrap markup", async () => {
  const { escapeHtml, icon, labelWithIcon, renderSelectOptions } = await load(path.join(jsRoot, "html.js"));
  for (const fn of [escapeHtml, icon, labelWithIcon, renderSelectOptions]) {
    assert.equal(typeof fn, "function");
  }
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  assert.ok(icon("server").startsWith('<span class="icon"'));
  assert.ok(labelWithIcon("server", "hi").includes("<span>hi</span>"));
  assert.ok(renderSelectOptions(["a", "b"], "b").includes('value="b" selected'));
});

test("icons module exports the icon table", async () => {
  const { ICONS } = await load(path.join(jsRoot, "icons.js"));
  assert.equal(typeof ICONS, "object");
  for (const key of ["admin", "logs", "mods", "overview", "owner", "refresh", "search", "server", "settings", "start", "stop", "theme", "unlock", "worlds"]) {
    assert.equal(typeof ICONS[key], "string", `missing icon ${key}`);
  }
});

test("api module exports the fetch wrapper and wait", async () => {
  const { api, wait } = await load(path.join(jsRoot, "api.js"));
  assert.equal(typeof api, "function");
  assert.equal(typeof wait, "function");
  assert.equal(await api("/api/anything"), null);
});

test("theme module exports theme and metadata helpers", async () => {
  const { applyTheme, toggleTheme, syncDocumentMeta } = await load(path.join(jsRoot, "theme.js"));
  for (const fn of [applyTheme, toggleTheme, syncDocumentMeta]) {
    assert.equal(typeof fn, "function");
  }
  applyTheme();
  assert.equal(globalThis.document.documentElement.dataset.theme, "dark");
});

test("format module exports date and permission helpers", async () => {
  const { formatDate, getServerPermissions, isServerLocked } = await load(path.join(jsRoot, "format.js"));
  for (const fn of [formatDate, getServerPermissions, isServerLocked]) {
    assert.equal(typeof fn, "function");
  }
  assert.equal(formatDate(null), "unknown");
  assert.equal(getServerPermissions({}).canControlRuntime, false);
  assert.equal(isServerLocked({}), false);
});

test("notice module exports setNotice and clearNotice", async () => {
  const { setNotice, clearNotice } = await load(path.join(jsRoot, "notice.js"));
  assert.equal(typeof setNotice, "function");
  assert.equal(typeof clearNotice, "function");
});

test("data module exports every loader and refreshAll", async () => {
  const data = await load(path.join(jsRoot, "data.js"));
  for (const name of [
    "loadBootstrap",
    "loadServers",
    "loadSnapshot",
    "loadUsers",
    "loadVersionCatalog",
    "loadIntegrations",
    "loadJavaRuntimes",
    "pollCreateJob",
    "refreshAll"
  ]) {
    assert.equal(typeof data[name], "function", `data.js is missing ${name}`);
  }
});

test("components module exports the shared renderers", async () => {
  const components = await load(path.join(jsRoot, "components.js"));
  for (const name of [
    "renderSafeSettingField",
    "renderVersionDatalist",
    "renderMinecraftVersionOptions",
    "renderCreateVersionPicker",
    "renderPageHeader",
    "renderMetaRows",
    "renderSection",
    "renderJavaBinSelect",
    "renderJavaBinNote"
  ]) {
    assert.equal(typeof components[name], "function", `components.js is missing ${name}`);
  }
  assert.ok(components.renderPageHeader("p", "t", "s").includes("<h1>t</h1>"));
});

test("loaders module exports the provisioning helpers", async () => {
  const { installableLoaders, isInstallableLoader, createLoaderNote } = await load(path.join(jsRoot, "loaders.js"));
  for (const fn of [installableLoaders, isInstallableLoader, createLoaderNote]) {
    assert.equal(typeof fn, "function");
  }
  assert.deepEqual(installableLoaders(), ["vanilla", "paper", "purpur"]);
  assert.equal(isInstallableLoader("fabric"), false);
  assert.ok(createLoaderNote("existing", "forge").includes("existing mode"));
});

test("log config module exports both limits", async () => {
  const { LOG_LINE_LIMIT, LOG_POLL_INTERVAL_MS } = await load(path.join(jsRoot, "logs-config.js"));
  assert.equal(LOG_LINE_LIMIT, 500);
  assert.equal(LOG_POLL_INTERVAL_MS, 3000);
});

test("render module exports render and the post-render hook seam", async () => {
  const { render, registerPostRender } = await load(path.join(jsRoot, "render.js"));
  assert.equal(typeof render, "function");
  assert.equal(typeof registerPostRender, "function");
});

test("logs-live module exports the poller and scroll handling", async () => {
  const module = await load(path.join(jsRoot, "logs-live.js"));
  for (const name of ["logsTabIsOpen", "syncLogPolling", "pollLogsOnce", "applyLogScroll"]) {
    assert.equal(typeof module[name], "function", `logs-live.js is missing ${name}`);
  }
  assert.deepEqual(module.logScrollPinned, { latest: true, runtime: true });
  assert.equal(module.logsTabIsOpen(), false);
});

test("dom module exports the app element accessor", async () => {
  const { getApp } = await load(path.join(jsRoot, "dom.js"));
  assert.equal(typeof getApp, "function");
  assert.equal(getApp(), appElement);
});

test("view modules export their section renderers", async () => {
  const expected = [
    ["views/auth.js", ["renderAuth"]],
    ["views/nav.js", ["renderServerTree", "renderOwnerTree", "renderSidebar"]],
    ["views/server-overview.js", ["renderOverviewSection", "renderUpdatePlanSummary", "renderUpdatesSection"]],
    [
      "views/server-settings.js",
      ["renderLoaderMismatchWarning", "renderSettingsSection", "renderServerOperatorsPanel", "renderAdminSettingsSection"]
    ],
    ["views/server-worlds.js", ["renderWorldsSection"]],
    ["views/server-mods.js", ["findAddonUpdate", "renderAddonUpdateLabel", "renderAddonUpdatePanel", "renderModsSection"]],
    ["views/server-logs.js", ["prepareLogText", "renderLogPane", "renderLogsSection"]],
    ["views/server.js", ["renderLockedServerAccess", "renderServerContent"]],
    ["views/owner.js", ["renderCreateProgress", "renderOwnerServers", "renderOwnerAdmins", "renderOwnerContent", "renderOwnerIntegrations"]]
  ];

  for (const [relative, names] of expected) {
    const module = await load(path.join(jsRoot, relative));
    for (const name of names) {
      assert.equal(typeof module[name], "function", `${relative} is missing ${name}`);
    }
  }

  const owner = await load(path.join(jsRoot, "views", "owner.js"));
  assert.equal(typeof owner.OWNER_PAGE_COPY, "object");
  assert.deepEqual(Object.keys(owner.OWNER_PAGE_COPY).sort(), ["admins", "integrations", "servers"]);

  const logs = await load(path.join(jsRoot, "views", "server-logs.js"));
  assert.deepEqual(logs.prepareLogText("", "nothing"), { hiddenLines: 0, text: "nothing", totalLines: 0 });

  const auth = await load(path.join(jsRoot, "views", "auth.js"));
  assert.ok(auth.renderAuth("Log In", "", "login").includes('data-form="login"'));
});

test("action modules export the three delegated listeners", async () => {
  const click = await load(path.join(jsRoot, "actions", "click.js"));
  const forms = await load(path.join(jsRoot, "actions", "forms.js"));
  const change = await load(path.join(jsRoot, "actions", "change.js"));

  assert.equal(typeof click.handleAppClick, "function");
  assert.equal(typeof forms.handleAppSubmit, "function");
  assert.equal(typeof change.handleAppChange, "function");

  for (const name of ["selectedValues", "checkedValues", "normalizeAccessSelection"]) {
    assert.equal(typeof forms[name], "function", `forms.js is missing ${name}`);
  }
  assert.deepEqual(forms.normalizeAccessSelection(["a"], ["a", "b"]), ["a", "b"]);
});
