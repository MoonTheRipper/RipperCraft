const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setHashCostForTests } = require("../src/lib/auth");
const { scanLoaderRequirements } = require("../src/lib/loader-deps");
const { startWithAdmin } = require("../test-support/lane");
const { PUBLIC_ADDRESS, scriptedOutbound } = require("../test-support/outbound");
const { buildZip } = require("../test-support/zip");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const MARKUP = "<img src=x onerror=alert(1)>";
// Everything JSON can put where a name was expected.
const NOT_TEXT = [{ __html: MARKUP }, [MARKUP], { toString: "x" }, true, 7, null, undefined, "", "   "];

// Addresses a page must not be handed as a picture or a link: they are not
// absolute https addresses. The first few would be fetched from this dashboard
// with the viewer's own session.
const NOT_A_WEB_ADDRESS = [
  "/api/servers/DemoServer/worlds/export",
  "api/logout",
  "//files.example/icon.png",
  "javascript:alert(1)",
  "data:image/svg+xml,<svg onload=alert(1)>",
  "http://files.example/icon.png",
  "https://someone:secret@files.example/icon.png",
  "file:///etc/hostname",
  `https://files.example/${"a".repeat(2100)}.png`,
  "not an address"
];

// Every value in a response, however deep, with the path it was found at.
function leaves(value, at = "") {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => leaves(item, `${at}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => leaves(item, `${at}.${key}`));
  }
  return [[at, value]];
}

test("add-on file names are taken as text or not at all", async (t) => {
  const { admin, app } = await startWithAdmin(t);
  const mods = path.join(app.root, "servers", "DemoServer", "mods");
  // What String() makes of an object, which is the name these used to act on.
  for (const name of ["kept.jar", "object-Object", "object Object", "true", "7"]) {
    await fsp.writeFile(path.join(mods, name), "jar");
  }
  const before = fs.readdirSync(mods).sort();
  const post = (action, json) => admin("POST", `/api/servers/DemoServer/mods/${action}`, { json });

  for (const fileName of NOT_TEXT) {
    assert.equal((await post("remove", { fileName })).status, 400, `remove ${JSON.stringify(fileName)}`);
    assert.equal((await post("toggle", { enabled: false, fileName })).status, 400, `toggle ${JSON.stringify(fileName)}`);
  }
  for (const fileNames of [[{ __html: MARKUP }], ["kept.jar", 7], [["kept.jar"]], [null], Array.from({ length: 501 }, () => "kept.jar")]) {
    assert.equal((await post("update", { fileNames })).status, 400, JSON.stringify(fileNames).slice(0, 60));
  }
  assert.deepEqual(fs.readdirSync(mods).sort(), before);

  // Text still works.
  const removed = await post("remove", { fileName: "kept.jar" });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(fs.existsSync(path.join(mods, "kept.jar")), false);
});

test("a world archive is named by text or not at all", async (t) => {
  const { admin, app } = await startWithAdmin(t);
  const library = path.join(app.root, "servers", "DemoServer", ".rippermoon", "world-library");
  await fsp.mkdir(library, { recursive: true });
  for (const name of ["kept.zip", "object-Object", "true", "7"]) {
    await fsp.writeFile(path.join(library, name), buildZip([{ data: "level", name: "world/level.dat" }]));
  }
  const before = fs.readdirSync(library).sort();

  for (const archiveName of NOT_TEXT) {
    const deleted = await admin("POST", "/api/servers/DemoServer/worlds/delete", { json: { archiveName } });
    assert.equal(deleted.status, 400, `delete ${JSON.stringify(archiveName)}`);
    const activated = await admin("POST", "/api/servers/DemoServer/worlds/activate", { json: { archiveName } });
    assert.equal(activated.status, 400, `activate ${JSON.stringify(archiveName)}`);
  }
  assert.deepEqual(fs.readdirSync(library).sort(), before);

  // A backup label that is not text is simply left off.
  for (const label of [{ __html: MARKUP }, [MARKUP], true]) {
    const captured = await admin("POST", "/api/servers/DemoServer/worlds/capture", { json: { label } });
    assert.equal(captured.status, 200, captured.text);
    assert.match(captured.json.archiveName, /-world\.zip$/);
  }
});

test("the add-on list is sent as text, whatever the manifest file holds", async (t) => {
  const { admin, app, owner } = await startWithAdmin(t);
  const serverDir = path.join(app.root, "servers", "DemoServer");
  const pictured = NOT_A_WEB_ADDRESS.map((_address, index) => `pictured-${index}.jar`);
  for (const name of ["hostile.jar", "honest.jar", "untracked.jar", ...pictured]) {
    await fsp.writeFile(path.join(serverDir, "mods", name), "jar");
  }
  await fsp.mkdir(path.join(serverDir, ".rippermoon"), { recursive: true });
  await fsp.writeFile(
    path.join(serverDir, ".rippermoon", "addons.json"),
    JSON.stringify({
      addons: [
        null,
        {
          clientSide: { __html: MARKUP },
          fileName: "hostile.jar",
          iconUrl: { __html: MARKUP },
          pageUrl: ["javascript:alert(1)"],
          provider: { __html: MARKUP },
          serverSide: 7,
          sourceId: { __html: MARKUP },
          title: { __html: MARKUP }
        },
        {
          clientSide: "required",
          fileName: "honest.jar",
          iconUrl: "https://cdn.modrinth.com/data/abc/icon.png",
          pageUrl: "https://modrinth.com/mod/abc",
          provider: "modrinth",
          serverSide: "optional",
          sourceId: "abc",
          title: "An Honest Mod"
        },
        ...NOT_A_WEB_ADDRESS.map((address, index) => ({ fileName: pictured[index], iconUrl: address, pageUrl: address, provider: "modrinth", sourceId: "abc", title: "Pictured" }))
      ]
    })
  );

  for (const client of [admin, owner]) {
    const snapshot = (await client("GET", "/api/servers/DemoServer")).json;
    const listed = (await client("GET", "/api/servers/DemoServer/mods")).json.mods;
    for (const mods of [snapshot.mods, listed]) {
      for (const [at, value] of leaves(mods)) {
        assert.ok(["string", "boolean"].includes(typeof value), `${at} is ${JSON.stringify(value)}`);
      }
      assert.deepEqual(mods.find((entry) => entry.fileName === "hostile.jar"), {
        clientSide: "unknown",
        enabled: true,
        fileName: "hostile.jar",
        iconUrl: "",
        pageUrl: "",
        provider: "",
        serverSide: "unknown",
        sourceId: "",
        title: "",
        tracked: true
      });
      const honest = mods.find((entry) => entry.fileName === "honest.jar");
      assert.equal(honest.title, "An Honest Mod");
      assert.equal(honest.iconUrl, "https://cdn.modrinth.com/data/abc/icon.png");
      assert.equal(honest.pageUrl, "https://modrinth.com/mod/abc");
      assert.equal(mods.find((entry) => entry.fileName === "untracked.jar").tracked, false);
      // A picture or a link that is not an https address is not passed on.
      for (const fileName of pictured) {
        const entry = mods.find((candidate) => candidate.fileName === fileName);
        assert.equal(entry.title, "Pictured");
        assert.equal(entry.iconUrl, "", fileName);
        assert.equal(entry.pageUrl, "", fileName);
      }
    }
    assert.doesNotMatch(JSON.stringify(snapshot.mods), /onerror|javascript:/);

    // The update check reads the same file and reports on every entry in it.
    const updates = await client("GET", "/api/servers/DemoServer/mods/updates");
    assert.equal(updates.status, 200, updates.text);
    for (const [at, value] of leaves(updates.json)) {
      assert.ok(value === null || ["string", "boolean", "number"].includes(typeof value), `updates${at} is ${JSON.stringify(value)}`);
    }
    assert.deepEqual(updates.json.entries.map((entry) => entry.fileName).sort(), ["honest.jar", "hostile.jar", ...pictured, "untracked.jar"].sort());
    assert.doesNotMatch(updates.text, /onerror|javascript:/);
  }
});

test("what an uploaded jar says about itself reaches the page as short text", async (t) => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-jars-"));
  t.after(() => fsp.rm(directory, { force: true, recursive: true }));
  const jar = (name, manifest) => fsp.writeFile(path.join(directory, name), buildZip([{ data: JSON.stringify(manifest), name: "fabric.mod.json" }]));

  await jar("honest.jar", { depends: { fabricloader: ">=0.16.0", minecraft: "~1.21" }, id: "honest", name: "An Honest Mod", version: "1.2.3" });
  await jar("objects.jar", {
    depends: { fabricloader: ">=0.17.0" },
    id: { __html: MARKUP },
    name: { __html: MARKUP },
    version: [MARKUP]
  });
  await jar("long.jar", { depends: { fabricloader: [">=0.15.0", "x".repeat(5000)] }, id: "long", name: `Long\n${"n".repeat(5000)}`, version: 7 });
  await jar("no-depends.jar", { depends: "not an object", id: "plain", name: "Plain" });

  const scan = await scanLoaderRequirements(directory, "fabric");
  for (const [at, value] of leaves({ floor: scan.floor, mods: scan.mods.map(({ loaderBound, minecraftBound, ...shown }) => shown) })) {
    assert.ok(value === null || typeof value === "string" || typeof value === "boolean", `${at} is ${JSON.stringify(value)}`);
    if (typeof value === "string") {
      assert.ok(value.length <= 200, `${at} is ${value.length} characters long`);
      assert.doesNotMatch(value, /[\u0000-\u001f]/, at);
    }
  }
  const byFile = Object.fromEntries(scan.mods.map((mod) => [mod.fileName, mod]));
  assert.equal(byFile["honest.jar"].name, "An Honest Mod");
  assert.equal(byFile["honest.jar"].version, "1.2.3");
  assert.equal(byFile["honest.jar"].loaderRaw, '">=0.16.0"');
  assert.equal(byFile["objects.jar"].name, null);
  assert.equal(byFile["objects.jar"].modId, null);
  assert.equal(byFile["objects.jar"].version, null);
  assert.equal(byFile["long.jar"].version, "7");
  assert.equal(byFile["long.jar"].name.length, 200);
  // The scan still does its job: the highest floor wins, and names who set it.
  assert.equal(scan.floor.version, "0.17.0");
  assert.deepEqual(scan.unreadable, []);
});

test("search results reach the page as text and numbers, whatever the provider sent", async (t) => {
  const { outbound } = scriptedOutbound({
    addresses: () => [PUBLIC_ADDRESS],
    respond: () => ({
      body: JSON.stringify({
        hits: [
          null,
          "not a hit",
          {
            author: { __html: MARKUP },
            client_side: { __html: MARKUP },
            description: [MARKUP],
            downloads: { __html: MARKUP },
            icon_url: { __html: MARKUP },
            project_id: { __html: MARKUP },
            server_side: 7,
            slug: { __html: MARKUP },
            title: { __html: MARKUP }
          },
          { author: "someone", client_side: "required", description: "A mod", downloads: 1234, icon_url: "https://cdn.modrinth.com/i.png", project_id: "AANobbMI", server_side: "optional", slug: "a mod/../x", title: "A Mod" },
          ...NOT_A_WEB_ADDRESS.map((icon_url, index) => ({ icon_url, project_id: `picture${index}`, slug: `picture-${index}`, title: "Picture" }))
        ]
      })
    })
  });
  const { admin } = await startWithAdmin(t, { app: { outbound } });

  const response = await admin("POST", "/api/servers/DemoServer/mods/search", { json: { provider: "modrinth", query: "sodium" } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.results.length, 2 + NOT_A_WEB_ADDRESS.length);
  // Artwork is loaded by the page of whoever is looking. An address that is
  // not an https one - a path on this dashboard, say - is not passed on.
  for (const result of response.json.results.slice(2)) {
    assert.equal(result.iconUrl, "", JSON.stringify(result));
  }
  for (const [at, value] of leaves(response.json.results)) {
    assert.ok(["string", "number"].includes(typeof value), `${at} is ${JSON.stringify(value)}`);
  }
  assert.doesNotMatch(JSON.stringify(response.json.results[0]), /onerror/);
  assert.deepEqual(response.json.results[1], {
    author: "someone",
    clientSide: "required",
    compatibilityLabel: "fabric • 1.21.1 • mod",
    description: "A mod",
    downloads: 1234,
    iconUrl: "https://cdn.modrinth.com/i.png",
    id: "AANobbMI",
    pageUrl: "https://modrinth.com/mod/a%20mod%2F..%2Fx",
    provider: "modrinth",
    serverSide: "optional",
    slug: "a mod/../x",
    title: "A Mod"
  });
});

// --- files in the server's folder -----------------------------------------------------------
//
// The dashboard keeps a few JSON files in each server's folder, and so does the
// game. The server runs there as the same user, and so does every mod an admin
// installs, so those files can hold anything - and the pages draw what is in them.

test("the world list is drawn from text and times, whatever the worlds file holds", async (t) => {
  const { admin, app, owner } = await startWithAdmin(t);
  const serverDir = path.join(app.root, "servers", "DemoServer");
  const worldsFile = path.join(serverDir, ".rippermoon", "worlds.json");
  await fsp.mkdir(path.dirname(worldsFile), { recursive: true });
  // With no world folder, the name and the time shown are the file's.
  await fsp.rm(path.join(serverDir, "world"), { force: true, recursive: true });
  const long = "W".repeat(5000);

  const cases = [
    ["null", "null", null],
    ["a list", "[1,2]", null],
    ["text", '"just text"', null],
    ["a number", "7", null],
    ["not JSON at all", "{{{{", null],
    ["an empty file", "", null],
    ["objects for both", JSON.stringify({ activeWorldName: { toString: "x" }, updatedAt: { toString: "x" } }), null],
    ["a list for the name", JSON.stringify({ activeWorldName: [MARKUP], updatedAt: 12345 }), null],
    ["a name with no time", JSON.stringify({ activeWorldName: "Named" }), "Named"],
    ["a time that is not one", JSON.stringify({ activeWorldName: "Named", updatedAt: MARKUP }), "Named"],
    ["a name of several lines", JSON.stringify({ activeWorldName: "one\ntwo\u0000three", updatedAt: "2026-11-15T12:00:00.000Z" }), "one two three"],
    ["a very long name", JSON.stringify({ activeWorldName: long, updatedAt: "2026-11-15T12:00:00.000Z" }), "W".repeat(200)],
    ["what the dashboard writes", JSON.stringify({ activeWorldName: "Survival", updatedAt: "2026-11-15T12:00:00.000Z" }), "Survival"]
  ];

  for (const [label, contents, name] of cases) {
    await fsp.writeFile(worldsFile, contents);
    for (const client of [admin, owner]) {
      const response = await client("GET", "/api/servers/DemoServer");
      assert.equal(response.status, 200, `${label}: ${response.text}`);
      const active = response.json.worlds.filter((world) => world.kind === "active");
      if (name === null) {
        assert.deepEqual(active, [], label);
        continue;
      }
      assert.equal(active.length, 1, label);
      assert.equal(active[0].name, name, label);
      // A time the page can show: text that is a date.
      assert.equal(typeof active[0].modifiedAt, "string", label);
      assert.equal(new Date(active[0].modifiedAt).toISOString(), active[0].modifiedAt, label);
    }
  }

  // The time in the file is used when it is one.
  const shown = (await admin("GET", "/api/servers/DemoServer")).json.worlds[0];
  assert.equal(shown.modifiedAt, "2026-11-15T12:00:00.000Z");
});

test("the operator list is drawn from text and numbers, whatever ops.json holds", async (t) => {
  const { app, owner } = await startWithAdmin(t);
  const serverDir = path.join(app.root, "servers", "DemoServer");
  // An offline-mode server works a player's id out from the name, so adding
  // an operator below asks nobody.
  await fsp.appendFile(path.join(serverDir, "server.properties"), "online-mode=false\n");
  const steve = "8667ba71-b85a-4004-af54-457a9734eed7";
  await fsp.writeFile(
    path.join(serverDir, "ops.json"),
    JSON.stringify([
      null,
      7,
      "Steve",
      [{ name: "InAList" }],
      { name: { toString: "x" }, uuid: steve },
      { name: [MARKUP] },
      { name: "   " },
      { level: 2, name: "N".repeat(500), uuid: "069a79f4-44e9-4726-a5be-fca90e38aaf5" },
      { bypassesPlayerLimit: "yes", level: { toString: "x" }, name: "Alex\nline two", uuid: { toString: "x" } },
      { bypassesPlayerLimit: true, level: 2, name: "Steve", uuid: steve.toUpperCase() }
    ])
  );

  const response = await owner("GET", "/api/servers/DemoServer");
  assert.equal(response.status, 200, response.text);
  const operators = response.json.operators;
  for (const [at, value] of leaves(operators)) {
    assert.ok(["string", "boolean", "number"].includes(typeof value), `${at} is ${JSON.stringify(value)}`);
  }
  assert.deepEqual(operators.map((operator) => [operator.name, operator.level, operator.bypassesPlayerLimit]), [
    ["Alex line two", 4, false],
    ["N".repeat(64), 2, false],
    ["Steve", 2, true]
  ]);
  assert.equal(operators.find((operator) => operator.name === "Steve").uuid, steve);
  // No uuid that is text: the one an offline server would give that name.
  assert.match(operators[0].uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);

  // And the list can still be changed from there.
  const added = await owner("POST", "/api/servers/DemoServer/operators", { json: { level: 1, name: "Moon" } });
  assert.ok([200, 201].includes(added.status), added.text);
  const kept = JSON.parse(await fsp.readFile(path.join(serverDir, "ops.json"), "utf8"));
  assert.deepEqual(kept.map((operator) => operator.name).sort(), ["Alex line two", "Moon", "N".repeat(64), "Steve"]);
});

test("an add-on manifest that is not a manifest lists nothing as tracked and breaks nothing", async (t) => {
  const { admin, app } = await startWithAdmin(t);
  const serverDir = path.join(app.root, "servers", "DemoServer");
  await fsp.writeFile(path.join(serverDir, "mods", "untracked.jar"), "jar");
  await fsp.mkdir(path.join(serverDir, ".rippermoon"), { recursive: true });

  for (const contents of ["null", "7", '"text"', "[]", '{"addons":null}', '{"addons":{"0":{"fileName":"untracked.jar"}}}', '{"addons":[null,7,"untracked.jar",["untracked.jar"],{"fileName":{"toString":"x"}},{"title":"no file"}]}']) {
    await fsp.writeFile(path.join(serverDir, ".rippermoon", "addons.json"), contents);
    const snapshot = await admin("GET", "/api/servers/DemoServer");
    assert.equal(snapshot.status, 200, `${contents}: ${snapshot.text}`);
    assert.deepEqual(snapshot.json.mods, [{ enabled: true, fileName: "untracked.jar", tracked: false }], contents);
    // The routes that read the manifest to act on it get through it too.
    const disabled = await admin("POST", "/api/servers/DemoServer/mods/toggle", { json: { enabled: false, fileName: "untracked.jar" } });
    assert.equal(disabled.status, 200, `${contents}: ${disabled.text}`);
    const enabled = await admin("POST", "/api/servers/DemoServer/mods/toggle", { json: { enabled: true, fileName: "untracked.jar" } });
    assert.equal(enabled.status, 200, `${contents}: ${enabled.text}`);
  }
});

test("a safe setting sent as something that is not text or a number is not saved, and is not a fault", async (t) => {
  const { admin, app } = await startWithAdmin(t);
  const propertiesFile = path.join(app.root, "servers", "DemoServer", "server.properties");
  const save = (safeProperties) => admin("PUT", "/api/servers/DemoServer/settings", { json: safeProperties === undefined ? {} : { safeProperties } });
  const faults = () => app.logs.filter((entry) => entry.level === "error").length;

  assert.equal((await save({ difficulty: "hard", "max-players": 12, "view-distance": "9" })).status, 200);
  const before = await fsp.readFile(propertiesFile, "utf8");
  assert.match(before, /^max-players=12$/m);
  assert.match(before, /^difficulty=hard$/m);
  const faultsBefore = faults();

  // A list nested deeply enough that turning it into text runs out of stack.
  // Written out as text: building it as a value would run this test out too.
  const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
  for (const value of ['{"toString":"x"}', '{"valueOf":"x","toString":"x"}', "[12]", '["hard"]', JSON.stringify({ __html: MARKUP }), "true", deep]) {
    for (const key of ["max-players", "view-distance", "difficulty", "gamemode"]) {
      const response = await admin("PUT", "/api/servers/DemoServer/settings", {
        body: `{"safeProperties":{"${key}":${value}}}`,
        headers: { "Content-Type": "application/json" }
      });
      // Taken as "not a number" or "not one of the words": the default, as for
      // any other value that is neither.
      assert.equal(response.status, 200, `${key}=${value.slice(0, 40)}: ${response.text.slice(0, 200)}`);
      assert.match(String(response.json.safeProperties[key]), /^[a-z0-9-]+$/, key);
    }
  }
  assert.equal(faults(), faultsBefore);
  // What was written each time was the setting's default: a number or a word.
  const after = await fsp.readFile(propertiesFile, "utf8");
  assert.doesNotMatch(after, /object Object|onerror|toString|\[|\{/);
  for (const line of after.split("\n").filter(Boolean)) {
    assert.match(line, /^[a-z-]+=[A-Za-z0-9 ]*$/, line);
  }
  assert.match(after, /^max-players=\d+$/m);
  assert.match(after, /^difficulty=(peaceful|easy|normal|hard)$/m);
});

