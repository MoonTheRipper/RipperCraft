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
  activeElement: null,
  addEventListener() {},
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
  },
  // render() restores the scroll position that emptying #app would otherwise
  // clamp to the top.
  scrollTo() {},
  scrollX: 0,
  scrollY: 0
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

test("escapeHtml keeps falsy values that are not empty", async () => {
  const { escapeHtml } = await load(path.join(jsRoot, "html.js"));
  // A server property set to 0 used to render as a blank input and save blank.
  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(false), "false");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("safe setting fields render a zero value instead of blanking it", async () => {
  const { renderSafeSettingField } = await load(path.join(jsRoot, "components.js"));
  assert.ok(renderSafeSettingField({ key: "spawn-protection", type: "number" }, 0).includes('value="0"'));
  assert.ok(renderSafeSettingField({ key: "motd", type: "string" }, undefined).includes('value=""'));
});

test("safeUrl only lets absolute http(s) links through", async () => {
  const { safeUrl } = await load(path.join(jsRoot, "html.js"));
  assert.equal(safeUrl("https://www.curseforge.com/minecraft/mc-mods/x"), "https://www.curseforge.com/minecraft/mc-mods/x");
  assert.equal(safeUrl("http://example.test/a"), "http://example.test/a");
  // Everything below reached an href straight from a provider response.
  assert.equal(safeUrl("javascript:alert(1)"), "");
  assert.equal(safeUrl("  JavaScript:alert(1)"), "");
  assert.equal(safeUrl("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(safeUrl("vbscript:msgbox(1)"), "");
  assert.equal(safeUrl("/relative/path"), "");
  assert.equal(safeUrl(""), "");
  assert.equal(safeUrl(null), "");
});

test("provider links degrade to a note when the url is unusable", async () => {
  const { renderProviderLink } = await load(path.join(jsRoot, "views", "server-mods.js"));
  assert.ok(renderProviderLink("https://example.test/mod", "open curseforge").includes('href="https://example.test/mod"'));
  const rejected = renderProviderLink("javascript:alert(1)", "open curseforge");
  assert.equal(rejected.includes("<a"), false);
  assert.equal(rejected.includes("javascript"), false);
  assert.ok(rejected.includes("no usable link"));
});

test("meta rows escape values unless markup is opted into", async () => {
  const { renderMetaRows } = await load(path.join(jsRoot, "components.js"));
  const { rawHtml } = await load(path.join(jsRoot, "html.js"));
  const escaped = renderMetaRows([["directory", "<img src=x onerror=alert(1)>"]]);
  assert.equal(escaped.includes("<img"), false);
  assert.ok(escaped.includes("&lt;img"));
  assert.ok(renderMetaRows([["directory", rawHtml("<code>/srv</code>")]]).includes("<code>/srv</code>"));
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

test("theme module exports only the theme helpers", async () => {
  const theme = await load(path.join(jsRoot, "theme.js"));
  for (const fn of [theme.applyTheme, theme.toggleTheme]) {
    assert.equal(typeof fn, "function");
  }
  // The runtime SEO rewriter is gone along with the meta tags it targeted.
  assert.equal(theme.syncDocumentMeta, undefined);
  theme.applyTheme();
  assert.equal(globalThis.document.documentElement.dataset.theme, "dark");
});

test("format module exports date and permission helpers", async () => {
  const format = await load(path.join(jsRoot, "format.js"));
  for (const fn of [format.formatDate, format.getServerPermissions]) {
    assert.equal(typeof fn, "function");
  }
  assert.equal(format.formatDate(null), "unknown");
  assert.equal(format.getServerPermissions({}).canControlRuntime, false);
  assert.equal(format.isServerLocked, undefined);
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
    "renderCreateVersionPicker",
    "renderPageHeader",
    "renderMetaRows",
    "renderSection",
    "renderJavaBinSelect",
    "renderJavaBinNote"
  ]) {
    assert.equal(typeof components[name], "function", `components.js is missing ${name}`);
  }
  assert.equal(components.renderMinecraftVersionOptions, undefined);
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
  const login = auth.renderAuth("Sign in", "login");
  assert.ok(login.includes('data-form="login"'));
  // The decorative quote is gone and the copy says what the page is for.
  assert.equal(login.includes("auth-quote"), false);
  assert.ok(login.includes("Minecraft servers"));
});

test("log panes are focusable and named for keyboard and screen reader users", async () => {
  const logs = await load(path.join(jsRoot, "views", "server-logs.js"));
  const pane = logs.renderLogPane("latest", "latest.log", "one\ntwo", "nothing yet");
  assert.ok(pane.includes('tabindex="0"'));
  assert.ok(pane.includes('aria-labelledby="log-label-latest"'));
  assert.ok(pane.includes('id="log-label-latest"'));
});

test("adding an in-game operator forces an explicit, non-owner op level", async () => {
  const settings = await load(path.join(jsRoot, "views", "server-settings.js"));
  const panel = settings.renderServerOperatorsPanel({ operators: [] });
  assert.ok(panel.includes('<select name="level" required>'));
  assert.ok(panel.includes('<option value="" selected disabled>'));
  // Nothing may be preselected for the user, least of all full op.
  assert.equal(panel.includes('<option value="4" selected'), false);
  assert.equal(panel.includes("labelWithIcon"), false);
});

test("modal, preserve and confirm modules expose their behaviour", async () => {
  const modal = await load(path.join(jsRoot, "modal.js"));
  for (const name of ["applyModalBehaviour", "handleAppKeydown", "currentModalPanel"]) {
    assert.equal(typeof modal[name], "function", `modal.js is missing ${name}`);
  }
  assert.equal(modal.currentModalPanel(), null);

  const preserve = await load(path.join(jsRoot, "preserve.js"));
  for (const name of ["captureUiState", "restoreUiState"]) {
    assert.equal(typeof preserve[name], "function", `preserve.js is missing ${name}`);
  }

  const confirmModule = await load(path.join(jsRoot, "confirm.js"));
  for (const name of ["serverIsRunning", "activeWorldName", "confirmRequiresStoppedServer", "confirmWithStopNotice", "confirmRestoreWorld"]) {
    assert.equal(typeof confirmModule[name], "function", `confirm.js is missing ${name}`);
  }
  // Nothing to interrupt on a stopped server, so no prompt is raised (the
  // stubbed window.confirm always says no).
  assert.equal(confirmModule.serverIsRunning(), false);
  assert.equal(confirmModule.confirmRequiresStoppedServer("Back up?"), true);
});

test("server-scoped state is cleared when the selected server changes", async () => {
  const { resetServerScopedState, state } = await load(path.join(jsRoot, "state.js"));
  state.manualDownload = { modName: "x" };
  state.modQuery = "essentials";
  state.modResults = [{ id: "1" }];
  state.modUpdates = { entries: [], serverId: "A" };
  state.updatePlan = { serverId: "A" };

  resetServerScopedState();

  assert.equal(state.manualDownload, null);
  assert.equal(state.modQuery, "");
  assert.deepEqual(state.modResults, []);
  assert.equal(state.modUpdates, null);
  assert.equal(state.updatePlan, null);
});

test("add-on updates from another server are never matched by filename alone", async () => {
  const { state } = await load(path.join(jsRoot, "state.js"));
  const { currentModUpdates, findAddonUpdate } = await load(path.join(jsRoot, "views", "server-mods.js"));

  state.selectedServerId = "server-b";
  state.modUpdates = {
    entries: [{ fileName: "EssentialsX.jar", status: "update-available" }],
    serverId: "server-a"
  };
  assert.equal(currentModUpdates(), null);
  assert.equal(findAddonUpdate("EssentialsX.jar"), null);

  state.modUpdates.serverId = "server-b";
  assert.notEqual(currentModUpdates(), null);
  assert.equal(findAddonUpdate("EssentialsX.jar").status, "update-available");

  state.modUpdates = null;
  state.selectedServerId = null;
});

// These exercise the decision logic of preserve.js - which controls are carried
// across a re-render and which are not - against hand-built element objects.
// They cannot prove the browser behaviour (focus rings, caret placement); that
// needs a real DOM. What they do pin down is the rule that stops a re-render
// eating unsaved input, and the rule that stops a stale edit eating fresh
// server data.
function fakeControl(overrides = {}) {
  const element = {
    checked: false,
    closest() {
      return element.form;
    },
    dataset: {},
    defaultChecked: false,
    defaultValue: "",
    focus() {
      element.focused = true;
    },
    focused: false,
    form: { dataset: { form: "save-settings" } },
    id: "",
    name: "field",
    scrollTop: 0,
    selectionEnd: 0,
    selectionStart: 0,
    setSelectionRange() {},
    tagName: "INPUT",
    type: "text",
    value: "",
    ...overrides
  };
  return element;
}

function fakeContainer(controls) {
  return {
    querySelectorAll() {
      return controls;
    }
  };
}

test("a re-render keeps edited fields and the focused control", async (t) => {
  const { captureUiState, restoreUiState } = await load(path.join(jsRoot, "preserve.js"));

  const typedInto = fakeControl({
    defaultValue: "motd=Demo\n",
    name: "propertiesText",
    tagName: "TEXTAREA",
    type: "textarea",
    value: "motd=Demo\nmax-players=30\n"
  });
  const untouched = fakeControl({ defaultValue: "4G", name: "maxMemory", value: "4G" });
  const ticked = fakeControl({ checked: true, defaultChecked: false, name: "servers", type: "checkbox" });

  globalThis.document.activeElement = typedInto;
  t.after(() => {
    globalThis.document.activeElement = null;
  });
  const snapshot = captureUiState(fakeContainer([typedInto, untouched, ticked]));

  // Only the two controls the user actually changed are worth carrying over.
  assert.equal(snapshot.fields.size, 2);

  const redrawnTyped = fakeControl({
    defaultValue: "motd=Demo\n",
    name: "propertiesText",
    tagName: "TEXTAREA",
    type: "textarea",
    value: "motd=Demo\n"
  });
  const redrawnUntouched = fakeControl({ defaultValue: "6G", name: "maxMemory", value: "6G" });
  const redrawnTicked = fakeControl({ checked: false, defaultChecked: false, name: "servers", type: "checkbox" });

  restoreUiState(fakeContainer([redrawnTyped, redrawnUntouched, redrawnTicked]), snapshot);

  assert.equal(redrawnTyped.value, "motd=Demo\nmax-players=30\n");
  assert.equal(redrawnTyped.focused, true);
  assert.equal(redrawnTicked.checked, true);
  // Untouched fields take whatever the server just sent.
  assert.equal(redrawnUntouched.value, "6G");
});

test("a re-render drops an edit whose underlying server value has changed", async (t) => {
  const { captureUiState, restoreUiState } = await load(path.join(jsRoot, "preserve.js"));

  const edited = fakeControl({ defaultValue: "2G", name: "minMemory", value: "3G" });
  globalThis.document.activeElement = null;
  t.after(() => {
    globalThis.document.activeElement = null;
  });
  const snapshot = captureUiState(fakeContainer([edited]));

  // Someone else (or a save) moved this setting underneath the edit: the fresh
  // value has to win, otherwise the form silently re-proposes a stale one.
  const redrawn = fakeControl({ defaultValue: "8G", name: "minMemory", value: "8G" });
  restoreUiState(fakeContainer([redrawn]), snapshot);
  assert.equal(redrawn.value, "8G");
});

test("action modules export the three delegated listeners", async () => {
  const click = await load(path.join(jsRoot, "actions", "click.js"));
  const forms = await load(path.join(jsRoot, "actions", "forms.js"));
  const change = await load(path.join(jsRoot, "actions", "change.js"));

  assert.equal(typeof click.handleAppClick, "function");
  assert.equal(typeof forms.handleAppSubmit, "function");
  assert.equal(typeof change.handleAppChange, "function");

  for (const name of ["checkedValues", "normalizeAccessSelection"]) {
    assert.equal(typeof forms[name], "function", `forms.js is missing ${name}`);
  }
  assert.equal(forms.selectedValues, undefined);
  assert.deepEqual(forms.normalizeAccessSelection(["a"], ["a", "b"]), ["a", "b"]);
});
