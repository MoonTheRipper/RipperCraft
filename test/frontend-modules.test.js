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
  const login = auth.renderAuth("Are You Worthy", "login");
  assert.ok(login.includes('data-form="login"'));
  // The quote is the owner's, and deliberate. The login screen also stays
  // quiet about what is behind it: an unauthenticated visitor is not told
  // that this machine runs Minecraft servers.
  assert.ok(login.includes("auth-quote"));
  assert.ok(login.includes("great power comes great responsibility"));
  assert.equal(/minecraft/i.test(login), false);

  const setup = auth.renderAuth("Create the Owner Account", "setup");
  assert.equal(/minecraft/i.test(setup), false);
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
  // The loader catalog is annotated with server A's mod conflicts, so leaving it
  // behind would show B a list of blocked builds that has nothing to do with B.
  state.loaderOptions = { options: { versions: [] }, serverId: "A" };

  resetServerScopedState();

  assert.equal(state.manualDownload, null);
  assert.equal(state.modQuery, "");
  assert.deepEqual(state.modResults, []);
  assert.equal(state.modUpdates, null);
  assert.equal(state.updatePlan, null);
  assert.equal(state.loaderOptions, null);
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

test("the icon set covers every name the views ask for", async () => {
  const { ICONS } = await load(path.join(jsRoot, "icons.js"));

  // A missing key renders an empty <span>, which looks like a layout bug rather
  // than a missing icon, so the set is checked against real usage instead.
  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".js")) {
        continue;
      }
      const source = fs.readFileSync(full, "utf8");
      for (const match of source.matchAll(/\b(?:icon|labelWithIcon)\(\s*"([a-z-]+)"/g)) {
        used.add(match[1]);
      }
    }
  };
  walk(jsRoot);

  const missing = [...used].filter((name) => !(name in ICONS)).sort();
  assert.deepEqual(missing, [], `icons.js is missing: ${missing.join(", ")}`);

  // Every glyph is pixel art on the same 24-unit grid; a stray viewBox would
  // render at a different weight from the rest of the set.
  for (const [name, markup] of Object.entries(ICONS)) {
    assert.match(markup, /viewBox="0 0 24 24"/, `${name} is not on the 24-unit grid`);
    assert.match(markup, /aria-hidden="true"/, `${name} is not hidden from assistive tech`);
  }
});

test("add-on side badges name where a mod has to be installed", async () => {
  const { describeAddonSide } = await load(path.join(jsRoot, "components.js"));

  // A mod the server cannot load. Worth flagging: on the server it does nothing
  // at all, which is indistinguishable from a mod that is quietly broken.
  assert.equal(describeAddonSide("required", "unsupported").label, "client only");
  assert.equal(describeAddonSide("required", "unsupported").tone, "danger");

  assert.equal(describeAddonSide("unsupported", "required").label, "server only");
  assert.equal(describeAddonSide("required", "required").label, "client + server");
  assert.equal(describeAddonSide("optional", "required").label, "server • client optional");
  assert.equal(describeAddonSide("required", "optional").label, "client • server optional");

  // CurseForge publishes no split at all, so nothing is asserted about it.
  assert.equal(describeAddonSide("unknown", "unknown").label, "side unknown");
  assert.equal(describeAddonSide(undefined, undefined).label, "side unknown");
  assert.equal(describeAddonSide("nonsense", "garbage").label, "side unknown");
});

test("add-on artwork falls back to the blocky placeholder", async () => {
  const { renderAddonIcon } = await load(path.join(jsRoot, "components.js"));

  const withIcon = renderAddonIcon("https://cdn.modrinth.com/data/abc/icon.png", "Some Mod");
  assert.match(withIcon, /<img/);
  // Browsing the dashboard must not leak its address to the provider's CDN.
  assert.match(withIcon, /referrerpolicy="no-referrer"/);
  assert.match(withIcon, /loading="lazy"/);

  // The glyph sits behind the artwork, so a CDN failure reveals it rather than
  // leaving an empty bordered box.
  assert.match(withIcon, /addon-icon__fallback/);

  const withoutIcon = renderAddonIcon("", "Some Mod");
  assert.match(withoutIcon, /addon-icon__fallback/);
  assert.doesNotMatch(withoutIcon, /<img/);

  // A URL carrying quotes must not be able to break out of the attribute.
  const hostile = renderAddonIcon('https://evil/"onerror="alert(1)', "x");
  assert.doesNotMatch(hostile, /"onerror="alert/);
});

test("browser preferences survive the rename from the old storage keys", async () => {
  const stored = { "rippermoonstash-theme": "light" };
  const previousLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem(key) {
      return key in stored ? stored[key] : null;
    },
    setItem(key, value) {
      stored[key] = value;
    },
    removeItem(key) {
      delete stored[key];
    }
  };

  try {
    // Cache-busted so the module re-evaluates against the stubbed storage.
    const url = `${pathToFileURL(path.join(jsRoot, "state.js")).href}?rename-fallback`;
    const { readStored, state, writeStored } = await import(url);

    // A returning user keeps the theme they chose before the rename.
    assert.equal(state.theme, "light");
    assert.equal(readStored("theme"), "light");

    // Writes only ever use the new key, so the old one ages out on its own.
    writeStored("theme", "dark");
    assert.equal(stored["rippercraft-theme"], "dark");
    assert.equal(stored["rippermoonstash-theme"], "light");
    assert.equal(readStored("theme"), "dark");
  } finally {
    globalThis.localStorage = previousLocalStorage;
  }
});

test("every brand asset the page and manifest reference actually exists", async () => {
  // A missing favicon fails silently in the browser - the tab just shows a
  // blank page glyph - so the references are checked against the filesystem.
  const html = fs.readFileSync(path.join(publicRoot, "index.html"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(publicRoot, "site.webmanifest"), "utf8"));

  const referenced = new Set();
  for (const match of html.matchAll(/(?:href|src)="\/([^"?]+)/g)) {
    referenced.add(match[1]);
  }
  for (const entry of manifest.icons) {
    referenced.add(entry.src.replace(/^\//, ""));
  }

  const missing = [...referenced]
    .filter((name) => !name.startsWith("api/"))
    .filter((name) => !fs.existsSync(path.join(publicRoot, name)))
    .sort();
  assert.deepEqual(missing, [], `public/ is missing: ${missing.join(", ")}`);

  // The mark has to cover the three contexts an OS actually asks for.
  assert.ok(referenced.has("favicon.ico"), "no .ico for clients that ask by convention");
  assert.ok(referenced.has("apple-touch-icon.png"), "no iOS home screen icon");
  assert.ok(
    manifest.icons.some((entry) => entry.purpose === "maskable"),
    "no maskable icon, so launchers crop the mark into their own shape"
  );
  assert.ok(
    manifest.icons.some((entry) => entry.sizes === "512x512" && entry.purpose === "any"),
    "no 512px icon, which is the install prompt's minimum"
  );

  // Favicons are fetched on every cold load of a dashboard that runs on a LAN
  // box; the master art is 1.4MB and must never be what gets served.
  for (const name of ["favicon-16.png", "favicon-32.png", "favicon.ico"]) {
    const bytes = fs.statSync(path.join(publicRoot, name)).size;
    assert.ok(bytes < 20_000, `${name} is ${bytes} bytes, too heavy for a favicon`);
  }
});

test("the brand mark is decorative and sized so the rail cannot be stretched", async () => {
  const { renderBrandMark } = await load(path.join(jsRoot, "components.js"));
  const markup = renderBrandMark("brand-mark--rail");

  assert.match(markup, /src="\/logo\.png"/);
  assert.match(markup, /class="brand-mark brand-mark--rail"/);
  // The product name is rendered as text beside it, so announcing the image too
  // would read "RipperCraft" twice.
  assert.match(markup, /alt=""/);
  // Intrinsic dimensions let the browser reserve the box before the image
  // lands, so the rail does not jump on first paint.
  assert.match(markup, /width="512"/);
  assert.match(markup, /height="404"/);
});

test("the first-run screen asks for the setup code and the login screen does not", async (t) => {
  const { state } = await load(path.join(jsRoot, "state.js"));
  const { renderAuth } = await load(path.join(jsRoot, "views", "auth.js"));
  const saved = { bootstrap: state.bootstrap, notice: state.notice };
  t.after(() => Object.assign(state, saved));
  state.notice = null;
  state.bootstrap = { needsSetup: true, passwordMinLength: 12 };

  const setup = renderAuth("Create the Owner Account", "setup");
  assert.match(setup, /<form data-form="setup"/);
  // The field the server reads, required, and not something to autofill or autocorrect.
  const codeField = /<input\s+name="setupCode"[^>]*>/.exec(setup);
  assert.ok(codeField, "no setup code field");
  assert.match(codeField[0], /\brequired\b/);
  assert.match(codeField[0], /autocomplete="off"/);
  assert.match(codeField[0], /spellcheck="false"/);
  assert.match(setup, /Printed in the terminal, or the service journal/);
  // It comes before the account fields: nothing else matters without it.
  assert.ok(setup.indexOf('name="setupCode"') < setup.indexOf('name="username"'));

  const login = renderAuth("Are You Worthy", "login");
  assert.match(login, /<form data-form="login"/);
  assert.equal(login.includes("setupCode"), false);
  assert.equal(login.includes("Setup Code"), false);
});

test("the password minimum is mirrored where a password is set, and only there", async (t) => {
  const { state } = await load(path.join(jsRoot, "state.js"));
  const { renderAuth } = await load(path.join(jsRoot, "views", "auth.js"));
  const saved = { bootstrap: state.bootstrap, notice: state.notice };
  t.after(() => Object.assign(state, saved));
  state.notice = null;

  state.bootstrap = { needsSetup: true, passwordMinLength: 12 };
  const setup = renderAuth("Create the Owner Account", "setup");
  assert.match(setup, /<input type="password" name="password" autocomplete="new-password" minlength="12" required \/>/);
  assert.match(setup, /At least 12 characters\./);

  // The number is the server's, not a second copy kept in the page.
  state.bootstrap = { needsSetup: true, passwordMinLength: 16 };
  assert.match(renderAuth("Create the Owner Account", "setup"), /minlength="16"/);
  // An older server that does not say still gets the current rule.
  state.bootstrap = { needsSetup: true };
  assert.match(renderAuth("Create the Owner Account", "setup"), /minlength="12"/);

  // Logging in must not be held to it: passwords set before the rule are shorter.
  state.bootstrap = { needsSetup: false, passwordMinLength: 12 };
  const login = renderAuth("Are You Worthy", "login");
  assert.match(login, /<input type="password" name="password" autocomplete="current-password" required \/>/);
  assert.equal(login.includes("minlength"), false);
});

test("the login and first-run screens show the notice, escaped", async (t) => {
  const { state } = await load(path.join(jsRoot, "state.js"));
  const { renderAuth } = await load(path.join(jsRoot, "views", "auth.js"));
  const saved = { bootstrap: state.bootstrap, notice: state.notice };
  t.after(() => Object.assign(state, saved));
  state.bootstrap = { needsSetup: false, passwordMinLength: 12 };

  state.notice = null;
  assert.equal(renderAuth("Are You Worthy", "login").includes("notice"), false);

  // A wrong password used to change nothing on screen: the banner only existed
  // inside the logged-in shell.
  state.notice = { message: "Too many failed login attempts. Try again in 15 minutes.", type: "error" };
  for (const mode of ["login", "setup"]) {
    const markup = renderAuth("title", mode);
    assert.ok(
      markup.includes(
        '<div class="notice notice--error" aria-hidden="true">Too many failed login attempts. Try again in 15 minutes.</div>'
      ),
      mode
    );
  }

  state.notice = { message: '<img src=x onerror="alert(1)">', type: 'error" onmouseover="alert(1)' };
  const hostile = renderAuth("Are You Worthy", "login");
  // (The page has an <img> of its own, the brand mark; this one must not join it.)
  assert.equal(hostile.includes("<img src=x"), false);
  assert.equal(hostile.includes('onmouseover="alert(1)"'), false);
  assert.ok(hostile.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
});

test("the api wrapper sends what the server's cross-site checks require", async (t) => {
  const { api } = await load(path.join(jsRoot, "api.js"));
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ options, url });
    return { headers: { get: () => "" }, ok: true, status: 204 };
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  // The server refuses any call that changes something unless it is declared
  // as JSON - including the ones that carry no body at all.
  await api("/api/logout", { method: "POST" });
  await api("/api/servers/x/start", { method: "POST" });
  await api("/api/servers/x", { body: { confirmServerId: "x" }, method: "DELETE" });
  await api("/api/users", { body: { username: "lane" }, method: "POST" });
  await api("/api/servers/x/settings", { body: { motd: "hi" }, method: "PUT" });
  for (const call of calls) {
    assert.equal(call.options.headers["Content-Type"], "application/json", `${call.options.method} ${call.url}`);
  }
  assert.equal(calls[3].options.body, '{"username":"lane"}');
  assert.equal(calls[0].options.body, undefined);

  // Uploads are the exception: the browser must set the multipart boundary itself.
  const form = new FormData();
  form.set("file", new Blob(["jar"]), "mod.jar");
  await api("/api/servers/x/mods/upload", { body: form, method: "POST" });
  assert.equal("Content-Type" in calls[5].options.headers, false);
  assert.equal(calls[5].options.body, form);

  // Same-origin, relative URLs only: the session cookie and the Origin header
  // are the browser's to attach.
  for (const call of calls) {
    assert.ok(call.url.startsWith("/api/"), call.url);
    assert.equal(call.options.credentials, undefined);
    assert.equal(call.options.mode, undefined);
  }
});

test("every network call in the front end goes through the api wrapper", () => {
  const offenders = [];
  for (const file of [path.join(publicRoot, "app.js"), ...listModuleFiles(jsRoot)]) {
    if (file === path.join(jsRoot, "api.js")) {
      continue;
    }
    const source = fs.readFileSync(file, "utf8");
    if (/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource/.test(source)) {
      offenders.push(path.relative(publicRoot, file));
    }
  }
  // A call made any other way would skip the JSON content type and be refused.
  assert.deepEqual(offenders, []);
  // And nothing changes state through a plain form post or a link.
  for (const file of listModuleFiles(jsRoot)) {
    const source = fs.readFileSync(file, "utf8");
    assert.equal(/<form[^>]*\smethod=/i.test(source), false, `${path.relative(publicRoot, file)} has a form with its own method`);
    assert.equal(/<form[^>]*\saction=/i.test(source), false, `${path.relative(publicRoot, file)} has a form with its own action`);
  }
});

test("the owner's account forms mirror the password minimum", async (t) => {
  const { state } = await load(path.join(jsRoot, "state.js"));
  const { renderOwnerAdmins } = await load(path.join(jsRoot, "views", "owner.js"));
  const saved = {
    bootstrap: state.bootstrap,
    editingUserId: state.editingUserId,
    resettingUserId: state.resettingUserId,
    servers: state.servers,
    users: state.users
  };
  t.after(() => Object.assign(state, saved));
  state.servers = [];
  state.users = [{ displayName: "Lane", id: "usr_lane", permissions: { createWorldServers: [] }, role: "admin", servers: [], username: "lane" }];
  state.bootstrap = { passwordMinLength: 12 };
  const passwordInputs = (markup, formName) => {
    const form = new RegExp(`<form data-form="${formName}"[\\s\\S]*?</form>`).exec(markup);
    assert.ok(form, `no ${formName} form`);
    return form[0].match(/<input type="password"[^>]*>/g) || [];
  };

  // Creating an account: required, and at least the minimum.
  state.editingUserId = null;
  state.resettingUserId = null;
  let markup = renderOwnerAdmins();
  assert.deepEqual(passwordInputs(markup, "create-user"), [
    '<input type="password" name="password" autocomplete="new-password" minlength="12" placeholder="at least 12 characters" required />'
  ]);
  assert.equal(markup.includes('data-form="update-user"'), false);

  // Editing one: optional - blank keeps the current password - but if a new
  // one is typed it has to meet the minimum. minlength ignores an empty field.
  state.editingUserId = "usr_lane";
  markup = renderOwnerAdmins();
  assert.deepEqual(passwordInputs(markup, "update-user"), [
    '<input type="password" name="password" autocomplete="new-password" minlength="12" placeholder="leave blank to keep current" />'
  ]);
  assert.match(markup, /a new password needs at least 12 characters, and signs this user out everywhere else\./);
  // The fields sit side by side in a row that stretches every cell to the
  // tallest: a note inside one cell makes its neighbours' inputs grow. Each
  // label in these rows holds its caption and its control and nothing else.
  for (const formName of ["create-user", "update-user"]) {
    const form = new RegExp(`<form data-form="${formName}"[\\s\\S]*?</form>`).exec(markup)[0];
    const row = /<div class="input-grid[^"]*">([\s\S]*?)<\/div>/.exec(form)[1];
    for (const label of row.match(/<label>[\s\S]*?<\/label>/g)) {
      assert.equal((label.match(/<span>/g) || []).length, 1, `${formName}: ${label.replace(/\s+/g, " ")}`);
    }
  }

  // Resetting one.
  state.editingUserId = null;
  state.resettingUserId = "usr_lane";
  markup = renderOwnerAdmins();
  assert.deepEqual(passwordInputs(markup, "reset-user-password"), [
    '<input type="password" name="password" autocomplete="new-password" minlength="12" required />'
  ]);
  assert.match(markup, /this signs the user out everywhere else/);

  // The number follows the server.
  state.bootstrap = { passwordMinLength: 20 };
  assert.match(renderOwnerAdmins(), /minlength="20"/);
});

test("an upload over the server's limit is stopped in the page, with the sizes spelled out", async (t) => {
  const { state } = await load(path.join(jsRoot, "state.js"));
  const { formatBytes } = await load(path.join(jsRoot, "format.js"));
  const { assertUploadFits } = await load(path.join(jsRoot, "actions", "forms.js"));
  const savedBootstrap = state.bootstrap;
  t.after(() => {
    state.bootstrap = savedBootstrap;
  });

  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(3.5 * 1024 * 1024), "3.5 MB");
  assert.equal(formatBytes(4096 * 1024 * 1024), "4 GB");
  assert.equal(formatBytes(100), "0.1 KB");

  const megabyte = 1024 * 1024;
  const asked = [];
  const formWith = (file) => ({
    querySelector(selector) {
      asked.push(selector);
      return { files: file ? [file] : [] };
    }
  });

  state.bootstrap = { uploadLimitBytes: 100 * megabyte };
  assert.doesNotThrow(() => assertUploadFits(formWith({ size: 100 * megabyte }), "archive"));
  assert.doesNotThrow(() => assertUploadFits(formWith(null), "archive"));
  assert.throws(
    () => assertUploadFits(formWith({ size: 100 * megabyte + 1 }), "archive"),
    /that file is 100 MB, and uploads here are limited to 100 MB/
  );
  assert.throws(
    () => assertUploadFits(formWith({ size: 5000 * megabyte }), "file"),
    /that file is 4\.9 GB, and uploads here are limited to 100 MB/
  );
  assert.deepEqual([...new Set(asked)], ['input[type="file"][name="archive"]', 'input[type="file"][name="file"]']);

  // A server that does not report a limit: nothing to check against, so the
  // upload is attempted and the server decides.
  state.bootstrap = {};
  assert.doesNotThrow(() => assertUploadFits(formWith({ size: 5000 * megabyte }), "file"));
  state.bootstrap = null;
  assert.doesNotThrow(() => assertUploadFits(formWith({ size: 5000 * megabyte }), "file"));
});

// --- a server that is stopping ------------------------------------------------------------------

// The least a snapshot has to hold for a server's page to be drawn.
function snapshotOf(status, permissions = {}) {
  return {
    mods: [],
    runtime: { modsDir: "servers/demo/mods", worldDir: "servers/demo/world" },
    server: {
      description: "",
      directory: "servers/demo",
      eulaAccepted: true,
      id: "demo",
      loader: "fabric",
      minecraftVersion: "1.21.1",
      name: "Demo",
      passphraseConfigured: true,
      permissions: { canControlRuntime: true, requiresUnlock: false, unlocked: true, ...permissions },
      status
    },
    unlocked: true,
    worlds: []
  };
}

const RUNNING = {
  lastStop: null,
  pid: 4242,
  running: true,
  startedAt: "2026-11-16T10:00:00.000Z",
  startedBy: "owner",
  stopping: false,
  stoppingSince: null
};
const STOPPING = { ...RUNNING, stopping: true, stoppingSince: "2026-11-16T12:00:00.000Z" };
const STOPPED = { lastStop: null, pid: null, running: false, startedAt: null, startedBy: null, stopping: false, stoppingSince: null };
// Stopped by the dashboard, and what the stop took.
const STOP_ENDED_AT = "2026-11-16T12:04:10.000Z";
const stoppedBy = (how) => ({ ...STOPPED, lastStop: { at: STOP_ENDED_AT, how } });

// Puts one server on the page for a test and takes it off again afterwards,
// along with any timer the page started for it.
async function withServerOnPage(t, status) {
  // The entry module registers what runs after every render, the watcher for
  // a stopping server among it.
  await load(path.join(publicRoot, "app.js"));
  await new Promise((resolve) => setImmediate(resolve));
  const { state } = await load(path.join(jsRoot, "state.js"));
  const { syncStopPolling } = await load(path.join(jsRoot, "stopping-live.js"));
  const saved = { ...state };
  t.after(() => {
    Object.assign(state, saved);
    syncStopPolling();
  });
  Object.assign(state, {
    bootstrap: { loggedIn: true, user: { role: "owner", username: "owner" } },
    notice: null,
    selectedServerId: "demo",
    serverSection: "overview",
    serverSnapshot: snapshotOf({ ...status }),
    servers: [{ id: "demo", name: "Demo", status: { ...status } }],
    view: "server"
  });
  return state;
}

// The timers a test's code asks for, kept instead of started.
function captureIntervals(t) {
  const real = { clearInterval: globalThis.clearInterval, setInterval: globalThis.setInterval };
  const intervals = [];
  globalThis.setInterval = (run, every) => {
    const interval = { cleared: false, every, run };
    intervals.push(interval);
    return interval;
  };
  globalThis.clearInterval = (interval) => {
    if (interval) {
      interval.cleared = true;
    }
  };
  t.after(() => Object.assign(globalThis, real));
  return intervals;
}

test("a server is shown as online, offline or stopping", async () => {
  const { describeRunState } = await load(path.join(jsRoot, "format.js"));
  const offline = { label: "offline", short: "down", stopping: false, tone: "idle" };

  assert.deepEqual(describeRunState(RUNNING), { label: "online", short: "up", stopping: false, tone: "ok" });
  assert.deepEqual(describeRunState(STOPPING), { label: "stopping…", short: "stopping", stopping: true, tone: "warn" });
  assert.deepEqual(describeRunState(STOPPED), offline);
  // A process that has gone is not stopping, whatever else an answer says.
  assert.deepEqual(describeRunState({ ...STOPPED, stopping: true }), offline);
  // An answer from before the dashboard said anything about stopping.
  assert.deepEqual(describeRunState({ pid: 1, running: true }), { label: "online", short: "up", stopping: false, tone: "ok" });
  for (const nothing of [undefined, null, {}, "running", 1]) {
    assert.deepEqual(describeRunState(nothing), offline);
  }
  // The colour it is drawn in exists.
  const css = fs.readFileSync(path.join(publicRoot, "styles.css"), "utf8");
  for (const tone of ["ok", "warn", "idle"]) {
    assert.match(css, new RegExp(`\\.status-inline--${tone}\\s*\\{`));
  }
  assert.match(css, /--c-warn-weak:\s*color-mix\(in srgb, var\(--c-warn\) 12%, transparent\);/);
});

test("while a server is stopping its page says so in three places, and start and stop are held", async (t) => {
  const state = await withServerOnPage(t, STOPPING);
  const { renderServerContent } = await load(path.join(jsRoot, "views", "server.js"));
  const { renderServerTree } = await load(path.join(jsRoot, "views", "nav.js"));
  const buttons = (markup) => (markup.match(/<button class="button[^>]*data-action="(?:start|stop|refresh)-server"[^>]*>/g) || []);
  const show = (status) => {
    state.serverSnapshot = snapshotOf(status);
    state.servers = [{ id: "demo", name: "Demo", status }];
    return { page: renderServerContent(), tree: renderServerTree() };
  };

  const stopping = show(STOPPING);
  assert.match(stopping.page, /<span class="status-inline status-inline--warn"><span class="icon">.*?<\/span>stopping…<\/span>/);
  assert.deepEqual(buttons(stopping.page), [
    '<button class="button button--primary" data-action="start-server" disabled title="this server is stopping">',
    '<button class="button button--quiet" data-action="stop-server" disabled title="this server is stopping">',
    '<button class="button button--quiet" data-action="refresh-server">'
  ]);
  assert.ok(stopping.page.includes(`<strong>stopping… since ${new Date(STOPPING.stoppingSince).toLocaleString()}</strong>`));
  assert.match(stopping.page, /this server was told to stop and is saving its world\./);
  assert.match(stopping.tree, /<span class="tree-meta">stopping<\/span>/);

  const online = show(RUNNING);
  assert.match(online.page, /<span class="status-inline status-inline--ok"><span class="icon">.*?<\/span>online<\/span>/);
  assert.deepEqual(buttons(online.page), [
    '<button class="button button--primary" data-action="start-server">',
    '<button class="button button--quiet" data-action="stop-server">',
    '<button class="button button--quiet" data-action="refresh-server">'
  ]);
  assert.match(online.page, /<strong>online<\/strong>/);
  assert.equal(online.page.includes("told to stop"), false);
  assert.match(online.tree, /<span class="tree-meta">up<\/span>/);

  const offline = show(STOPPED);
  assert.match(offline.page, /<span class="status-inline status-inline--idle"><span class="icon">.*?<\/span>offline<\/span>/);
  assert.equal(offline.page.includes("disabled"), false);
  assert.match(offline.page, /<strong>offline<\/strong>/);
  assert.match(offline.tree, /<span class="tree-meta">down<\/span>/);

  // When it began is drawn as a time or as "unknown", never as what was sent.
  const odd = show({ ...STOPPING, stoppingSince: '<b onclick="alert(1)">' });
  assert.ok(odd.page.includes("<strong>stopping… since unknown</strong>"));
  assert.equal(odd.page.includes("<b onclick"), false);

  // Someone who may not start or stop it has no buttons to hold.
  state.serverSnapshot = snapshotOf(STOPPING, { canControlRuntime: false });
  assert.deepEqual(buttons(renderServerContent()), ['<button class="button button--quiet" data-action="refresh-server">']);
});

test("stop is answered at once, and the page then watches the server until it has stopped", async (t) => {
  const state = await withServerOnPage(t, RUNNING);
  const intervals = captureIntervals(t);
  const { handleAppClick } = await load(path.join(jsRoot, "actions", "click.js"));
  const { STOP_POLL_INTERVAL_MS, anyServerStopping } = await load(path.join(jsRoot, "stopping-live.js"));
  assert.equal(STOP_POLL_INTERVAL_MS, 2000);

  // The dashboard, as far as this page can tell.
  let status = RUNNING;
  const calls = [];
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  globalThis.fetch = async (url, options) => {
    calls.push(`${options.method} ${url}`);
    let body = null;
    if (url === "/api/servers/demo/stop") {
      status = status.running ? STOPPING : STOPPED;
      body = { status };
    } else if (url === "/api/servers") {
      body = { providers: {}, servers: [{ id: "demo", name: "Demo", status }] };
    } else if (url === "/api/servers/demo") {
      body = snapshotOf(status);
    }
    return { headers: { get: () => "application/json" }, json: async () => body, ok: true, status: 200 };
  };
  const press = (action) =>
    handleAppClick({ target: { closest: (selector) => (selector === "[data-action]" ? { dataset: { action } } : null) } });
  const held = () => (appElement.innerHTML.match(/data-action="(?:start|stop)-server" disabled/g) || []).length;

  await press("stop-server");
  // One request to stop it, then the page is brought up to date.
  assert.deepEqual(calls.splice(0), ["POST /api/servers/demo/stop", "GET /api/servers", "GET /api/servers/demo"]);
  assert.deepEqual(state.notice, { message: "stopping — the server saves the world first", type: "success" });
  assert.match(appElement.innerHTML, /status-inline--warn"><span class="icon">.*?<\/span>stopping…/);
  assert.equal(held(), 2);
  assert.equal(anyServerStopping(), true);
  // And from then on it is asked about every two seconds, by one timer.
  assert.deepEqual(intervals.map((interval) => [interval.every, interval.cleared]), [[2000, false]]);

  // Still stopping: the list is asked for and nothing is drawn again.
  appElement.innerHTML = "as it was";
  await intervals[0].run();
  assert.deepEqual(calls.splice(0), ["GET /api/servers"]);
  assert.equal(appElement.innerHTML, "as it was");
  assert.equal(intervals.length, 1);

  // A tab in the background does not ask at all.
  globalThis.document.hidden = true;
  await intervals[0].run();
  globalThis.document.hidden = false;
  assert.deepEqual(calls, []);

  // It has gone: the whole page is fetched again and drawn as usual.
  status = STOPPED;
  await intervals[0].run();
  assert.deepEqual(calls.splice(0), ["GET /api/servers", "GET /api/servers/demo"]);
  assert.deepEqual(state.notice, { message: "Demo stopped", type: "success" });
  assert.match(appElement.innerHTML, /status-inline--idle"><span class="icon">.*?<\/span>offline/);
  assert.equal(held(), 0);
  assert.equal(anyServerStopping(), false);
  assert.deepEqual(intervals.map((interval) => interval.cleared), [true]);

  // Stop on a server that is not running says so, and watches nothing.
  await press("stop-server");
  assert.deepEqual(state.notice, { message: "the server is not running", type: "success" });
  assert.equal(intervals.length, 1);
});

test("a page opened in the middle of a stop watches it too, and gives up when the dashboard stops answering", async (t) => {
  const state = await withServerOnPage(t, STOPPING);
  const intervals = captureIntervals(t);
  const { render } = await load(path.join(jsRoot, "render.js"));
  const { anyServerStopping } = await load(path.join(jsRoot, "stopping-live.js"));
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  let asked = 0;
  globalThis.fetch = async () => {
    asked += 1;
    return { headers: { get: () => "application/json" }, json: async () => ({ error: "Sign in first." }), ok: false, status: 401 };
  };

  // Nothing was pressed here: the status that was loaded is all it takes.
  render();
  assert.deepEqual(intervals.map((interval) => [interval.every, interval.cleared]), [[2000, false]]);
  // Drawing again does not start a second timer.
  render();
  assert.equal(intervals.length, 1);

  // Two failures are let pass.
  await intervals[0].run();
  await intervals[0].run();
  assert.equal(asked, 2);
  assert.equal(state.notice, null);
  assert.equal(anyServerStopping(), true);

  // The third ends it: said once, the buttons are given back, the timer goes.
  await intervals[0].run();
  assert.deepEqual(state.notice, { message: "lost touch with a server that was stopping: Sign in first.", type: "error" });
  assert.equal(anyServerStopping(), false);
  assert.equal(appElement.innerHTML.includes('data-action="stop-server" disabled'), false);
  assert.match(appElement.innerHTML, /status-inline--ok"><span class="icon">.*?<\/span>online/);
  assert.deepEqual(intervals.map((interval) => interval.cleared), [true]);
});

test("a server that stops while another one is on the page is noticed as well", async (t) => {
  const state = await withServerOnPage(t, RUNNING);
  const intervals = captureIntervals(t);
  const { render } = await load(path.join(jsRoot, "render.js"));
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const calls = [];
  let other = STOPPING;
  globalThis.fetch = async (url) => {
    calls.push(url);
    const body = { providers: {}, servers: [{ id: "demo", name: "Demo", status: RUNNING }, { id: "other", name: "Other", status: other }] };
    return { headers: { get: () => "application/json" }, json: async () => body, ok: true, status: 200 };
  };
  state.servers = [...state.servers, { id: "other", name: "Other", status: STOPPING }];

  render();
  assert.equal(intervals.length, 1);
  assert.match(appElement.innerHTML, /<span class="tree-meta">stopping<\/span>/);

  other = STOPPED;
  await intervals[0].run();
  // Only the list: the page that is open is not the server that stopped.
  assert.deepEqual(calls, ["/api/servers"]);
  assert.deepEqual(state.notice, { message: "Other stopped", type: "success" });
  assert.equal(appElement.innerHTML.includes('<span class="tree-meta">stopping</span>'), false);
  assert.deepEqual(intervals.map((interval) => interval.cleared), [true]);
});

// A page with one server on it that is stopping, a dashboard that answers
// with whatever `answer.status` is at the time, and the timer that asks.
async function withStoppingServer(t) {
  const state = await withServerOnPage(t, STOPPING);
  const intervals = captureIntervals(t);
  const { render } = await load(path.join(jsRoot, "render.js"));
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const answer = { status: STOPPING };
  globalThis.fetch = async (url) => {
    const body = url === "/api/servers" ? { providers: {}, servers: [{ id: "demo", name: "Demo", status: answer.status }] } : snapshotOf(answer.status);
    return { headers: { get: () => "application/json" }, json: async () => body, ok: true, status: 200 };
  };
  render();
  assert.equal(intervals.length, 1);
  return { answer, state, tick: () => intervals[0].run() };
}

test("how a stop ended is told apart: by the console, by SIGTERM, or by killing the server", async () => {
  const { describeLastStop } = await load(path.join(jsRoot, "format.js"));
  const when = new Date(STOP_ENDED_AT).toLocaleString();

  assert.deepEqual(describeLastStop(stoppedBy("console")), { killed: false, summary: `${when} — by "stop" on its console` });
  assert.deepEqual(describeLastStop(stoppedBy("SIGTERM")), { killed: false, summary: `${when} — by SIGTERM` });
  assert.deepEqual(describeLastStop(stoppedBy("SIGKILL")), { killed: true, summary: `${when} — killed. it did not stop when asked` });

  // A server the dashboard has not stopped has nothing to say about it.
  for (const status of [STOPPED, RUNNING, STOPPING, undefined, null, {}, "stopped"]) {
    assert.equal(describeLastStop(status), null);
  }
  // Nor has one that is running, whatever an answer says.
  assert.equal(describeLastStop({ ...RUNNING, lastStop: { at: STOP_ENDED_AT, how: "SIGKILL" } }), null);
  // Only the three words the dashboard uses mean anything, and nothing that was sent is passed on.
  for (const how of ["sigkill", "KILL", '<b onclick="alert(1)">', 9, null, undefined, ["SIGKILL"]]) {
    assert.equal(describeLastStop({ ...STOPPED, lastStop: { at: STOP_ENDED_AT, how } }), null, JSON.stringify(how));
  }
  for (const lastStop of ["SIGKILL", 1, true, []]) {
    assert.equal(describeLastStop({ ...STOPPED, lastStop }), null, JSON.stringify(lastStop));
  }
  // When it ended is drawn as a time or as "unknown".
  assert.equal(describeLastStop({ ...STOPPED, lastStop: { at: '<b onclick="alert(1)">', how: "SIGKILL" } }).summary, "unknown — killed. it did not stop when asked");
});

test("a server that had to be killed is not called stopped: the page says what that may have cost", async (t) => {
  const { answer, state, tick } = await withStoppingServer(t);
  const when = new Date(STOP_ENDED_AT).toLocaleString();

  answer.status = stoppedBy("SIGKILL");
  await tick();
  assert.deepEqual(state.notice, {
    message: "Demo did not stop when asked, and was killed: the world may not have been saved, see its log",
    type: "error"
  });
  // Drawn as an error, and read out as one.
  assert.match(appElement.innerHTML, /<div class="notice notice--error" aria-hidden="true">Demo did not stop when asked, and was killed: the world may not have been saved, see its log<\/div>/);
  // The notice goes with the next thing that is done. The server's page keeps saying it.
  assert.match(appElement.innerHTML, /status-inline--idle"><span class="icon">.*?<\/span>offline/);
  assert.ok(appElement.innerHTML.includes('<p class="notice notice--error">this server did not stop when it was asked to, and was killed. the world may not have been saved: see its log before starting it again.</p>'));
  assert.ok(appElement.innerHTML.includes(`<span>last stop</span>\n              <strong>${when} — killed. it did not stop when asked</strong>`));
  // It can be started again: nothing is held.
  assert.equal(appElement.innerHTML.includes('data-action="start-server" disabled'), false);
});

for (const [how, summary] of [
  ["console", "by &quot;stop&quot; on its console"],
  ["SIGTERM", "by SIGTERM"]
]) {
  test(`a server that stopped by ${how} is called stopped, and its page says how`, async (t) => {
    const { answer, state, tick } = await withStoppingServer(t);
    answer.status = stoppedBy(how);
    await tick();
    assert.deepEqual(state.notice, { message: "Demo stopped", type: "success" });
    assert.ok(appElement.innerHTML.includes(`<span>last stop</span>\n              <strong>${new Date(STOP_ENDED_AT).toLocaleString()} — ${summary}</strong>`));
    assert.equal(appElement.innerHTML.includes("was killed"), false);
    assert.equal(appElement.innerHTML.includes('<p class="notice notice--error">'), false);
  });
}

test("a server the dashboard did not stop has no last stop on its page", async (t) => {
  const { answer, state, tick } = await withStoppingServer(t);
  // It went, and nothing says how: the dashboard was restarted in the middle of the stop.
  answer.status = STOPPED;
  await tick();
  assert.deepEqual(state.notice, { message: "Demo stopped", type: "success" });
  assert.equal(appElement.innerHTML.includes("last stop"), false);
  assert.equal(appElement.innerHTML.includes("was killed"), false);
});

test("a stop that ends with the server still running is said as an error, and one that was started again is not", async (t) => {
  const { answer, state, tick } = await withStoppingServer(t);

  // The same process, and no stop under way any more.
  answer.status = RUNNING;
  await tick();
  assert.deepEqual(state.notice, {
    message: "Demo is still running: the stop did not finish. see its log, then stop it again",
    type: "error"
  });
  assert.match(appElement.innerHTML, /status-inline--ok"><span class="icon">.*?<\/span>online/);
  // Stop can be pressed again.
  assert.equal(appElement.innerHTML.includes('data-action="stop-server" disabled'), false);
});

test("a server that stopped and was started again between two looks is a running server, and nothing is said", async (t) => {
  const { answer, state, tick } = await withStoppingServer(t);
  answer.status = { ...RUNNING, pid: 5151, startedAt: "2026-11-16T12:05:00.000Z" };
  await tick();
  assert.equal(state.notice, null);
  assert.match(appElement.innerHTML, /status-inline--ok"><span class="icon">.*?<\/span>online/);
});

test("several stops that end together are each said for what they were, the bad news first", async (t) => {
  const state = await withServerOnPage(t, STOPPING);
  const intervals = captureIntervals(t);
  const { render } = await load(path.join(jsRoot, "render.js"));
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const names = { demo: "Demo", four: "Four", three: "Three", two: "Two" };
  let statuses = { demo: STOPPING, four: { ...STOPPING, pid: 44 }, three: { ...STOPPING, pid: 33 }, two: { ...STOPPING, pid: 22 } };
  const list = () => Object.keys(names).map((id) => ({ id, name: names[id], status: statuses[id] }));
  globalThis.fetch = async (url) => {
    const body = url === "/api/servers" ? { providers: {}, servers: list() } : snapshotOf(statuses.demo);
    return { headers: { get: () => "application/json" }, json: async () => body, ok: true, status: 200 };
  };
  state.servers = list();
  render();

  statuses = { demo: stoppedBy("SIGKILL"), four: stoppedBy("console"), three: { ...RUNNING, pid: 33 }, two: stoppedBy("SIGKILL") };
  await intervals[0].run();
  assert.deepEqual(state.notice, {
    message:
      "Demo, Two did not stop when asked, and were killed: the world may not have been saved, see their logs. " +
      "Three is still running: the stop did not finish. see its log, then stop it again. " +
      "Four stopped",
    type: "error"
  });
});

test("stop on a server that keeps running without stopping is not called 'not running'", async (t) => {
  const state = await withServerOnPage(t, RUNNING);
  captureIntervals(t);
  const { handleAppClick } = await load(path.join(jsRoot, "actions", "click.js"));
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  // The stop could not begin: the answer is a server that is running, and not stopping.
  globalThis.fetch = async (url) => {
    const body = url === "/api/servers/demo/stop" ? { status: RUNNING } : url === "/api/servers" ? { providers: {}, servers: [{ id: "demo", name: "Demo", status: RUNNING }] } : snapshotOf(RUNNING);
    return { headers: { get: () => "application/json" }, json: async () => body, ok: true, status: 200 };
  };
  await handleAppClick({ target: { closest: (selector) => (selector === "[data-action]" ? { dataset: { action: "stop-server" } } : null) } });
  assert.deepEqual(state.notice, {
    message: "the server is still running: the stop did not go through. see its log and the dashboard's, then try again",
    type: "error"
  });
  assert.match(appElement.innerHTML, /status-inline--ok"><span class="icon">.*?<\/span>online/);
});

