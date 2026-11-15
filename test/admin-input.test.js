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
  for (const name of ["hostile.jar", "honest.jar", "untracked.jar"]) {
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
        }
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
      assert.equal(mods.find((entry) => entry.fileName === "honest.jar").title, "An Honest Mod");
      assert.equal(mods.find((entry) => entry.fileName === "untracked.jar").tracked, false);
    }
    assert.doesNotMatch(JSON.stringify(snapshot.mods), /onerror|javascript:/);
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
          { author: "someone", client_side: "required", description: "A mod", downloads: 1234, icon_url: "https://cdn.modrinth.com/i.png", project_id: "AANobbMI", server_side: "optional", slug: "a mod/../x", title: "A Mod" }
        ]
      })
    })
  });
  const { admin } = await startWithAdmin(t, { app: { outbound } });

  const response = await admin("POST", "/api/servers/DemoServer/mods/search", { json: { provider: "modrinth", query: "sodium" } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.json.results.length, 2);
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
