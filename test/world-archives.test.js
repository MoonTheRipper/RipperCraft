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

// --- more than one request at a time ---------------------------------------------------------

// A server with a world, straight on the managers, for tests that need to hold
// the clock still or stand in for the disk.
async function managedWorld(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-worlds-"));
  t.after(() => fsp.rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 }));
  const serverDir = path.join(root, "servers", "DemoServer");
  const library = path.join(serverDir, ".rippermoon", "world-library");
  await fsp.mkdir(path.join(serverDir, "world", "region"), { recursive: true });
  await fsp.mkdir(library, { recursive: true });
  await fsp.writeFile(path.join(serverDir, "world", "level.dat"), "original");
  await fsp.writeFile(path.join(serverDir, "world", "region", "r.0.0.mca"), Buffer.alloc(300_000, 7));

  const store = createStore(root);
  await store.ensureInitialized();
  const serverManager = createServerManager(store);
  await serverManager.syncDiscoveredServers();
  if (options.record) {
    await store.updateServerRecord("DemoServer", { ...(await serverManager.getServer("DemoServer")), ...options.record });
  }
  const logged = [];
  const logger = { error: (message, details) => logged.push({ details, message }) };
  const worldManager = createWorldManager(serverManager, { logger, ...(options.manager || {}) });
  const levelIn = (archiveName) => execFileSync("unzip", ["-p", path.join(library, archiveName), "world/level.dat"]).toString();
  return { library, levelIn, logged, names: () => fs.readdirSync(library).sort(), root, serverDir, serverManager, worldManager };
}

test("the same restore sent twice at once is done twice, in turn, and loses nothing", async (t) => {
  // A double click. The two requests used to run through each other: both
  // archived the live world under one name, and the one that lost the race
  // deleted the other's finished archive after the world itself was gone.
  for (let round = 0; round < 6; round += 1) {
    const world = await managedWorld(t);
    await fsp.writeFile(path.join(world.library, "incoming.zip"), goodWorld("incoming"));

    const outcomes = await Promise.allSettled([
      world.worldManager.activateWorldArchive("DemoServer", "incoming.zip"),
      world.worldManager.activateWorldArchive("DemoServer", "incoming.zip")
    ]);
    assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled"], String(outcomes.find((outcome) => outcome.reason)?.reason));

    assert.equal(await fsp.readFile(path.join(world.serverDir, "world", "level.dat"), "utf8"), "incoming");
    // One archive of the world that was live, and one of the world the first
    // restore put there - each made before the folder it describes was removed.
    const backups = world.names().filter((name) => name.includes("pre-activate"));
    assert.deepEqual(backups.map(world.levelIn).sort(), ["incoming", "original"], `round ${round}`);
    assert.deepEqual(fs.readdirSync(world.serverDir).filter((name) => name.startsWith(".rippercraft-restore-")), []);
  }
});

test("backups, restores and new worlds asked for together all happen, one after another", async (t) => {
  const world = await managedWorld(t);
  await fsp.writeFile(path.join(world.library, "incoming.zip"), goodWorld("incoming"));

  const outcomes = await Promise.allSettled([
    world.worldManager.captureActiveWorld("DemoServer", "one"),
    world.worldManager.activateWorldArchive("DemoServer", "incoming.zip"),
    world.worldManager.captureActiveWorld("DemoServer", "two"),
    world.worldManager.createExportArchive("DemoServer"),
    world.worldManager.createNewWorld("DemoServer", { name: "fresh" }),
    world.worldManager.captureActiveWorld("DemoServer", "three")
  ]);
  // The export is a folder beside the world; it goes whatever happens below.
  t.after(() => outcomes[3].status === "fulfilled" && outcomes[3].value.cleanup());
  // In the order they were asked for: the last backup finds no world left.
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["fulfilled", "fulfilled", "fulfilled", "fulfilled", "fulfilled", "rejected"]);
  assert.match(outcomes[5].reason.message, /no world to back up/);

  const levels = world.names().filter((name) => name !== "incoming.zip").map((name) => [name.replace(/^[^Z]*Z-/, ""), world.levelIn(name)]);
  assert.deepEqual(levels.map(([, level]) => level).sort(), ["incoming", "incoming", "original", "original"]);
  assert.equal(levels.find(([name]) => name.startsWith("one"))[1], "original");
  assert.equal(levels.find(([name]) => name.startsWith("two"))[1], "incoming");
  assert.equal(fs.existsSync(path.join(world.serverDir, "world")), false);
});

test("a world is zipped for download beside the world folder, and the folder goes afterwards", async (t) => {
  const world = await managedWorld(t);

  const archive = await world.worldManager.createExportArchive("DemoServer");
  t.after(() => archive.cleanup());

  // On the disk the world is on, not in the system's temporary folder: that is
  // often memory, and small for a service that is given one of its own.
  const folder = path.dirname(archive.outputPath);
  assert.equal(path.dirname(folder), world.serverDir);
  assert.match(path.basename(folder), /^\.rippercraft-export-[0-9a-f]{16}$/);
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  assert.equal(execFileSync("unzip", ["-p", archive.outputPath, "world/level.dat"]).toString(), "original");

  await archive.cleanup();
  assert.deepEqual(fs.readdirSync(world.serverDir).filter((name) => name.startsWith(".rippercraft-export-")), []);
});

test("an export folder left by a dashboard that was stopped half-way is cleared once it is a day old", async (t) => {
  const world = await managedWorld(t);
  const stale = path.join(world.serverDir, ".rippercraft-export-0123456789abcdef");
  const recent = path.join(world.serverDir, ".rippercraft-export-fedcba9876543210");
  for (const folder of [stale, recent]) {
    await fsp.mkdir(folder);
    await fsp.writeFile(path.join(folder, "DemoServer-active-world.zip"), "half an archive");
  }
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await fsp.utimes(stale, twoDaysAgo, twoDaysAgo);

  await (await world.worldManager.createExportArchive("DemoServer")).cleanup();

  assert.equal(fs.existsSync(stale), false);
  // Another export may still be on its way to a browser.
  assert.equal(fs.existsSync(recent), true);
});

test("two backups made in the same millisecond are two archives", async (t) => {
  const world = await managedWorld(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-15T12:00:00.000Z") });

  const first = await world.worldManager.captureActiveWorld("DemoServer", "same");
  await fsp.writeFile(path.join(world.serverDir, "world", "level.dat"), "changed since");
  const second = await world.worldManager.captureActiveWorld("DemoServer", "same");

  assert.equal(first.archiveName, "2026-11-15T12-00-00-000Z-same.zip");
  assert.equal(second.archiveName, "2026-11-15T12-00-00-000Z-same-2.zip");
  assert.equal(world.levelIn(first.archiveName), "original");
  assert.equal(world.levelIn(second.archiveName), "changed since");

  // An upload with the name of an archive that is already there goes beside it.
  const upload = path.join(world.library, ".upload-0123456789abcdef.part");
  await fsp.writeFile(upload, goodWorld("uploaded"));
  const imported = await world.worldManager.importWorldArchiveFile("DemoServer", "same.zip", upload);
  assert.equal(imported.archiveName, "2026-11-15T12-00-00-000Z-same-3.zip");
  assert.equal(world.levelIn(first.archiveName), "original");
});

test("a backup that fails removes its own unfinished file and no other archive", async (t) => {
  if (process.getuid && process.getuid() === 0) {
    t.skip("root can read every file, so the backup below would not fail");
    return;
  }
  const world = await managedWorld(t);
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-15T12:00:00.000Z") });

  const kept = await world.worldManager.captureActiveWorld("DemoServer", "same");
  // A file zip cannot read: it gives up on the archive.
  const unreadable = path.join(world.serverDir, "world", "locked.dat");
  await fsp.writeFile(unreadable, "x", { mode: 0o000 });
  t.after(() => fsp.chmod(unreadable, 0o644).catch(() => {}));

  // The same moment and the same label: the name the failed backup would have
  // taken is the name of the archive made a moment ago.
  await assert.rejects(world.worldManager.captureActiveWorld("DemoServer", "same"), {
    message: /could not be archived \(zip stopped with code \d+\)/,
    statusCode: 500
  });
  // What zip said goes to the operator's log, and only there.
  assert.equal(world.logged.length, 1);
  assert.equal(world.logged[0].message, "Archiving a world failed");
  assert.match(world.logged[0].details.output, /Permission denied/);
  assert.match(world.logged[0].details.error, /world-library/);
  assert.deepEqual(world.names(), [kept.archiveName]);
  assert.equal(world.levelIn(kept.archiveName), "original");

  // And a restore that cannot archive the live world first leaves it, and every archive, alone.
  await fsp.writeFile(path.join(world.library, "incoming.zip"), goodWorld("incoming"));
  const failure = await world.worldManager.activateWorldArchive("DemoServer", "incoming.zip").catch((error) => error);
  assert.equal(failure.statusCode, 500);
  // The message is the dashboard's own: no command line, no path on this machine.
  assert.equal(failure.message.includes(world.root), false);
  assert.doesNotMatch(failure.message, /zip -|world-library/);
  assert.equal(await fsp.readFile(path.join(world.serverDir, "world", "level.dat"), "utf8"), "original");
  assert.deepEqual(world.names(), [kept.archiveName, "incoming.zip"].sort());
});

test("a world folder another disk is mounted on is not swapped out", async (t) => {
  // Removing a mounted folder empties it and then fails, and the move into its
  // place fails after that: the server would be left with no world at all.
  const world = await managedWorld(t, { manager: { isMountPoint: async (folder) => folder.endsWith(`${path.sep}world`) } });
  await fsp.writeFile(path.join(world.library, "incoming.zip"), goodWorld("incoming"));

  await assert.rejects(world.worldManager.activateWorldArchive("DemoServer", "incoming.zip"), { message: /another disk is mounted/, statusCode: 409 });
  assert.equal(await fsp.readFile(path.join(world.serverDir, "world", "level.dat"), "utf8"), "original");
  // Refused before the live world was archived: asking again does not fill the library.
  assert.deepEqual(world.names(), ["incoming.zip"]);
  assert.deepEqual(fs.readdirSync(world.serverDir).filter((name) => name.startsWith(".rippercraft-restore-")), []);

  // Backing it up and exporting it only read, and work as anywhere else.
  assert.match((await world.worldManager.captureActiveWorld("DemoServer", "mounted")).archiveName, /mounted\.zip$/);
  await (await world.worldManager.createExportArchive("DemoServer")).cleanup();

  // A new world needs the folder empty, not gone: what is in it is archived
  // and removed, and the folder - the disk - stays where it is.
  await world.worldManager.createNewWorld("DemoServer", { name: "fresh" });
  assert.deepEqual(fs.readdirSync(path.join(world.serverDir, "world")), []);
  const archived = world.names().filter((name) => name.includes("pre-new-world"));
  assert.equal(archived.length, 1);
  assert.equal(world.levelIn(archived[0]), "original");
});

test("the dashboard's own check finds no disk mounted on an ordinary world folder", async (t) => {
  // The check itself, not a stand-in for it: on one disk, everything goes on as before.
  const world = await managedWorld(t);
  await fsp.writeFile(path.join(world.library, "incoming.zip"), goodWorld("incoming"));
  await world.worldManager.activateWorldArchive("DemoServer", "incoming.zip");
  assert.equal(await fsp.readFile(path.join(world.serverDir, "world", "level.dat"), "utf8"), "incoming");
  await world.worldManager.createNewWorld("DemoServer", { name: "fresh" });
  assert.equal(fs.existsSync(path.join(world.serverDir, "world")), false);
});

test("a world folder reached through a link out of the server folder is not written to", async (t) => {
  // The world configured a level down, and that level swapped for a link.
  const world = await managedWorld(t, { record: { worldDir: "saves/world" } });
  const outside = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-outside-"));
  t.after(() => fsp.rm(outside, { force: true, recursive: true }));
  await fsp.symlink(outside, path.join(world.serverDir, "saves"));
  await fsp.writeFile(path.join(world.library, "incoming.zip"), goodWorld("incoming"));

  // There is no world there yet, so nothing is archived first: only the check
  // on where the folder is stands between the archive and the link's target.
  await assert.rejects(world.worldManager.activateWorldArchive("DemoServer", "incoming.zip"), { message: /leads outside the server folder/, statusCode: 409 });
  await assert.rejects(world.worldManager.createNewWorld("DemoServer", { name: "fresh" }), { message: /leads outside the server folder/, statusCode: 409 });
  assert.deepEqual(fs.readdirSync(outside), []);

  // With a world behind the link, it is neither archived nor exported.
  await fsp.mkdir(path.join(outside, "world"));
  await fsp.writeFile(path.join(outside, "world", "level.dat"), CANARY);
  await assert.rejects(world.worldManager.captureActiveWorld("DemoServer", "through"), { statusCode: 409 });
  await assert.rejects(world.worldManager.createExportArchive("DemoServer"), { statusCode: 409 });
  assert.deepEqual(world.names(), ["incoming.zip"]);
  assert.deepEqual(fs.readdirSync(outside), ["world"]);
});

test("every zip the dashboard makes stores a link as a link", () => {
  // -y. Without it zip follows a link and archives what it points to. The
  // world archives above are tested by making one; this holds for any other
  // archive too, including the client modpack, which is built from a folder
  // of the dashboard's own and so has no link in it to test with.
  const source = path.join(__dirname, "..", "src");
  const files = fs.readdirSync(source, { recursive: true }).filter((name) => String(name).endsWith(".js"));
  const calls = files.flatMap((name) =>
    [...fs.readFileSync(path.join(source, String(name)), "utf8").matchAll(/runCommand\(\s*"zip",\s*\[\s*"(-[A-Za-z]+)"/g)].map((match) => [String(name), match[1]])
  );
  assert.deepEqual(calls.map(([name]) => name).sort(), [path.join("lib", "mod-sources.js"), path.join("lib", "worlds.js")]);
  for (const [name, flags] of calls) {
    assert.match(flags, /y/, `${name} runs zip ${flags}`);
  }
  // And nothing runs zip any other way: every program is started through runCommand.
  const started = files.filter((name) => /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*["'`]zip["'`]/.test(fs.readFileSync(path.join(source, String(name)), "utf8")));
  assert.deepEqual(started, []);
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
