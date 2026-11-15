const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setHashCostForTests } = require("../src/lib/auth");
const { createServerManager } = require("../src/lib/servers");
const { createStore } = require("../src/lib/store");
const {
  KNOWN_LOADERS,
  isMinecraftVersion,
  normalizeLoader,
  normalizeMinecraftVersion,
  singleLine
} = require("../src/lib/validate");
const { createRoot, startApp } = require("../test-support/app");
const { startWithAdmin } = require("../test-support/lane");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const MARKUP = "<img src=x onerror=alert(1)>";

async function recordOf(app, serverId = "DemoServer") {
  return JSON.parse(await fsp.readFile(path.join(app.root, "data", "servers.json"), "utf8")).servers[serverId];
}

function saveAddonSettings(client, addonSettings) {
  return client("PUT", "/api/servers/DemoServer/settings", { json: { addonSettings } });
}

// --- the rules themselves ------------------------------------------------------

test("loaders are matched against the known list, whatever their case", () => {
  for (const loader of KNOWN_LOADERS) {
    assert.equal(normalizeLoader(loader), loader);
  }
  assert.equal(normalizeLoader(" Fabric "), "fabric");
  assert.equal(normalizeLoader("NEOFORGE"), "neoforge");

  for (const value of ["", "sponge", "fabric;rm", MARKUP, { __html: MARKUP }, ["fabric"], null, undefined, true, 7]) {
    assert.throws(() => normalizeLoader(value), { statusCode: 400 }, JSON.stringify(value));
  }
});

test("the loaders the settings page offers are all ones the server accepts", async () => {
  const { ALL_LOADERS } = await import("../public/js/state.js");
  for (const loader of ALL_LOADERS) {
    assert.ok(KNOWN_LOADERS.includes(loader), loader);
  }
});

test("Minecraft versions as Mojang publishes them are accepted, and nothing with markup or a path in it", () => {
  const published = [
    "1.20.1",
    "1.21",
    "26.1.2",
    "26.3",
    "26.4-snapshot-8",
    "26.3-rc-3",
    "26.1-pre-1",
    "24w14a",
    "23w13a_or_b",
    "1.21-pre1",
    "1.20.5-rc2",
    "1.16_combat-0",
    "1.18_experimental-snapshot-1",
    "1.14.2 Pre-Release 4",
    "3D Shareware v1.34",
    "22w13oneblockatatime",
    "1.RV-Pre1",
    "b1.7.3",
    "a1.2.6",
    "rd-132211",
    "latest",
    "unknown"
  ];
  for (const version of published) {
    assert.equal(isMinecraftVersion(version), true, version);
    assert.equal(normalizeMinecraftVersion(` ${version} `), version);
  }
  // Blank is how "nobody knows" is stored.
  assert.equal(normalizeMinecraftVersion(""), "");
  assert.equal(normalizeMinecraftVersion("   "), "");

  const refused = [
    MARKUP,
    '1.21.1"><script>',
    "1.21.1'",
    "../../etc/passwd",
    "1.21/../..",
    "1.21\\x",
    "1.21\n1.22",
    "1.21\tx",
    "1.21  1",
    "-1.21",
    ".1.21",
    "1.21;id",
    "$(id)",
    "`id`",
    "1.21&x=1",
    "1.21?x",
    "1.21#x",
    "1.21:x",
    "1".repeat(65)
  ];
  for (const version of refused) {
    assert.equal(isMinecraftVersion(version), false, JSON.stringify(version));
    assert.throws(() => normalizeMinecraftVersion(version), { statusCode: 400 }, JSON.stringify(version));
  }
  for (const value of [{ __html: MARKUP }, ["1.21"], null, undefined, true]) {
    assert.throws(() => normalizeMinecraftVersion(value), { statusCode: 400 }, JSON.stringify(value));
  }
});

test("a one-line field refuses what is not text, control characters, and anything too long", () => {
  assert.equal(singleLine("  Moon Lab  ", "The name"), "Moon Lab");
  assert.equal(singleLine(42, "The name"), "42");
  // Markup is not refused: it is text, and it is escaped wherever it is shown.
  assert.equal(singleLine(MARKUP, "The name"), MARKUP);

  for (const value of [{ __html: MARKUP }, ["x"], null, undefined, true, Number.NaN]) {
    assert.throws(() => singleLine(value, "The name"), { statusCode: 400 }, JSON.stringify(value));
  }
  // The two Unicode line separators, spelled out so no editor turns them into
  // real line breaks in this file.
  const lineSeparator = String.fromCharCode(0x2028);
  const paragraphSeparator = String.fromCharCode(0x2029);
  for (const value of [
    "a\nb",
    "a\rb",
    "a\tb",
    "a\u0000b",
    "a\u001bb",
    "a\u007fb",
    "a\u0085b",
    `a${lineSeparator}b`,
    `a${paragraphSeparator}b`
  ]) {
    assert.throws(() => singleLine(value, "The name"), { statusCode: 400 }, JSON.stringify(value));
  }
  assert.throws(() => singleLine("x".repeat(81), "The name", { maxLength: 80 }), { statusCode: 400 });
  assert.equal(singleLine("x".repeat(80), "The name", { maxLength: 80 }).length, 80);
  assert.throws(() => singleLine("   ", "The name", { required: true }), { statusCode: 400 });
  assert.equal(singleLine("   ", "The name"), "");
});

// --- the admin's add-on settings ----------------------------------------------

test("an admin cannot save an object, a list or markup as a server's loader", async (t) => {
  const { admin, app, owner } = await startWithAdmin(t);

  for (const loader of [{ __html: MARKUP }, [MARKUP], MARKUP, "sponge", true, 7, null, ""]) {
    const response = await saveAddonSettings(admin, { loader, minecraftVersion: "1.21.1" });
    assert.equal(response.status, 400, JSON.stringify(loader));
    assert.match(response.json.error, /loader must be one of/);
  }

  // Nothing of it was stored, and the owner is handed the text that was there.
  assert.equal((await recordOf(app)).loader, "fabric");
  const snapshot = (await owner("GET", "/api/servers/DemoServer")).json;
  assert.equal(snapshot.server.loader, "fabric");
  assert.equal((await owner("GET", "/api/servers")).json.servers[0].loader, "fabric");
  assert.doesNotMatch(JSON.stringify(snapshot), /onerror/);
});

test("an admin cannot save an object, markup or a path as a server's Minecraft version", async (t) => {
  const { admin, app, owner } = await startWithAdmin(t);

  for (const minecraftVersion of [{ __html: MARKUP }, [MARKUP], MARKUP, '1.21.1"><script>', "../../../tmp/x", true, null]) {
    const response = await saveAddonSettings(admin, { loader: "fabric", minecraftVersion });
    assert.equal(response.status, 400, JSON.stringify(minecraftVersion));
    assert.match(response.json.error, /Minecraft version/);
  }

  assert.equal((await recordOf(app)).minecraftVersion, "1.21.1");
  const snapshot = (await owner("GET", "/api/servers/DemoServer")).json;
  assert.equal(snapshot.server.minecraftVersion, "1.21.1");
  assert.equal(snapshot.addonCompatibility.gameVersion, "1.21.1");
});

test("an admin can still change the loader and version to real ones", async (t) => {
  const { admin, app } = await startWithAdmin(t);

  const saved = await saveAddonSettings(admin, { loader: " Paper ", minecraftVersion: " 26.1.2 " });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.server.loader, "paper");
  assert.equal(saved.json.server.minecraftVersion, "26.1.2");
  assert.equal(saved.json.server.installTarget, "plugins");

  for (const minecraftVersion of ["1.20.1", "26.4-snapshot-8", "24w14a", "1.14.2 Pre-Release 4", ""]) {
    const response = await saveAddonSettings(admin, { loader: "forge", minecraftVersion });
    assert.equal(response.status, 200, minecraftVersion);
    assert.equal((await recordOf(app)).minecraftVersion, minecraftVersion);
  }
});

test("saving one add-on setting leaves the other as it was", async (t) => {
  const { admin, app } = await startWithAdmin(t);

  // Sending only the version used to write the loader as undefined, which
  // dropped it from the record.
  assert.equal((await saveAddonSettings(admin, { minecraftVersion: "1.21.4" })).status, 200);
  assert.deepEqual(
    (({ loader, minecraftVersion }) => ({ loader, minecraftVersion }))(await recordOf(app)),
    { loader: "fabric", minecraftVersion: "1.21.4" }
  );

  assert.equal((await saveAddonSettings(admin, { loader: "quilt" })).status, 200);
  assert.deepEqual(
    (({ loader, minecraftVersion }) => ({ loader, minecraftVersion }))(await recordOf(app)),
    { loader: "quilt", minecraftVersion: "1.21.4" }
  );
});

test("a request that mixes add-on settings with an owner-only field changes nothing", async (t) => {
  const { admin, app } = await startWithAdmin(t);

  const response = await admin("PUT", "/api/servers/DemoServer/settings", {
    json: { addonSettings: { loader: "paper", minecraftVersion: "1.20.1" }, name: "Renamed" }
  });
  assert.equal(response.status, 403);

  const record = await recordOf(app);
  assert.equal(record.loader, "fabric");
  assert.equal(record.minecraftVersion, "1.21.1");
});

// --- the owner's settings form ---------------------------------------------------

test("the owner's settings are held to the same checks", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const save = (json) => owner("PUT", "/api/servers/DemoServer/settings", { json });

  assert.equal((await save({ description: "A demo", loader: "fabric", minecraftVersion: "1.21.1", name: "Demo" })).status, 200);

  const refused = [
    { loader: { __html: MARKUP } },
    { loader: "sponge" },
    { minecraftVersion: { __html: MARKUP } },
    { minecraftVersion: "1.21\n1.22" },
    { name: { __html: MARKUP } },
    { name: "two\nlines" },
    { name: "   " },
    { name: "x".repeat(81) },
    { description: ["a list"] },
    { description: "line one\nline two" },
    { description: "x".repeat(501) },
    { startCommand: { run: "id" } },
    { startCommand: "./launch-server.sh\nid" }
  ];
  for (const body of refused) {
    const response = await save(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }

  const record = await recordOf(app);
  assert.equal(record.name, "Demo");
  assert.equal(record.description, "A demo");
  assert.equal(record.loader, "fabric");
  assert.equal(record.minecraftVersion, "1.21.1");
  assert.equal(record.startCommand, "./launch-server.sh");
});

test("a setting the owner did not send keeps its value", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const save = (json) => owner("PUT", "/api/servers/DemoServer/settings", { json });

  assert.equal((await save({ description: "A demo", loader: "fabric", minecraftVersion: "1.21.1", name: "Demo" })).status, 200);
  // Only the description: the name, loader and version used to be erased.
  assert.equal((await save({ description: "Changed" })).status, 200);

  const record = await recordOf(app);
  assert.equal(record.description, "Changed");
  assert.equal(record.name, "Demo");
  assert.equal(record.loader, "fabric");
  assert.equal(record.minecraftVersion, "1.21.1");

  // Text with markup in it is still text. It is stored as typed and escaped
  // where it is shown.
  assert.equal((await save({ description: MARKUP, name: "Moon <Lab> & Co" })).status, 200);
  assert.equal((await recordOf(app)).name, "Moon <Lab> & Co");
});

// --- records that were written before any of this -------------------------------

test("a record that already holds something other than text is repaired when it is read", async (t) => {
  const root = await createRoot(t);
  await fsp.mkdir(path.join(root, "data"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "data", "servers.json"),
    JSON.stringify({
      servers: {
        DemoServer: {
          description: [MARKUP],
          directory: "servers/DemoServer",
          id: "DemoServer",
          loader: { __html: MARKUP },
          minecraftVersion: { __html: MARKUP },
          name: { __html: MARKUP },
          startCommand: "./launch-server.sh"
        }
      }
    })
  );

  const app = await startApp(t, { root });
  const owner = await app.setupOwner();
  const snapshot = (await owner("GET", "/api/servers/DemoServer")).json;

  assert.equal(snapshot.server.loader, "vanilla");
  assert.equal(snapshot.server.minecraftVersion, "unknown");
  assert.equal(snapshot.server.name, "DemoServer");
  assert.equal(snapshot.server.description, "");
  assert.doesNotMatch(JSON.stringify(snapshot), /onerror/);
  assert.doesNotMatch(JSON.stringify((await owner("GET", "/api/servers")).json), /onerror/);
  // And it is written back that way.
  assert.equal((await recordOf(app)).loader, "vanilla");
});

test("records made of ordinary text are not rewritten by being read", async (t) => {
  const root = await createRoot(t);
  await fsp.mkdir(path.join(root, "data"), { recursive: true });
  // The shape of a record on a real deployment, year-based version and all.
  const stored = {
    servers: {
      DemoServer: {
        id: "DemoServer",
        name: "Cult Of The Ripper",
        description: "A chad is a big chinned organism  that exudes aura which inflicts damage to nearby NPC's.",
        directory: "servers/DemoServer",
        loader: "fabric",
        minecraftVersion: "26.1.2",
        startCommand: "./launch-server.sh",
        worldDir: "world",
        logFile: "logs/latest.log",
        serverPropertiesFile: "server.properties",
        modsDir: "mods",
        passphraseHash: null,
        createdAt: "2026-04-25T11:52:38.462Z",
        updatedAt: "2026-10-26T21:46:36.518Z",
        maxMemory: "12G",
        minMemory: "2G",
        javaBin: "",
        managedRuntime: null
      }
    }
  };
  const file = path.join(root, "data", "servers.json");
  await fsp.writeFile(file, `${JSON.stringify(stored, null, 2)}\n`);
  const before = await fsp.readFile(file, "utf8");

  const app = await startApp(t, { root });
  const owner = await app.setupOwner();
  assert.equal((await owner("GET", "/api/servers/DemoServer")).status, 200);
  assert.equal((await owner("GET", "/api/servers")).status, 200);

  assert.equal(await fsp.readFile(file, "utf8"), before);
});

test("a version read from a server's own log is only believed when it looks like one", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-discovery-"));
  t.after(() => fsp.rm(root, { force: true, recursive: true }));
  for (const [name, line] of [
    ["Honest", "Starting minecraft server version 26.1.2"],
    ["Hostile", `Starting minecraft server version ${MARKUP.replace(/ /g, "")}`]
  ]) {
    await fsp.mkdir(path.join(root, "servers", name, "logs"), { recursive: true });
    await fsp.writeFile(path.join(root, "servers", name, "logs", "latest.log"), `[Server thread/INFO]: ${line}\n`);
  }

  const store = createStore(root);
  await store.ensureInitialized();
  const records = await createServerManager(store).syncDiscoveredServers();

  assert.equal(records.Honest.minecraftVersion, "26.1.2");
  assert.equal(records.Hostile.minecraftVersion, "unknown");
});

// --- registering a server ---------------------------------------------------------

test("registering a server checks every field before anything is stored", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-create-"));
  t.after(() => fsp.rm(root, { force: true, recursive: true }));
  await fsp.mkdir(path.join(root, "servers", "Existing"), { recursive: true });
  // Not picked up by discovery, so it can be registered by hand below.
  await fsp.mkdir(path.join(root, "data"), { recursive: true });

  const store = createStore(root);
  await store.ensureInitialized();
  const serverManager = createServerManager(store);
  const actor = { username: "owner" };
  const base = { directoryName: "Existing", mode: "existing", serverId: "by-hand" };

  const refused = [
    { loader: { __html: MARKUP } },
    { loader: "sponge" },
    { minecraftVersion: { __html: MARKUP } },
    { minecraftVersion: "../1.21" },
    { name: { __html: MARKUP } },
    { name: "two\nlines" },
    { description: { __html: MARKUP } },
    { startCommand: ["id"] },
    { worldDir: { path: "world" } },
    { logFile: "logs/latest.log\nx" },
    { port: "25565\nonline-mode=false" },
    { port: 70000 },
    { passphrase: { length: 12 } },
    { serverId: { id: "x" } }
  ];
  for (const fields of refused) {
    await assert.rejects(serverManager.createServer({ ...base, ...fields }, actor), { statusCode: 400 }, JSON.stringify(fields));
  }
  assert.equal((await store.getServerRecords())["by-hand"], undefined);

  const record = await serverManager.createServer(
    { ...base, description: "Registered by hand", loader: "Purpur", minecraftVersion: "1.21.4", name: "By Hand" },
    actor
  );
  assert.equal(record.loader, "purpur");
  assert.equal(record.minecraftVersion, "1.21.4");
  assert.equal(record.name, "By Hand");
  assert.equal(record.description, "Registered by hand");
  assert.equal(record.startCommand, "./launch-server.sh");
  assert.equal(record.worldDir, "world");
});
