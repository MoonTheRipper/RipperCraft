const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { createStore } = require("../src/lib/store");
const { createSessionManager, hashSecret, setHashCostForTests, verifySecret } = require("../src/lib/auth");
const { createServerManager } = require("../src/lib/servers");
const { createWorldManager } = require("../src/lib/worlds");
const { createModManager } = require("../src/lib/mod-sources");
const { createJobRegistry } = require("../src/lib/jobs");
const { useFetchForOutbound } = require("../test-support/outbound");

// These tests hash dozens of passwords and passphrases on the way to checking
// something else. test/auth.test.js covers hashing at its real cost.
setHashCostForTests({ ln: 10, r: 8, p: 1 });

// The tests below describe Mojang, Modrinth and the rest by replacing fetch.
// The dashboard no longer calls fetch itself - it resolves and checks every
// address and connects to it directly - so those last steps are swapped for
// one that asks fetch. test/outbound.test.js covers the real ones.
useFetchForOutbound();

async function createFixtureRoot() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippermoonstash-test-"));
  await fsp.mkdir(path.join(root, "servers", "DemoServer", "logs"), { recursive: true });
  await fsp.mkdir(path.join(root, "servers", "DemoServer", "mods"), { recursive: true });
  await fsp.mkdir(path.join(root, "servers", "DemoServer", "plugins"), { recursive: true });
  await fsp.mkdir(path.join(root, "servers", "DemoServer", "world"), { recursive: true });
  await fsp.writeFile(path.join(root, "servers", "DemoServer", "launch-server.sh"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  await fsp.writeFile(path.join(root, "servers", "DemoServer", "server.properties"), "motd=Demo\n", "utf8");
  await fsp.writeFile(
    path.join(root, "servers", "DemoServer", "logs", "latest.log"),
    "[Server thread/INFO]: Starting minecraft server version 1.21.11\n",
    "utf8"
  );
  await fsp.writeFile(path.join(root, "servers", "DemoServer", "world", "level.dat"), "demo", "utf8");
  return root;
}

test("auth hashing verifies valid passwords and rejects invalid ones", async () => {
  const hash = await hashSecret("moon-pass");
  assert.equal(await verifySecret("moon-pass", hash), true);
  assert.equal(await verifySecret("wrong-pass", hash), false);
});

test("store and server manager discover servers and sanitize snapshots", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const sessionManager = createSessionManager(() => store.getAppConfig());

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  const owner = await store.createUser({
    username: "owner",
    displayName: "Ripper Moon",
    passwordHash: await hashSecret("moon-pass"),
    role: "owner",
    servers: []
  });

  const records = await serverManager.syncDiscoveredServers();
  assert.ok(records.DemoServer);
  assert.equal(records.DemoServer.minecraftVersion, "1.21.11");

  await serverManager.setServerMetadata("DemoServer", {
    description: "Owner managed demo server",
    loader: "fabric",
    name: "Demo Server",
    passphrase: "moon-lane",
    startCommand: "./launch-server.sh"
  });

  const session = await sessionManager.createSession(owner.id);
  await sessionManager.unlockServer(session, "DemoServer");

  const servers = await serverManager.listServersForUser(owner);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "Demo Server");
  assert.equal(servers[0].passphraseConfigured, true);
  assert.equal("passphraseHash" in servers[0], false);

  const snapshot = await serverManager.getServerSnapshot("DemoServer", owner, true);
  assert.equal(snapshot.server.passphraseConfigured, true);
  assert.equal(snapshot.server.loader, "fabric");
  assert.equal("passphraseHash" in snapshot.server, false);
  assert.match(snapshot.propertiesText, /motd=Demo/);
});

test("world manager can archive the active world into the server library", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const worldManager = createWorldManager(serverManager);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", {
    passphrase: "moon-lane"
  });

  const result = await worldManager.captureActiveWorld("DemoServer", "demo-backup");
  assert.match(result.archiveName, /demo-backup\.zip$/);

  const worlds = await worldManager.listWorlds("DemoServer");
  assert.equal(worlds.length, 2);
  assert.equal(worlds[0].active, true);
  assert.equal(worlds[0].name, "world");
  assert.match(worlds[1].name, /demo-backup\.zip$/);
  assert.equal(worlds[1].kind, "archive");
});

test("admin snapshots stay locked until the server passphrase is unlocked and only expose safe settings", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  const admin = await store.createUser({
    username: "lane-admin",
    displayName: "Lane Admin",
    passwordHash: await hashSecret("lane-pass"),
    permissions: {
      createWorldServers: ["DemoServer"]
    },
    role: "admin",
    servers: ["DemoServer"]
  });

  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", {
    description: "Owner managed demo server",
    loader: "fabric",
    minecraftVersion: "1.21.11",
    passphrase: "moon-lane",
    startCommand: "./launch-server.sh"
  });

  const lockedSnapshot = await serverManager.getServerSnapshot("DemoServer", admin, false);
  assert.equal(lockedSnapshot.server.permissions.requiresUnlock, true);
  assert.equal(lockedSnapshot.logs, null);
  assert.equal(lockedSnapshot.propertiesText, null);
  assert.equal(lockedSnapshot.safeProperties, null);

  await serverManager.writeSafeAdminProperties("DemoServer", {
    "allow-flight": "true",
    difficulty: "hard",
    "max-players": "12",
    motd: "Admin Safe"
  });

  const unlockedSnapshot = await serverManager.getServerSnapshot("DemoServer", admin, true);
  assert.equal(unlockedSnapshot.server.permissions.requiresUnlock, false);
  assert.equal(unlockedSnapshot.server.permissions.canCreateWorlds, true);
  assert.equal(unlockedSnapshot.settingsMode, "admin-safe");
  assert.equal(unlockedSnapshot.safeProperties["allow-flight"], "true");
  assert.equal(unlockedSnapshot.safeProperties["max-players"], "12");
  assert.equal(unlockedSnapshot.propertiesText, null);
});

test("server admins can manage add-on loader settings and remove add-ons after unlock", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  const admin = await store.createUser({
    username: "lane-admin",
    displayName: "Lane Admin",
    passwordHash: await hashSecret("lane-pass"),
    role: "admin",
    servers: ["DemoServer"]
  });

  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", {
    loader: "vanilla",
    minecraftVersion: "1.21.11",
    passphrase: "moon-lane"
  });

  const lockedSnapshot = await serverManager.getServerSnapshot("DemoServer", admin, false);
  assert.equal(lockedSnapshot.server.permissions.canManageAddonSettings, false);

  const unlockedSnapshot = await serverManager.getServerSnapshot("DemoServer", admin, true);
  assert.equal(unlockedSnapshot.server.permissions.canManageAddonSettings, true);
  assert.equal(unlockedSnapshot.server.permissions.canUseManualAddons, true);

  await serverManager.setServerMetadata("DemoServer", {
    loader: "fabric"
  });
  await serverManager.installManagedFile("DemoServer", "example-mod.jar", Buffer.from("mod"));
  await serverManager.recordAddonInstalls("DemoServer", [
    {
      fileName: "example-mod.jar",
      provider: "upload",
      sourceId: "example-mod.jar"
    }
  ]);

  // Installed files now carry the tracked manifest's display metadata, so the
  // add-on list can show artwork and a client/server side without a lookup.
  const listed = await serverManager.listInstalledFiles("DemoServer");
  assert.deepEqual(listed.map((entry) => ({ enabled: entry.enabled, fileName: entry.fileName })), [
    { enabled: true, fileName: "example-mod.jar" }
  ]);
  assert.equal(listed[0].tracked, true);
  assert.equal(listed[0].provider, "upload");
  // An uploaded jar has no project behind it, so its side stays honestly unknown.
  assert.equal(listed[0].clientSide, "unknown");
  assert.equal(listed[0].serverSide, "unknown");

  const afterDisable = await serverManager.setAddonEnabled("DemoServer", "example-mod.jar", false);
  assert.deepEqual(afterDisable.map((entry) => ({ enabled: entry.enabled, fileName: entry.fileName })), [
    { enabled: false, fileName: "example-mod.jar" }
  ]);
  const afterEnable = await serverManager.setAddonEnabled("DemoServer", "example-mod.jar", true);
  assert.deepEqual(afterEnable.map((entry) => ({ enabled: entry.enabled, fileName: entry.fileName })), [
    { enabled: true, fileName: "example-mod.jar" }
  ]);
  assert.deepEqual(await serverManager.removeAddonFiles("DemoServer", ["example-mod.jar"]), ["example-mod.jar"]);
  assert.deepEqual(await serverManager.listInstalledFiles("DemoServer"), []);
  assert.deepEqual(await serverManager.readAddonManifest("DemoServer"), []);
});

test("compatibility profiles distinguish modded, plugin, and unsupported servers", async () => {
  const modManager = createModManager({
    getServer: async () => null
  });

  assert.deepEqual(modManager.getCompatibilityProfile({ loader: "fabric", minecraftVersion: "1.21.11" }), {
    gameVersion: "1.21.11",
    installKind: "mod",
    loader: "fabric",
    projectType: "mod",
    queryLoaders: ["fabric"],
    supportsCurseforge: true,
    supportsManagedInstalls: true
  });

  assert.deepEqual(modManager.getCompatibilityProfile({ loader: "paper", minecraftVersion: "1.21.11" }), {
    gameVersion: "1.21.11",
    installKind: "plugin",
    loader: "paper",
    projectType: "plugin",
    queryLoaders: ["paper", "spigot", "bukkit"],
    supportsCurseforge: false,
    supportsManagedInstalls: true
  });

  assert.deepEqual(modManager.getCompatibilityProfile({ loader: "vanilla", minecraftVersion: "1.21.11" }), {
    gameVersion: "1.21.11",
    installKind: "unsupported",
    loader: "vanilla",
    projectType: null,
    queryLoaders: [],
    supportsCurseforge: false,
    supportsManagedInstalls: false
  });

  // Purpur and Folia are Paper forks: the plugins they run are tagged for
  // paper/spigot/bukkit, never for the fork itself.
  assert.deepEqual(
    modManager.getCompatibilityProfile({ loader: "purpur", minecraftVersion: "1.21.4" }).queryLoaders,
    ["purpur", "paper", "spigot", "bukkit"]
  );
  assert.deepEqual(
    modManager.getCompatibilityProfile({ loader: "folia", minecraftVersion: "1.21.4" }).queryLoaders,
    ["folia", "paper", "spigot", "bukkit"]
  );
});

test("a purpur server installs a paper-tagged modrinth plugin", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const seenLoaderQueries = [];
  global.fetch = async (url) => {
    const href = String(url);
    if (href.includes("/project/luckperms/version")) {
      const loaders = JSON.parse(new URL(href).searchParams.get("loaders"));
      seenLoaderQueries.push(loaders);
      // Mirrors the live API: a plugin release carries the paper/spigot/bukkit
      // tags only, so asking for purpur alone comes back empty.
      if (!loaders.includes("paper")) {
        return {
          ok: true,
          async json() {
            return [];
          }
        };
      }
      return {
        ok: true,
        async json() {
          return [
            {
              date_published: "2026-02-01T00:00:00Z",
              dependencies: [],
              files: [{ filename: "LuckPerms-Bukkit-5.4.jar", primary: true, url: "https://cdn.modrinth.com/luckperms.jar" }],
              game_versions: ["1.21.4"],
              loaders: ["bukkit", "paper", "spigot"],
              version_type: "release"
            }
          ];
        }
      };
    }
    throw new Error(`Unexpected fetch call: ${href}`);
  };

  const modManager = createModManager({
    downloadAndInstallFile: async (serverId, url, fileName) => ({ fileName }),
    getServer: async () => ({ id: "PurpurServer", loader: "purpur", minecraftVersion: "1.21.4" }),
    recordAddonInstalls: async (serverId, entries) => entries
  });

  const installed = await modManager.install("PurpurServer", {
    projectId: "luckperms",
    provider: "modrinth"
  });

  assert.deepEqual(seenLoaderQueries, [["purpur", "paper", "spigot", "bukkit"]]);
  assert.deepEqual(installed, [
    {
      fileName: "LuckPerms-Bukkit-5.4.jar",
      provider: "modrinth",
      sourceId: "luckperms"
    }
  ]);
});

test("curseforge availability only needs an api key and defaults to the minecraft game id", async (t) => {
  const previousKey = process.env.CURSEFORGE_API_KEY;
  const previousGameId = process.env.CURSEFORGE_GAME_ID;
  t.after(() => {
    process.env.CURSEFORGE_API_KEY = previousKey;
    process.env.CURSEFORGE_GAME_ID = previousGameId;
    if (previousKey === undefined) {
      delete process.env.CURSEFORGE_API_KEY;
    }
    if (previousGameId === undefined) {
      delete process.env.CURSEFORGE_GAME_ID;
    }
  });

  let stored = {};
  const modManager = createModManager(
    { getServer: async () => null },
    { readIntegrations: async () => stored }
  );

  delete process.env.CURSEFORGE_API_KEY;
  delete process.env.CURSEFORGE_GAME_ID;
  assert.equal((await modManager.providerAvailability()).curseforge, false);

  // An owner-saved key is enough on its own.
  stored = { curseforgeApiKey: "stored-key" };
  const fromStore = await modManager.providerAvailability();
  assert.equal(fromStore.curseforge, true);
  assert.equal(fromStore.curseforgeSource, "stored");

  // The environment always outranks whatever the owner saved.
  process.env.CURSEFORGE_API_KEY = "env-key";
  const fromEnv = await modManager.providerAvailability();
  assert.equal(fromEnv.curseforge, true);
  assert.equal(fromEnv.curseforgeSource, "environment");
});

test("integration keys are stored, hardened on disk, and cleared by a blank value", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippermoonstash-integrations-"));
  const store = createStore(root);
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  assert.deepEqual(await store.getIntegrations(), {});

  await store.saveIntegrations({ curseforgeApiKey: "  spaced-key  " });
  assert.equal((await store.getIntegrations()).curseforgeApiKey, "spaced-key");

  // app.json holds the cookie secret and now an API key; it must not be world readable.
  const mode = (await fsp.stat(path.join(root, "data", "app.json"))).mode & 0o777;
  assert.equal(mode, 0o600);

  await store.saveIntegrations({ curseforgeApiKey: "" });
  assert.equal(Object.prototype.hasOwnProperty.call(await store.getIntegrations(), "curseforgeApiKey"), false);

  // Unrelated config must survive an integration write.
  assert.ok((await store.getAppConfig()).cookieSecret);
});

test("a per-server java binary is validated and reaches the launched process", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  const owner = await store.createUser({
    username: "owner",
    passwordHash: await hashSecret("moon-pass"),
    role: "owner",
    servers: []
  });
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", { passphrase: "demo-pass" });
  await fsp.writeFile(path.join(root, "servers", "DemoServer", "eula.txt"), "eula=true\n", "utf8");

  // A relative path is rejected outright.
  await assert.rejects(
    () => serverManager.setServerMetadata("DemoServer", { javaBin: "java" }),
    /absolute path/
  );

  // A path that is not executable is rejected.
  const notExecutable = path.join(root, "not-java");
  await fsp.writeFile(notExecutable, "", { mode: 0o644 });
  await assert.rejects(
    () => serverManager.setServerMetadata("DemoServer", { javaBin: notExecutable }),
    /not found or not executable/
  );

  // A real executable is accepted and handed to the launch script via the
  // environment variable the script already prefers.
  const fakeJava = path.join(root, "fake-java");
  await fsp.writeFile(fakeJava, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  const saved = await serverManager.setServerMetadata("DemoServer", { javaBin: fakeJava });
  assert.equal(saved.javaBin, fakeJava);

  const probe = path.join(root, "servers", "DemoServer", "launch-server.sh");
  const capture = path.join(root, "captured-env.txt");
  await fsp.writeFile(
    probe,
    // Captures both names: the launch scripts this dashboard generates read the
    // new one, but scripts written before the rename read the old one and must
    // keep receiving the per-server JDK.
    `#!/usr/bin/env bash\nprintf '%s|%s' "\${RIPPERCRAFT_JAVA_BIN:-unset}" "\${RIPPERMOONSTASH_JAVA_BIN:-unset}" > ${capture}\nsleep 5\n`
  );
  // writeFile only honours mode when it creates the file, and the fixture
  // already made this one.
  await fsp.chmod(probe, 0o755);

  await serverManager.startServer("DemoServer", owner);
  t.after(async () => {
    await serverManager.stopServer("DemoServer").catch(() => {});
  });

  const expectedCapture = `${fakeJava}|${fakeJava}`;
  let captured = "";
  for (let attempt = 0; attempt < 40 && captured !== expectedCapture; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    captured = await fsp.readFile(capture, "utf8").catch(() => "");
  }
  assert.equal(captured, expectedCapture);

  // Clearing it puts the server back on the dashboard-wide default.
  await serverManager.stopServer("DemoServer");
  const cleared = await serverManager.setServerMetadata("DemoServer", { javaBin: "" });
  assert.equal(cleared.javaBin, "");
});

test("addon update check reports per-mod status and swaps only outdated jars", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const modManager = createModManager(serverManager);
  const previousFetch = globalThis.fetch;

  t.after(async () => {
    globalThis.fetch = previousFetch;
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", { loader: "fabric", minecraftVersion: "1.21.11" });

  // One outdated, one current, one hand-installed, one untracked on disk.
  await serverManager.installManagedFile("DemoServer", "old-mod-1.0.0.jar", Buffer.from("old"));
  await serverManager.installManagedFile("DemoServer", "fresh-mod-2.0.0.jar", Buffer.from("fresh"));
  await serverManager.installManagedFile("DemoServer", "hand-made.jar", Buffer.from("manual"));
  await serverManager.installManagedFile("DemoServer", "mystery.jar", Buffer.from("mystery"));
  await serverManager.writeAddonManifest("DemoServer", [
    { fileName: "old-mod-1.0.0.jar", provider: "modrinth", sourceId: "OLD" },
    { fileName: "fresh-mod-2.0.0.jar", provider: "modrinth", sourceId: "FRESH" },
    { fileName: "hand-made.jar", manual: true, provider: "upload", sourceId: "hand-made.jar" }
  ]);

  const versionPayload = (projectId) =>
    JSON.stringify([
      {
        date_published: "2026-01-01T00:00:00Z",
        dependencies: [],
        files: [
          {
            filename: projectId === "OLD" ? "old-mod-1.1.0.jar" : "fresh-mod-2.0.0.jar",
            primary: true,
            url: `https://example.invalid/${projectId}.jar`
          }
        ],
        version_number: projectId === "OLD" ? "1.1.0" : "2.0.0",
        version_type: "release"
      }
    ]);

  globalThis.fetch = async (url) => {
    const href = String(url);
    const match = href.match(/\/project\/([A-Z]+)\/version/);
    if (match) {
      return new Response(versionPayload(match[1]), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }
    if (href.endsWith("/OLD.jar")) {
      return new Response(Buffer.from("new bytes"), { status: 200 });
    }
    throw new Error(`Unexpected request: ${href}`);
  };

  const plan = await modManager.planAddonUpdates("DemoServer");
  const statusOf = (name) => plan.entries.find((entry) => entry.fileName === name).status;
  assert.equal(statusOf("old-mod-1.0.0.jar"), "update-available");
  assert.equal(statusOf("fresh-mod-2.0.0.jar"), "up-to-date");
  assert.equal(statusOf("hand-made.jar"), "unsupported");
  assert.equal(statusOf("mystery.jar"), "untracked");
  assert.equal(plan.updatable, 1);
  assert.equal(plan.gameVersion, "1.21.11");

  // A hand-installed add-on must refuse rather than silently do nothing.
  await assert.rejects(() => modManager.applyAddonUpdate("DemoServer", "hand-made.jar"), /installed by hand/);
  await assert.rejects(() => modManager.applyAddonUpdate("DemoServer", "mystery.jar"), /No tracked add-on/);

  // Updating the current one is a no-op, not a redundant download.
  const unchanged = await modManager.applyAddonUpdate("DemoServer", "fresh-mod-2.0.0.jar");
  assert.equal(unchanged.changed, false);

  const updated = await modManager.applyAddonUpdate("DemoServer", "old-mod-1.0.0.jar");
  assert.equal(updated.changed, true);
  assert.equal(updated.fileName, "old-mod-1.1.0.jar");

  const files = (await serverManager.listInstalledFiles("DemoServer")).map((entry) => entry.fileName);
  assert.equal(files.includes("old-mod-1.1.0.jar"), true);
  assert.equal(files.includes("old-mod-1.0.0.jar"), false, "the superseded jar must be removed");

  // The manifest must follow the rename, keeping the add-on tracked.
  const manifest = await serverManager.readAddonManifest("DemoServer");
  const tracked = manifest.find((entry) => entry.sourceId === "OLD");
  assert.equal(tracked.fileName, "old-mod-1.1.0.jar");
  assert.equal(manifest.some((entry) => entry.fileName === "old-mod-1.0.0.jar"), false);
});

test("world archives can be deleted without touching the active world", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const worldManager = createWorldManager(serverManager);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();

  const capturedA = await worldManager.captureActiveWorld("DemoServer", "keep-me");
  const capturedB = await worldManager.captureActiveWorld("DemoServer", "delete-me");

  const before = await worldManager.listWorlds("DemoServer");
  assert.equal(before.filter((world) => world.kind === "archive").length, 2);

  const result = await worldManager.deleteWorldArchive("DemoServer", capturedB.archiveName);
  assert.equal(result.deleted, capturedB.archiveName);

  const after = result.worlds;
  const archiveNames = after.filter((world) => world.kind === "archive").map((world) => world.name);
  assert.deepEqual(archiveNames, [capturedA.archiveName]);

  // The live world must survive an archive deletion.
  const active = after.find((world) => world.active);
  assert.ok(active);
  await fsp.access(path.join(root, "servers", "DemoServer", "world", "level.dat"));

  // Deleting the same archive twice is an error, not a silent no-op.
  await assert.rejects(
    () => worldManager.deleteWorldArchive("DemoServer", capturedB.archiveName),
    /No archived world named/
  );

  // The active world is not an archive and must not be deletable this way.
  await assert.rejects(() => worldManager.deleteWorldArchive("DemoServer", "world"), /No archived world named/);

  // Path traversal must not escape the world library.
  await assert.rejects(
    () => worldManager.deleteWorldArchive("DemoServer", "../../../../etc/passwd"),
    /No archived world named|Invalid archive path/
  );
  await assert.rejects(() => worldManager.deleteWorldArchive("DemoServer", ""), /archive name is required/);

  // The traversal attempt must not have removed the surviving archive.
  const final = await worldManager.listWorlds("DemoServer");
  assert.equal(final.filter((world) => world.kind === "archive").length, 1);
});

test("operator uuids follow the server's online-mode and mismatches are repairable", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const previousFetch = globalThis.fetch;
  const MOJANG = "9c47ffc4-16a9-4fb5-9618-d6a48db8d79e";

  t.after(async () => {
    globalThis.fetch = previousFetch;
    await fsp.rm(root, { recursive: true, force: true });
  });

  globalThis.fetch = async (url) => {
    if (String(url).includes("api.mojang.com")) {
      return new Response(JSON.stringify({ id: MOJANG.replace(/-/g, ""), name: "RipperMoon" }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  };

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  const propertiesPath = path.join(root, "servers", "DemoServer", "server.properties");

  // Offline-mode server: the name-based uuid is the correct one.
  await fsp.writeFile(propertiesPath, "online-mode=false\n", "utf8");
  let ops = await serverManager.addServerOperator("DemoServer", { level: 4, name: "RipperMoon" });
  assert.equal(ops[0].uuid[14], "3", "offline servers need a version 3 uuid");
  let listed = await serverManager.listServerOperators("DemoServer");
  assert.equal(listed[0].uuidKind, "offline");
  assert.equal(listed[0].uuidMatchesServerMode, true);

  // Flipping to online-mode makes that same entry inert - Minecraft will never
  // match it against a real player, and says nothing about it.
  await fsp.writeFile(propertiesPath, "online-mode=true\n", "utf8");
  listed = await serverManager.listServerOperators("DemoServer");
  assert.equal(listed[0].uuidMatchesServerMode, false);
  assert.equal(listed[0].uuidKind, "offline");

  // Repair rewrites it to the real Mojang uuid.
  const repair = await serverManager.repairServerOperators("DemoServer");
  assert.equal(repair.failures.length, 0);
  assert.equal(repair.operators[0].uuid, MOJANG);
  assert.equal(repair.operators[0].uuidMatchesServerMode, true);

  // Adding on an online-mode server resolves from Mojang, and a caller-supplied
  // uuid must not be able to reintroduce the broken form.
  await serverManager.writeServerOperators("DemoServer", []);
  ops = await serverManager.addServerOperator("DemoServer", {
    level: 4,
    name: "RipperMoon",
    uuid: "c81d3d67-a6c9-387e-90a4-a9dd4f476f2c"
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].uuid, MOJANG);

  // A name that does not exist must fail loudly rather than store a bad entry.
  globalThis.fetch = async () => new Response("", { status: 404 });
  await assert.rejects(
    () => serverManager.addServerOperator("DemoServer", { level: 4, name: "NoSuchPlayer" }),
    /No Minecraft account named/
  );
});

test("adding an operator requires an explicit op level", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  await fsp.writeFile(path.join(root, "servers", "DemoServer", "server.properties"), "online-mode=false\n", "utf8");

  // Level 4 grants /stop, /ban and /op. Omitting the field used to hand that
  // out silently, so a request that does not name a level is refused.
  for (const level of [undefined, "", 0, 5, "owner"]) {
    await assert.rejects(
      () => serverManager.addServerOperator("DemoServer", { level, name: "RipperMoon" }),
      /op level between 1 and 4/,
      `level ${JSON.stringify(level)} should be refused`
    );
  }

  const operators = await serverManager.addServerOperator("DemoServer", { level: 1, name: "RipperMoon" });
  assert.equal(operators[0].level, 1);

  // Entries already written to ops.json keep whatever powers they had, so an
  // existing operator is never silently demoted by the stricter add path.
  await serverManager.writeServerOperators("DemoServer", [{ name: "Legacy", uuid: "c81d3d67-a6c9-387e-90a4-a9dd4f476f2c" }]);
  const listed = await serverManager.listServerOperators("DemoServer");
  assert.equal(listed.find((entry) => entry.name === "Legacy").level, 4);
});

test("job registry tracks progress, completion and failure", async () => {
  const jobs = createJobRegistry();

  const job = jobs.create("create-server", { label: "starting", totalSteps: 4 });
  assert.equal(jobs.get(job.id).status, "running");
  assert.equal(jobs.get(job.id).progress, 0);

  jobs.progress(job.id, "creating server folders");
  jobs.progress(job.id, "resolving forge build");
  const midway = jobs.get(job.id);
  assert.equal(midway.step, "resolving forge build");
  assert.equal(midway.stepIndex, 2);
  assert.equal(midway.progress, 0.5);

  // Progress must never exceed the declared total, even if more steps report.
  jobs.progress(job.id, "a");
  jobs.progress(job.id, "b");
  jobs.progress(job.id, "c");
  assert.equal(jobs.get(job.id).progress, 1);

  jobs.succeed(job.id, { server: { id: "demo" } });
  const done = jobs.get(job.id);
  assert.equal(done.status, "succeeded");
  assert.equal(done.result.server.id, "demo");

  // A finished job ignores further progress reports.
  jobs.progress(job.id, "late");
  assert.equal(jobs.get(job.id).step, "done");

  const failing = jobs.create("create-server", { totalSteps: 2 });
  jobs.fail(failing.id, new Error("installer exploded"));
  assert.equal(jobs.get(failing.id).status, "failed");
  assert.equal(jobs.get(failing.id).error, "installer exploded");

  assert.equal(jobs.get("job_missing"), null);
});

test("java runtime discovery collapses symlinked duplicates and reports versions", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const runtimes = await serverManager.listJavaRuntimes({ refresh: true });

  // The suite needs a JDK to run Forge installers anyway; if the host has none
  // there is nothing meaningful to assert.
  if (!runtimes.length) {
    t.skip("no java installations detected on this host");
    return;
  }

  const paths = runtimes.map((runtime) => runtime.path);
  assert.equal(new Set(paths).size, paths.length, "paths must be unique");

  // Distributions ship both java-17-... and java-1.17.0-... pointing at one
  // JDK. Resolving each entry must not surface the same binary twice.
  const realPaths = await Promise.all(paths.map((javaPath) => fsp.realpath(javaPath)));
  assert.equal(new Set(realPaths).size, realPaths.length, "symlinked duplicates must be collapsed");

  for (const runtime of runtimes) {
    assert.match(runtime.version, /^\d/);
    assert.equal(typeof runtime.major, "number");
    assert.match(runtime.label, /^Java \d+ \(/);
    assert.equal(path.isAbsolute(runtime.path), true);
  }

  // Sorted ascending by major version so the dropdown reads predictably.
  const majors = runtimes.map((runtime) => runtime.major);
  assert.deepEqual(majors, [...majors].sort((left, right) => left - right));
});

test("curseforge search flags mods whose author disabled third-party downloads", async (t) => {
  const modManager = createModManager({ getServer: async () => null });
  const previousKey = process.env.CURSEFORGE_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.CURSEFORGE_API_KEY = "test-key";

  t.after(() => {
    globalThis.fetch = previousFetch;
    process.env.CURSEFORGE_API_KEY = previousKey;
    if (previousKey === undefined) {
      delete process.env.CURSEFORGE_API_KEY;
    }
  });

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        data: [
          {
            allowModDistribution: false,
            authors: [{ name: "Someone" }],
            id: 448233,
            links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/entityculling" },
            name: "Entity Culling",
            summary: "skips rendering hidden entities"
          },
          {
            allowModDistribution: true,
            authors: [{ name: "Someone Else" }],
            id: 12345,
            links: { websiteUrl: "javascript:alert(1)" },
            name: "Open Mod",
            summary: "installable"
          }
        ]
      }),
      { headers: { "content-type": "application/json" }, status: 200 }
    );

  const results = await modManager.search(
    { loader: "fabric", minecraftVersion: "1.21.11" },
    "curseforge",
    "culling"
  );

  assert.equal(results[0].manualDownloadOnly, true);
  assert.equal(results[0].pageUrl, "https://www.curseforge.com/minecraft/mc-mods/entityculling");
  assert.equal(results[1].manualDownloadOnly, false);
  // A non-http link must never reach the UI, where it would become an href.
  assert.equal(results[1].pageUrl, "");
});

test("curseforge installs hand off to a manual download when the author opts out", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const modManager = createModManager(serverManager);

  const previousKey = process.env.CURSEFORGE_API_KEY;
  const previousFetch = globalThis.fetch;
  process.env.CURSEFORGE_API_KEY = "test-key";

  t.after(async () => {
    globalThis.fetch = previousFetch;
    process.env.CURSEFORGE_API_KEY = previousKey;
    if (previousKey === undefined) {
      delete process.env.CURSEFORGE_API_KEY;
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", {
    loader: "fabric",
    minecraftVersion: "1.21.11"
  });

  const requested = [];
  globalThis.fetch = async (url) => {
    const href = String(url);
    requested.push(href);

    if (href.includes("/files/55501/download-url")) {
      return new Response(JSON.stringify({ data: null }), {
        headers: { "content-type": "application/json" },
        status: 200
      });
    }

    if (href.includes("/mods/9001/files")) {
      return new Response(
        JSON.stringify({
          data: [
            {
              dependencies: [{ modId: 4242, relationType: 3 }],
              downloadUrl: null,
              fileDate: "2026-01-01T00:00:00Z",
              fileName: "guarded-mod-1.0.0.jar",
              id: 55501,
              releaseType: 1
            }
          ]
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    }

    if (href.endsWith("/mods/9001")) {
      return new Response(
        JSON.stringify({
          data: {
            links: { websiteUrl: "https://www.curseforge.com/minecraft/mc-mods/guarded-mod" },
            name: "Guarded Mod"
          }
        }),
        { headers: { "content-type": "application/json" }, status: 200 }
      );
    }

    throw new Error(`Unexpected request in test: ${href}`);
  };

  await assert.rejects(
    () => modManager.install("DemoServer", { modId: "9001", provider: "curseforge" }),
    (error) => {
      assert.equal(error.code, "CURSEFORGE_MANUAL_DOWNLOAD_REQUIRED");
      assert.equal(error.statusCode, 409);
      assert.equal(error.manualDownload.fileName, "guarded-mod-1.0.0.jar");
      assert.equal(error.manualDownload.modName, "Guarded Mod");
      assert.equal(
        error.manualDownload.pageUrl,
        "https://www.curseforge.com/minecraft/mc-mods/guarded-mod/files/55501"
      );
      return true;
    }
  );

  // The opt-out must be detected before any dependency is written to disk.
  assert.equal(
    requested.some((href) => href.includes("/mods/4242")),
    false
  );
  assert.deepEqual(await serverManager.listInstalledFiles("DemoServer"), []);
});

test("world manager can prepare a new generated world and update generation properties", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const worldManager = createWorldManager(serverManager);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  await worldManager.createNewWorld("DemoServer", {
    generateStructures: false,
    levelType: "minecraft:flat",
    name: "Fresh Start",
    seed: "moon-seed"
  });

  const propertiesText = await serverManager.readServerProperties("DemoServer");
  assert.match(propertiesText, /level-seed=moon-seed/);
  assert.match(propertiesText, /level-type=minecraft:flat/);
  assert.match(propertiesText, /generate-structures=false/);
  assert.match(propertiesText, /level-name=world/);

  const worlds = await worldManager.listWorlds("DemoServer");
  assert.equal(worlds[0].active, true);
  assert.equal(worlds[0].name, "Fresh Start");
  assert.equal(worlds[0].pathName, "world");
});

test("server manager can list available Minecraft versions and delete a stopped server", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const originalFetch = global.fetch;

  t.after(async () => {
    global.fetch = originalFetch;
    await fsp.rm(root, { recursive: true, force: true });
  });

  global.fetch = async (url) => {
    if (String(url).includes("version_manifest_v2.json")) {
      return {
        ok: true,
        async json() {
          return {
            latest: {
              release: "1.21.11",
              snapshot: "26w16a"
            },
            versions: [
              {
                id: "1.21.11",
                releaseTime: "2026-04-20T12:00:00Z",
                type: "release"
              },
              {
                id: "26w16a",
                releaseTime: "2026-04-18T12:00:00Z",
                type: "snapshot"
              }
            ]
          };
        }
      };
    }
    throw new Error(`Unexpected fetch call: ${url}`);
  };

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();

  const catalog = await serverManager.listAvailableMinecraftVersions();
  assert.equal(catalog.latest.release, "1.21.11");
  assert.equal(catalog.versions.length, 2);
  assert.equal(catalog.versions[0].id, "1.21.11");

  const deleteResult = await serverManager.deleteServer("DemoServer");
  assert.equal(deleteResult.deleted, true);
  await assert.rejects(
    fsp.access(path.join(root, "servers", "DemoServer")),
    /ENOENT/
  );
  assert.equal(await serverManager.getServer("DemoServer"), null);
});

test("combined add-on update blocks manual and untracked files before contacting providers", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const modManager = createModManager(serverManager);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", {
    loader: "paper",
    minecraftVersion: "1.21.11"
  });

  await serverManager.installManagedFile("DemoServer", "rogue-plugin.jar", Buffer.from("rogue"));
  await serverManager.recordAddonInstalls("DemoServer", [
    {
      direct: true,
      fileName: "manual-plugin.jar",
      gameVersion: "1.21.11",
      installKind: "plugin",
      loader: "paper",
      managed: false,
      manual: true,
      provider: "upload",
      sourceId: "manual-plugin.jar"
    }
  ]);

  const plan = await modManager.planCombinedAddonUpdate("DemoServer", "1.21.11");
  assert.equal(plan.safe, false);
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.untrackedFiles.includes("rogue-plugin.jar"), true);
  assert.match(plan.blockedReasons[0], /Untracked add-on files are present/);
  assert.match(plan.blockedReasons[1], /Manual add-ons are present/);
});

test("managed server creation rejects loaders without a safe installer path", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();

  // Quilt has no provisioning path, and the rejection happens before any
  // network call so this stays offline.
  await assert.rejects(
    serverManager.createServer(
      {
        directoryName: "quilt-lab",
        loader: "quilt",
        minecraftVersion: "1.21.11",
        mode: "managed",
        name: "Quilt Lab"
      },
      { username: "owner" }
    ),
    (error) => {
      assert.match(error.message, /does not support the quilt loader/);
      // The message must name every loader that can be provisioned.
      for (const loader of ["vanilla", "paper", "purpur", "fabric", "forge", "neoforge"]) {
        assert.match(error.message, new RegExp(loader));
      }
      return true;
    }
  );
});

test("argfile loaders get a launch script that uses their installer argfile", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();

  const argFile = "libraries/net/minecraftforge/forge/1.20.1-47.4.10/unix_args.txt";
  await serverManager.setServerMetadata("DemoServer", {
    loader: "forge",
    managedRuntime: {
      kind: "forge",
      launch: { argFile, kind: "argfile" },
      loaderVersion: "47.4.10",
      source: "forge 47.4.10"
    },
    maxMemory: "10G",
    minMemory: "2G",
    minecraftVersion: "1.20.1"
  });

  await serverManager.ensureManagedServerArtifacts("DemoServer");
  const script = await fsp.readFile(
    path.join(root, "servers", "DemoServer", ".rippermoon", "launch-server.sh"),
    "utf8"
  );

  // Forge has no server.jar, so the script must not try to run one.
  assert.equal(script.includes("-jar server.jar"), false);
  assert.match(script, new RegExp(`@${argFile.replace(/[/.]/g, "\\$&")}`));
  assert.match(script, /user_jvm_args\.txt/);
  assert.match(script, /MIN_MEMORY="2G"/);
  assert.match(script, /MAX_MEMORY="10G"/);

  // A jar-based runtime keeps the original shape.
  await serverManager.setServerMetadata("DemoServer", {
    managedRuntime: { kind: "fabric", launch: { kind: "jar" }, source: "fabric" }
  });
  await serverManager.ensureManagedServerArtifacts("DemoServer");
  const jarScript = await fsp.readFile(
    path.join(root, "servers", "DemoServer", ".rippermoon", "launch-server.sh"),
    "utf8"
  );
  assert.match(jarScript, /-jar server\.jar nogui/);
});

test("managed server creation defaults the server id to the directory name", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);
  const originalFetch = global.fetch;

  t.after(async () => {
    global.fetch = originalFetch;
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  global.fetch = async (url) => {
    if (String(url).includes("version_manifest_v2.json")) {
      return {
        ok: true,
        async json() {
          return {
            latest: {
              release: "1.21.11"
            },
            versions: [
              {
                id: "1.21.11",
                releaseTime: "2026-04-20T12:00:00Z",
                type: "release",
                url: "https://example.test/version/1.21.11.json"
              }
            ]
          };
        }
      };
    }

    if (String(url) === "https://example.test/version/1.21.11.json") {
      return {
        ok: true,
        async json() {
          return {
            downloads: {
              server: {
                sha1: "d418e3579882392d4778792a888dcfec7f87fbdd",
                url: "https://example.test/downloads/server-1.21.11.jar"
              }
            }
          };
        }
      };
    }

    if (String(url) === "https://example.test/downloads/server-1.21.11.jar") {
      return {
        ok: true,
        async arrayBuffer() {
          return Uint8Array.from(Buffer.from("test-jar")).buffer;
        }
      };
    }

    throw new Error(`Unexpected fetch call: ${url}`);
  };

  const created = await serverManager.createServer(
    {
      directoryName: "moon-keep",
      loader: "vanilla",
      minecraftVersion: "1.21.11",
      mode: "managed",
      name: "Moon Keep"
    },
    { username: "owner" }
  );

  assert.equal(created.id, "moon-keep");
  assert.equal(created.directory, "servers/moon-keep");
  const launchScript = await fsp.readFile(path.join(root, "servers", "moon-keep", ".rippermoon", "launch-server.sh"), "utf8");
  assert.match(launchScript, /dirname "\$\{BASH_SOURCE\[0\]\}"\)\/\.\./);
  assert.match(launchScript, /RIPPERCRAFT_JAVA_BIN/);
  // The pre-rename variable stays supported for existing deployments.
  assert.match(launchScript, /RIPPERMOONSTASH_JAVA_BIN/);
  assert.match(launchScript, /command -v java/);
});

test("discovery collapses duplicate records that point at the same server folder", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await store.createUser({
    username: "lane-admin",
    displayName: "Lane Admin",
    passwordHash: await hashSecret("lane-pass"),
    permissions: {
      createWorldServers: ["DemoServer"]
    },
    role: "admin",
    servers: ["DemoServer"]
  });

  await store.updateServerRecord("DemoServer", {
    directory: "servers/DemoServer",
    id: "DemoServer",
    loader: "vanilla",
    minecraftVersion: "1.21.11",
    modsDir: "mods",
    name: "Demo Server",
    serverPropertiesFile: "server.properties",
    startCommand: "./launch-server.sh",
    worldDir: "world"
  });

  await store.updateServerRecord("Moon-Keep", {
    directory: "servers/DemoServer",
    id: "Moon-Keep",
    loader: "vanilla",
    minecraftVersion: "1.21.11",
    modsDir: "mods",
    name: "Moon Keep",
    serverPropertiesFile: "server.properties",
    startCommand: "./launch-server.sh",
    worldDir: "world"
  });

  const records = await serverManager.syncDiscoveredServers();
  assert.equal(Boolean(records["Moon-Keep"]), true);
  assert.equal(Boolean(records.DemoServer), false);

  const users = await store.getUsers();
  assert.equal(users[0].servers.includes("Moon-Keep"), true);
  assert.equal(users[0].permissions.createWorldServers.includes("Moon-Keep"), true);
  assert.equal(users[0].servers.includes("DemoServer"), false);
  assert.equal(users[0].permissions.createWorldServers.includes("DemoServer"), false);
});

test("admin password reset changes only the password hash", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await store.createUser({
    username: "owner",
    displayName: "Ripper Moon",
    passwordHash: await hashSecret("moon-pass"),
    role: "owner",
    servers: []
  });
  const admin = await store.createUser({
    username: "lane-admin",
    displayName: "Lane Admin",
    passwordHash: await hashSecret("forgotten-pass"),
    permissions: {
      createWorldServers: ["DemoServer"]
    },
    role: "admin",
    servers: ["DemoServer"]
  });

  await store.updateUser(admin.id, {
    passwordHash: await hashSecret("new-lane-pass")
  });

  const users = await store.getUsers();
  const updatedAdmin = users.find((user) => user.id === admin.id);
  assert.equal(updatedAdmin.role, "admin");
  assert.deepEqual(updatedAdmin.servers, ["DemoServer"]);
  assert.deepEqual(updatedAdmin.permissions.createWorldServers, ["DemoServer"]);
  assert.equal(await verifySecret("forgotten-pass", updatedAdmin.passwordHash), false);
  assert.equal(await verifySecret("new-lane-pass", updatedAdmin.passwordHash), true);
});

test("sync normalizes machine-specific server paths back to the workspace root", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await store.updateServerRecord("DemoServer", {
    directory: "/Users/legacy-admin/Desktop/minecraft-server/servers/DemoServer",
    id: "DemoServer",
    loader: "vanilla",
    logFile: "/Users/legacy-admin/Desktop/minecraft-server/servers/DemoServer/logs/latest.log",
    minecraftVersion: "1.21.11",
    modsDir: "/Users/legacy-admin/Desktop/minecraft-server/servers/DemoServer/mods",
    name: "Demo Server",
    serverPropertiesFile: "/Users/legacy-admin/Desktop/minecraft-server/servers/DemoServer/server.properties",
    startCommand: "/Users/legacy-admin/Desktop/minecraft-server/servers/DemoServer/launch-server.sh",
    worldDir: "/Users/legacy-admin/Desktop/minecraft-server/servers/DemoServer/world"
  });

  const records = await serverManager.syncDiscoveredServers();
  assert.equal(records.DemoServer.directory, "servers/DemoServer");
  assert.equal(records.DemoServer.logFile, "logs/latest.log");
  assert.equal(records.DemoServer.modsDir, "mods");
  assert.equal(records.DemoServer.serverPropertiesFile, "server.properties");
  assert.equal(records.DemoServer.startCommand, "./launch-server.sh");
  assert.equal(records.DemoServer.worldDir, "world");
});

test("sync migrates legacy managed launch commands to the internal launcher", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await store.updateServerRecord("DemoServer", {
    directory: "/Users/legacy-admin/Desktop/minecraft-server/servers/DemoServer",
    id: "DemoServer",
    loader: "vanilla",
    managedRuntime: {
      kind: "vanilla",
      source: "mojang",
      updatedAt: new Date().toISOString()
    },
    minecraftVersion: "1.21.11",
    name: "Demo Server",
    startCommand: "/Users/legacy-admin/Desktop/minecraft-server/servers/DemoServer/launch-server.sh"
  });

  const records = await serverManager.syncDiscoveredServers();
  assert.equal(records.DemoServer.directory, "servers/DemoServer");
  assert.equal(records.DemoServer.startCommand, "./.rippermoon/launch-server.sh");
});

test("startServer reports missing launch commands without crashing or marking the server as running", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  await serverManager.writeEulaStatus("DemoServer", true);
  await serverManager.setServerMetadata("DemoServer", {
    passphrase: "moon-lane",
    startCommand: "./missing-launcher.sh"
  });

  await assert.rejects(
    serverManager.startServer("DemoServer", { username: "owner" }),
    /launch command was not found/i
  );

  const status = await serverManager.getServerStatus("DemoServer");
  assert.equal(status.running, false);

  const runtimeLog = await fsp.readFile(path.join(root, "servers", "DemoServer", ".rippermoon", "runtime.log"), "utf8");
  assert.match(runtimeLog, /Start failed:/);
  assert.match(runtimeLog, /missing-launcher\.sh/);
});

test("startServer blocks until the server eula is accepted", async (t) => {
  const root = await createFixtureRoot();
  const store = createStore(root);
  const serverManager = createServerManager(store);

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await store.ensureInitialized();
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", {
    passphrase: "moon-lane",
    startCommand: "./launch-server.sh"
  });

  assert.equal(await serverManager.readEulaStatus("DemoServer"), false);

  await assert.rejects(
    serverManager.startServer("DemoServer", { username: "owner" }),
    /EULA has not been accepted yet/i
  );

  assert.equal(await serverManager.writeEulaStatus("DemoServer", true), true);
  assert.equal(await serverManager.readEulaStatus("DemoServer"), true);
});

// ---------------------------------------------------------------------------
// Loader version updates
// ---------------------------------------------------------------------------

// A stored-method zip, which is all a mod jar is. Kept local so this file stays
// runnable on its own.
function makeStoredJar(entries) {
  const zlib = require("node:zlib");
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const dataBuffer = Buffer.from(contents, "utf8");
    const crc = zlib.crc32(dataBuffer);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(dataBuffer.length, 18);
    header.writeUInt32LE(dataBuffer.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(dataBuffer.length, 20);
    central.writeUInt32LE(dataBuffer.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);

    localChunks.push(header, nameBuffer, dataBuffer);
    centralChunks.push(central, nameBuffer);
    offset += header.length + nameBuffer.length + dataBuffer.length;
  }

  const centralBuffer = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, centralBuffer, eocd]);
}

function fabricModJar(id, name, loaderRange) {
  return makeStoredJar({
    "fabric.mod.json": JSON.stringify({ depends: { fabricloader: loaderRange }, id, name, version: "1.0.0" })
  });
}

// Mirrors the shape of the live endpoints the loader picker depends on.
function stubFabricMeta({ gameVersion = "26.1.2", loaderVersions = [] } = {}) {
  return async (url) => {
    const href = String(url);
    if (href.includes("version_manifest_v2.json")) {
      return {
        ok: true,
        async json() {
          return { latest: { release: gameVersion }, versions: [{ id: gameVersion, releaseTime: "2026-01-01T00:00:00Z", type: "release" }] };
        }
      };
    }
    if (href.includes("/versions/installer")) {
      return { ok: true, async json() { return [{ stable: true, version: "1.1.2" }]; } };
    }
    if (href.includes(`/versions/loader/${gameVersion}/`)) {
      // The server launcher jar download.
      return { ok: true, async arrayBuffer() { return Buffer.from(`launcher for ${href}`); } };
    }
    if (href.includes(`/versions/loader/${gameVersion}`)) {
      return {
        ok: true,
        async json() {
          return loaderVersions.map((entry) => ({ loader: { stable: entry.stable !== false, version: entry.version } }));
        }
      };
    }
    throw new Error(`Unexpected fetch call: ${href}`);
  };
}

async function createFabricFixture(t, { loaderVersion = "0.19.2", mods = {} } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippermoonstash-loader-"));
  const serverDir = path.join(root, "servers", "FabricServer");
  await fsp.mkdir(path.join(serverDir, "mods"), { recursive: true });
  await fsp.mkdir(path.join(serverDir, "logs"), { recursive: true });
  await fsp.mkdir(path.join(serverDir, "world"), { recursive: true });
  await fsp.writeFile(path.join(serverDir, "server.jar"), "existing fabric launcher", "utf8");
  await fsp.writeFile(path.join(serverDir, "server.properties"), "motd=Fabric\n", "utf8");
  await fsp.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n", "utf8");
  for (const [fileName, buffer] of Object.entries(mods)) {
    await fsp.writeFile(path.join(serverDir, "mods", fileName), buffer);
  }

  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const store = createStore(root);
  await store.ensureInitialized();
  const serverManager = createServerManager(store);
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("FabricServer", {
    loader: "fabric",
    managedRuntime: {
      kind: "fabric",
      launch: { kind: "jar" },
      loaderVersion,
      source: `fabric ${loaderVersion}`,
      updatedAt: new Date().toISOString()
    },
    minecraftVersion: "26.1.2",
    startCommand: "./.rippermoon/launch-server.sh"
  });

  return { root, serverDir, serverManager, store };
}

test("the loader picker ranks builds by what the installed mods accept", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const { serverManager } = await createFabricFixture(t, {
    mods: {
      "worldedit-items.jar": fabricModJar("worldedit_items", "WorldEdit Items", ">=0.19.3"),
      "relaxed.jar": fabricModJar("relaxed", "Relaxed Mod", ">=0.16.0")
    }
  });

  globalThis.fetch = stubFabricMeta({
    loaderVersions: [
      { version: "0.19.4", stable: false },
      { version: "0.19.3" },
      { version: "0.19.2" },
      { version: "0.18.0" }
    ]
  });

  const options = await serverManager.getLoaderVersionOptions("FabricServer", "26.1.2");

  assert.equal(options.loaderVersioned, true);
  assert.equal(options.currentLoaderVersion, "0.19.2");
  assert.equal(options.modScan.floor.version, "0.19.3");
  assert.deepEqual(options.modScan.floor.requiredBy.map((mod) => mod.name), ["WorldEdit Items"]);

  const byVersion = Object.fromEntries(options.versions.map((entry) => [entry.version, entry]));
  assert.equal(byVersion["0.19.4"].satisfiesInstalledMods, true);
  assert.equal(byVersion["0.19.3"].satisfiesInstalledMods, true);
  assert.equal(byVersion["0.19.2"].satisfiesInstalledMods, false);
  assert.equal(byVersion["0.19.2"].current, true);
  // Only the strict mod rejects 0.18.0; the relaxed one still accepts it.
  assert.deepEqual(byVersion["0.18.0"].conflicts.map((conflict) => conflict.name), ["WorldEdit Items"]);

  // 0.19.4 is newer but unstable, so the stable build that clears the floor wins.
  assert.equal(options.recommendedLoaderVersion, "0.19.3");
});

test("a loader-only plan moves the loader and leaves the game version alone", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const { serverManager } = await createFabricFixture(t, {
    mods: { "worldedit-items.jar": fabricModJar("worldedit_items", "WorldEdit Items", ">=0.19.3") }
  });
  globalThis.fetch = stubFabricMeta({
    loaderVersions: [{ version: "0.19.3" }, { version: "0.19.2" }]
  });

  const plan = await serverManager.planServerRuntimeUpdate("FabricServer", "");

  assert.equal(plan.supported, true);
  assert.equal(plan.mode, "loader-only");
  assert.equal(plan.targetVersion, "26.1.2");
  assert.equal(plan.versionDirection, "unchanged");
  assert.equal(plan.loaderVersion, "0.19.3");
  assert.equal(plan.currentLoaderVersion, "0.19.2");
  assert.equal(plan.loaderDirection, "upgrade");
});

test("a loader build the installed mods reject is refused and names them", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const { serverManager } = await createFabricFixture(t, {
    loaderVersion: "0.19.3",
    mods: { "worldedit-items.jar": fabricModJar("worldedit_items", "WorldEdit Items", ">=0.19.3") }
  });
  globalThis.fetch = stubFabricMeta({
    loaderVersions: [{ version: "0.19.3" }, { version: "0.19.2" }]
  });

  const plan = await serverManager.planServerRuntimeUpdate("FabricServer", "", { loaderVersion: "0.19.2" });

  assert.equal(plan.supported, false);
  assert.equal(plan.loaderDirection, "downgrade");
  assert.match(plan.reason, /rejected by 1 installed mod/);
  assert.match(plan.reason, /WorldEdit Items needs/);
  assert.deepEqual(plan.loaderConflicts.map((conflict) => conflict.name), ["WorldEdit Items"]);
});

test("a downgrade the mods still accept is planned and applied", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const { serverDir, serverManager } = await createFabricFixture(t, {
    loaderVersion: "0.19.3",
    mods: { "relaxed.jar": fabricModJar("relaxed", "Relaxed Mod", ">=0.16.0") }
  });
  globalThis.fetch = stubFabricMeta({
    loaderVersions: [{ version: "0.19.3" }, { version: "0.19.2" }, { version: "0.18.0" }]
  });

  const plan = await serverManager.planServerRuntimeUpdate("FabricServer", "", { loaderVersion: "0.18.0" });
  assert.equal(plan.supported, true);
  assert.equal(plan.loaderDirection, "downgrade");
  assert.equal(plan.mode, "loader-only");

  const result = await serverManager.applyServerRuntimeUpdate("FabricServer", plan);
  assert.equal(result.loaderVersion, "0.18.0");
  assert.equal(result.previousLoaderVersion, "0.19.3");

  const server = await serverManager.getServer("FabricServer");
  assert.equal(server.managedRuntime.loaderVersion, "0.18.0");
  assert.equal(server.managedRuntime.previousLoaderVersion, "0.19.3");
  // The game version must not drift as a side effect of a loader change.
  assert.equal(server.minecraftVersion, "26.1.2");

  // The replaced runtime is kept, so a bad loader move can be undone by hand.
  const backups = await fsp.readdir(path.join(serverDir, ".rippermoon", "server-backups"));
  assert.equal(backups.some((name) => name.includes("loader-0.19.3")), true);
});

test("an existing server is adopted into a managed runtime with its script preserved", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippermoonstash-adopt-"));
  const serverDir = path.join(root, "servers", "LegacyFabric");
  await fsp.mkdir(path.join(serverDir, "mods"), { recursive: true });
  await fsp.mkdir(path.join(serverDir, "logs"), { recursive: true });
  await fsp.writeFile(
    path.join(serverDir, "launch-server.sh"),
    "#!/usr/bin/env bash\nexec java -Xmx8G -jar fabric-server-launch.jar nogui\n",
    "utf8"
  );
  await fsp.writeFile(
    path.join(serverDir, "mods", "worldedit-items.jar"),
    fabricModJar("worldedit_items", "WorldEdit Items", ">=0.19.3")
  );
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const store = createStore(root);
  await store.ensureInitialized();
  const serverManager = createServerManager(store);
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("LegacyFabric", {
    loader: "fabric",
    minecraftVersion: "26.1.2",
    startCommand: "./launch-server.sh"
  });

  globalThis.fetch = stubFabricMeta({
    loaderVersions: [{ version: "0.19.3" }, { version: "0.19.2" }]
  });

  // Before adoption the dashboard refuses to update a runtime it does not own.
  const support = await serverManager.getServerUpdateSupport("LegacyFabric");
  assert.equal(support.supported, false);
  assert.equal(support.adoptable, true);

  const result = await serverManager.adoptManagedRuntime("LegacyFabric", { loaderVersion: "0.19.3" });
  assert.equal(result.adopted, true);
  assert.equal(result.loaderVersion, "0.19.3");

  const server = await serverManager.getServer("LegacyFabric");
  assert.equal(server.managedRuntime.kind, "fabric");
  assert.equal(server.managedRuntime.loaderVersion, "0.19.3");
  assert.equal(server.managedRuntime.adoptedFromStartCommand, "./launch-server.sh");
  assert.equal(server.startCommand, "./.rippermoon/launch-server.sh");

  // The hand-written script may carry flags worth recovering, so it is kept.
  const backups = await fsp.readdir(path.join(serverDir, ".rippermoon", "server-backups"));
  assert.equal(backups.some((name) => name.startsWith("launch-server.adopted-")), true);

  // And the runtime is now updatable.
  assert.equal((await serverManager.getServerUpdateSupport("LegacyFabric")).supported, true);
});

test("repairing a missing runtime reinstalls the pinned loader instead of drifting to the newest", async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const { serverDir, serverManager } = await createFabricFixture(t, {
    loaderVersion: "0.19.2",
    mods: { "relaxed.jar": fabricModJar("relaxed", "Relaxed Mod", ">=0.16.0") }
  });
  globalThis.fetch = stubFabricMeta({
    loaderVersions: [{ version: "0.19.3" }, { version: "0.19.2" }]
  });

  // The runtime jar has gone missing, which is what triggers a repair on start.
  await fsp.rm(path.join(serverDir, "server.jar"));

  const ensured = await serverManager.ensureManagedServerArtifacts("FabricServer", { repairRuntime: true });
  assert.equal(ensured.repairedRuntime, true);

  const server = await serverManager.getServer("FabricServer");
  // 0.19.3 exists and the mods would accept it, but the server was pinned to
  // 0.19.2 - a repair must not quietly become an upgrade.
  assert.equal(server.managedRuntime.loaderVersion, "0.19.2");
  assert.equal(server.minecraftVersion, "26.1.2");
});
