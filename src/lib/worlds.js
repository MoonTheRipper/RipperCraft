const crypto = require("node:crypto");
const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { HttpError, describeBytes } = require("./http");
const { newUploadTempPath, removeStaleTempFiles } = require("./upload");
const { createMutex, ensureDir, nowIso, readEnv, runCommand, safeFilename, withinParent } = require("./utils");
const { invalid, normalizeLevelType, propertyValue, singleLine } = require("./validate");
const { assertPlainTree, extractZip } = require("./zip-extract");

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
  const logger = options.logger || { error() {} };
  // How full the disk is. Replaceable so a test can describe a full one.
  const statfs = options.statfs || fsp.statfs;
  // Whether a folder is where another disk is mounted. Replaceable for the
  // same reason: a test cannot mount one.
  const isMountPoint = options.isMountPoint || folderIsMountPoint;

  // One thing at a time happens to a server's worlds. Backing up, restoring,
  // exporting and starting a new world each take a while and each assume the
  // world folder and the library hold still meanwhile. They did not: the same
  // restore sent twice (a double click) had both requests archive the live
  // world under one name, and the request that lost the race deleted the
  // archive the other had just finished - after the world itself was gone.
  const queues = new Map();
  async function oneAtATime(serverId, task) {
    const key = String(serverId);
    let queue = queues.get(key);
    if (!queue) {
      queue = { run: createMutex(), waiting: 0 };
      queues.set(key, queue);
    }
    queue.waiting += 1;
    try {
      return await queue.run(task);
    } finally {
      queue.waiting -= 1;
      // Nothing is kept for a server that has nothing going on.
      if (queue.waiting === 0) {
        queues.delete(key);
      }
    }
  }
  // Unpacking is queued across every server as well, so that the free space
  // one restore was promised is not being used up by another on the same disk.
  // It is always taken second, with the server's own queue already held, and
  // nothing waits for a server's queue while holding it.
  const unpacking = createMutex();

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
    try {
      await runCommand("zip", ["-ryq", targetArchive, "--", path.basename(paths.worldDir)], {
        cwd: path.dirname(paths.worldDir)
      });
    } catch (error) {
      // Said in the dashboard's words. The command's own failure names the
      // full path of the library on this machine, which is the operator's
      // business and nobody else's: it goes to the log, not to the browser.
      logger.error("Archiving a world failed", {
        code: error.code,
        error: error.message,
        output: String(error.stderr || "").slice(-2000)
      });
      if (error.code === "ENOENT") {
        throw worldError("The world could not be archived: the zip command is not installed on this machine.", 500);
      }
      const how = typeof error.code === "number" ? `zip stopped with code ${error.code}` : "zip was stopped before it finished";
      throw worldError(
        `The world could not be archived (${how}). Check that the disk has room and that every file in the world can be read. The dashboard's log has the details.`,
        500
      );
    }
  }

  // A name in the library that nothing has yet: the one asked for, or the same
  // with a number after it.
  async function freeArchivePath(directory, stem) {
    for (let attempt = 1; ; attempt += 1) {
      const candidate = path.join(directory, `${stem}${attempt === 1 ? "" : `-${attempt}`}.zip`);
      if (!(await fsp.lstat(candidate).catch(() => null))) {
        return candidate;
      }
    }
  }

  // A folder another disk is mounted on is on a different device from the
  // folder it is in. (A folder of the same disk mounted a second time is not
  // told apart this way.)
  async function folderIsMountPoint(directory) {
    try {
      const [own, parent] = await Promise.all([fsp.stat(directory), fsp.stat(path.dirname(directory))]);
      return own.dev !== parent.dev;
    } catch {
      return false;
    }
  }

  async function worldFolderIsMounted(paths) {
    return (await worldFolderKind(paths)) === "folder" && (await isMountPoint(paths.worldDir));
  }

  // Restoring a world means removing its folder and moving another into its
  // place. A folder another disk is mounted on cannot be removed - only
  // emptied, after which the move fails too, and the server is left with no
  // world. The archive is also unpacked beside the world folder, which is then
  // the wrong disk to have measured. So that is refused before anything is
  // touched.
  async function assertWorldFolderCanBeSwapped(paths) {
    if (await worldFolderIsMounted(paths)) {
      throw worldError(
        "This server's world folder is where another disk is mounted, and the dashboard cannot swap a different world into it. Unpack the archive onto that disk by hand, or mount the disk on the server folder instead of on the world folder."
      );
    }
  }

  // Removes the live world, for a new one to be generated in its place. Where
  // another disk is mounted on the folder, the folder stays and what is in it
  // goes.
  async function removeLiveWorld(paths) {
    if (await worldFolderIsMounted(paths)) {
      for (const name of await fsp.readdir(paths.worldDir)) {
        await fsp.rm(path.join(paths.worldDir, name), { recursive: true, force: true });
      }
      return;
    }
    await fsp.rm(paths.worldDir, { recursive: true, force: true });
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

  function updateWorldRules(serverId, options = {}) {
    return oneAtATime(serverId, () => writeWorldRules(serverId, options));
  }

  async function writeWorldRules(serverId, options) {
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

  function captureActiveWorld(serverId, label) {
    return oneAtATime(serverId, () => archiveLiveWorld(serverId, label));
  }

  // Zips the live world into the library. Called with the server's queue held.
  //
  // The archive is written under a temporary name and given its real one only
  // when it is complete, so a backup that failed is never mistaken for one
  // that did not - and so that clearing up after a failure removes this call's
  // own file and cannot remove anybody else's.
  async function archiveLiveWorld(serverId, label) {
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    await ensureDir(paths.worldLibraryDir);

    // A label is text, or left out. Anything else is not turned into a name.
    const labelText = typeof label === "string" || typeof label === "number" ? String(label) : "";
    const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFilename(labelText || "world")}`;
    await serverManager.ensureServerStopped(serverId);
    if ((await worldFolderKind(paths)) === "missing") {
      throw worldError("This server has no world to back up yet. Start it once to generate one.");
    }
    await assertWorldFolderIsOurs(paths);

    // What a backup that was cut short left behind, a day or more ago.
    await removeStaleTempFiles(paths.worldLibraryDir);
    const unfinished = newUploadTempPath(paths.worldLibraryDir);
    try {
      await zipWorld(paths, unfinished);
      const targetArchive = await freeArchivePath(paths.worldLibraryDir, stem);
      await fsp.rename(unfinished, targetArchive);
      return {
        archiveName: path.basename(targetArchive)
      };
    } catch (error) {
      await fsp.rm(unfinished, { force: true });
      throw error;
    }
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
    await archiveLiveWorld(serverId, label);
  }

  // Files an uploaded archive in the world library. The upload was received
  // into that directory, so the archive appears under its final name complete
  // or not at all.
  function importWorldArchiveFile(serverId, fileName, sourcePath) {
    return oneAtATime(serverId, async () => {
      const server = await serverManager.getServer(serverId);
      const paths = serverManager.resolveRecordPaths(server);
      await ensureDir(paths.worldLibraryDir);
      const stem = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFilename(fileName || "world.zip")}`.replace(/\.zip$/, "");
      // Never over an archive that is already there.
      const targetFile = await freeArchivePath(paths.worldLibraryDir, stem);
      await fsp.rename(sourcePath, targetFile);
      return {
        archiveName: path.basename(targetFile)
      };
    });
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
    const requested = archiveNameFrom(archiveName);
    return await oneAtATime(serverId, () => removeArchive(serverId, requested));
  }

  async function removeArchive(serverId, requested) {
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
    return await oneAtATime(serverId, () => unpacking(() => restoreArchive(serverId, requested)));
  }

  async function restoreArchive(serverId, requested) {
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
    await assertWorldFolderCanBeSwapped(paths);

    const stagingParent = path.dirname(paths.worldDir);
    await ensureDir(stagingParent);
    await removeStaleStaging(stagingParent);
    const stagingDir = path.join(stagingParent, `${STAGING_PREFIX}${crypto.randomBytes(8).toString("hex")}`);
    await fsp.mkdir(stagingDir, { mode: 0o700 });
    try {
      // The archive's own list of contents decides, before anything is
      // unpacked: is it readable, is all of it files and folders, does it fit
      // the limit - and then, here, does the disk have room for it. Unpacking
      // stops at what was checked: an entry that holds more than its header
      // declares ends it.
      await extractZip(archivePath, stagingDir, {
        beforeWriting: async (contents) => {
          const allowance = await unpackAllowance(stagingParent);
          if (contents.weight > allowance) {
            throw worldError(
              `There is not enough free disk space to unpack this world: it needs ${describeBytes(contents.weight)}, and ${describeBytes(allowance)} can be used (1 GB is always left free).`,
              507
            );
          }
        },
        maxBytes: worldLimitBytes
      });
      // The extractor only ever creates files and folders. This looks at what
      // is actually on disk anyway, so that the rule holds for whatever is
      // about to become the world, however it got there.
      await assertPlainTree(stagingDir, { maxBytes: worldLimitBytes });

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

  function createExportArchive(serverId) {
    return oneAtATime(serverId, () => zipLiveWorldForDownload(serverId));
  }

  async function zipLiveWorldForDownload(serverId) {
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

  function createNewWorld(serverId, options = {}) {
    return oneAtATime(serverId, () => startNewWorld(serverId, options));
  }

  async function startNewWorld(serverId, options) {
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

    await removeLiveWorld(paths);

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
