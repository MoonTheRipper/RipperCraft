const crypto = require("node:crypto");
const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { HttpError, describeBytes } = require("./http");
const { ensureDir, nowIso, readEnv, runCommand, safeFilename, withinParent } = require("./utils");
const { invalid, normalizeLevelType, propertyValue, singleLine } = require("./validate");
const { assertPlainTree, extractZip, inspectZip } = require("./zip-extract");

// The largest world, measured unpacked, that an archive may hold. A zip can be
// tiny and still unpack to more than the disk has room for.
const DEFAULT_WORLD_LIMIT_MB = 32768;
// Left free on the disk after a world has been unpacked onto it. The game
// servers save to the same disk, and a save that runs out of space corrupts.
const FREE_SPACE_RESERVE_BYTES = 1024 * 1024 * 1024;

// Where an archive is unpacked before it becomes the world: a folder beside
// the world folder, so that putting it in place is a rename and never a copy.
const STAGING_PREFIX = ".rippercraft-restore-";
const STAGING_NAME = /^\.rippercraft-restore-[0-9a-f]{16}$/;
const STALE_STAGING_AGE_MS = 24 * 60 * 60 * 1000;

// The limit in bytes, from RIPPERCRAFT_MAX_WORLD_MB.
function resolveWorldLimitBytes(logger) {
  const raw = readEnv("MAX_WORLD_MB");
  if (!raw) {
    return DEFAULT_WORLD_LIMIT_MB * 1024 * 1024;
  }
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    if (logger) {
      logger.warn("Ignoring MAX_WORLD_MB: it must be a positive number of megabytes", { value: raw });
    }
    return DEFAULT_WORLD_LIMIT_MB * 1024 * 1024;
  }
  return Math.floor(megabytes * 1024 * 1024);
}

function createWorldManager(serverManager, options = {}) {
  const worldLimitBytes = options.worldLimitBytes || DEFAULT_WORLD_LIMIT_MB * 1024 * 1024;
  // How full the disk is. Replaceable so a test can describe a full one.
  const statfs = options.statfs || fsp.statfs;

  // Bad input from the browser should surface as a 4xx, not a 500 that logs as
  // a server fault.
  function worldError(message, statusCode = 409) {
    return new HttpError(statusCode, message);
  }

  // The name of an archive in the world library, as sent by the browser.
  function archiveNameFrom(value) {
    if (typeof value !== "string" || !value.trim()) {
      throw worldError("An archive name is required.", 400);
    }
    return value.trim();
  }

  // What is at the place the server's world lives: "missing", "folder", or
  // "other" for anything else - which in practice is a symbolic link.
  async function worldFolderKind(paths) {
    let stats;
    try {
      stats = await fsp.lstat(paths.worldDir);
    } catch (error) {
      if (error.code === "ENOENT") {
        return "missing";
      }
      throw error;
    }
    return stats.isDirectory() ? "folder" : "other";
  }

  // The dashboard archives and replaces a world folder that is a real folder
  // inside the server's own folder, and nothing else. If the world folder is a
  // link, or sits behind one that leads out of the server folder, following it
  // would read or write wherever it points with the dashboard's permissions -
  // on behalf of an admin who is only trusted with this one server.
  async function assertWorldFolderIsOurs(paths) {
    if ((await worldFolderKind(paths)) === "other") {
      throw worldError(
        "This server's world folder is a symbolic link, and the dashboard does not follow links. Replace the link with the real folder to back up, export or restore worlds here."
      );
    }
    const serverRoot = await fsp.realpath(paths.serverDir);
    // The folder the world sits in: the server folder itself, unless the world
    // was configured a level or two down.
    let parent = path.dirname(paths.worldDir);
    while (!(await fsp.lstat(parent).catch(() => null))) {
      parent = path.dirname(parent);
    }
    if (!withinParent(serverRoot, await fsp.realpath(parent))) {
      throw worldError(
        "This server's world folder is reached through a symbolic link that leads outside the server folder, and the dashboard does not follow links."
      );
    }
  }

  // Runs zip over the world folder. -y stores a symbolic link as the link it
  // is. Without it zip followed every link and packed whatever was behind it,
  // so a link inside a world handed its target to anyone who could download a
  // backup. "--" keeps a folder name that begins with a dash from being read
  // as an option.
  async function zipWorld(paths, targetArchive) {
    await runCommand("zip", ["-ryq", targetArchive, "--", path.basename(paths.worldDir)], {
      cwd: path.dirname(paths.worldDir)
    });
  }

  function parseServerPropertiesText(contents) {
    const properties = {};
    for (const line of String(contents || "").split(/\r?\n/)) {
      if (!line || line.startsWith("#")) {
        continue;
      }
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }
      properties[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1);
    }
    return properties;
  }

  function serializeServerProperties(properties) {
    return `${Object.entries(properties)
      .filter(([key]) => key)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value ?? ""}`)
      .join("\n")}\n`;
  }

  async function listWorlds(serverId) {
    return await serverManager.listWorldEntries(serverId);
  }

  async function updateWorldRules(serverId, options = {}) {
    // Checked before the file is read, let alone written: the world type goes
    // into server.properties, and is one of a fixed list.
    let levelType = null;
    if (options.levelType !== undefined && options.levelType !== null && options.levelType !== "") {
      levelType = normalizeLevelType(options.levelType);
    }
    const properties = parseServerPropertiesText(await serverManager.readServerProperties(serverId));
    if (levelType) {
      properties["level-type"] = levelType;
    }
    if (typeof options.generateStructures === "boolean") {
      properties["generate-structures"] = options.generateStructures ? "true" : "false";
    }
    if (typeof options.forceGamemode === "boolean") {
      properties["force-gamemode"] = options.forceGamemode ? "true" : "false";
    }
    await serverManager.writeServerProperties(serverId, serializeServerProperties(properties));
    return {
      rules: {
        forceGamemode: properties["force-gamemode"] || "false",
        generateStructures: properties["generate-structures"] || "true",
        levelType: properties["level-type"] || "minecraft:normal"
      }
    };
  }

  async function captureActiveWorld(serverId, label) {
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    await ensureDir(paths.worldLibraryDir);

    // A label is text, or left out. Anything else is not turned into a name.
    const labelText = typeof label === "string" || typeof label === "number" ? String(label) : "";
    const archiveName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFilename(labelText || "world")}.zip`;
    const targetArchive = path.join(paths.worldLibraryDir, archiveName);
    await serverManager.ensureServerStopped(serverId);
    if ((await worldFolderKind(paths)) === "missing") {
      throw worldError("This server has no world to back up yet. Start it once to generate one.");
    }
    await assertWorldFolderIsOurs(paths);
    try {
      await zipWorld(paths, targetArchive);
    } catch (error) {
      // Not half an archive under a name that looks like a backup.
      await fsp.rm(targetArchive, { force: true });
      throw error;
    }

    return {
      archiveName
    };
  }

  // Archives the world that is live now, ahead of something that is about to
  // delete it. Returns quietly when there is no world yet. If there is one and
  // it cannot be archived, this throws, and the caller must not go on: the
  // backup used to be attempted and its failure ignored, so a world that could
  // not be archived was deleted all the same.
  async function backUpWorldBeforeReplacing(serverId, paths, label) {
    if ((await worldFolderKind(paths)) === "missing") {
      return;
    }
    await captureActiveWorld(serverId, label);
  }

  // Files an uploaded archive in the world library. The upload was received
  // into that directory, so the archive appears under its final name complete
  // or not at all.
  async function importWorldArchiveFile(serverId, fileName, sourcePath) {
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    await ensureDir(paths.worldLibraryDir);
    const archiveName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFilename(fileName || "world.zip")}`;
    const targetFile = path.join(paths.worldLibraryDir, archiveName.endsWith(".zip") ? archiveName : `${archiveName}.zip`);
    await fsp.rename(sourcePath, targetFile);
    return {
      archiveName: path.basename(targetFile)
    };
  }

  async function resolveArchiveSource(tmpDir) {
    const entries = await fsp.readdir(tmpDir, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());
    const directLevelDat = entries.find((entry) => entry.isFile() && entry.name === "level.dat");
    if (directLevelDat) {
      return tmpDir;
    }
    if (directories.length === 1) {
      return path.join(tmpDir, directories[0].name);
    }
    const worldDir = path.join(tmpDir, "world");
    try {
      await fsp.access(path.join(worldDir, "level.dat"));
      return worldDir;
    } catch {
      return tmpDir;
    }
  }

  // Removes unpacking folders a crash or a kill left behind.
  async function removeStaleStaging(directory, now = Date.now()) {
    let names;
    try {
      names = await fsp.readdir(directory);
    } catch {
      return;
    }
    for (const name of names.filter((entry) => STAGING_NAME.test(entry))) {
      const target = path.join(directory, name);
      try {
        if (now - (await fsp.lstat(target)).mtimeMs > STALE_STAGING_AGE_MS) {
          await fsp.rm(target, { force: true, recursive: true });
        }
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }

  // How many bytes may be unpacked onto the disk this server lives on: the
  // limit, or what the disk has free less a reserve, whichever is smaller.
  async function unpackAllowance(directory) {
    try {
      const { bavail, bsize } = await statfs(directory);
      const free = Number(bavail) * Number(bsize) - FREE_SPACE_RESERVE_BYTES;
      if (Number.isFinite(free) && free < worldLimitBytes) {
        return Math.max(0, free);
      }
    } catch {
      // A filesystem that will not say how full it is: the limit alone applies.
    }
    return worldLimitBytes;
  }

  // Deletes an archived world zip. The live world is never touched here - it is
  // not an archive, and removing it is what "create new world" is for.
  async function deleteWorldArchive(serverId, archiveName) {
    const requested = String(archiveName || "").trim();
    if (!requested) {
      throw worldError("An archive name is required.", 400);
    }

    const server = await serverManager.getServer(serverId);
    if (!server) {
      throw worldError("Server not found.", 404);
    }

    const paths = serverManager.resolveRecordPaths(server);
    const archivePath = await serverManager.readWorldArchivePath(serverId, requested);
    if (!withinParent(paths.worldLibraryDir, archivePath)) {
      throw worldError("Invalid archive path.", 400);
    }

    const entries = await serverManager.listWorldEntries(serverId);
    const match = entries.find((entry) => entry.kind === "archive" && entry.name === path.basename(archivePath));
    if (!match) {
      // Either it never existed or it is the active world, which has no archive
      // entry. Refuse rather than guess.
      throw worldError(
        `No archived world named ${requested} was found. The active world cannot be deleted here.`,
        404
      );
    }

    await fsp.rm(archivePath, { force: true });
    return {
      deleted: match.name,
      worlds: await listWorlds(serverId)
    };
  }

  // Replaces the server's world with an archived one.
  //
  // The archive is unpacked into a folder of its own beside the world folder -
  // on the same disk, so nothing large lands in /tmp, which is often memory -
  // and only moved into place once all of it has been unpacked and checked.
  // Nothing about the live world changes until then.
  async function activateWorldArchive(serverId, archiveName) {
    const requested = archiveNameFrom(archiveName);
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    const archivePath = await serverManager.readWorldArchivePath(serverId, requested);
    if (!withinParent(paths.worldLibraryDir, archivePath)) {
      throw worldError("Invalid archive path.", 400);
    }
    // A file that is in the library, not a link somebody left there.
    const archiveStats = await fsp.lstat(archivePath).catch(() => null);
    if (!archiveStats || !archiveStats.isFile()) {
      throw worldError(`No archived world named ${path.basename(archivePath)} was found.`, 404);
    }
    await serverManager.ensureServerStopped(serverId);
    await assertWorldFolderIsOurs(paths);

    // Decided from the archive's own list of contents, before anything is
    // unpacked: is it readable, is all of it files and folders, does it fit.
    const contents = await inspectZip(archivePath, { maxBytes: worldLimitBytes });
    const stagingParent = path.dirname(paths.worldDir);
    await ensureDir(stagingParent);
    const allowance = await unpackAllowance(stagingParent);
    if (contents.totalBytes > allowance) {
      throw worldError(
        `There is not enough free disk space to unpack this world: it needs ${describeBytes(contents.totalBytes)}, and ${describeBytes(allowance)} can be used (1 GB is always left free).`,
        507
      );
    }

    await removeStaleStaging(stagingParent);
    const stagingDir = path.join(stagingParent, `${STAGING_PREFIX}${crypto.randomBytes(8).toString("hex")}`);
    await fsp.mkdir(stagingDir, { mode: 0o700 });
    try {
      // Stops at what was just checked: an entry that holds more than its
      // header declares ends the unpacking.
      await extractZip(archivePath, stagingDir, { maxBytes: allowance });
      // The extractor only ever creates files and folders. This looks at what
      // is actually on disk anyway, so that the rule holds for whatever is
      // about to become the world, however it got there.
      await assertPlainTree(stagingDir, { maxBytes: allowance });

      const extractedRoot = await resolveArchiveSource(stagingDir);
      const levelDat = await fsp.lstat(path.join(extractedRoot, "level.dat")).catch(() => null);
      if (!levelDat || !levelDat.isFile()) {
        throw worldError("This archive does not hold a Minecraft world: there is no level.dat in it.", 400);
      }

      await backUpWorldBeforeReplacing(serverId, paths, `pre-activate-${nowIso().replace(/[:.]/g, "-")}`);
      await fsp.rm(paths.worldDir, { recursive: true, force: true });
      // Same folder, same disk: a rename, which either happens or does not.
      await fsp.rename(extractedRoot, paths.worldDir);
      await serverManager.setActiveWorldName(serverId, path.basename(archivePath).replace(/\.zip$/i, ""));
    } finally {
      await fsp.rm(stagingDir, { recursive: true, force: true });
    }
  }

  async function createExportArchive(serverId) {
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    await serverManager.ensureServerStopped(serverId);
    if ((await worldFolderKind(paths)) === "missing") {
      throw worldError("This server has no world to export yet. Start it once to generate one.");
    }
    await assertWorldFolderIsOurs(paths);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rippermoon-export-"));
    const outputPath = path.join(tmpDir, `${safeFilename(server.id)}-active-world.zip`);
    try {
      await zipWorld(paths, outputPath);
    } catch (error) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      throw error;
    }
    return {
      cleanup: async () => {
        await fsp.rm(tmpDir, { recursive: true, force: true });
      },
      outputPath
    };
  }

  async function createNewWorld(serverId, options = {}) {
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    // What was asked for is checked first. The seed and the world type are
    // written into server.properties; the name is shown in the world list. A
    // refusal here comes before the live world is archived or removed.
    const blank = (value) => value === undefined || value === null || value === "";
    const name = blank(options.name) ? "new world" : singleLine(options.name, "The world name", { maxLength: 80, required: true });
    const seed = blank(options.seed) ? "" : propertyValue(options.seed, "The world seed", { maxLength: 128 });
    const levelType = blank(options.levelType) ? "minecraft:normal" : normalizeLevelType(options.levelType);
    const levelName = propertyValue(path.basename(paths.worldDir), "The world folder name");
    if (!levelName) {
      throw invalid("This server's world folder has no name to write into server.properties.");
    }

    await serverManager.ensureServerStopped(serverId);
    await assertWorldFolderIsOurs(paths);
    // Nothing to archive if the current world has not been generated yet.
    await backUpWorldBeforeReplacing(serverId, paths, `pre-new-world-${name}`);

    const properties = parseServerPropertiesText(await serverManager.readServerProperties(serverId));
    properties["level-name"] = levelName;
    properties["level-seed"] = seed;
    properties["level-type"] = levelType;
    properties["generate-structures"] = String(options.generateStructures === false ? "false" : "true");
    await serverManager.writeServerProperties(serverId, serializeServerProperties(properties));
    await serverManager.setActiveWorldName(serverId, name);

    await fsp.rm(paths.worldDir, { recursive: true, force: true });

    return {
      nextWorld: {
        generateStructures: properties["generate-structures"],
        levelType: properties["level-type"],
        name,
        seed: properties["level-seed"]
      }
    };
  }

  return {
    activateWorldArchive,
    captureActiveWorld,
    createNewWorld,
    createExportArchive,
    deleteWorldArchive,
    importWorldArchiveFile,
    listWorlds,
    updateWorldRules
  };
}

module.exports = {
  DEFAULT_WORLD_LIMIT_MB,
  createWorldManager,
  resolveWorldLimitBytes
};
