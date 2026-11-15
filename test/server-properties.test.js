const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setHashCostForTests } = require("../src/lib/auth");
const { createServerManager } = require("../src/lib/servers");
const { createStore } = require("../src/lib/store");
const { LEVEL_TYPES, normalizeLevelType, propertyValue } = require("../src/lib/validate");
const { startWithAdmin } = require("../test-support/lane");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

// A file with security settings in it, in the order the dashboard writes them.
const PROPERTIES = [
  "enable-rcon=false",
  "enforce-whitelist=true",
  "level-seed=1234",
  "level-type=minecraft\\:normal",
  "motd=Demo",
  "online-mode=true",
  "rcon.password=",
  "server-port=25565",
  "white-list=true"
].join("\n");

async function setUp(t) {
  const lane = await startWithAdmin(t);
  const file = path.join(lane.app.root, "servers", "DemoServer", "server.properties");
  await fsp.writeFile(file, `${PROPERTIES}\n`);
  const read = () => fs.readFileSync(file, "utf8");
  // What Minecraft would make of the file. Java reads a line that ends in an
  // odd number of backslashes as continuing on the next one; an even number is
  // that many halves of escaped backslashes, and the line ends there.
  const asJavaReadsIt = () => {
    const lines = [];
    let carried = "";
    for (const line of read().split(/\r?\n/)) {
      const whole = carried + (carried ? line.trimStart() : line);
      const trailing = /\\+$/.exec(whole);
      if (trailing && trailing[0].length % 2 === 1) {
        carried = whole.slice(0, -1);
      } else {
        carried = "";
        lines.push(whole);
      }
    }
    return Object.fromEntries(
      lines
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
    );
  };
  const saveSafe = (safeProperties) => lane.admin("PUT", "/api/servers/DemoServer/settings", { json: { safeProperties } });
  return { ...lane, asJavaReadsIt, file, read, saveSafe };
}

const lineSeparator = String.fromCharCode(0x2028);

// --- the rule ----------------------------------------------------------------------

test("a value for server.properties is one line that cannot run into the next", () => {
  for (const value of ["A Minecraft Server", "", "two\\nlines", "colour \\u00a7aGreen", "50% off = today: yes # really!", "trailing pair \\\\", "C:\\\\worlds\\\\one"]) {
    assert.equal(propertyValue(value, "The value"), value);
  }
  assert.equal(propertyValue("  padded  ", "The value"), "padded");
  assert.equal(propertyValue(25565, "The value"), "25565");

  const refused = [
    "hello\nonline-mode=false",
    "hello\ronline-mode=false",
    "hello\r\nonline-mode=false",
    "tab\there",
    "nul\u0000byte",
    "escape\u001b[0m",
    "form\u000cfeed",
    "vertical\u000btab",
    "delete\u007f",
    "next line\u0085",
    `separator${lineSeparator}here`,
    "ends with one\\",
    "ends with three\\\\\\",
    "ends with one and a space\\ ",
    { toString: () => "hello" },
    ["hello"],
    null,
    undefined,
    true
  ];
  for (const value of refused) {
    assert.throws(() => propertyValue(value, "The value"), { statusCode: 400 }, JSON.stringify(value));
  }
  assert.throws(() => propertyValue("x".repeat(257), "The value"), { statusCode: 400 });
  assert.equal(propertyValue("x".repeat(512), "The value", { maxLength: 512 }).length, 512);
});

test("the world type is one of Minecraft's own, in either spelling", () => {
  for (const levelType of LEVEL_TYPES) {
    assert.equal(normalizeLevelType(levelType), levelType);
  }
  // The four the dashboard offers, the way the page sends them.
  for (const offered of ["minecraft:normal", "minecraft:flat", "minecraft:large_biomes", "minecraft:amplified"]) {
    assert.ok(LEVEL_TYPES.includes(offered));
  }
  // As Minecraft itself writes it back into the file, and as older versions spelled it.
  assert.equal(normalizeLevelType("minecraft\\:normal"), "minecraft:normal");
  assert.equal(normalizeLevelType("  Minecraft:Large_Biomes "), "minecraft:large_biomes");
  assert.equal(normalizeLevelType("DEFAULT"), "default");
  assert.equal(normalizeLevelType("largeBiomes"), "largebiomes");

  for (const value of [
    "",
    "anything",
    "minecraft:normal\nonline-mode=false",
    "minecraft:normal\\",
    "minecraft:",
    "minecraft:normal minecraft:flat",
    "terraforged:terraforged",
    "../../x",
    { id: "minecraft:normal" },
    ["minecraft:normal"],
    null,
    undefined,
    7
  ]) {
    assert.throws(() => normalizeLevelType(value), { statusCode: 400 }, JSON.stringify(value));
  }
});

// --- the admin's safe settings -----------------------------------------------------------

test("an admin cannot add a line to server.properties through the message of the day", async (t) => {
  const lane = await setUp(t);
  const before = lane.read();

  const attempts = [
    "hello\nonline-mode=false",
    "hello\r\nenable-rcon=true\r\nrcon.password=letmein",
    "hello\ronline-mode=false",
    `hello${lineSeparator}online-mode=false`,
    "hello\u0085online-mode=false",
    "hello\u000conline-mode=false",
    { toString: "x" },
    ["hello", "online-mode=false"]
  ];
  for (const motd of attempts) {
    const response = await lane.saveSafe({ motd });
    assert.equal(response.status, 400, JSON.stringify(motd));
  }
  assert.equal(lane.read(), before);
});

test("an admin cannot make the message of the day swallow the setting after it", async (t) => {
  const lane = await setUp(t);
  const before = lane.read();

  // The line after motd is online-mode. Ending motd with a backslash joined
  // the two when Minecraft read the file, and online-mode was gone.
  for (const motd of ["hello\\", "hello\\\\\\", "hello\\   "]) {
    const response = await lane.saveSafe({ motd });
    assert.equal(response.status, 400, JSON.stringify(motd));
    assert.match(response.json.error, /cannot end with a backslash/);
  }
  assert.equal(lane.read(), before);
  assert.equal(lane.asJavaReadsIt()["online-mode"], "true");
});

test("a refused value leaves every other setting in the request unwritten too", async (t) => {
  const lane = await setUp(t);
  const before = lane.read();

  const response = await lane.saveSafe({ difficulty: "hard", "max-players": "5", motd: "bad\nline", pvp: "false" });
  assert.equal(response.status, 400);
  assert.equal(lane.read(), before);
});

test("ordinary messages of the day are still saved, escapes and all", async (t) => {
  const lane = await setUp(t);

  for (const motd of ["A Minecraft Server", "AbsoluteChads", "Line one\\nLine two", "\\u00a7aGreen \\u00a7lbold", "50% = half: yes # no", "ends with a pair \\\\", ""]) {
    const response = await lane.saveSafe({ difficulty: "hard", "max-players": "12", motd });
    assert.equal(response.status, 200, `${JSON.stringify(motd)}: ${response.text}`);
    assert.equal(response.json.safeProperties.motd, motd);
    const stored = lane.asJavaReadsIt();
    assert.equal(stored.motd, motd);
    // And nothing else in the file moved.
    assert.equal(stored["online-mode"], "true");
    assert.equal(stored["white-list"], "true");
    assert.equal(stored["enforce-whitelist"], "true");
    assert.equal(stored["level-type"], "minecraft\\:normal");
    assert.equal(stored.difficulty, "hard");
    assert.equal(stored["max-players"], "12");
  }
  assert.equal(lane.read().split("\n").filter(Boolean).length, 11);
});

test("a key that is not one of the safe settings is ignored, however it is sent", async (t) => {
  const lane = await setUp(t);

  const response = await lane.saveSafe({
    "enable-rcon": "true",
    "motd\nonline-mode": "false",
    "online-mode": "false",
    "rcon.password": "letmein",
    __proto__: { motd: "from the prototype" },
    constructor: "x",
    motd: "Changed"
  });
  assert.equal(response.status, 200, response.text);
  const stored = lane.asJavaReadsIt();
  assert.equal(stored.motd, "Changed");
  assert.equal(stored["online-mode"], "true");
  assert.equal(stored["enable-rcon"], "false");
  assert.equal(stored["rcon.password"], "");
  assert.equal(lane.read().split("\n").filter(Boolean).length, 9);
});

// --- world rules and new worlds --------------------------------------------------------------

test("the world type is taken from the list, and nothing else is written", async (t) => {
  const lane = await setUp(t);
  const before = lane.read();
  const saveRules = (levelType) =>
    lane.admin("POST", "/api/servers/DemoServer/worlds/rules", { json: { forceGamemode: false, generateStructures: true, levelType } });

  for (const levelType of ["minecraft:normal\nonline-mode=false", "minecraft:flat\\", "anything-at-all", "terraforged:terraforged", { id: "minecraft:flat" }, ["minecraft:flat"], 7]) {
    const response = await saveRules(levelType);
    assert.equal(response.status, 400, JSON.stringify(levelType));
  }
  assert.equal(lane.read(), before);

  for (const [sent, stored] of [["minecraft:flat", "minecraft:flat"], ["minecraft\\:large_biomes", "minecraft:large_biomes"], ["DEFAULT", "default"]]) {
    const response = await saveRules(sent);
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.rules.levelType, stored);
    assert.equal(lane.asJavaReadsIt()["level-type"], stored);
  }
  // Left out, the world type stays as it is and the other rules are saved.
  const without = await lane.admin("POST", "/api/servers/DemoServer/worlds/rules", { json: { forceGamemode: true, generateStructures: false } });
  assert.equal(without.status, 200);
  const stored = lane.asJavaReadsIt();
  assert.equal(stored["level-type"], "default");
  assert.equal(stored["force-gamemode"], "true");
  assert.equal(stored["generate-structures"], "false");
  assert.equal(stored["online-mode"], "true");
});

test("a new world's seed, type and name are checked before the live world is touched", async (t) => {
  const lane = await setUp(t);
  const before = lane.read();
  const world = path.join(lane.app.root, "servers", "DemoServer", "world");
  const library = path.join(lane.app.root, "servers", "DemoServer", ".rippermoon", "world-library");
  const create = (json) => lane.admin("POST", "/api/servers/DemoServer/worlds/create", { json });

  const refused = [
    { name: "fresh", seed: "1\nonline-mode=false" },
    { name: "fresh", seed: "1\\" },
    { name: "fresh", seed: { value: 1 } },
    { name: "fresh", seed: "s".repeat(129) },
    { levelType: "minecraft:normal\nonline-mode=false", name: "fresh" },
    { levelType: "anything", name: "fresh" },
    { levelType: ["minecraft:flat"], name: "fresh" },
    { name: "two\nlines" },
    { name: { text: "fresh" } },
    { name: "n".repeat(81) }
  ];
  for (const body of refused) {
    const response = await create(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  // Refused before anything else happened: no archive, the world in place.
  assert.equal(lane.read(), before);
  assert.equal(fs.readFileSync(path.join(world, "level.dat"), "utf8"), "demo");
  assert.equal(fs.existsSync(library) ? fs.readdirSync(library).length : 0, 0);

  const created = await create({ generateStructures: false, levelType: "minecraft:amplified", name: "Second <World>", seed: "-4172144997902289642" });
  assert.equal(created.status, 200, created.text);
  assert.deepEqual(created.json.nextWorld, {
    generateStructures: "false",
    levelType: "minecraft:amplified",
    name: "Second <World>",
    seed: "-4172144997902289642"
  });
  const stored = lane.asJavaReadsIt();
  assert.equal(stored["level-seed"], "-4172144997902289642");
  assert.equal(stored["level-type"], "minecraft:amplified");
  assert.equal(stored["level-name"], "world");
  assert.equal(stored["online-mode"], "true");
  // Seeds are often words; a number sent as a number is taken too.
  await fsp.mkdir(world, { recursive: true });
  assert.equal((await create({ name: "third", seed: 42 })).status, 200);
  assert.equal(lane.asJavaReadsIt()["level-seed"], "42");
  assert.equal(lane.asJavaReadsIt()["level-type"], "minecraft:normal");
});

// --- the file the dashboard writes for a new server -----------------------------------------------

test("a server's name cannot add a line to the properties file written for it", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-props-"));
  t.after(() => fsp.rm(root, { force: true, recursive: true }));
  await fsp.mkdir(path.join(root, "servers", "Managed", ".rippermoon"), { recursive: true });
  await fsp.writeFile(path.join(root, "servers", "Managed", "server.jar"), "jar");

  const store = createStore(root);
  await store.ensureInitialized();
  const serverManager = createServerManager(store);
  await serverManager.syncDiscoveredServers();
  const file = path.join(root, "servers", "Managed", "server.properties");

  // A managed server gets its properties file written on the way to starting.
  for (const [name, motd] of [
    ["Moon Lab", "Moon Lab"],
    ["Ends with a backslash\\", "Managed"],
    ["Fine \\\\", "Fine \\\\"]
  ]) {
    await fsp.rm(file, { force: true });
    await serverManager.setServerMetadata("Managed", { managedRuntime: { kind: "vanilla", launch: { kind: "jar" } }, name });
    await serverManager.ensureManagedServerArtifacts("Managed");
    assert.equal(await fsp.readFile(file, "utf8"), `motd=${motd}\nserver-port=25565\n`);
  }
});
