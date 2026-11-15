const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { assertPlainTree, extractZip, inspectZip } = require("../src/lib/zip-extract");
const { buildZip } = require("../test-support/zip");

// A place to unpack into, with a sibling to catch anything that climbs out.
async function workspace(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-zip-"));
  t.after(() => fsp.rm(base, { force: true, recursive: true }));
  const target = path.join(base, "target");
  await fsp.mkdir(target);
  return {
    archive: path.join(base, "archive.zip"),
    base,
    target,
    async write(entries, options) {
      await fsp.writeFile(path.join(base, "archive.zip"), Buffer.isBuffer(entries) ? entries : buildZip(entries, options));
      return path.join(base, "archive.zip");
    }
  };
}

// Every path under a folder, relative to it, with what kind of thing each is.
function listTree(root) {
  const found = [];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const stats = fs.lstatSync(full);
      const relative = path.relative(root, full);
      if (stats.isDirectory()) {
        found.push(`${relative}/`);
        walk(full);
      } else {
        found.push(stats.isFile() ? relative : `${relative} (not a file)`);
      }
    }
  };
  walk(root);
  return found;
}

async function refused(space, entries, options, expected) {
  const archive = await space.write(entries, options);
  await assert.rejects(inspectZip(archive, expected.limits), expected.error, "inspecting");
  await assert.rejects(extractZip(archive, space.target, expected.limits), expected.error, "unpacking");
  // Refused on its list of contents: before anything was written, anywhere.
  assert.deepEqual(listTree(space.target), []);
  assert.deepEqual(fs.readdirSync(space.base).sort(), ["archive.zip", "target"]);
}

// --- ordinary archives -----------------------------------------------------------

test("an ordinary world unpacks to exactly what was packed", async (t) => {
  const space = await workspace(t);
  const region = crypto.randomBytes(3 * 1024 * 1024);
  const repetitive = Buffer.alloc(2 * 1024 * 1024, "chunk ");
  const contents = {
    "world/data packs/pack one/pack.mcmeta": '{"pack":{}}',
    "world/level.dat": "level",
    "world/playerdata/empty.dat": "",
    "world/region/r.0.0.mca": region,
    "world/region/r.0.1.mca": repetitive,
    "world/stored.bin": "kept as it is"
  };
  const archive = await space.write([
    { name: "world/" },
    { name: "world/empty-folder/" },
    ...Object.entries(contents).map(([name, data]) => ({ data, method: name.endsWith("stored.bin") ? "store" : undefined, name }))
  ]);

  const total = Object.values(contents).reduce((sum, data) => sum + Buffer.byteLength(data), 0);
  // Six folders: the two that are listed and the four the paths pass through.
  // Each is charged a 4 KB block against the limit, on top of the files.
  const summary = { directories: 6, files: 6, totalBytes: total, weight: total + 6 * 4096 };
  assert.deepEqual(await inspectZip(archive), summary);
  assert.deepEqual(await extractZip(archive, space.target), summary);

  assert.deepEqual(listTree(space.target), [
    "world/",
    "world/data packs/",
    "world/data packs/pack one/",
    "world/data packs/pack one/pack.mcmeta",
    "world/empty-folder/",
    "world/level.dat",
    "world/playerdata/",
    "world/playerdata/empty.dat",
    "world/region/",
    "world/region/r.0.0.mca",
    "world/region/r.0.1.mca",
    "world/stored.bin"
  ]);
  for (const [name, data] of Object.entries(contents)) {
    assert.ok(Buffer.from(data).equals(await fsp.readFile(path.join(space.target, name))), name);
  }
  // What is on disk afterwards weighs exactly what the archive said it would.
  assert.deepEqual(await assertPlainTree(space.target), summary);
});

test("an archive made by the zip command unpacks to the folder it was made from", async (t) => {
  const space = await workspace(t);
  const source = path.join(space.base, "source");
  await fsp.mkdir(path.join(source, "world", "region"), { recursive: true });
  await fsp.mkdir(path.join(source, "world", "empty"));
  await fsp.writeFile(path.join(source, "world", "level.dat"), "level");
  await fsp.writeFile(path.join(source, "world", "region", "r.0.0.mca"), crypto.randomBytes(1_500_000));
  await fsp.writeFile(path.join(source, "world", "region", "r.0.1.mca"), Buffer.alloc(1_500_000, 7));
  await fsp.writeFile(path.join(source, "world", "name with spaces.txt"), "x");
  execFileSync("zip", ["-rq", space.archive, "world"], { cwd: source });

  await extractZip(space.archive, space.target);
  execFileSync("diff", ["-r", path.join(source, "world"), path.join(space.target, "world")]);
  await fsp.rm(source, { recursive: true });
});

test("archives past 4 GB or 65,535 entries are laid out differently, and are read", async (t) => {
  const entries = [
    { name: "world/" },
    { data: "level", name: "world/level.dat" },
    { data: Buffer.alloc(200_000, "region "), name: "world/region/r.0.0.mca" },
    { data: "stored", method: "store", name: "world/stored.bin" }
  ];
  const layouts = {
    "every field moved": [entries.map((entry) => ({ ...entry, zip64: "all" })), {}],
    "only the offsets moved": [entries.map((entry) => ({ ...entry, zip64: "offset" })), {}],
    "only the sizes moved": [entries.map((entry) => ({ ...entry, zip64: "sizes" })), {}],
    "the end record moved": [entries, { zip64End: true }],
    "both, with a comment": [entries.map((entry) => ({ ...entry, zip64: "all" })), { comment: "made by hand", zip64End: true }]
  };
  for (const [label, [list, options]] of Object.entries(layouts)) {
    const space = await workspace(t);
    const archive = await space.write(list, options);
    assert.deepEqual(await extractZip(archive, space.target), { directories: 2, files: 3, totalBytes: 200_011, weight: 200_011 + 2 * 4096 }, label);
    assert.equal(await fsp.readFile(path.join(space.target, "world", "level.dat"), "utf8"), "level", label);
    assert.equal((await fsp.stat(path.join(space.target, "world", "region", "r.0.0.mca"))).size, 200_000, label);
  }
});

test("sizes written after the data rather than before it are still found", async (t) => {
  const space = await workspace(t);
  // How a zip written to a pipe looks: the local header says nothing.
  const archive = await space.write([
    { data: "level", descriptor: true, name: "world/level.dat" },
    { data: Buffer.alloc(1_200_000, "x"), descriptor: true, name: "world/big.bin" }
  ]);
  assert.deepEqual(await extractZip(archive, space.target), { directories: 1, files: 2, totalBytes: 1_200_005, weight: 1_200_005 + 4096 });
  assert.equal(await fsp.readFile(path.join(space.target, "world", "level.dat"), "utf8"), "level");
});

test("a name is taken from the archive's directory, never from the header beside the data", async (t) => {
  const space = await workspace(t);
  const archive = await space.write([
    { data: "level", name: "world/level.dat" },
    { data: "payload", localName: "../../outside.txt", name: "world/inside.txt" }
  ]);
  await extractZip(archive, space.target);
  assert.deepEqual(listTree(space.target), ["world/", "world/inside.txt", "world/level.dat"]);
  assert.deepEqual(fs.readdirSync(space.base).sort(), ["archive.zip", "target"]);
});

test("backslashes are separators, as the Windows tools that write them mean", async (t) => {
  const space = await workspace(t);
  const archive = await space.write([{ data: "level", name: "world\\level.dat" }, { name: "world\\region\\" }]);
  await extractZip(archive, space.target);
  assert.deepEqual(listTree(space.target), ["world/", "world/level.dat", "world/region/"]);
});

// --- links and other things that are not files ---------------------------------------

test("an archive holding a symbolic link is refused, and nothing is unpacked", async (t) => {
  for (const [label, link] of Object.entries({
    "a link to a folder": { name: "world/link", symlink: "/etc" },
    "a link to a file": { name: "world/secret.txt", symlink: "../../../data/users.json" },
    "a link whose name looks like a folder": { name: "world/link/", symlink: "/etc" },
    "a link at the top": { name: "world", symlink: "/home" },
    "a link from a Mac": { madeBy: 0x1315, name: "world/link", symlink: "/etc" }
  })) {
    const space = await workspace(t);
    await refused(space, [{ data: "level", name: "world/level.dat" }, link, { data: "after", name: "world/after.txt" }], undefined, {
      error: { message: /holds a symbolic link/, statusCode: 400 }
    });
    assert.ok(label);
  }
});

test("devices, pipes and sockets in an archive are refused too", async (t) => {
  for (const mode of [0o010644, 0o020644, 0o060644, 0o140644]) {
    const space = await workspace(t);
    await refused(space, [{ data: "level", name: "world/level.dat" }, { mode, name: "world/special" }], undefined, {
      error: { message: /neither a file nor a folder/, statusCode: 400 }
    });
  }
});

// --- paths -------------------------------------------------------------------------------

test("a path that leads out of the folder is refused, however it is spelled", async (t) => {
  const escapes = [
    "../outside.txt",
    "world/../../outside.txt",
    "world/./../../outside.txt",
    "/tmp/outside.txt",
    "//server/share/outside.txt",
    "..\\outside.txt",
    "world\\..\\..\\outside.txt",
    "C:/outside.txt",
    "C:\\outside.txt",
    "..",
    "world/.."
  ];
  for (const name of escapes) {
    const space = await workspace(t);
    await refused(space, [{ data: "level", name: "world/level.dat" }, { data: "escaped", name }], undefined, {
      error: { statusCode: 400 }
    });
  }
});

test("names with control characters, or too long to create, are refused", async (t) => {
  for (const name of ["world/a\nb.txt", "world/a\rb.txt", "world/\u0000.txt", "world/a\u001bb", `world/${"n".repeat(256)}`, `world/${"\u00e9".repeat(128)}`, `${"d/".repeat(600)}f`]) {
    const space = await workspace(t);
    await refused(space, [{ data: "level", name: "world/level.dat" }, { data: "x", name }], undefined, {
      error: { statusCode: 400 }
    });
  }
});

// --- size ----------------------------------------------------------------------------------

test("an archive that unpacks to more than the limit is refused before anything is written", async (t) => {
  const space = await workspace(t);
  // 64 MB of zeros in about 64 KB of archive.
  const entries = [{ data: "level", name: "world/level.dat" }, { data: Buffer.alloc(64 * 1024 * 1024), name: "world/zeros.bin" }];
  const archive = await space.write(entries);
  assert.ok((await fsp.stat(archive)).size < 200_000);

  await refused(space, entries, undefined, {
    error: { message: /unpacks to 64 MB, and the limit is 16 MB/, statusCode: 413 },
    limits: { maxBytes: 16 * 1024 * 1024 }
  });
  // The same archive is fine under a limit it fits.
  assert.equal((await extractZip(archive, space.target, { maxBytes: 65 * 1024 * 1024 })).totalBytes, 64 * 1024 * 1024 + 5);
  // The limit is exact: its files and its one folder, to the byte.
  const exact = 64 * 1024 * 1024 + 5 + 4096;
  assert.equal((await inspectZip(archive, { maxBytes: exact })).weight, exact);
  await assert.rejects(inspectZip(archive, { maxBytes: exact - 1 }), { statusCode: 413 });
});

test("the limit counts every entry, so many small ones add up", async (t) => {
  const space = await workspace(t);
  const entries = Array.from({ length: 40 }, (_unused, index) => ({ data: Buffer.alloc(1024 * 1024), name: `world/part-${index}.bin` }));
  await refused(space, entries, undefined, {
    error: { statusCode: 413 },
    limits: { maxBytes: 39 * 1024 * 1024 }
  });
});

test("an entry that holds more than its header declares stops the unpacking", async (t) => {
  // The header says ten bytes; the data is far more. unzip writes all of it.
  for (const [label, real, declared] of [
    ["a small claim", 4 * 1024 * 1024, 10],
    ["a claim just under the truth", 6 * 1024 * 1024, 6 * 1024 * 1024 - 1],
    ["a large claim", 24 * 1024 * 1024, 2 * 1024 * 1024]
  ]) {
    const space = await workspace(t);
    const archive = await space.write([
      { data: "level", name: "world/level.dat" },
      { data: Buffer.alloc(real), declaredSize: declared, name: "world/liar.bin" }
    ]);
    // Its list of contents looks harmless, and passes the limit.
    assert.equal((await inspectZip(archive, { maxBytes: 8 * 1024 * 1024 })).totalBytes, declared + 5, label);

    await assert.rejects(
      extractZip(archive, space.target, { maxBytes: 8 * 1024 * 1024 }),
      { message: /holds more data .* than it declares/, statusCode: 400 },
      label
    );
    // Whatever reached the disk is no more than was declared.
    const written = await fsp.stat(path.join(space.target, "world", "liar.bin")).then((stats) => stats.size, () => 0);
    assert.ok(written <= declared, `${label}: ${written} bytes written`);
  }
});

test("an archive with more entries than the limit is refused", async (t) => {
  const space = await workspace(t);
  const entries = Array.from({ length: 12 }, (_unused, index) => ({ data: "x", name: `world/f${index}` }));
  await refused(space, entries, undefined, {
    error: { message: /holds 12 entries; at most 10/, statusCode: 413 },
    limits: { maxEntries: 10 }
  });
});

test("folders count against the limit, listed or only passed through", async (t) => {
  // An empty folder holds no bytes and still takes a block of the disk. A
  // hundred kilobytes of archive used to make fifty thousand of them under a
  // limit of one byte.
  const listed = Array.from({ length: 400 }, (_unused, index) => ({ name: `world/empty-${index}/` }));
  const implied = Array.from({ length: 20 }, (_unused, index) => ({ data: "x", name: `world/${Array.from({ length: 30 }, (_u, depth) => `d${index}-${depth}`).join("/")}/f` }));

  for (const [label, entries, folders] of [["listed", listed, 401], ["passed through", implied, 601]]) {
    const space = await workspace(t);
    const archive = await space.write(entries);
    const summary = await inspectZip(archive);
    assert.equal(summary.directories, folders, label);
    assert.equal(summary.weight, summary.totalBytes + folders * 4096, label);

    await refused(space, entries, undefined, {
      error: { message: /unpacks to .* and the limit is/, statusCode: 413 },
      limits: { maxBytes: 100 * 4096 }
    });
    // And they are counted with the files against the number of entries: the
    // twenty paths below are twenty entries, and six hundred and one folders.
    await refused(space, entries, undefined, {
      error: { message: label === "listed" ? /holds 400 entries; at most 300/ : /more than 300 files and folders/, statusCode: 413 },
      limits: { maxEntries: 300 }
    });
    assert.equal((await extractZip(archive, space.target, { maxBytes: summary.weight, maxEntries: folders + entries.length })).directories, folders, label);
  }
});

test("a path may only go so deep", async (t) => {
  const path64 = `${Array.from({ length: 63 }, (_unused, index) => `d${index}`).join("/")}/level.dat`;
  const path65 = `d/${path64}`;

  const fits = await workspace(t);
  assert.equal((await extractZip(await fits.write([{ data: "x", name: path64 }]), fits.target)).directories, 63);

  for (const name of [path65, `${"a/".repeat(200)}f`, `${"a/".repeat(65)}`]) {
    const space = await workspace(t);
    await refused(space, [{ data: "level", name: "world/level.dat" }, { data: "x", name }], undefined, {
      error: { message: /more than 64 folders deep/, statusCode: 400 }
    });
  }
});

test("a path written with ./ in front is the path without it", async (t) => {
  const space = await workspace(t);
  // How bsdtar and other tar-like tools write a zip: "./" first, then "./name".
  const archive = await space.write([
    { name: "./" },
    { name: "./world/" },
    { data: "level", name: "./world/level.dat" },
    { data: "region", name: "./world/./region/r.0.0.mca" },
    { data: "x", name: "world//doubled/slash.txt" }
  ]);
  assert.deepEqual(await extractZip(archive, space.target), { directories: 3, files: 3, totalBytes: 12, weight: 12 + 3 * 4096 });
  assert.deepEqual(listTree(space.target), ["world/", "world/doubled/", "world/doubled/slash.txt", "world/level.dat", "world/region/", "world/region/r.0.0.mca"]);

  // ".." is still what it always was.
  const climbing = await workspace(t);
  await refused(climbing, [{ data: "x", name: "./../outside.txt" }], undefined, { error: { message: /leads outside/, statusCode: 400 } });
  const nameless = await workspace(t);
  await refused(nameless, [{ data: "x", name: "./." }], undefined, { error: { statusCode: 400 } });
});

test("a very long list of contents is read in pieces, so other work is not held up", async (t) => {
  const space = await workspace(t);
  const entries = Array.from({ length: 30_000 }, (_unused, index) => ({ name: `world/region-${index % 300}/chunks/empty-${index}.dat` }));
  const archive = await space.write(entries);

  // Something else the dashboard has to keep doing meanwhile: how many turns
  // does it get while the list is read? Read in one go it got a handful, one
  // each time the file was touched, and for a list as long as an archive may
  // carry nothing else was answered for seconds.
  let turns = 0;
  let reading = true;
  const takeTurn = () => {
    if (reading) {
      turns += 1;
      setImmediate(takeTurn);
    }
  };
  setImmediate(takeTurn);
  try {
    const summary = await inspectZip(archive);
    assert.equal(summary.files, 30_000);
    assert.equal(summary.directories, 601);
  } finally {
    reading = false;
  }
  // 30,000 entries four names deep is 150,000 steps, taken 2,000 at a time.
  assert.ok(turns >= 60, `other work got ${turns} turns`);
});

test("the caller can stop an unpacking after the checks and before anything is written", async (t) => {
  const space = await workspace(t);
  const archive = await space.write([{ data: "level", name: "world/level.dat" }]);
  const seen = [];

  await assert.rejects(
    extractZip(archive, space.target, {
      beforeWriting: async (summary) => {
        seen.push(summary);
        throw Object.assign(new Error("not now"), { statusCode: 507 });
      }
    }),
    { message: "not now" }
  );
  assert.deepEqual(seen, [{ directories: 1, files: 1, totalBytes: 5, weight: 5 + 4096 }]);
  assert.deepEqual(listTree(space.target), []);

  // It is not asked about an archive that failed a check of its own.
  const hostile = await space.write([{ data: "level", name: "world/level.dat" }, { name: "world/link", symlink: "/etc" }]);
  await assert.rejects(extractZip(hostile, space.target, { beforeWriting: async () => seen.push("asked") }), { statusCode: 400 });
  assert.equal(seen.length, 1);
});

// --- damaged, encrypted and unsupported archives ------------------------------------------

test("a file whose contents do not match its checksum is refused", async (t) => {
  const space = await workspace(t);
  for (const data of ["small", Buffer.alloc(1_500_000, "large ")]) {
    const archive = await space.write([{ data, declaredCrc: 0x12345678, name: "world/level.dat" }]);
    await assert.rejects(extractZip(archive, space.target), { message: /does not match its checksum/, statusCode: 400 });
    await fsp.rm(path.join(space.target, "world"), { force: true, recursive: true });
  }
});

test("an entry that declares more than it holds is refused", async (t) => {
  const space = await workspace(t);
  const archive = await space.write([{ data: "short", declaredSize: 5000, name: "world/level.dat" }]);
  await assert.rejects(extractZip(archive, space.target), { statusCode: 400 });
});

test("the same name twice, or a file where a folder is needed, is refused", async (t) => {
  for (const entries of [
    [{ data: "one", name: "world/level.dat" }, { data: "two", name: "world/level.dat" }],
    [{ data: "a file", name: "world/region" }, { data: "inside it", name: "world/region/r.0.0.mca" }],
    [{ data: "inside it", name: "world/region/r.0.0.mca" }, { data: "a file", name: "world/region" }]
  ]) {
    const space = await workspace(t);
    const archive = await space.write(entries);
    await assert.rejects(extractZip(archive, space.target), { message: /more than once|both a file and a folder/, statusCode: 400 });
  }
});

test("encrypted archives and compression the dashboard cannot read are refused by name", async (t) => {
  const encrypted = await workspace(t);
  await refused(encrypted, [{ data: "level", flags: 0x0001, name: "world/level.dat" }], undefined, {
    error: { message: /is encrypted/, statusCode: 400 }
  });

  for (const [methodNumber, name] of [[9, "Deflate64"], [12, "bzip2"], [14, "LZMA"], [93, "Zstandard"], [77, "method 77"]]) {
    const space = await workspace(t);
    await refused(space, [{ data: "level", methodNumber, name: "world/level.dat" }], undefined, {
      error: { message: new RegExp(`compressed with ${name}`), statusCode: 400 }
    });
  }
});

test("a file that is not a zip, or only part of one, is refused", async (t) => {
  const whole = buildZip([{ data: "level", name: "world/level.dat" }, { data: Buffer.alloc(50_000, "x"), name: "world/big.bin" }]);
  const cases = {
    "an empty file": Buffer.alloc(0),
    "a few bytes": Buffer.from("PK"),
    "random bytes": crypto.randomBytes(4096),
    "text": Buffer.from("this is not a zip archive at all, just a sentence long enough to be read"),
    "a zip cut off at the end": whole.subarray(0, whole.length - 30),
    "a zip cut off in the middle": whole.subarray(0, 40),
    "a zip with its directory pointing past the end": (() => {
      const copy = Buffer.from(whole);
      copy.writeUInt32LE(whole.length + 1000, whole.length - 6);
      return copy;
    })(),
    "a zip split across disks": buildZip([{ data: "level", name: "world/level.dat" }], { disk: 1 })
  };
  for (const [label, bytes] of Object.entries(cases)) {
    const space = await workspace(t);
    const archive = await space.write(bytes);
    await assert.rejects(inspectZip(archive), { statusCode: 400 }, label);
    await assert.rejects(extractZip(archive, space.target), { statusCode: 400 }, label);
    assert.deepEqual(listTree(space.target), [], label);
  }
});

test("corrupt compressed data is refused as damage, not as a fault", async (t) => {
  const space = await workspace(t);
  const data = crypto.randomBytes(2_000_000);
  const whole = buildZip([{ data, name: "world/region.mca" }]);
  // Scribble over the middle of the compressed stream.
  whole.fill(0xff, 5000, 9000);
  const archive = await space.write(whole);
  await assert.rejects(extractZip(archive, space.target), { statusCode: 400 });
});

// --- the check on what is on disk -------------------------------------------------------------

test("a folder of files and folders passes; a link or a pipe anywhere in it does not", async (t) => {
  const space = await workspace(t);
  const root = space.target;
  await fsp.mkdir(path.join(root, "world", "region"), { recursive: true });
  await fsp.writeFile(path.join(root, "world", "level.dat"), "level");
  await fsp.writeFile(path.join(root, "world", "region", "r.0.0.mca"), Buffer.alloc(1000));
  const plain = { directories: 2, files: 2, totalBytes: 1005, weight: 1005 + 2 * 4096 };
  assert.deepEqual(await assertPlainTree(root), plain);
  assert.deepEqual(await assertPlainTree(root, { maxBytes: plain.weight }), plain);
  await assert.rejects(assertPlainTree(root, { maxBytes: plain.weight - 1 }), { statusCode: 413 });

  const outside = path.join(space.base, "outside");
  await fsp.mkdir(outside);
  await fsp.writeFile(path.join(outside, "secret.txt"), "secret");

  const offenders = {
    "a link to a file": (target) => fsp.symlink(path.join(outside, "secret.txt"), target),
    "a link to a folder": (target) => fsp.symlink(outside, target),
    "a link to nothing": (target) => fsp.symlink(path.join(outside, "missing"), target),
    "a link to something inside": (target) => fsp.symlink("level.dat", target),
    "a named pipe": async (target) => execFileSync("mkfifo", [target])
  };
  for (const [label, plant] of Object.entries(offenders)) {
    const planted = path.join(root, "world", "region", "planted");
    await plant(planted);
    await assert.rejects(assertPlainTree(root), { message: /world\/region\/planted.*not allowed/, statusCode: 409 }, label);
    await fsp.rm(planted, { force: true });
  }
  assert.deepEqual(await assertPlainTree(root), plain);

  // The folder being checked has to be a real one itself.
  const alias = path.join(space.base, "alias");
  await fsp.symlink(root, alias);
  await assert.rejects(assertPlainTree(alias), { message: /is not a folder/, statusCode: 409 });
});
