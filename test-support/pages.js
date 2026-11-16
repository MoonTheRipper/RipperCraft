// Draws the dashboard's pages to strings, from what a real server sends, for
// tests that read the markup. Call installBrowserStubs() from ./browser first.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadPublicModule } = require("./browser");
const { startWithAdmin } = require("./lane");

// Everything the server sends for one server, as the owner and as the admin,
// with enough in it that every list on the page has a row to draw.
async function realResponses(t) {
  const { admin, app, owner } = await startWithAdmin(t);
  const serverDir = path.join(app.root, "servers", "DemoServer");
  // One add-on dropped in by hand, one whose update check failed, and one
  // installed through a provider, which is the kind that has a title, artwork
  // and a page of its own to draw.
  for (const name of ["example-mod.jar", "other.jar", "tracked-mod.jar"]) {
    fs.writeFileSync(path.join(serverDir, "mods", name), "jar");
  }
  fs.mkdirSync(path.join(serverDir, ".rippermoon"), { recursive: true });
  fs.writeFileSync(
    path.join(serverDir, ".rippermoon", "addons.json"),
    JSON.stringify({
      addons: [
        {
          clientSide: "required",
          fileName: "tracked-mod.jar",
          iconUrl: "https://cdn.modrinth.com/data/abc/icon.png",
          pageUrl: "https://modrinth.com/mod/abc",
          provider: "modrinth",
          serverSide: "optional",
          sourceId: "abc",
          title: "Tracked Mod"
        }
      ]
    })
  );
  fs.writeFileSync(path.join(serverDir, "ops.json"), JSON.stringify([{ level: 4, name: "Moon", uuid: "0-0" }]));
  assert.equal((await admin("POST", "/api/servers/DemoServer/worlds/capture", { json: { label: "first" } })).status, 200);

  return {
    adminSnapshot: (await admin("GET", "/api/servers/DemoServer")).json,
    bootstrap: (await owner("GET", "/api/bootstrap")).json,
    lockedSnapshot: (await lockedView(app)).json,
    ownerSnapshot: (await owner("GET", "/api/servers/DemoServer")).json,
    panels: panelResponses(),
    servers: (await owner("GET", "/api/servers")).json.servers,
    users: (await owner("GET", "/api/users")).json.users
  };
}

// The same server as a second session of the admin sees it before unlocking.
async function lockedView(app) {
  const { ADMIN_PASSWORD } = require("./app");
  const second = app.client();
  assert.equal((await second("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "lane" } })).status, 200);
  return second("GET", "/api/servers/DemoServer");
}

// What the routes behind the page's other panels answer with - a search, an
// update check, a loader catalogue, an update plan, a running job. They need
// Modrinth, Mojang or a real installer to produce, so these are written out in
// the shapes those routes return.
function panelResponses() {
  const conflict = { fileName: "example-mod.jar", modId: "example", name: "Example Mod", range: ">=0.16.0", version: "1.0.0" };
  return {
    createJob: { createdAt: "2026-11-15T12:00:00.000Z", progress: 0.5, status: "running", step: "downloading fabric", stepIndex: 3, totalSteps: 6 },
    integrations: {
      curseforge: {
        configured: true,
        envOverride: { envFile: "/etc/rippercraft.env", service: "rippercraft", variable: "CURSEFORGE_API_KEY" },
        hint: "...abcd",
        source: "environment",
        stored: true
      }
    },
    javaRuntimes: [{ label: "Java 21 (21.0.4)", major: 21, path: "/usr/lib/jvm/java-21/bin/java", source: "installed", version: "21.0.4" }],
    loaderOptions: {
      currentLoaderVersion: "0.16.14",
      gameVersion: "1.21.1",
      loader: "fabric",
      loaderVersioned: true,
      modScan: {
        floor: { inclusive: true, requiredBy: [conflict], version: "0.16.0" },
        scannedMods: 2,
        supported: true,
        unreadable: [{ fileName: "broken.jar", reason: "not a zip archive" }]
      },
      recommendedLoaderVersion: "0.16.14",
      versions: [
        { conflicts: [], current: true, satisfiesInstalledMods: true, stable: true, version: "0.16.14" },
        { conflicts: [conflict], current: false, satisfiesInstalledMods: false, stable: false, version: "0.15.0" }
      ]
    },
    // What the snapshot of a server carries when its runtime was installed by
    // the dashboard - here one whose label has since been changed to another
    // loader - and when it was not, with and without a loader the dashboard
    // can install for it.
    managedServer: {
      managedRuntime: { kind: "paper", launch: { kind: "jar" }, loaderVersion: "0.16.14" },
      updateSupport: { adoptable: false, loaderVersioned: true, runtimeKind: "fabric", supported: true }
    },
    adoptions: [
      { alreadyManaged: false, currentStartCommand: "./start.sh", detectedLoaderVersion: "0.16.10", installable: true, loader: "fabric", minecraftVersion: "1.21.1" },
      { alreadyManaged: false, currentStartCommand: "./start.sh", detectedLoaderVersion: "", installable: false, loader: "quilt", minecraftVersion: "1.21.1" }
    ],
    manualDownload: { fileId: "1", fileName: "closed-mod.jar", modId: "2", modName: "Closed Mod", pageUrl: "https://www.curseforge.com/minecraft/mc-mods/closed/files/1", provider: "curseforge" },
    modResults: [
      {
        author: "someone",
        clientSide: "required",
        compatibilityLabel: "fabric - 1.21.1 - mod",
        description: "A mod",
        downloads: 1234,
        iconUrl: "https://cdn.modrinth.com/data/abc/icon.png",
        id: "abc",
        pageUrl: "https://modrinth.com/mod/abc",
        provider: "modrinth",
        serverSide: "optional",
        slug: "abc",
        title: "A Mod"
      },
      {
        author: "someone else",
        clientSide: "unknown",
        description: "A closed mod",
        downloads: 5,
        iconUrl: "https://media.forgecdn.net/avatars/thumbnails/1/2/64/64/3.png",
        id: "77",
        manualDownloadOnly: true,
        pageUrl: "https://www.curseforge.com/minecraft/mc-mods/closed",
        provider: "curseforge",
        serverSide: "unknown",
        slug: "closed",
        title: "Closed Mod"
      }
    ],
    modUpdates: {
      entries: [
        { fileName: "example-mod.jar", latestFileName: "example-mod-2.jar", latestVersion: "2.0", provider: "modrinth", sourceId: "abc", status: "update-available" },
        { fileName: "other.jar", provider: "modrinth", reason: "Could not check: Request failed with status 500.", sourceId: "def", status: "error" },
        { fileName: "tracked-mod.jar", latestFileName: "tracked-mod-2.jar", latestVersion: "2.0", provider: "modrinth", sourceId: "abc", status: "update-available" }
      ],
      gameVersion: "1.21.1",
      loader: "fabric",
      updatable: 1
    },
    notice: { message: "something happened", type: "error" },
    // The status of a server that has been told to stop and has not gone yet.
    // A real one would take a server that is slow to stop.
    stoppingStatus: {
      lastStop: null,
      pid: 4242,
      running: true,
      startedAt: "2026-11-16T10:00:00.000Z",
      startedBy: "owner",
      stopping: true,
      stoppingSince: "2026-11-16T12:00:00.000Z"
    },
    // And of one that did not go, and was killed. A real one would take a
    // server that ignores "stop" and SIGTERM for minutes.
    killedStatus: {
      lastStop: { at: "2026-11-16T12:04:10.000Z", how: "SIGKILL" },
      pid: null,
      running: false,
      startedAt: null,
      startedBy: null,
      stopping: false,
      stoppingSince: null
    },
    updatePlan: {
      addons: {
        blockedReasons: [],
        managedCount: 1,
        manualCount: 0,
        safe: true,
        untrackedFiles: [],
        updates: [{ changed: true, direct: true, fileName: "example-mod-2.jar", fromFileName: "example-mod.jar", provider: "modrinth", sourceId: "abc" }]
      },
      blockedReasons: ["Fabric 0.15.0 is rejected by 1 installed mod(s): Example Mod needs >=0.16.0."],
      mode: "version",
      runtime: {
        currentLoaderVersion: "0.16.14",
        currentVersion: "1.21.1",
        loaderConflicts: [conflict],
        loaderDirection: "downgrade",
        loaderVersion: "0.15.0",
        loaderVersioned: true,
        minecraftConflicts: [conflict],
        runtimeKind: "fabric",
        versionDirection: "upgrade"
      },
      safe: false,
      targetVersion: "1.21.4"
    },
    versionCatalog: {
      latest: { release: "1.21.4", snapshot: "25w02a" },
      versions: [
        { id: "1.21.4", releaseTime: "2024-12-03T10:12:57+00:00", type: "release" },
        { id: "25w02a", releaseTime: "2025-01-08T13:42:18+00:00", type: "snapshot" }
      ]
    }
  };
}

// Draws every page the dashboard has from the given responses: the sign-in and
// first-run screens, the passphrase gate, every server section with its panels
// open, the sidebar, and every owner page with its dialogs open.
async function renderEverything(responses, role) {
  const { state } = await loadPublicModule("js/state.js");
  const { render } = await loadPublicModule("js/render.js");
  const { renderAuth } = await loadPublicModule("js/views/auth.js");
  const { renderServerContent } = await loadPublicModule("js/views/server.js");
  const { renderOwnerContent } = await loadPublicModule("js/views/owner.js");
  const { renderSidebar } = await loadPublicModule("js/views/nav.js");
  const { renderVersionDatalist } = await loadPublicModule("js/components.js");

  const saved = { ...state };
  const pages = [];
  const panels = responses.panels;
  try {
    state.bootstrap = { ...responses.bootstrap, user: { ...responses.bootstrap.user, role } };
    state.notice = panels.notice;
    pages.push(renderAuth("Create the Owner Account", "setup"), renderAuth("Are You Worthy", "login"));

    state.servers = responses.servers;
    state.users = responses.users;
    state.view = "server";

    // Before the passphrase has been given.
    if (role !== "owner") {
      state.serverSnapshot = responses.lockedSnapshot;
      state.selectedServerId = state.serverSnapshot.server.id;
      state.serverSection = "overview";
      pages.push(renderServerContent());
    }

    state.serverSnapshot = role === "owner" ? responses.ownerSnapshot : responses.adminSnapshot;
    // The panels below are only drawn for the server they were fetched for.
    const serverId = state.serverSnapshot.server.id;
    state.selectedServerId = serverId;
    state.loaderOptions = { options: panels.loaderOptions, serverId };
    state.manualDownload = panels.manualDownload;
    state.modQuery = panels.modResults[0].title;
    state.modResults = panels.modResults;
    state.modUpdates = { ...panels.modUpdates, serverId };
    state.updatePlan = { plan: panels.updatePlan, serverId };
    state.versionCatalog = panels.versionCatalog;
    state.javaRuntimes = panels.javaRuntimes;
    state.integrations = panels.integrations;
    for (const section of ["overview", "settings", "worlds", "mods", "logs"]) {
      state.serverSection = section;
      pages.push(renderServerContent());
    }
    // The add-ons section again as it is before anything has been searched for.
    state.modResults = [];
    state.serverSection = "mods";
    pages.push(renderServerContent());
    state.modResults = panels.modResults;

    // The same server while it is stopping: its page, and its place in the tree.
    const atRest = state.serverSnapshot;
    state.serverSnapshot = { ...atRest, server: { ...atRest.server, status: panels.stoppingStatus } };
    state.servers = responses.servers.map((server) => ({ ...server, status: panels.stoppingStatus }));
    state.serverSection = "overview";
    pages.push(renderServerContent(), renderSidebar("light"));
    // And after a stop that ended with the server being killed.
    state.serverSnapshot = { ...atRest, server: { ...atRest.server, status: panels.killedStatus } };
    state.servers = responses.servers.map((server) => ({ ...server, status: panels.killedStatus }));
    pages.push(renderServerContent());
    state.serverSnapshot = atRest;
    state.servers = responses.servers;

    if (role === "owner") {
      // The same server as one the dashboard installed the runtime for: with
      // the builds it could move to, and before those have been fetched.
      const plain = state.serverSnapshot;
      state.serverSnapshot = { ...plain, server: { ...plain.server, ...panels.managedServer } };
      for (const loaderOptions of [state.loaderOptions, null]) {
        state.loaderOptions = loaderOptions;
        for (const section of ["overview", "settings"]) {
          state.serverSection = section;
          pages.push(renderServerContent());
        }
      }
      state.loaderOptions = { options: panels.loaderOptions, serverId };
      // And as one it did not, which it offers to take over - or cannot.
      for (const runtimeAdoption of panels.adoptions) {
        state.serverSnapshot = {
          ...plain,
          server: { ...plain.server, permissions: { ...plain.server.permissions, canAdoptRuntime: true }, runtimeAdoption }
        };
        state.serverSection = "overview";
        pages.push(renderServerContent());
      }
      state.serverSnapshot = plain;
    }
    state.navOpen = true;
    pages.push(renderSidebar("light"), renderVersionDatalist("minecraft-version-list", true));
    // The page as a whole, the way the browser is handed it: the frame around
    // a section, with the notice that sits above every one of them.
    pages.push(drawWholePage(render));

    if (role === "owner") {
      state.view = "owner";
      state.createJob = panels.createJob;
      state.createVersionOpen = true;
      // A version picked from the list, not the "latest" the form opens with.
      state.createServerMinecraftVersion = panels.versionCatalog.versions[0].id;
      state.editingUserId = state.users[0].id;
      state.resettingUserId = state.users[state.users.length - 1].id;
      for (const section of ["servers", "admins", "integrations"]) {
        state.ownerSection = section;
        pages.push(renderOwnerContent());
      }
      pages.push(drawWholePage(render));
    }
  } finally {
    Object.assign(state, saved);
  }
  return pages.join("\n");
}

// Runs the dashboard's own render() and returns what it put into the page.
function drawWholePage(render) {
  const app = document.getElementById("app");
  app.innerHTML = "";
  render();
  assert.ok(app.innerHTML.includes('<main class="shell">'), "the whole page was not drawn");
  return app.innerHTML;
}

// Text in a response is one of three things. Most of it is drawn. Some of it
// decides what is drawn - a setting's type, an update's status - and some of
// it says which thing a record is about, so that two records about the same
// add-on or setting find each other. Replace all three and the page falls
// back to its plainest branches, leaving the others undrawn and untested.
const DECIDES = new Set([
  "clientSide",
  "installKind",
  "kind",
  "loaderDirection",
  "mode",
  "role",
  "runtimeKind",
  "serverSide",
  "settingsMode",
  "source",
  "status",
  "type",
  "versionDirection"
]);
const IDENTIFIES = new Set(["fileName", "id", "key", "serverId"]);

function replaceText(value, replacement, keep, key) {
  if (typeof value === "string") {
    return keep.has(key) ? value : replacement(key);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceText(item, replacement, keep, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replaceText(item, replacement, keep, name)]));
  }
  return value;
}

// Copies of a set of responses with the text in them replaced by whatever
// `replacement` returns, in every combination a page's branches need: all of
// it; all but what decides; all but what decides or identifies. Each of those
// twice - once with the same replacement everywhere, so that records which
// matched still match, and once with a different one each time, so that
// nothing matches by accident. `replacement` is called with a number that
// counts up, or 0 when the same value is wanted everywhere, and with the name
// of the field being replaced.
function hostileCopies(responses, replacement) {
  const copies = [];
  const keeps = [
    ["every string", new Set()],
    ["every string that is drawn or names something", DECIDES],
    ["every string that is drawn", new Set([...DECIDES, ...IDENTIFIES])]
  ];
  for (const [label, keep] of keeps) {
    copies.push([`${label}, the same everywhere`, replaceText(responses, (key) => replacement(0, key), keep, "")]);
    let count = 0;
    copies.push([
      `${label}, different each time`,
      replaceText(
        responses,
        (key) => {
          count += 1;
          return replacement(count, key);
        },
        keep,
        ""
      )
    ]);
  }
  return copies;
}

module.exports = {
  hostileCopies,
  realResponses,
  renderEverything
};
