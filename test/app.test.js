const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { createStore } = require("../src/lib/store");
const { createSessionManager, hashSecret, verifySecret } = require("../src/lib/auth");
const { createServerManager } = require("../src/lib/servers");
const { createWorldManager } = require("../src/lib/worlds");
const { createModManager } = require("../src/lib/mod-sources");

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
  const hash = hashSecret("moon-pass");
  assert.equal(verifySecret("moon-pass", hash), true);
  assert.equal(verifySecret("wrong-pass", hash), false);
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
    passwordHash: hashSecret("moon-pass"),
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
    passwordHash: hashSecret("lane-pass"),
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
    passwordHash: hashSecret("lane-pass"),
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

  assert.deepEqual(await serverManager.listInstalledFiles("DemoServer"), ["example-mod.jar"]);
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
    supportsCurseforge: true,
    supportsManagedInstalls: true
  });

  assert.deepEqual(modManager.getCompatibilityProfile({ loader: "paper", minecraftVersion: "1.21.11" }), {
    gameVersion: "1.21.11",
    installKind: "plugin",
    loader: "paper",
    projectType: "plugin",
    supportsCurseforge: false,
    supportsManagedInstalls: true
  });

  assert.deepEqual(modManager.getCompatibilityProfile({ loader: "vanilla", minecraftVersion: "1.21.11" }), {
    gameVersion: "1.21.11",
    installKind: "unsupported",
    loader: "vanilla",
    projectType: null,
    supportsCurseforge: false,
    supportsManagedInstalls: false
  });
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

  await assert.rejects(
    serverManager.createServer(
      {
        directoryName: "fabric-lab",
        loader: "fabric",
        minecraftVersion: "1.21.11",
        mode: "managed",
        name: "Fabric Lab"
      },
      { username: "owner" }
    ),
    /Managed server creation currently supports vanilla, Paper, and Purpur only/
  );
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
    passwordHash: hashSecret("lane-pass"),
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
    passwordHash: hashSecret("moon-pass"),
    role: "owner",
    servers: []
  });
  const admin = await store.createUser({
    username: "lane-admin",
    displayName: "Lane Admin",
    passwordHash: hashSecret("forgotten-pass"),
    permissions: {
      createWorldServers: ["DemoServer"]
    },
    role: "admin",
    servers: ["DemoServer"]
  });

  await store.updateUser(admin.id, {
    passwordHash: hashSecret("new-lane-pass")
  });

  const users = await store.getUsers();
  const updatedAdmin = users.find((user) => user.id === admin.id);
  assert.equal(updatedAdmin.role, "admin");
  assert.deepEqual(updatedAdmin.servers, ["DemoServer"]);
  assert.deepEqual(updatedAdmin.permissions.createWorldServers, ["DemoServer"]);
  assert.equal(verifySecret("forgotten-pass", updatedAdmin.passwordHash), false);
  assert.equal(verifySecret("new-lane-pass", updatedAdmin.passwordHash), true);
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
