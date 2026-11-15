const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { setHashCostForTests } = require("../src/lib/auth");
const { createServerManager } = require("../src/lib/servers");
const { createStore } = require("../src/lib/store");
const { createWorldManager, resolveWorldLimitBytes } = require("../src/lib/worlds");
const { inspectZip } = require("../src/lib/zip-extract");
const { startWithAdmin } = require("../test-support/lane");
const { buildZip } = require("../test-support/zip");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const CANARY = "CANARY-FROM-OUTSIDE-THE-SERVER";

// An app with an admin on DemoServer, plus a folder outside the app's root
// holding a file the admin has no business reading.
async function setUp(t, appOptions = {}) {
  const lane = await startWithAdmin(t, { app: appOptions });
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-outside-"));
  t.after(() => fsp.rm(outside, { force: true, recursive: true }));
  await fsp.writeFile(path.join(outside, "canary.txt"), CANARY);

  const serverDir = path.join(lane.app.root, "servers", "DemoServer");
  const library = path.join(serverDir, ".rippermoon", "world-library");
  const world = path.join(serverDir, "world");

  // Uploads an archive through the real import route.
  async function importArchive(bytes, name = "upload.zip", client = lane.admin) {
    const form = new FormData();
    form.set("archive", new Blob([bytes]), name);
    const response = await fetch(`${lane.app.origin}/api/servers/DemoServer/worlds/import`, {
      body: form,
      headers: { Cookie: client.cookie() },
      method: "POST"
    });
    const payload = await response.json();
    assert.equal(response.status, 201, JSON.stringify(payload));
    return payload.archiveName;
  }

  async function download(urlPath, client = lane.admin) {
    const response = await fetch(`${lane.app.origin}${urlPath}`, { headers: { Cookie: client.cookie() } });
    return { body: Buffer.from(await response.arrayBuffer()), status: response.status };
  }

  const activate = (archiveName, client = lane.admin) =>
    client("POST", "/api/servers/DemoServer/worlds/activate", { json: { archiveName } });
  const capture = (label, client = lane.admin) => client("POST", "/api/servers/DemoServer/worlds/capture", { json: { label } });

  // Folders left behind by an unpacking that did not finish.
  const staging = () => fs.readdirSync(serverDir).filter((name) => name.startsWith(".rippercraft-restore-"));
  const libraryNames = () => (fs.existsSync(library) ? fs.readdirSync(library).sort() : []);

  return { ...lane, activate, capture, download, importArchive, library, libraryNames, outside, serverDir, staging, world };
}

// Everything a zip holds, written out one entry after another. A link is
// written as the path it points to, a file as its contents.
function everythingIn(zipBytes) {
  const file = path.join(os.tmpdir(), `rippercraft-read-${process.pid}-${Math.random().toString(16).slice(2)}.zip`);
  fs.writeFileSync(file, zipBytes);
  try {
    return {
      contents: execFileSync("unzip", ["-p", file], { maxBuffer: 64 * 1024 * 1024 }).toString("latin1"),
      names: execFileSync("unzip", ["-Z1", file]).toString().trim().split("\n")
    };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const goodWorld = (marker = "restored") =>
  buildZip([
    { name: "world/" },
    { data: marker, name: "world/level.dat" },
    { data: Buffer.alloc(40_000, "r"), name: "world/region/r.0.0.mca" }
  ]);

// --- restoring -----------------------------------------------------------------------

test("restoring a world replaces the live one, and archives what was there first", async (t) => {
  const lane = await setUp(t);
  const archiveName = await lane.importArchive(goodWorld("the restored world"), "new world.zip");

  const response = await lane.activate(archiveName);
  assert.equal(response.status, 200, response.text);

  assert.equal(await fsp.readFile(path.join(lane.world, "level.dat"), "utf8"), "the restored world");
  assert.equal((await fsp.stat(path.join(lane.world, "region", "r.0.0.mca"))).size, 40_000);
  assert.deepEqual(lane.staging(), []);

  // The world that was live is in the library, and can be put back.
  const backup = lane.libraryNames().find((name) => name.includes("pre-activate"));
  assert.ok(backup, lane.libraryNames().join(", "));
  assert.equal((await lane.activate(backup)).status, 200);
  assert.equal(await fsp.readFile(path.join(lane.world, "level.dat"), "utf8"), "demo");

  const active = response.json.worlds.find((entry) => entry.active);
  assert.equal(active.name, archiveName.replace(/\.zip$/, ""));
});

test("an archive holding a link is not restored, and the live world is left alone", async (t) => {
  const lane = await setUp(t);
  const cases = {
    "a link to a folder outside": { name: "world/link", symlink: lane.outside },
    "a link to a file outside": { name: "world/secret.txt", symlink: path.join(lane.outside, "canary.txt") },
    "a relative link": { name: "world/up", symlink: "../../../data" }
  };

  for (const [label, link] of Object.entries(cases)) {
    const archiveName = await lane.importArchive(buildZip([{ data: "hostile", name: "world/level.dat" }, link]), "linked.zip");
    const before = lane.libraryNames();

    const response = await lane.activate(archiveName);
    assert.equal(response.status, 400, label);
    assert.match(response.json.error, /symbolic link/, label);

    // Nothing was unpacked, nothing was replaced, and no backup was needed.
    assert.equal(await fsp.readFile(path.join(lane.world, "level.dat"), "utf8"), "demo", label);
    assert.deepEqual(fs.readdirSync(lane.world), ["level.dat"], label);
    assert.deepEqual(lane.staging(), [], label);
    assert.deepEqual(lane.libraryNames(), before, label);
  }
});

test("an archive that is not a world, or not an archive, is refused before the live world is touched", async (t) => {
  const lane = await setUp(t);
  const cases = [
    [buildZip([{ data: "x", name: "readme.txt" }, { data: "y", name: "other/file.txt" }]), /no level\.dat/],
    [buildZip([{ name: "world/level.dat/" }, { data: "x", name: "world/level.dat/inside" }]), /no level\.dat/],
    [Buffer.from("this is not a zip archive"), /not a zip archive/],
    [buildZip([{ data: "level", name: "world/level.dat" }, { data: "x", name: "../escape.txt" }]), /leads outside/]
  ];
  for (const [bytes, message] of cases) {
    const archiveName = await lane.importArchive(bytes, "odd.zip");
    const response = await lane.activate(archiveName);
    assert.equal(response.status, 400, response.text);
    assert.match(response.json.error, message);
    assert.equal(await fsp.readFile(path.join(lane.world, "level.dat"), "utf8"), "demo");
    assert.deepEqual(lane.staging(), []);
  }
  assert.equal(lane.libraryNames().some((name) => name.includes("pre-activate")), false);
  assert.equal(fs.existsSync(path.join(lane.serverDir, "escape.txt")), false);
  assert.equal(fs.existsSync(path.join(lane.app.root, "servers", "escape.txt")), false);

  for (const archiveName of [undefined, null, "", "   ", 7, {}, ["x.zip"]]) {
    assert.equal((await lane.activate(archiveName)).status, 400, JSON.stringify(archiveName));
  }
  assert.equal((await lane.activate("never-uploaded.zip")).status, 404);
});

test("an archive that unpacks to more than the limit is not restored", async (t) => {
  const lane = await setUp(t, { worldLimitBytes: 4 * 1024 * 1024 });

  // Honest about its size: 32 MB of zeros in a few kilobytes.
  const honest = await lane.importArchive(
    buildZip([{ data: "bomb", name: "world/level.dat" }, { data: Buffer.alloc(32 * 1024 * 1024), name: "world/zeros.bin" }]),
    "bomb.zip"
  );
  assert.ok((await fsp.stat(path.join(lane.library, honest))).size < 100_000);
  const refusedHonest = await lane.activate(honest);
  assert.equal(refusedHonest.status, 413, refusedHonest.text);
  assert.match(refusedHonest.json.error, /unpacks to 32 MB, and the limit is 4 MB/);

  // Lying about it: the header says ten bytes.
  const liar = await lane.importArchive(
    buildZip([
      { data: "bomb", name: "world/level.dat" },
      { data: Buffer.alloc(32 * 1024 * 1024), declaredSize: 10, name: "world/zeros.bin" }
    ]),
    "liar.zip"
  );
  const refusedLiar = await lane.activate(liar);
  assert.equal(refusedLiar.status, 400, refusedLiar.text);
  assert.match(refusedLiar.json.error, /more data .* than it declares/);

  assert.equal(await fsp.readFile(path.join(lane.world, "level.dat"), "utf8"), "demo");
  assert.deepEqual(fs.readdirSync(lane.world), ["level.dat"]);
  assert.deepEqual(lane.staging(), []);
  assert.equal(lane.libraryNames().some((name) => name.includes("pre-activate")), false);

  // A world that fits the limit is still restored.
  const fits = await lane.importArchive(goodWorld("fits"), "fits.zip");
  assert.equal((await lane.activate(fits)).status, 200);
});

test("a world is not unpacked onto a disk that has no room for it", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-full-"));
  t.after(() => fsp.rm(root, { force: true, recursive: true }));
  const serverDir = path.join(root, "servers", "DemoServer");
  await fsp.mkdir(path.join(serverDir, "world"), { recursive: true });
  await fsp.mkdir(path.join(serverDir, ".rippermoon", "world-library"), { recursive: true });
  await fsp.writeFile(path.join(serverDir, "world", "level.dat"), "demo");
  await fsp.writeFile(path.join(serverDir, ".rippermoon", "world-library", "big.zip"), goodWorld("too big for this disk"));

  const store = createStore(root);
  await store.ensureInitialized();
  const serverManager = createServerManager(store);
  await serverManager.syncDiscoveredServers();

  // 1 GB is kept in reserve, so a disk with 1 GB and a little free has room for a little.
  const gigabyte = 1024 * 1024 * 1024;
  const diskWith = (freeBytes) => async () => ({ bavail: BigInt(Math.floor(freeBytes / 4096)), bsize: 4096 });

  const full = createWorldManager(serverManager, { statfs: diskWith(gigabyte + 10_000) });
  await assert.rejects(full.activateWorldArchive("DemoServer", "big.zip"), {
    message: /not enough free disk space/,
    statusCode: 507
  });
  assert.equal(await fsp.readFile(path.join(serverDir, "world", "level.dat"), "utf8"), "demo");
  assert.deepEqual(fs.readdirSync(serverDir).filter((name) => name.startsWith(".rippercraft-restore-")), []);

  const roomy = createWorldManager(serverManager, { statfs: diskWith(gigabyte + 1_000_000) });
  await roomy.activateWorldArchive("DemoServer", "big.zip");
  assert.equal(await fsp.readFile(path.join(serverDir, "world", "level.dat"), "utf8"), "too big for this disk");

  // A filesystem that will not say leaves the limit alone in charge.
  const silent = createWorldManager(serverManager, {
    statfs: async () => {
      throw new Error("not supported");
    }
  });
  await silent.activateWorldArchive("DemoServer", "big.zip");
});

test("a restore that cannot archive the live world first does not delete it", async (t) => {
  const lane = await setUp(t);
  const archiveName = await lane.importArchive(goodWorld("replacement"), "replacement.zip");

  // The library cannot be written to, so the backup of the live world fails.
  await fsp.chmod(lane.library, 0o555);
  let response;
  try {
    response = await lane.activate(archiveName);
  } finally {
    await fsp.chmod(lane.library, 0o755);
  }
  assert.ok(response.status >= 400, response.text);

  // It used to be deleted and replaced regardless, with no copy kept.
  assert.equal(await fsp.readFile(path.join(lane.world, "level.dat"), "utf8"), "demo");
  assert.deepEqual(lane.staging(), []);
});

test("creating a new world does not delete a live one it could not archive", async (t) => {
  const lane = await setUp(t);
  await fsp.mkdir(lane.library, { recursive: true });
  await fsp.chmod(lane.library, 0o555);
  let response;
  try {
    response = await lane.admin("POST", "/api/servers/DemoServer/worlds/create", { json: { name: "fresh" } });
  } finally {
    await fsp.chmod(lane.library, 0o755);
  }
  assert.ok(response.status >= 400, response.text);
  assert.equal(await fsp.readFile(path.join(lane.world, "level.dat"), "utf8"), "demo");
});

test("unpacking folders left by a crash are cleared out by the next restore, recent ones are not", async (t) => {
  const lane = await setUp(t);
  const stale = path.join(lane.serverDir, ".rippercraft-restore-0123456789abcdef");
  const recent = path.join(lane.serverDir, ".rippercraft-restore-fedcba9876543210");
  const unrelated = path.join(lane.serverDir, ".rippercraft-restore-notes");
  for (const directory of [stale, recent, unrelated]) {
    await fsp.mkdir(path.join(directory, "world"), { recursive: true });
    await fsp.writeFile(path.join(directory, "world", "level.dat"), "half");
  }
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await fsp.utimes(stale, twoDaysAgo, twoDaysAgo);
  await fsp.utimes(unrelated, twoDaysAgo, twoDaysAgo);

  assert.equal((await lane.activate(await lane.importArchive(goodWorld(), "next.zip"))).status, 200);

  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(recent), true);
  // Only folders with exactly the name the dashboard gives its own.
  assert.equal(fs.existsSync(unrelated), true);
});

// --- backing up, exporting and downloading ---------------------------------------------------

test("a backup stores a link in the world as a link, never as what it points to", async (t) => {
  const lane = await setUp(t);
  // Put there by a mod, or by hand: not something an archive can do any more.
  await fsp.symlink(lane.outside, path.join(lane.world, "folder-link"));
  await fsp.symlink(path.join(lane.outside, "canary.txt"), path.join(lane.world, "file-link.txt"));

  const captured = await lane.capture("with links");
  assert.equal(captured.status, 200, captured.text);

  const downloaded = await lane.download(`/api/servers/DemoServer/worlds/download?name=${encodeURIComponent(captured.json.archiveName)}`);
  assert.equal(downloaded.status, 200);
  const { contents, names } = everythingIn(downloaded.body);
  // The canary's contents used to be in here, under world/folder-link/ and as
  // world/file-link.txt.
  assert.equal(contents.includes(CANARY), false);
  assert.equal(names.some((name) => name.startsWith("world/folder-link/")), false);
  assert.ok(names.includes("world/level.dat"));

  // What the archive holds for them is the link itself - which is exactly what
  // restoring refuses.
  await assert.rejects(inspectZip(path.join(lane.library, captured.json.archiveName)), { message: /symbolic link/ });
  assert.equal((await lane.activate(captured.json.archiveName)).status, 400);
  // The links, and what they point to, are untouched.
  assert.equal(await fsp.readFile(path.join(lane.outside, "canary.txt"), "utf8"), CANARY);
  assert.equal(fs.lstatSync(path.join(lane.world, "folder-link")).isSymbolicLink(), true);
});

test("an export stores a link in the world as a link too", async (t) => {
  const lane = await setUp(t);
  await fsp.symlink(lane.outside, path.join(lane.world, "folder-link"));
  await fsp.symlink(path.join(lane.outside, "canary.txt"), path.join(lane.world, "file-link.txt"));

  const exported = await lane.download("/api/servers/DemoServer/worlds/export-active");
  assert.equal(exported.status, 200);
  const { contents, names } = everythingIn(exported.body);
  assert.equal(contents.includes(CANARY), false);
  assert.equal(names.some((name) => name.startsWith("world/folder-link/")), false);
  assert.ok(names.includes("world/level.dat"));
});

test("a world folder that is itself a link is not archived, exported or replaced", async (t) => {
  const lane = await setUp(t);
  const archiveName = await lane.importArchive(goodWorld("replacement"), "replacement.zip");
  const before = lane.libraryNames();

  // The whole world folder swapped for a link to somewhere else.
  await fsp.writeFile(path.join(lane.outside, "level.dat"), "not a world of this server");
  await fsp.rm(lane.world, { recursive: true });
  await fsp.symlink(lane.outside, lane.world);

  const captured = await lane.capture("through the link");
  assert.equal(captured.status, 409, captured.text);
  assert.match(captured.json.error, /symbolic link/);
  assert.equal((await lane.download("/api/servers/DemoServer/worlds/export-active")).status, 409);
  assert.equal((await lane.activate(archiveName)).status, 409);
  assert.equal((await lane.admin("POST", "/api/servers/DemoServer/worlds/create", { json: { name: "fresh" } })).status, 409);

  // No archive was made, the link is still a link, and what it points at was
  // neither read into an archive nor deleted.
  assert.deepEqual(lane.libraryNames(), before);
  assert.equal(fs.lstatSync(lane.world).isSymbolicLink(), true);
  assert.equal(await fsp.readFile(path.join(lane.outside, "canary.txt"), "utf8"), CANARY);
  assert.equal(await fsp.readFile(path.join(lane.outside, "level.dat"), "utf8"), "not a world of this server");
  assert.deepEqual(lane.staging(), []);
});

test("a link left in the library under an archive's name is neither listed, downloaded nor restored", async (t) => {
  const lane = await setUp(t);
  await fsp.mkdir(lane.library, { recursive: true });
  await fsp.symlink(path.join(lane.outside, "canary.txt"), path.join(lane.library, "planted.zip"));
  await fsp.writeFile(path.join(lane.library, "real.zip"), goodWorld());

  const listed = (await lane.admin("GET", "/api/servers/DemoServer/worlds")).json.worlds.map((entry) => entry.name);
  assert.ok(listed.includes("real.zip"));
  assert.equal(listed.includes("planted.zip"), false);

  const planted = await lane.download("/api/servers/DemoServer/worlds/download?name=planted.zip");
  assert.equal(planted.status, 404);
  assert.equal(planted.body.toString().includes(CANARY), false);
  assert.equal((await lane.activate("planted.zip")).status, 404);

  // A real archive still downloads, byte for byte.
  const real = await lane.download("/api/servers/DemoServer/worlds/download?name=real.zip");
  assert.equal(real.status, 200);
  assert.ok(real.body.equals(goodWorld()));
});

test("backing up a server with no world yet says so", async (t) => {
  const lane = await setUp(t);
  await fsp.rm(lane.world, { recursive: true });

  const captured = await lane.capture("nothing there");
  assert.equal(captured.status, 409);
  assert.match(captured.json.error, /no world to back up/);
  assert.equal((await lane.download("/api/servers/DemoServer/worlds/export-active")).status, 409);
  assert.deepEqual(lane.libraryNames(), []);

  // Restoring onto it works: there is simply nothing to archive first.
  assert.equal((await lane.activate(await lane.importArchive(goodWorld("first world"), "first.zip"))).status, 200);
  assert.equal(await fsp.readFile(path.join(lane.world, "level.dat"), "utf8"), "first world");
  assert.equal(lane.libraryNames().some((name) => name.includes("pre-activate")), false);
});

// --- the limit setting ---------------------------------------------------------------------------

test("the world limit comes from RIPPERCRAFT_MAX_WORLD_MB, and defaults to 32 GB", (t) => {
  const saved = { ...process.env };
  t.after(() => {
    for (const name of ["RIPPERCRAFT_MAX_WORLD_MB", "RIPPERMOONSTASH_MAX_WORLD_MB"]) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });
  delete process.env.RIPPERCRAFT_MAX_WORLD_MB;
  delete process.env.RIPPERMOONSTASH_MAX_WORLD_MB;
  const megabyte = 1024 * 1024;

  assert.equal(resolveWorldLimitBytes(), 32768 * megabyte);
  process.env.RIPPERCRAFT_MAX_WORLD_MB = "512";
  assert.equal(resolveWorldLimitBytes(), 512 * megabyte);

  const warnings = [];
  for (const value of ["0", "-5", "lots", "NaN"]) {
    process.env.RIPPERCRAFT_MAX_WORLD_MB = value;
    assert.equal(resolveWorldLimitBytes({ warn: (message) => warnings.push(message) }), 32768 * megabyte, value);
  }
  assert.equal(warnings.length, 4);
});
