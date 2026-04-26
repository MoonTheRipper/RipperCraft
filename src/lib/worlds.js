const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { ensureDir, nowIso, runCommand, safeFilename, withinParent } = require("./utils");

function createWorldManager(serverManager) {
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
    const properties = parseServerPropertiesText(await serverManager.readServerProperties(serverId));
    if (typeof options.levelType === "string" && options.levelType.trim()) {
      properties["level-type"] = String(options.levelType).trim();
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

    const archiveName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFilename(label || "world")}.zip`;
    const targetArchive = path.join(paths.worldLibraryDir, archiveName);
    await serverManager.ensureServerStopped(serverId);
    await runCommand("zip", ["-rq", targetArchive, path.basename(paths.worldDir)], {
      cwd: path.dirname(paths.worldDir)
    });

    return {
      archiveName
    };
  }

  async function importWorldArchive(serverId, fileName, buffer) {
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    await ensureDir(paths.worldLibraryDir);
    const archiveName = `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeFilename(fileName || "world.zip")}`;
    const targetFile = path.join(paths.worldLibraryDir, archiveName.endsWith(".zip") ? archiveName : `${archiveName}.zip`);
    await fsp.writeFile(targetFile, buffer);
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

  async function activateWorldArchive(serverId, archiveName) {
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    const archivePath = await serverManager.readWorldArchivePath(serverId, archiveName);
    if (!withinParent(paths.worldLibraryDir, archivePath)) {
      throw new Error("Invalid archive path.");
    }
    await serverManager.ensureServerStopped(serverId);

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rippermoon-world-"));
    try {
      await runCommand("unzip", ["-qq", archivePath, "-d", tmpDir]);
      const extractedRoot = await resolveArchiveSource(tmpDir);
      const levelDat = path.join(extractedRoot, "level.dat");
      await fsp.access(levelDat);

      const backupName = `pre-activate-${nowIso().replace(/[:.]/g, "-")}`;
      try {
        await fsp.access(paths.worldDir);
        await captureActiveWorld(serverId, backupName);
      } catch {
        // ignore if no active world exists
      }

      await fsp.rm(paths.worldDir, { recursive: true, force: true });
      await fsp.cp(extractedRoot, paths.worldDir, { recursive: true });
      await serverManager.setActiveWorldName(serverId, archiveName.replace(/\.zip$/i, ""));
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    }
  }

  async function createExportArchive(serverId) {
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rippermoon-export-"));
    const outputPath = path.join(tmpDir, `${safeFilename(server.id)}-active-world.zip`);
    await serverManager.ensureServerStopped(serverId);
    await runCommand("zip", ["-rq", outputPath, path.basename(paths.worldDir)], {
      cwd: path.dirname(paths.worldDir)
    });
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
    await serverManager.ensureServerStopped(serverId);

    try {
      await fsp.access(paths.worldDir);
      await captureActiveWorld(serverId, `pre-new-world-${options.name || "world"}`);
    } catch {
      // ignore if the current world has not been generated yet
    }

    const properties = parseServerPropertiesText(await serverManager.readServerProperties(serverId));
    properties["level-name"] = path.basename(paths.worldDir);
    properties["level-seed"] = String(options.seed || "");
    properties["level-type"] = String(options.levelType || "minecraft:normal");
    properties["generate-structures"] = String(options.generateStructures === false ? "false" : "true");
    await serverManager.writeServerProperties(serverId, serializeServerProperties(properties));
    await serverManager.setActiveWorldName(serverId, options.name || "new world");

    await fsp.rm(paths.worldDir, { recursive: true, force: true });

    return {
      nextWorld: {
        generateStructures: properties["generate-structures"],
        levelType: properties["level-type"],
        name: String(options.name || "new world"),
        seed: properties["level-seed"]
      }
    };
  }

  return {
    activateWorldArchive,
    captureActiveWorld,
    createNewWorld,
    createExportArchive,
    importWorldArchive,
    listWorlds,
    updateWorldRules
  };
}

module.exports = {
  createWorldManager
};
