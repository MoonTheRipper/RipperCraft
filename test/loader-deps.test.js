const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const zlib = require("node:zlib");

const {
  compareVersions,
  evaluateLoaderCandidate,
  evaluateMinecraftCandidate,
  parseFabricPredicate,
  parseMavenRange,
  readJarTextEntry,
  scanLoaderRequirements
} = require("../src/lib/loader-deps");

// Build a real (stored, uncompressed) zip so the reader is exercised against the
// actual format rather than a stub. Mod jars are just zips with a manifest.
function makeJar(entries) {
  const files = Object.entries(entries).map(([name, contents]) => {
    const nameBuffer = Buffer.from(name, "utf8");
    const dataBuffer = Buffer.from(contents, "utf8");
    return { crc: zlib.crc32(dataBuffer), dataBuffer, nameBuffer };
  });

  const localChunks = [];
  const centralChunks = [];
  let offset = 0;

  for (const file of files) {
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8); // stored
    header.writeUInt32LE(file.crc, 14);
    header.writeUInt32LE(file.dataBuffer.length, 18);
    header.writeUInt32LE(file.dataBuffer.length, 22);
    header.writeUInt16LE(file.nameBuffer.length, 26);
    header.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // stored
    central.writeUInt32LE(file.crc, 16);
    central.writeUInt32LE(file.dataBuffer.length, 20);
    central.writeUInt32LE(file.dataBuffer.length, 24);
    central.writeUInt16LE(file.nameBuffer.length, 28);
    central.writeUInt32LE(offset, 42);

    localChunks.push(header, file.nameBuffer, file.dataBuffer);
    centralChunks.push(central, file.nameBuffer);
    offset += header.length + file.nameBuffer.length + file.dataBuffer.length;
  }

  const centralBuffer = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localChunks, centralBuffer, eocd]);
}

function fabricJar(id, name, loaderRange, minecraftRange) {
  return makeJar({
    "fabric.mod.json": JSON.stringify({
      depends: {
        ...(loaderRange ? { fabricloader: loaderRange } : {}),
        ...(minecraftRange ? { minecraft: minecraftRange } : {})
      },
      id,
      name,
      version: "1.0.0"
    })
  });
}

test("version comparison orders loader builds numerically, not lexically", () => {
  // The bug this guards: "0.19.10" < "0.19.9" under string comparison, which
  // would pick the wrong floor and silently allow an unusable build.
  assert.equal(compareVersions("0.19.10", "0.19.9") > 0, true);
  assert.equal(compareVersions("0.19.2", "0.19.3") < 0, true);
  assert.equal(compareVersions("0.19.3", "0.19.3"), 0);
  assert.equal(compareVersions("47.4.10", "47.4.9") > 0, true);
  // A release outranks its own prereleases.
  assert.equal(compareVersions("1.0.0", "1.0.0-beta") > 0, true);
});

test("fabric version predicates yield the strictest lower bound", () => {
  assert.deepEqual(parseFabricPredicate(">=0.19.3"), { min: "0.19.3", minInclusive: true });
  assert.equal(parseFabricPredicate("*"), null);
  assert.equal(parseFabricPredicate(">0.16.0").minInclusive, false);
  // ANDed terms: the higher floor wins.
  assert.equal(parseFabricPredicate(">=0.15.0 <0.20.0").min, "0.15.0");
  // Caret and tilde carry an upper bound too, which is what makes a downgrade
  // check able to reject a build that is too *new*.
  assert.deepEqual(parseFabricPredicate("^1.2.3"), {
    exclusiveMax: "2.0.0",
    min: "1.2.3",
    minInclusive: true
  });
  assert.equal(parseFabricPredicate("~1.2.3").exclusiveMax, "1.3.0");
});

test("maven ranges from mods.toml resolve their bounds", () => {
  assert.deepEqual(parseMavenRange("[47,)"), {
    exclusiveMax: null,
    inclusiveMax: null,
    min: "47",
    minInclusive: true
  });
  assert.equal(parseMavenRange("(47,)").minInclusive, false);
  assert.equal(parseMavenRange("[47.1,48)").exclusiveMax, "48");
  // Maven's "soft" requirement, which Forge treats as a minimum.
  assert.equal(parseMavenRange("47").min, "47");
  assert.equal(parseMavenRange("*"), null);
});

test("scanning a mods folder reports the loader floor and every mod that sets it", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rms-loaderdeps-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await fsp.writeFile(path.join(root, "old-mod.jar"), fabricJar("old", "Old Mod", ">=0.15.0"));
  await fsp.writeFile(path.join(root, "strict-mod.jar"), fabricJar("strict", "Strict Mod", ">=0.19.3"));
  await fsp.writeFile(path.join(root, "also-strict.jar"), fabricJar("also", "Also Strict", ">=0.19.3"));
  await fsp.writeFile(path.join(root, "anything.jar"), fabricJar("any", "Anything", "*"));
  // A library jar with no fabric.mod.json constrains nothing and must not be
  // mistaken for an unreadable one.
  await fsp.writeFile(path.join(root, "plain-library.jar"), makeJar({ "META-INF/MANIFEST.MF": "Manifest-Version: 1.0\n" }));
  await fsp.writeFile(path.join(root, "corrupt.jar"), Buffer.from("this is not a zip archive at all"));

  const scan = await scanLoaderRequirements(root, "fabric");

  assert.equal(scan.supported, true);
  assert.equal(scan.floor.version, "0.19.3");
  assert.deepEqual(
    scan.floor.requiredBy.map((mod) => mod.name).sort(),
    ["Also Strict", "Strict Mod"]
  );
  assert.deepEqual(scan.unreadable.map((entry) => entry.fileName), ["corrupt.jar"]);
  // 4 mods with metadata; the library and the corrupt jar are not among them.
  assert.equal(scan.mods.length, 4);
});

test("a loader build below the floor is rejected and names the mods responsible", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rms-loadercand-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await fsp.writeFile(path.join(root, "worldedit-items.jar"), fabricJar("worldedit_items", "WorldEdit Items", ">=0.19.3"));
  await fsp.writeFile(path.join(root, "relaxed.jar"), fabricJar("relaxed", "Relaxed Mod", ">=0.16.0"));

  const scan = await scanLoaderRequirements(root, "fabric");

  const tooOld = evaluateLoaderCandidate(scan, "0.19.2");
  assert.equal(tooOld.compatible, false);
  assert.deepEqual(tooOld.conflicts.map((conflict) => conflict.name), ["WorldEdit Items"]);

  assert.equal(evaluateLoaderCandidate(scan, "0.19.3").compatible, true);
  assert.equal(evaluateLoaderCandidate(scan, "0.20.0").compatible, true);

  // Downgrading far enough trips both mods.
  assert.equal(evaluateLoaderCandidate(scan, "0.15.0").conflicts.length, 2);
});

test("a game version outside a mod's declared range is reported separately from the loader", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rms-mcrange-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  await fsp.writeFile(path.join(root, "pinned.jar"), fabricJar("pinned", "Pinned Mod", ">=0.16.0", "~1.21.4"));

  const scan = await scanLoaderRequirements(root, "fabric");

  assert.equal(evaluateMinecraftCandidate(scan, "1.21.4").compatible, true);
  assert.equal(evaluateMinecraftCandidate(scan, "1.21.8").compatible, true);
  const tooNew = evaluateMinecraftCandidate(scan, "1.22.0");
  assert.equal(tooNew.compatible, false);
  assert.deepEqual(tooNew.conflicts.map((conflict) => conflict.name), ["Pinned Mod"]);
  // The loader is fine at that game version; only the game constraint failed.
  assert.equal(evaluateLoaderCandidate(scan, "0.19.3").compatible, true);
});

test("forge mods.toml dependency ranges drive the same floor", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rms-forgedeps-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const modsToml = `
modLoader="javafml"
loaderVersion="[47,)"

[[mods]]
modId="examplemod"
displayName="Example Mod"
version="1.0.0"

[[dependencies.examplemod]]
    modId="forge"
    mandatory=true
    versionRange="[47.2.0,)"
    ordering="NONE"
    side="BOTH"

[[dependencies.examplemod]]
    modId="minecraft"
    mandatory=true
    versionRange="[1.20.1,1.21)"
    ordering="NONE"
    side="BOTH"
`;
  await fsp.writeFile(path.join(root, "example.jar"), makeJar({ "META-INF/mods.toml": modsToml }));

  const scan = await scanLoaderRequirements(root, "forge");

  assert.equal(scan.floor.version, "47.2.0");
  assert.equal(scan.floor.requiredBy[0].name, "Example Mod");
  assert.equal(evaluateLoaderCandidate(scan, "47.1.0").compatible, false);
  assert.equal(evaluateLoaderCandidate(scan, "47.4.10").compatible, true);
  // The minecraft range is bounded above, so 1.21 is out of range.
  assert.equal(evaluateMinecraftCandidate(scan, "1.20.1").compatible, true);
  assert.equal(evaluateMinecraftCandidate(scan, "1.21").compatible, false);
});

test("a jar entry can be read back out for loader version detection", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rms-jarentry-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  const jarPath = path.join(root, "fabric-server-launch.jar");
  await fsp.writeFile(
    jarPath,
    makeJar({ "install.properties": "fabric-loader-version=0.19.2\ngame-version=26.1.2" })
  );

  const contents = await readJarTextEntry(jarPath, "install.properties");
  assert.match(contents, /fabric-loader-version=0\.19\.2/);
  assert.equal(await readJarTextEntry(jarPath, "missing.txt"), null);
});

test("a deflated jar entry is inflated, not just read raw", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rms-deflate-"));
  t.after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  // Real mod jars are deflated; makeJar stores, so this covers the other branch
  // using a jar produced the way tooling actually produces them.
  const manifest = JSON.stringify({ depends: { fabricloader: ">=0.19.3" }, id: "deflated", name: "Deflated Mod" });
  const data = zlib.deflateRawSync(Buffer.from(manifest, "utf8"));
  const nameBuffer = Buffer.from("fabric.mod.json", "utf8");
  const uncompressedLength = Buffer.byteLength(manifest, "utf8");
  const crc = zlib.crc32(Buffer.from(manifest, "utf8"));

  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(8, 8); // deflate
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(uncompressedLength, 22);
  header.writeUInt16LE(nameBuffer.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); // deflate
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(uncompressedLength, 24);
  central.writeUInt16LE(nameBuffer.length, 28);
  central.writeUInt32LE(0, 42);

  const centralBuffer = Buffer.concat([central, nameBuffer]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(header.length + nameBuffer.length + data.length, 16);

  await fsp.writeFile(
    path.join(root, "deflated.jar"),
    Buffer.concat([header, nameBuffer, data, centralBuffer, eocd])
  );

  const scan = await scanLoaderRequirements(root, "fabric");
  assert.equal(scan.unreadable.length, 0);
  assert.equal(scan.floor.version, "0.19.3");
});
