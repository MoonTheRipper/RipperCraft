const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { hashSecret } = require("./auth");
const {
  compareVersions,
  evaluateLoaderCandidate,
  evaluateMinecraftCandidate,
  readJarTextEntry,
  scanLoaderRequirements
} = require("./loader-deps");
const {
  ENV_PREFIX,
  LEGACY_ENV_PREFIX,
  coerceBoolean,
  displayNameFromSlug,
  ensureDir,
  exists,
  nowIso,
  readEnv,
  readJson,
  runCommand,
  safeFilename,
  sleep,
  tailTextFile,
  withinParent,
  writeJson
} = require("./utils");

const MOJANG_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const PAPER_DOWNLOADS_API = "https://fill.papermc.io/v3";
const PURPUR_DOWNLOADS_API = "https://api.purpurmc.org/v2/purpur";
const FABRIC_META_API = "https://meta.fabricmc.net/v2";
const NEOFORGE_VERSIONS_API = "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";
const FORGE_PROMOTIONS_URL = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
// Loaders the dashboard can provision end to end. Anything outside this set has
// to be installed by hand and registered as an existing folder.
const INSTALLABLE_LOADERS = new Set(["vanilla", "paper", "purpur", "fabric", "forge", "neoforge"]);
const INSTALLER_LOADERS = new Set(["forge", "neoforge"]);
const PAPER_LIKE_LOADERS = new Set(["paper", "purpur", "folia", "spigot", "bukkit"]);
const COMBINED_UPDATE_LOADERS = new Set(["vanilla", "paper", "purpur", "fabric", "forge", "neoforge"]);
// Loaders that version their runtime separately from Minecraft, so the loader
// build is a choice the operator can make - pin it, move it forward, or move it
// back - without the game version changing at all.
const LOADER_VERSIONED_LOADERS = new Set(["fabric", "forge", "neoforge"]);
const FORGE_MAVEN_METADATA_URL = `${FORGE_MAVEN}/maven-metadata.xml`;
const REMOTE_USER_AGENT = readEnv("USER_AGENT", "RipperCraft/0.1 (https://github.com/MoonTheRipper/RipperCraft)");
const DEFAULT_EXISTING_START_COMMAND = "./launch-server.sh";
const DEFAULT_MANAGED_START_COMMAND = "./.rippermoon/launch-server.sh";
const SAFE_ADMIN_SETTING_DEFINITIONS = [
  { key: "motd", type: "string", defaultValue: "" },
  { key: "gamemode", type: "enum", defaultValue: "survival", options: ["survival", "creative", "adventure", "spectator"] },
  { key: "difficulty", type: "enum", defaultValue: "easy", options: ["peaceful", "easy", "normal", "hard"] },
  { key: "max-players", type: "number", defaultValue: "20" },
  { key: "view-distance", type: "number", defaultValue: "10" },
  { key: "simulation-distance", type: "number", defaultValue: "10" },
  { key: "allow-flight", type: "boolean", defaultValue: "false" },
  { key: "force-gamemode", type: "boolean", defaultValue: "false" },
  { key: "hardcore", type: "boolean", defaultValue: "false" },
  { key: "pvp", type: "boolean", defaultValue: "true" },
  { key: "spawn-monsters", type: "boolean", defaultValue: "true" },
  { key: "spawn-protection", type: "number", defaultValue: "16" },
  { key: "white-list", type: "boolean", defaultValue: "false" },
  { key: "allow-nether", type: "boolean", defaultValue: "true" },
  { key: "player-idle-timeout", type: "number", defaultValue: "0" }
];
const SAFE_ADMIN_SETTING_KEYS = new Set(SAFE_ADMIN_SETTING_DEFINITIONS.map((definition) => definition.key));

function createServerManager(store) {
  const serversRoot = path.join(store.rootDir, "servers");
  const runningChildren = new Map();
  const versionCatalogCache = {
    data: null,
    expiresAt: 0,
    promise: null
  };
  const javaRuntimeCache = {
    data: null,
    expiresAt: 0
  };
  // Planning a loader change asks for the same build list twice - once to
  // annotate the picker, once to resolve the download - and the picker itself is
  // re-opened often. Loader release lists barely move, so a short cache keeps
  // that to one request.
  const loaderCatalogCache = new Map();

  function withRemoteHeaders(headers = {}) {
    return {
      "User-Agent": REMOTE_USER_AGENT,
      ...headers
    };
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: withRemoteHeaders(options.headers || {})
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}.`);
    }
    return await response.json();
  }

  async function fetchText(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: withRemoteHeaders(options.headers || {})
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}.`);
    }
    return await response.text();
  }

  async function fetchBuffer(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: withRemoteHeaders(options.headers || {})
    });
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}.`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  function serializeManagedRuntime(managedRuntime) {
    if (!managedRuntime || typeof managedRuntime !== "object") {
      return null;
    }

    return {
      kind: managedRuntime.kind || null,
      launchKind: (managedRuntime.launch && managedRuntime.launch.kind) || "jar",
      loaderVersion: managedRuntime.loaderVersion || null,
      source: managedRuntime.source || null,
      updatedAt: managedRuntime.updatedAt || null
    };
  }

  function serializeServer(record) {
    return {
      createdAt: record.createdAt,
      description: record.description,
      directory: record.directory,
      id: record.id,
      javaBin: record.javaBin || "",
      loader: record.loader,
      logFile: record.logFile,
      maxMemory: record.maxMemory || "4G",
      managedRuntime: serializeManagedRuntime(record.managedRuntime),
      minMemory: record.minMemory || "2G",
      minecraftVersion: record.minecraftVersion,
      modsDir: record.modsDir,
      name: record.name,
      passphraseConfigured: Boolean(record.passphraseHash),
      serverPropertiesFile: record.serverPropertiesFile,
      startCommand: record.startCommand,
      updatedAt: record.updatedAt,
      worldDir: record.worldDir
    };
  }

  function resolveRecordPaths(record) {
    const serverDir = path.resolve(store.rootDir, record.directory);
    if (!withinParent(serversRoot, serverDir)) {
      throw new Error(`Server path is outside managed servers directory: ${record.directory}`);
    }

    return {
      backupsDir: path.join(serverDir, "backups"),
      logFile: path.join(serverDir, record.logFile || "logs/latest.log"),
      modsDir: path.join(serverDir, PAPER_LIKE_LOADERS.has(record.loader) ? "plugins" : (record.modsDir || "mods")),
      disabledModsDir: path.join(serverDir, ".rippermoon", "disabled-mods"),
      addonManifestFile: path.join(serverDir, ".rippermoon", "addons.json"),
      eulaFile: path.join(serverDir, "eula.txt"),
      pidFile: path.join(serverDir, ".rippermoon", "pid.json"),
      opsFile: path.join(serverDir, "ops.json"),
      propertiesFile: path.join(serverDir, record.serverPropertiesFile || "server.properties"),
      managedLaunchScript: path.join(serverDir, ".rippermoon", "launch-server.sh"),
      runtimeDir: path.join(serverDir, ".rippermoon"),
      runtimeBackupDir: path.join(serverDir, ".rippermoon", "server-backups"),
      runtimeLog: path.join(serverDir, ".rippermoon", "runtime.log"),
      serverDir,
      serverJarFile: path.join(serverDir, "server.jar"),
      worldMetadataFile: path.join(serverDir, ".rippermoon", "worlds.json"),
      worldDir: path.join(serverDir, record.worldDir || "world"),
      worldLibraryDir: path.join(serverDir, ".rippermoon", "world-library")
    };
  }

  function getSafeAdminSettingDefinitions() {
    return SAFE_ADMIN_SETTING_DEFINITIONS.map((definition) => ({ ...definition }));
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
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1);
      properties[key] = value;
    }
    return properties;
  }

  function serializeServerProperties(properties) {
    const lines = Object.entries(properties)
      .filter(([key]) => key)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value ?? ""}`);
    return `${lines.join("\n")}\n`;
  }

  function normalizeAdminSettingValue(definition, value) {
    if (value === undefined || value === null) {
      return definition.defaultValue;
    }

    if (definition.type === "boolean") {
      return coerceBoolean(value) ? "true" : "false";
    }

    if (definition.type === "number") {
      const text = String(value).trim();
      return /^-?\d+$/.test(text) ? text : definition.defaultValue;
    }

    if (definition.type === "enum") {
      const text = String(value).trim().toLowerCase();
      return definition.options.includes(text) ? text : definition.defaultValue;
    }

    return String(value);
  }

  async function fetchMinecraftVersionManifest() {
    if (versionCatalogCache.data && versionCatalogCache.expiresAt > Date.now()) {
      return versionCatalogCache.data;
    }

    if (versionCatalogCache.promise) {
      return await versionCatalogCache.promise;
    }

    versionCatalogCache.promise = fetchJson(MOJANG_MANIFEST_URL)
      .then((manifest) => {
        versionCatalogCache.data = manifest;
        versionCatalogCache.expiresAt = Date.now() + 5 * 60_000;
        versionCatalogCache.promise = null;
        return manifest;
      })
      .catch((error) => {
        versionCatalogCache.promise = null;
        throw error;
      });

    return await versionCatalogCache.promise;
  }

  async function listAvailableMinecraftVersions(options = {}) {
    const manifest = await fetchMinecraftVersionManifest();
    const includeSnapshots = options.includeSnapshots !== false;
    return {
      latest: manifest.latest || {},
      versions: (manifest.versions || [])
        .filter((entry) => includeSnapshots || entry.type === "release")
        .map((entry) => ({
          id: entry.id,
          releaseTime: entry.releaseTime,
          type: entry.type
        }))
    };
  }

  async function resolveRequestedReleaseVersion(version) {
    const manifest = await fetchMinecraftVersionManifest();
    if (!version || version === "latest") {
      return manifest.latest.release;
    }
    return String(version).trim();
  }

  async function listServerDirectories() {
    await ensureDir(serversRoot);
    const entries = await fsp.readdir(serversRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  function getManagedDirectoryName(record) {
    const relativeDirectory = record && record.directory ? String(record.directory) : "";
    const normalized = relativeDirectory
      .replaceAll("\\", "/")
      .replace(/^\.?\/*/, "");
    return path.basename(normalized || String(record && record.id ? record.id : ""));
  }

  function normalizeStoredSlashes(value) {
    return String(value || "").replaceAll("\\", "/").trim();
  }

  function extractPathWithinServer(value, directoryName) {
    const normalized = normalizeStoredSlashes(value);
    const relativePrefix = `servers/${directoryName}/`;
    const absoluteMarker = `/servers/${directoryName}/`;
    if (normalized.startsWith(relativePrefix)) {
      return normalized.slice(relativePrefix.length);
    }
    const absoluteIndex = normalized.lastIndexOf(absoluteMarker);
    if (absoluteIndex !== -1) {
      return normalized.slice(absoluteIndex + absoluteMarker.length);
    }
    return null;
  }

  function sanitizeServerRelativePath(value, fallback) {
    const normalized = normalizeStoredSlashes(value)
      .replace(/^\.?\/*/, "");
    if (!normalized) {
      return fallback;
    }

    const segments = normalized.split("/").filter(Boolean);
    if (!segments.length || segments.includes("..")) {
      return fallback;
    }

    return segments.join("/");
  }

  function normalizeServerRelativePath(record, value, fallback) {
    const directoryName = getManagedDirectoryName(record);
    const extracted = extractPathWithinServer(value, directoryName);
    if (extracted !== null) {
      return sanitizeServerRelativePath(extracted, fallback);
    }

    const normalized = normalizeStoredSlashes(value);
    if (!normalized || path.isAbsolute(normalized)) {
      return fallback;
    }

    if (normalized.startsWith("servers/")) {
      return fallback;
    }

    return sanitizeServerRelativePath(normalized, fallback);
  }

  function normalizeStartCommand(record) {
    const fallback = record && record.managedRuntime ? DEFAULT_MANAGED_START_COMMAND : DEFAULT_EXISTING_START_COMMAND;
    const configured = normalizeStoredSlashes(record && record.startCommand ? record.startCommand : "");
    if (!configured) {
      return fallback;
    }

    if (record && record.managedRuntime && (configured === DEFAULT_EXISTING_START_COMMAND || configured === DEFAULT_MANAGED_START_COMMAND)) {
      return DEFAULT_MANAGED_START_COMMAND;
    }

    if (shouldSpawnDirectly(configured) || path.isAbsolute(configured) || configured.startsWith("servers/")) {
      const normalizedPath = normalizeServerRelativePath(record, configured, fallback.replace(/^\.?\//, ""));
      if (record && record.managedRuntime && (normalizedPath === "launch-server.sh" || normalizedPath === ".rippermoon/launch-server.sh")) {
        return DEFAULT_MANAGED_START_COMMAND;
      }
      return normalizedPath.startsWith("./") ? normalizedPath : `./${normalizedPath}`;
    }

    return configured;
  }

  function normalizeServerRecord(recordId, record) {
    const normalizedRecord = { ...(record || {}) };
    const normalizedWithId = {
      ...normalizedRecord,
      id: recordId
    };
    const directoryName = getManagedDirectoryName(normalizedWithId);
    const withDirectory = {
      ...normalizedWithId,
      directory: path.posix.join("servers", directoryName)
    };

    return {
      ...withDirectory,
      javaBin: String(withDirectory.javaBin || "").trim(),
      logFile: normalizeServerRelativePath(withDirectory, withDirectory.logFile, "logs/latest.log"),
      modsDir: normalizeServerRelativePath(withDirectory, withDirectory.modsDir, "mods"),
      serverPropertiesFile: normalizeServerRelativePath(withDirectory, withDirectory.serverPropertiesFile, "server.properties"),
      startCommand: normalizeStartCommand(withDirectory),
      worldDir: normalizeServerRelativePath(withDirectory, withDirectory.worldDir, "world")
    };
  }

  function normalizeServerRecords(records) {
    const nextRecords = {};
    let changed = false;

    for (const [recordId, record] of Object.entries(records || {})) {
      const normalizedRecord = normalizeServerRecord(recordId, record);
      nextRecords[recordId] = normalizedRecord;
      if (JSON.stringify(normalizedRecord) !== JSON.stringify(record || {})) {
        changed = true;
      }
    }

    return {
      changed,
      records: nextRecords
    };
  }

  function uniqueStrings(values) {
    return [...new Set((values || []).filter(Boolean).map((value) => String(value)))];
  }

  function recordPreferenceScore(record, directoryName) {
    let score = 0;
    if (record.id && record.id !== directoryName) {
      score += 50;
    }
    if (record.name && record.name !== displayNameFromSlug(directoryName)) {
      score += 20;
    }
    if (record.createdBy) {
      score += 10;
    }
    if (record.passphraseHash) {
      score += 10;
    }
    if (record.description) {
      score += 5;
    }
    if (record.managedRuntime) {
      score += 5;
    }
    if (record.loader && record.loader !== "vanilla") {
      score += 3;
    }
    return score;
  }

  function mergeDuplicateRecords(primaryRecord, secondaryRecord) {
    return {
      ...secondaryRecord,
      ...primaryRecord,
      createdAt:
        primaryRecord.createdAt && secondaryRecord.createdAt
          ? (primaryRecord.createdAt <= secondaryRecord.createdAt ? primaryRecord.createdAt : secondaryRecord.createdAt)
          : (primaryRecord.createdAt || secondaryRecord.createdAt || nowIso()),
      createdBy: primaryRecord.createdBy || secondaryRecord.createdBy || null,
      description: primaryRecord.description || secondaryRecord.description || "",
      managedRuntime: primaryRecord.managedRuntime || secondaryRecord.managedRuntime || null,
      name: primaryRecord.name || secondaryRecord.name || displayNameFromSlug(primaryRecord.id),
      passphraseHash: primaryRecord.passphraseHash || secondaryRecord.passphraseHash || null,
      updatedAt:
        primaryRecord.updatedAt && secondaryRecord.updatedAt
          ? (primaryRecord.updatedAt >= secondaryRecord.updatedAt ? primaryRecord.updatedAt : secondaryRecord.updatedAt)
          : (primaryRecord.updatedAt || secondaryRecord.updatedAt || nowIso())
    };
  }

  function dedupeServerRecords(records) {
    const groupedByDirectory = new Map();
    for (const [recordId, record] of Object.entries(records)) {
      const directoryName = getManagedDirectoryName(record);
      if (!groupedByDirectory.has(directoryName)) {
        groupedByDirectory.set(directoryName, []);
      }
      groupedByDirectory.get(directoryName).push([recordId, record]);
    }

    const nextRecords = { ...records };
    const aliases = new Map();
    let changed = false;

    for (const [directoryName, entries] of groupedByDirectory.entries()) {
      if (entries.length <= 1) {
        continue;
      }

      entries.sort((leftEntry, rightEntry) => {
        const leftScore = recordPreferenceScore(leftEntry[1], directoryName);
        const rightScore = recordPreferenceScore(rightEntry[1], directoryName);
        if (leftScore !== rightScore) {
          return rightScore - leftScore;
        }
        const leftCreatedAt = leftEntry[1].createdAt || "";
        const rightCreatedAt = rightEntry[1].createdAt || "";
        return leftCreatedAt.localeCompare(rightCreatedAt);
      });

      const [keptId, keptRecord] = entries[0];
      let mergedRecord = keptRecord;
      for (const [duplicateId, duplicateRecord] of entries.slice(1)) {
        mergedRecord = mergeDuplicateRecords(mergedRecord, duplicateRecord);
        delete nextRecords[duplicateId];
        aliases.set(duplicateId, keptId);
        changed = true;
      }
      nextRecords[keptId] = mergedRecord;
    }

    return {
      aliases,
      changed,
      records: nextRecords
    };
  }

  async function applyRecordAliases(aliases) {
    if (!aliases.size) {
      return;
    }

    const users = await store.getUsers();
    let changed = false;
    const nextUsers = users.map((user) => {
      const nextServers = uniqueStrings(
        (Array.isArray(user.servers) ? user.servers : []).map((serverId) => aliases.get(serverId) || serverId)
      );
      const existingCreateWorldServers =
        user.permissions && Array.isArray(user.permissions.createWorldServers)
          ? user.permissions.createWorldServers
          : [];
      const nextCreateWorldServers = uniqueStrings(
        existingCreateWorldServers.map((serverId) => aliases.get(serverId) || serverId)
      );

      if (
        nextServers.length !== (Array.isArray(user.servers) ? user.servers.length : 0) ||
        nextCreateWorldServers.length !== existingCreateWorldServers.length ||
        nextServers.some((value, index) => value !== (user.servers || [])[index]) ||
        nextCreateWorldServers.some((value, index) => value !== existingCreateWorldServers[index])
      ) {
        changed = true;
        return {
          ...user,
          permissions: {
            ...(user.permissions || {}),
            createWorldServers: nextCreateWorldServers
          },
          servers: nextServers,
          updatedAt: nowIso()
        };
      }

      return user;
    });

    if (changed) {
      await store.saveUsers(nextUsers);
    }
  }

  async function detectVersion(serverDir) {
    const jarPath = path.join(serverDir, "server.jar");
    try {
      const linkTarget = await fsp.readlink(jarPath);
      const match = linkTarget.match(/versions\/([^/]+)\/server-/);
      if (match) {
        return match[1];
      }
    } catch {
      // ignore
    }

    const latestLog = await tailTextFile(path.join(serverDir, "logs/latest.log"), 80_000);
    const match = latestLog.match(/Starting minecraft server version ([^\s]+)/);
    return match ? match[1] : "unknown";
  }

  async function syncDiscoveredServers() {
    const directories = await listServerDirectories();
    const initialRecords = await store.getServerRecords();
    const deduped = dedupeServerRecords(initialRecords);
    const normalized = normalizeServerRecords(deduped.records);
    const records = normalized.records;
    const registeredDirectories = new Set(
      Object.values(records).map((record) => getManagedDirectoryName(record))
    );
    let discoveredAdded = false;

    for (const directoryName of directories) {
      if (registeredDirectories.has(directoryName)) {
        continue;
      }

      const relativeDirectory = path.join("servers", directoryName);
      const version = await detectVersion(path.join(store.rootDir, relativeDirectory));
      records[directoryName] = {
        id: directoryName,
        name: displayNameFromSlug(directoryName),
        description: "",
        directory: relativeDirectory,
        loader: "vanilla",
        minecraftVersion: version,
        startCommand: DEFAULT_EXISTING_START_COMMAND,
        worldDir: "world",
        logFile: "logs/latest.log",
        serverPropertiesFile: "server.properties",
        modsDir: "mods",
        passphraseHash: null,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };
      registeredDirectories.add(directoryName);
      discoveredAdded = true;
    }

    if (deduped.aliases.size) {
      await applyRecordAliases(deduped.aliases);
    }

    if (deduped.changed || normalized.changed || discoveredAdded) {
      await store.saveServerRecords(records);
    }
    return records;
  }

  async function getAllServers() {
    return await syncDiscoveredServers();
  }

  async function getServer(serverId) {
    const records = await getAllServers();
    return records[serverId] || null;
  }

  function userCanAccessServer(user, server) {
    if (!user || !server) {
      return false;
    }
    if (user.role === "owner") {
      return true;
    }
    const servers = Array.isArray(user.servers) ? user.servers : [];
    return servers.includes(server.id);
  }

  function userCanCreateWorld(user, serverId) {
    if (!user) {
      return false;
    }
    if (user.role === "owner") {
      return true;
    }
    const createWorldServers =
      user.permissions && Array.isArray(user.permissions.createWorldServers)
        ? user.permissions.createWorldServers
        : [];
    return createWorldServers.includes(serverId);
  }

  function userCanManageAddons(user, server) {
    return userCanAccessServer(user, server);
  }

  async function listServersForUser(user) {
    const records = Object.values(await getAllServers());
    const visible = records.filter((server) => userCanAccessServer(user, server));

    return await Promise.all(
      visible.map(async (server) => {
        const status = await getServerStatus(server.id);
        const paths = resolveRecordPaths(server);
        const worldCount = await countWorldAssets(paths.worldLibraryDir);
        const modCount = await countFiles(paths.modsDir);
        return {
          ...serializeServer(server),
          status,
          worldCount,
          modCount
        };
      })
    );
  }

  async function countFiles(directoryPath) {
    try {
      const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile()).length;
    } catch (error) {
      if (error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  async function countWorldAssets(directoryPath) {
    try {
      const entries = await fsp.readdir(directoryPath, { withFileTypes: true });
      return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".zip")).length;
    } catch (error) {
      if (error.code === "ENOENT") {
        return 0;
      }
      throw error;
    }
  }

  async function getPidInfo(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      return null;
    }
    const paths = resolveRecordPaths(server);
    try {
      const raw = await fsp.readFile(paths.pidFile, "utf8");
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  function isProcessAlive(pid) {
    if (!pid) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function writePidInfo(serverId, info) {
    const server = await getServer(serverId);
    const paths = resolveRecordPaths(server);
    await ensureDir(paths.runtimeDir);
    await fsp.writeFile(paths.pidFile, `${JSON.stringify(info, null, 2)}\n`, "utf8");
  }

  async function clearPidInfo(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      return;
    }
    const paths = resolveRecordPaths(server);
    await fsp.rm(paths.pidFile, { force: true });
  }

  async function getServerStatus(serverId) {
    const pidInfo = await getPidInfo(serverId);
    if (pidInfo && isProcessAlive(pidInfo.pid)) {
      return {
        running: true,
        pid: pidInfo.pid,
        startedAt: pidInfo.startedAt,
        startedBy: pidInfo.startedBy || "unknown"
      };
    }

    if (pidInfo) {
      await clearPidInfo(serverId);
    }

    return {
      running: false,
      pid: null,
      startedAt: null,
      startedBy: null
    };
  }

  // A per-server Java path is needed because one dashboard can host servers
  // that require different JDKs, while the JAVA_BIN environment override is global to
  // the whole service process.
  async function validateJavaBin(javaBin) {
    const trimmed = String(javaBin || "").trim();
    if (!trimmed) {
      return "";
    }
    if (!path.isAbsolute(trimmed)) {
      throw userFacingError(
        "The Java binary must be an absolute path, for example /usr/lib/jvm/java-17-openjdk-amd64/bin/java."
      );
    }
    try {
      await fsp.access(trimmed, fs.constants.X_OK);
    } catch {
      throw userFacingError(`Java binary not found or not executable: ${trimmed}`);
    }
    return trimmed;
  }

  async function setServerMetadata(serverId, patch) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const nextPatch = { ...patch };
    if (nextPatch.javaBin !== undefined) {
      nextPatch.javaBin = await validateJavaBin(nextPatch.javaBin);
    }
    if (typeof nextPatch.passphrase === "string") {
      const trimmed = nextPatch.passphrase.trim();
      nextPatch.passphraseHash = trimmed ? hashSecret(trimmed) : null;
      delete nextPatch.passphrase;
    }

    const nextRecord = normalizeServerRecord(serverId, {
      ...server,
      ...nextPatch,
      updatedAt: nowIso()
    });

    await store.updateServerRecord(serverId, nextRecord);
    return nextRecord;
  }

  async function readServerProperties(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    try {
      return await fsp.readFile(paths.propertiesFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  }

  async function readEulaStatus(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    try {
      const contents = await fsp.readFile(paths.eulaFile, "utf8");
      return /^eula\s*=\s*true\b/im.test(contents);
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async function writeEulaStatus(serverId, accepted) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await fsp.writeFile(paths.eulaFile, `eula=${accepted ? "true" : "false"}\n`, "utf8");
    return await readEulaStatus(serverId);
  }

  async function writeServerProperties(serverId, contents) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await fsp.writeFile(paths.propertiesFile, contents, "utf8");
  }

  async function readSafeAdminProperties(serverId) {
    const propertyMap = parseServerPropertiesText(await readServerProperties(serverId));
    const safeProperties = {};
    for (const definition of SAFE_ADMIN_SETTING_DEFINITIONS) {
      safeProperties[definition.key] = propertyMap[definition.key] ?? definition.defaultValue;
    }
    return safeProperties;
  }

  async function readWorldRules(serverId) {
    const propertyMap = parseServerPropertiesText(await readServerProperties(serverId));
    return {
      forceGamemode: propertyMap["force-gamemode"] ?? "false",
      generateStructures: propertyMap["generate-structures"] ?? "true",
      levelType: propertyMap["level-type"] ?? "minecraft:normal"
    };
  }

  async function writeSafeAdminProperties(serverId, nextSafeProperties) {
    const propertyMap = parseServerPropertiesText(await readServerProperties(serverId));

    for (const definition of SAFE_ADMIN_SETTING_DEFINITIONS) {
      if (!(definition.key in nextSafeProperties)) {
        continue;
      }
      propertyMap[definition.key] = normalizeAdminSettingValue(definition, nextSafeProperties[definition.key]);
    }

    await writeServerProperties(serverId, serializeServerProperties(propertyMap));
    return await readSafeAdminProperties(serverId);
  }

  function offlinePlayerUuid(name) {
    const hash = crypto.createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
    hash[6] = (hash[6] & 0x0f) | 0x30;
    hash[8] = (hash[8] & 0x3f) | 0x80;
    const hex = hash.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // Offline UUIDs are version 3 (name-based MD5); Mojang issues version 4.
  // The version nibble is the first character of the third group.
  function uuidKind(uuid) {
    const normalized = String(uuid || "").trim().toLowerCase();
    const match = normalized.match(/^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    if (!match) {
      return "unknown";
    }
    return match[1] === "3" ? "offline" : match[1] === "4" ? "online" : "unknown";
  }

  async function serverIsOnlineMode(serverId) {
    try {
      const properties = parseServerPropertiesText(await readServerProperties(serverId));
      // Minecraft defaults online-mode to true when the key is absent.
      return String(properties["online-mode"] ?? "true").trim().toLowerCase() !== "false";
    } catch {
      return true;
    }
  }

  // On an online-mode server an offline UUID can never match a real player: the
  // operator silently has no powers. Resolve the real one from Mojang instead.
  async function resolveMojangUuid(name) {
    const response = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
      headers: withRemoteHeaders()
    });
    if (response.status === 404 || response.status === 204) {
      throw userFacingError(`No Minecraft account named "${name}" exists. Check the spelling.`, 404);
    }
    if (!response.ok) {
      throw userFacingError(
        `Could not reach Mojang to look up "${name}" (HTTP ${response.status}). Try again in a moment.`,
        502
      );
    }
    const payload = await response.json();
    const raw = String(payload.id || "").replace(/-/g, "");
    if (raw.length !== 32) {
      throw userFacingError(`Mojang returned an unexpected id for "${name}".`, 502);
    }
    return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`.toLowerCase();
  }

  async function resolveOperatorUuid(serverId, name) {
    if (await serverIsOnlineMode(serverId)) {
      return await resolveMojangUuid(name);
    }
    return offlinePlayerUuid(name);
  }

  function normalizeOperator(entry) {
    const name = String(entry && entry.name ? entry.name : "").trim();
    const uuid = String(entry && entry.uuid ? entry.uuid : "").trim().toLowerCase();
    if (!name) {
      return null;
    }
    return {
      uuid: uuid || offlinePlayerUuid(name),
      name,
      level: Math.min(4, Math.max(1, Number.parseInt(entry.level, 10) || 4)),
      bypassesPlayerLimit: entry.bypassesPlayerLimit === true
    };
  }

  async function listServerOperators(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    const payload = await readJson(paths.opsFile, []);
    const onlineMode = await serverIsOnlineMode(serverId);
    const expected = onlineMode ? "online" : "offline";
    return (Array.isArray(payload) ? payload : [])
      .map(normalizeOperator)
      .filter(Boolean)
      .map((operator) => {
        const kind = uuidKind(operator.uuid);
        return {
          ...operator,
          // A mismatch here means the entry can never match a joining player,
          // and Minecraft gives no indication - it just ignores the operator.
          uuidKind: kind,
          uuidMatchesServerMode: kind === expected
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async function writeServerOperators(serverId, operators) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    const unique = new Map();
    for (const operator of operators || []) {
      const normalized = normalizeOperator(operator);
      if (normalized) {
        unique.set(normalized.uuid, normalized);
      }
    }
    const nextOperators = [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
    await writeJson(paths.opsFile, nextOperators);
    return nextOperators;
  }

  async function addServerOperator(serverId, operator) {
    const name = String((operator && operator.name) || "").trim();
    if (!name) {
      throw userFacingError("A player name is required.", 400);
    }

    // normalizeOperator falls back to level 4 so that hand-written ops.json
    // entries keep the powers they already had. Granting that by default to a
    // request that simply omitted the field is a different matter: level 4
    // includes /stop, /ban and /op, so the caller has to say so out loud.
    const level = Number.parseInt(operator && operator.level, 10);
    if (!Number.isInteger(level) || level < 1 || level > 4) {
      throw userFacingError("Choose an op level between 1 and 4 for this operator.", 400);
    }

    const current = await listServerOperators(serverId);
    // Always derive the uuid from the server's auth mode rather than trusting
    // whatever the caller sent, so the entry can actually match a player.
    const uuid = await resolveOperatorUuid(serverId, name);
    const next = current.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
    return await writeServerOperators(serverId, [...next, { ...operator, level, name, uuid }]);
  }

  // Rewrites existing operators to the uuid form the server's auth mode needs.
  // Fixes entries added before the mode was known or changed afterwards.
  async function repairServerOperators(serverId) {
    const current = await listServerOperators(serverId);
    const next = [];
    const failures = [];
    let repaired = 0;

    for (const operator of current) {
      if (operator.uuidMatchesServerMode) {
        next.push(operator);
        continue;
      }
      try {
        next.push({ ...operator, uuid: await resolveOperatorUuid(serverId, operator.name) });
        repaired += 1;
      } catch (error) {
        failures.push({ name: operator.name, reason: error.message });
        next.push(operator);
      }
    }

    await writeServerOperators(serverId, next);
    return { failures, operators: await listServerOperators(serverId), repaired };
  }

  async function removeServerOperator(serverId, uuid) {
    const targetUuid = String(uuid || "").trim().toLowerCase();
    const current = await listServerOperators(serverId);
    return await writeServerOperators(
      serverId,
      current.filter((operator) => operator.uuid !== targetUuid)
    );
  }

  async function getServerLog(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    const latestLog = await tailTextFile(paths.logFile, 180_000);
    const runtimeLog = await tailTextFile(paths.runtimeLog, 60_000);
    return {
      latestLog,
      runtimeLog
    };
  }

  async function listInstalledFiles(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await ensureDir(paths.modsDir);
    await ensureDir(paths.disabledModsDir);
    const entries = await fsp.readdir(paths.modsDir, { withFileTypes: true });
    const disabledEntries = await fsp.readdir(paths.disabledModsDir, { withFileTypes: true });
    const active = entries
      .filter((entry) => entry.isFile())
      .map((entry) => ({ enabled: true, fileName: entry.name }));
    const disabled = disabledEntries
      .filter((entry) => entry.isFile())
      .map((entry) => ({ enabled: false, fileName: entry.name }));

    // Join the tracked manifest onto what is actually on disk, so the add-on
    // list can show a title, artwork and which side the mod belongs on instead
    // of a bare filename. Files with no manifest entry were dropped in by hand
    // and stay deliberately bare - there is nothing truthful to show for them.
    const manifest = await readAddonManifest(serverId);
    const detailsByFileName = new Map(manifest.map((entry) => [entry.fileName, entry]));

    return [...active, ...disabled]
      .map((entry) => {
        const tracked = detailsByFileName.get(entry.fileName);
        if (!tracked) {
          return { ...entry, tracked: false };
        }
        return {
          ...entry,
          clientSide: tracked.clientSide || "unknown",
          iconUrl: tracked.iconUrl || "",
          pageUrl: tracked.pageUrl || "",
          provider: tracked.provider || "",
          serverSide: tracked.serverSide || "unknown",
          sourceId: tracked.sourceId || "",
          title: tracked.title || "",
          tracked: true
        };
      })
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
  }

  async function readAddonManifest(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    const payload = await readJson(paths.addonManifestFile, { addons: [] });
    return Array.isArray(payload.addons) ? payload.addons : [];
  }

  async function writeAddonManifest(serverId, addons) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await ensureDir(paths.runtimeDir);
    const normalized = (Array.isArray(addons) ? addons : [])
      .filter((entry) => entry && entry.fileName && entry.provider && entry.sourceId)
      .map((entry) => ({
        dependencyOf: entry.dependencyOf || null,
        direct: entry.direct !== false,
        fileName: safeFilename(entry.fileName),
        gameVersion: entry.gameVersion || server.minecraftVersion || "",
        installKind: entry.installKind || (PAPER_LIKE_LOADERS.has(server.loader) ? "plugin" : "mod"),
        installedAt: entry.installedAt || nowIso(),
        loader: entry.loader || server.loader || "vanilla",
        manual: entry.manual === true,
        managed: entry.managed !== false,
        provider: entry.provider,
        sourceId: String(entry.sourceId)
      }))
      .sort((left, right) => left.fileName.localeCompare(right.fileName));
    await writeJson(paths.addonManifestFile, { addons: normalized });
    return normalized;
  }

  async function recordAddonInstalls(serverId, nextEntries) {
    const current = await readAddonManifest(serverId);
    const replacementNames = new Set((nextEntries || []).map((entry) => safeFilename(entry.fileName)));
    const remaining = current.filter((entry) => !replacementNames.has(entry.fileName));
    return await writeAddonManifest(serverId, [...remaining, ...(nextEntries || [])]);
  }

  async function removeInstalledFiles(serverId, fileNames) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    const uniqueNames = [...new Set((fileNames || []).map((name) => safeFilename(name)).filter(Boolean))];
    await Promise.all(
      uniqueNames.flatMap((fileName) => [
        fsp.rm(path.join(paths.modsDir, fileName), { force: true }),
        fsp.rm(path.join(paths.disabledModsDir, fileName), { force: true })
      ])
    );
  }

  async function removeAddonFiles(serverId, fileNames) {
    const uniqueNames = [...new Set((fileNames || []).map((name) => safeFilename(name)).filter(Boolean))];
    if (!uniqueNames.length) {
      return [];
    }

    await removeInstalledFiles(serverId, uniqueNames);
    const removedNames = new Set(uniqueNames);
    const remaining = (await readAddonManifest(serverId)).filter((entry) => !removedNames.has(entry.fileName));
    await writeAddonManifest(serverId, remaining);
    return uniqueNames;
  }

  async function setAddonEnabled(serverId, fileName, enabled) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await ensureDir(paths.modsDir);
    await ensureDir(paths.disabledModsDir);

    const cleanName = safeFilename(fileName);
    if (!cleanName) {
      throw new Error("Add-on file name is required.");
    }

    const activePath = path.join(paths.modsDir, cleanName);
    const disabledPath = path.join(paths.disabledModsDir, cleanName);
    const sourcePath = enabled ? disabledPath : activePath;
    const targetPath = enabled ? activePath : disabledPath;

    if (!(await exists(sourcePath))) {
      throw new Error(`Add-on is already ${enabled ? "enabled" : "disabled"} or does not exist.`);
    }
    if (await exists(targetPath)) {
      throw new Error(`Cannot ${enabled ? "enable" : "disable"} ${cleanName}; target file already exists.`);
    }

    await fsp.rename(sourcePath, targetPath);
    return await listInstalledFiles(serverId);
  }

  async function installManagedFile(serverId, fileName, buffer) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await ensureDir(paths.modsDir);
    const targetFile = path.join(paths.modsDir, safeFilename(fileName));
    await fsp.writeFile(targetFile, buffer);
    return path.basename(targetFile);
  }

  async function downloadAndInstallFile(serverId, url, fileNameHint) {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}.`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const parsedUrl = new URL(url);
    const fallbackName = path.basename(parsedUrl.pathname) || "download.jar";
    const installedName = await installManagedFile(serverId, fileNameHint || fallbackName, buffer);
    return {
      fileName: installedName,
      size: buffer.length
    };
  }

  async function resolveVanillaRuntime(version) {
    const manifest = await fetchMinecraftVersionManifest();
    const requestedVersion = !version || version === "latest" ? manifest.latest.release : String(version).trim();
    const versionEntry = (manifest.versions || []).find((entry) => entry.id === requestedVersion);
    if (!versionEntry) {
      throw new Error(`Minecraft version ${requestedVersion} was not found.`);
    }

    const versionData = await fetchJson(versionEntry.url);
    const serverDownload = versionData.downloads && versionData.downloads.server;
    if (!serverDownload) {
      throw new Error(`Version ${requestedVersion} does not have a downloadable server jar.`);
    }

    return {
      downloadUrl: serverDownload.url,
      sha1: serverDownload.sha1,
      targetVersion: requestedVersion
    };
  }

  async function resolvePaperRuntime(loader, version) {
    const requestedVersion = await resolveRequestedReleaseVersion(version);
    if (!requestedVersion) {
      throw new Error(`Choose a Minecraft version before updating a ${displayNameFromSlug(loader)} server.`);
    }

    const builds = await fetchJson(
      `${PAPER_DOWNLOADS_API}/projects/${encodeURIComponent(loader)}/versions/${encodeURIComponent(requestedVersion)}/builds`
    );
    const selectedBuild = Array.isArray(builds)
      ? builds.find((item) => item.channel === "STABLE" && item.downloads && item.downloads["server:default"]?.url)
      : null;

    if (!selectedBuild) {
      throw new Error(`No stable ${displayNameFromSlug(loader)} build was found for Minecraft ${requestedVersion}.`);
    }

    return {
      buildId: selectedBuild.id,
      downloadUrl: selectedBuild.downloads["server:default"].url,
      source: `papermc:${loader}`,
      targetVersion: requestedVersion
    };
  }

  async function resolvePurpurRuntime(version) {
    const requestedVersion = await resolveRequestedReleaseVersion(version);
    if (!requestedVersion) {
      throw new Error("Choose a Minecraft version before updating a Purpur server.");
    }

    const payload = await fetchJson(`${PURPUR_DOWNLOADS_API}/${encodeURIComponent(requestedVersion)}`);
    if (!payload || payload.error) {
      throw new Error(`Purpur does not provide a build for Minecraft ${requestedVersion}.`);
    }

    const latestBuild =
      payload.builds && typeof payload.builds === "object"
        ? payload.builds.latest || null
        : null;

    return {
      buildId: latestBuild,
      downloadUrl: `${PURPUR_DOWNLOADS_API}/${encodeURIComponent(requestedVersion)}/latest/download`,
      source: "purpur",
      targetVersion: requestedVersion
    };
  }

  // Every loader build published for a Minecraft version, newest first. This is
  // what makes pinning, upgrading and downgrading possible: without the full
  // list the dashboard can only ever take whatever "latest" happens to be.
  async function listFabricLoaderVersions(gameVersion) {
    const entries = await fetchJson(`${FABRIC_META_API}/versions/loader/${encodeURIComponent(gameVersion)}`);
    return (entries || [])
      .filter((entry) => entry && entry.loader && entry.loader.version)
      .map((entry) => ({
        stable: entry.loader.stable === true,
        version: entry.loader.version
      }));
  }

  async function listForgeLoaderVersions(gameVersion) {
    const [metadataXml, promotions] = await Promise.all([
      fetchText(FORGE_MAVEN_METADATA_URL),
      fetchJson(FORGE_PROMOTIONS_URL).catch(() => ({ promos: {} }))
    ]);

    const promos = promotions.promos || {};
    const recommended = promos[`${gameVersion}-recommended`] || null;
    const latest = promos[`${gameVersion}-latest`] || null;

    const prefix = `${gameVersion}-`;
    const versions = [...metadataXml.matchAll(/<version>([^<]+)<\/version>/g)]
      .map((match) => match[1].trim())
      // Forge artifacts are "<mc>-<forge>", sometimes with a branch suffix.
      .filter((artifact) => artifact.startsWith(prefix))
      .map((artifact) => artifact.slice(prefix.length));

    return versions
      .map((version) => ({
        recommended: version === recommended,
        stable: version === recommended || version === latest,
        version
      }))
      .reverse();
  }

  async function listNeoforgeLoaderVersions(gameVersion) {
    const payload = await fetchJson(NEOFORGE_VERSIONS_API);
    // NeoForge encodes the Minecraft version in its own: 1.21.1 -> 21.1.x.
    const [, minor, patch = "0"] = String(gameVersion).split(".");
    if (minor === undefined) {
      return [];
    }
    const prefix = `${String(Number(minor))}.${String(Number(patch))}.`;
    return (payload.versions || [])
      .filter((entry) => entry.startsWith(prefix))
      .map((version) => ({
        stable: !version.includes("beta"),
        version
      }))
      .reverse();
  }

  async function listLoaderVersionsFor(loader, gameVersion) {
    const normalizedLoader = String(loader || "").trim().toLowerCase();
    const resolvedGameVersion = await resolveRequestedReleaseVersion(gameVersion);
    const cacheKey = `${normalizedLoader}:${resolvedGameVersion}`;
    const cached = loaderCatalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    let versions = [];
    if (normalizedLoader === "fabric") {
      versions = await listFabricLoaderVersions(resolvedGameVersion);
    } else if (normalizedLoader === "forge") {
      versions = await listForgeLoaderVersions(resolvedGameVersion);
    } else if (normalizedLoader === "neoforge") {
      versions = await listNeoforgeLoaderVersions(resolvedGameVersion);
    }
    // Vanilla, Paper and Purpur have no loader version of their own - the build
    // is chosen by the game version alone, so the list stays empty.

    const value = { gameVersion: resolvedGameVersion, versions };
    loaderCatalogCache.set(cacheKey, { expiresAt: Date.now() + 5 * 60_000, value });
    return value;
  }

  // Pick the loader build to install. An explicit request is honoured only if
  // that build actually exists for the target game version, which is what stops
  // an upgrade or downgrade from silently producing an unlaunchable server.
  async function selectLoaderVersion(loader, gameVersion, requestedVersion, describeLoader) {
    const catalog = await listLoaderVersionsFor(loader, gameVersion);
    const available = catalog.versions;
    if (!available.length) {
      throw new Error(`${describeLoader} has no build for Minecraft ${gameVersion}.`);
    }

    const requested = String(requestedVersion || "").trim();
    if (requested) {
      const match = available.find((entry) => entry.version === requested);
      if (!match) {
        throw new Error(
          `${describeLoader} ${requested} is not published for Minecraft ${gameVersion}. Available builds: ${available
            .slice(0, 6)
            .map((entry) => entry.version)
            .join(", ")}${available.length > 6 ? ", ..." : ""}.`
        );
      }
      return match.version;
    }

    const preferred = available.find((entry) => entry.recommended) || available.find((entry) => entry.stable);
    return (preferred || available[0]).version;
  }

  // Fabric publishes a ready-made server launcher jar, so no installer run is
  // needed - unlike Forge and NeoForge below.
  async function resolveFabricRuntime(version, loaderVersionRequest) {
    const targetVersion = await resolveRequestedReleaseVersion(version);
    const loaderVersion = await selectLoaderVersion("fabric", targetVersion, loaderVersionRequest, "Fabric Loader");

    const installers = await fetchJson(`${FABRIC_META_API}/versions/installer`);
    const stableInstaller = installers.find((entry) => entry.stable) || installers[0];
    if (!stableInstaller) {
      throw new Error("Fabric has no installer build available.");
    }

    const installerVersion = stableInstaller.version;
    return {
      downloadUrl: `${FABRIC_META_API}/versions/loader/${encodeURIComponent(targetVersion)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installerVersion)}/server/jar`,
      loaderVersion,
      source: `fabric ${loaderVersion}`,
      targetVersion
    };
  }

  async function resolveForgeRuntime(version, loaderVersionRequest) {
    const targetVersion = await resolveRequestedReleaseVersion(version);
    const forgeVersion = await selectLoaderVersion("forge", targetVersion, loaderVersionRequest, "Forge");

    const artifact = `${targetVersion}-${forgeVersion}`;
    return {
      installerUrl: `${FORGE_MAVEN}/${artifact}/forge-${artifact}-installer.jar`,
      loaderVersion: forgeVersion,
      relativeArgFile: path.posix.join("libraries", "net", "minecraftforge", "forge", artifact, "unix_args.txt"),
      source: `forge ${forgeVersion}`,
      targetVersion
    };
  }

  async function resolveNeoforgeRuntime(version, loaderVersionRequest) {
    const targetVersion = await resolveRequestedReleaseVersion(version);
    let neoforgeVersion;
    try {
      neoforgeVersion = await selectLoaderVersion("neoforge", targetVersion, loaderVersionRequest, "NeoForge");
    } catch (error) {
      if (String(error.message).includes("has no build")) {
        throw new Error(
          `NeoForge has no stable build for Minecraft ${targetVersion}. NeoForge starts at Minecraft 1.20.2.`
        );
      }
      throw error;
    }

    return {
      installerUrl: `${NEOFORGE_MAVEN}/${neoforgeVersion}/neoforge-${neoforgeVersion}-installer.jar`,
      loaderVersion: neoforgeVersion,
      relativeArgFile: path.posix.join("libraries", "net", "neoforged", "neoforge", neoforgeVersion, "unix_args.txt"),
      source: `neoforge ${neoforgeVersion}`,
      targetVersion
    };
  }

  // Directories distributions install JDKs into. Each child is probed for
  // bin/java, plus the macOS Contents/Home layout.
  function javaSearchRoots() {
    return [
      "/usr/lib/jvm",
      "/usr/java",
      "/opt/java",
      "/opt/jdk",
      path.join(os.homedir(), ".sdkman", "candidates", "java"),
      "/Library/Java/JavaVirtualMachines"
    ];
  }

  async function collectJavaCandidates() {
    // Lower rank wins when two paths resolve to the same binary. A versioned
    // JVM directory is preferred over /usr/bin/java, which floats with
    // update-alternatives and would silently change a pinned server's JDK.
    const candidates = [];
    const add = (candidatePath, source, rank) => {
      if (candidatePath) {
        candidates.push({ path: candidatePath, rank, source });
      }
    };

    for (const root of javaSearchRoots()) {
      let entries = [];
      try {
        entries = await fsp.readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          continue;
        }
        add(path.join(root, entry.name, "bin", "java"), "installed", 0);
        add(path.join(root, entry.name, "Contents", "Home", "bin", "java"), "installed", 0);
      }
    }

    add(readEnv("JAVA_BIN").trim(), "environment", 1);
    if (String(process.env.JAVA_HOME || "").trim()) {
      add(path.join(process.env.JAVA_HOME.trim(), "bin", "java"), "environment", 1);
    }

    try {
      const { stdout } = await runCommand("command", ["-v", "java"], { timeoutMs: 3000 });
      add(stdout.trim(), "path", 2);
    } catch {
      try {
        const { stdout } = await runCommand("/usr/bin/env", ["which", "java"], { timeoutMs: 3000 });
        add(stdout.trim(), "path", 2);
      } catch {
        // No java on PATH; the installed scan may still have found some.
      }
    }

    return candidates;
  }

  async function probeJavaVersion(javaPath) {
    try {
      // `java -version` writes to stderr on every JDK vendor.
      const { stderr, stdout } = await runCommand(javaPath, ["-version"], { timeoutMs: 8000 });
      const text = `${stderr}${stdout}`;
      const match = text.match(/version "([^"]+)"/);
      if (!match) {
        return null;
      }
      const version = match[1];
      // 1.8.0_x is Java 8; everything since uses the leading number.
      const major = version.startsWith("1.")
        ? Number(version.split(".")[1])
        : Number(version.split(/[.\-+]/)[0]);
      return { major: Number.isFinite(major) ? major : null, version };
    } catch {
      return null;
    }
  }

  async function listJavaRuntimes(options = {}) {
    const now = Date.now();
    if (!options.refresh && javaRuntimeCache.data && javaRuntimeCache.expiresAt > now) {
      return javaRuntimeCache.data;
    }

    const candidates = await collectJavaCandidates();

    // Collapse symlinked duplicates: /usr/lib/jvm/java-1.17.0-... and
    // java-17-... are the same JDK and must not appear twice.
    const byRealPath = new Map();
    for (const candidate of candidates) {
      let realPath;
      try {
        realPath = await fsp.realpath(candidate.path);
        await fsp.access(realPath, fs.constants.X_OK);
      } catch {
        continue;
      }
      const existing = byRealPath.get(realPath);
      if (
        !existing ||
        candidate.rank < existing.rank ||
        (candidate.rank === existing.rank && candidate.path.length < existing.path.length)
      ) {
        byRealPath.set(realPath, candidate);
      }
    }

    const probed = await Promise.all(
      [...byRealPath.values()].map(async (candidate) => {
        const info = await probeJavaVersion(candidate.path);
        if (!info) {
          return null;
        }
        return {
          label: `Java ${info.major ?? "?"} (${info.version})`,
          major: info.major,
          path: candidate.path,
          source: candidate.source,
          version: info.version
        };
      })
    );

    const runtimes = probed
      .filter(Boolean)
      .sort((left, right) => (left.major || 0) - (right.major || 0) || left.path.localeCompare(right.path));

    javaRuntimeCache.data = runtimes;
    javaRuntimeCache.expiresAt = now + 5 * 60 * 1000;
    return runtimes;
  }

  // Mirrors the resolution order baked into the generated launch script, so the
  // installer runs on the same JDK the server will.
  function resolveJavaBinary(javaBin) {
    const explicit = String(javaBin || "").trim();
    if (explicit) {
      return explicit;
    }
    if (readEnv("JAVA_BIN").trim()) {
      return readEnv("JAVA_BIN").trim();
    }
    if (String(process.env.JAVA_HOME || "").trim()) {
      return path.join(process.env.JAVA_HOME.trim(), "bin", "java");
    }
    return "java";
  }

  async function runLoaderInstaller(runtime, serverDir, javaBin, onProgress = () => {}) {
    const javaBinary = resolveJavaBinary(javaBin);
    const installerPath = path.join(serverDir, ".rippermoon", "loader-installer.jar");
    await ensureDir(path.dirname(installerPath));
    onProgress(`downloading ${runtime.source} installer`);
    await fsp.writeFile(installerPath, await fetchBuffer(runtime.installerUrl));
    onProgress(`running the ${runtime.source} installer (this usually takes under a minute)`);

    try {
      await runCommand(javaBinary, ["-jar", installerPath, "--installServer", serverDir], {
        cwd: serverDir
      });
    } catch (error) {
      const detail = String(error.stderr || error.stdout || error.message || "").trim().split("\n").slice(-3).join(" ");
      throw new Error(
        `The ${runtime.source} installer failed. Check that ${javaBinary} exists and can run installers. ${detail}`
      );
    } finally {
      // The installer also drops a sibling <name>.jar.log next to its own cwd.
      await Promise.all([
        fsp.rm(installerPath, { force: true }),
        fsp.rm(`${installerPath}.log`, { force: true }),
        fsp.rm(path.join(serverDir, `${path.basename(installerPath)}.log`), { force: true })
      ]);
    }

    const argFilePath = path.join(serverDir, runtime.relativeArgFile);
    if (!(await exists(argFilePath))) {
      throw new Error(
        `The ${runtime.source} installer finished but did not produce ${runtime.relativeArgFile}. The server cannot be launched.`
      );
    }
  }

  async function createVanillaServer(version, serverDir) {
    const runtime = await resolveVanillaRuntime(version);
    const targetDir = path.join(serverDir, "versions", runtime.targetVersion);
    await ensureDir(targetDir);
    const bundlePath = path.join(targetDir, `server-${runtime.targetVersion}-bundle.jar`);
    const buffer = await fetchBuffer(runtime.downloadUrl);
    const actualSha1 = crypto.createHash("sha1").update(buffer).digest("hex");
    if (actualSha1 !== runtime.sha1) {
      throw new Error(`Checksum verification failed for ${runtime.targetVersion}.`);
    }
    await fsp.writeFile(bundlePath, buffer);

    const symlinkPath = path.join(serverDir, "server.jar");
    await fsp.rm(symlinkPath, { force: true });
    await fsp.symlink(path.relative(serverDir, bundlePath), symlinkPath);
    return runtime.targetVersion;
  }

  async function createJarManagedRuntime(loader, version, serverDir, options = {}) {
    const normalizedLoader = String(loader || "vanilla").trim().toLowerCase();
    const report = typeof options.onProgress === "function" ? options.onProgress : () => {};
    if (normalizedLoader === "vanilla") {
      return {
        kind: "vanilla",
        source: "mojang",
        targetVersion: await createVanillaServer(version, serverDir)
      };
    }

    if (normalizedLoader === "paper") {
      const runtime = await resolvePaperRuntime("paper", version);
      const bundlePath = path.join(serverDir, "server.jar");
      const buffer = await fetchBuffer(runtime.downloadUrl);
      await fsp.rm(bundlePath, { force: true });
      await fsp.writeFile(bundlePath, buffer);
      return {
        kind: "paper",
        source: runtime.source,
        targetVersion: runtime.targetVersion
      };
    }

    if (normalizedLoader === "purpur") {
      const runtime = await resolvePurpurRuntime(version);
      const bundlePath = path.join(serverDir, "server.jar");
      const buffer = await fetchBuffer(runtime.downloadUrl);
      await fsp.rm(bundlePath, { force: true });
      await fsp.writeFile(bundlePath, buffer);
      return {
        kind: "purpur",
        source: runtime.source,
        targetVersion: runtime.targetVersion
      };
    }

    if (normalizedLoader === "fabric") {
      report("resolving Fabric build");
      const runtime = await resolveFabricRuntime(version, options.loaderVersion);
      report(`downloading Fabric ${runtime.loaderVersion} server launcher`);
      const bundlePath = path.join(serverDir, "server.jar");
      const buffer = await fetchBuffer(runtime.downloadUrl);
      await fsp.rm(bundlePath, { force: true });
      await fsp.writeFile(bundlePath, buffer);
      return {
        kind: "fabric",
        launch: { kind: "jar" },
        loaderVersion: runtime.loaderVersion,
        source: runtime.source,
        targetVersion: runtime.targetVersion
      };
    }

    if (INSTALLER_LOADERS.has(normalizedLoader)) {
      report(`resolving ${normalizedLoader} build`);
      const runtime =
        normalizedLoader === "forge"
          ? await resolveForgeRuntime(version, options.loaderVersion)
          : await resolveNeoforgeRuntime(version, options.loaderVersion);
      await runLoaderInstaller(runtime, serverDir, options.javaBin, report);
      return {
        kind: normalizedLoader,
        // Forge and NeoForge produce argfiles instead of a runnable server.jar.
        launch: { argFile: runtime.relativeArgFile, kind: "argfile" },
        loaderVersion: runtime.loaderVersion,
        source: runtime.source,
        targetVersion: runtime.targetVersion
      };
    }

    throw new Error(
      `Managed server creation does not support the ${normalizedLoader} loader. Supported loaders are ${[...INSTALLABLE_LOADERS].join(", ")}. Use register existing for anything else.`
    );
  }

  function buildLaunchScript(minMemory = "2G", maxMemory = "4G", launch = null) {
    const launchLine = buildLaunchLine(launch);
    return `#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIN_MEMORY="${minMemory}"
MAX_MEMORY="${maxMemory}"

JAVA_BIN=""
if [ -n "\${RIPPERCRAFT_JAVA_BIN:-}" ]; then
  JAVA_BIN="\${RIPPERCRAFT_JAVA_BIN}"
elif [ -n "\${RIPPERMOONSTASH_JAVA_BIN:-}" ]; then
  # Pre-rename variable, still honoured so an existing deployment keeps working.
  JAVA_BIN="\${RIPPERMOONSTASH_JAVA_BIN}"
elif [ -n "\${JAVA_HOME:-}" ] && [ -x "\${JAVA_HOME}/bin/java" ]; then
  JAVA_BIN="\${JAVA_HOME}/bin/java"
elif command -v /usr/libexec/java_home >/dev/null 2>&1; then
  JAVA_HOME="$("/usr/libexec/java_home" -v 21 2>/dev/null || "/usr/libexec/java_home")"
  export JAVA_HOME
  JAVA_BIN="\${JAVA_HOME}/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"
else
  echo "Java was not found. Install Java or set JAVA_HOME or RIPPERCRAFT_JAVA_BIN." >&2
  exit 1
fi

${launchLine}
`;
  }

  // Forge and NeoForge have no server.jar; they are launched through the
  // argfile their installer generates, alongside user_jvm_args.txt.
  function buildLaunchLine(launch) {
    if (launch && launch.kind === "argfile" && launch.argFile) {
      return `JVM_ARGS=""
if [ -f user_jvm_args.txt ]; then
  JVM_ARGS="@user_jvm_args.txt"
fi

exec "$JAVA_BIN" -Xms\${MIN_MEMORY} -Xmx\${MAX_MEMORY} \${JVM_ARGS} "@${launch.argFile}" nogui`;
    }
    return `exec "$JAVA_BIN" -Xms\${MIN_MEMORY} -Xmx\${MAX_MEMORY} -jar server.jar nogui`;
  }

  function getManagedLaunchScriptContents(server) {
    return buildLaunchScript(
      server.minMemory || "2G",
      server.maxMemory || "4G",
      server.managedRuntime && server.managedRuntime.launch
    );
  }

  function shouldUseManagedLaunchCommand(server) {
    if (!server || !server.managedRuntime) {
      return false;
    }

    const configuredCommand = String(server.startCommand || "").trim();
    return !configuredCommand || configuredCommand === DEFAULT_EXISTING_START_COMMAND || configuredCommand === DEFAULT_MANAGED_START_COMMAND;
  }

  function userFacingError(message, statusCode = 409) {
    const error = new Error(message);
    error.statusCode = statusCode;
    return error;
  }

  function getInstallableLoaders() {
    return [...INSTALLABLE_LOADERS];
  }

  function usesArgFileLaunch(server) {
    const launch = server && server.managedRuntime && server.managedRuntime.launch;
    return Boolean(launch && launch.kind === "argfile" && launch.argFile);
  }

  // Forge and NeoForge have no server.jar, so "is the runtime installed?" means
  // checking for the argfile their installer generated instead.
  function managedRuntimeArtifactPath(server, paths) {
    if (usesArgFileLaunch(server)) {
      return path.join(paths.serverDir, server.managedRuntime.launch.argFile);
    }
    return paths.serverJarFile;
  }

  async function ensureManagedServerArtifacts(serverId, options = {}) {
    const server = await getServer(serverId);
    if (!server || !server.managedRuntime) {
      return {
        managed: false,
        repairedRuntime: false,
        startCommand: server ? server.startCommand || DEFAULT_EXISTING_START_COMMAND : DEFAULT_EXISTING_START_COMMAND
      };
    }

    const paths = resolveRecordPaths(server);
    await ensureDir(paths.serverDir);
    await ensureDir(paths.runtimeDir);
    await ensureDir(paths.modsDir);
    await ensureDir(paths.backupsDir);
    await ensureDir(path.dirname(paths.logFile));

    if (!(await exists(paths.eulaFile))) {
      await fsp.writeFile(paths.eulaFile, "eula=false\n", "utf8");
    }

    if (!(await exists(paths.propertiesFile))) {
      await fsp.writeFile(
        paths.propertiesFile,
        `motd=${server.name || displayNameFromSlug(server.id)}\nserver-port=25565\n`,
        "utf8"
      );
    }

    await fsp.writeFile(paths.managedLaunchScript, getManagedLaunchScriptContents(server), "utf8");
    await fsp.chmod(paths.managedLaunchScript, 0o755);

    let repairedRuntime = false;
    const runtimeArtifact = managedRuntimeArtifactPath(server, paths);
    if (!(await exists(runtimeArtifact)) && options.repairRuntime === true) {
      // Installer-based loaders cannot be repaired by the jar-swap update path;
      // re-run their installer instead.
      if (usesArgFileLaunch(server)) {
        const runtime = await createJarManagedRuntime(
          server.loader,
          server.minecraftVersion,
          paths.serverDir,
          {
            javaBin: server.javaBin,
            // Repair must reinstall the build the server was pinned to. Letting
            // it drift to "latest" would turn a missing-file repair into a
            // silent loader upgrade.
            loaderVersion: server.managedRuntime.loaderVersion || null
          }
        );
        await setServerMetadata(serverId, {
          managedRuntime: { ...runtime, updatedAt: nowIso() }
        });
        await fsp.writeFile(
          paths.managedLaunchScript,
          buildLaunchScript(server.minMemory, server.maxMemory, runtime.launch),
          "utf8"
        );
        await fsp.chmod(paths.managedLaunchScript, 0o755);
        return {
          managed: true,
          repairedRuntime: true,
          startCommand: DEFAULT_MANAGED_START_COMMAND
        };
      }

      let runtimePlan;
      try {
        // Reinstall the build this server is pinned to. Repair restores what was
        // lost; moving the loader is an update, and updates are the operator's
        // call to make in the update panel.
        runtimePlan = await planServerRuntimeUpdate(serverId, server.minecraftVersion, {
          loaderVersion: server.managedRuntime.loaderVersion || ""
        });
      } catch (error) {
        throw userFacingError(
          `Unable to repair the managed runtime for ${server.name}. ${error.message} Choose a valid Minecraft version in server settings or through the update panel first.`
        );
      }
      if (!runtimePlan.supported) {
        throw userFacingError(
          `${runtimePlan.reason || `Unable to repair the managed runtime for ${server.name}.`} Choose a valid Minecraft version in server settings or through the update panel first.`
        );
      }
      await applyServerRuntimeUpdate(serverId, runtimePlan);
      repairedRuntime = true;
    }

    if (shouldUseManagedLaunchCommand(server) && server.startCommand !== DEFAULT_MANAGED_START_COMMAND) {
      await setServerMetadata(serverId, { startCommand: DEFAULT_MANAGED_START_COMMAND });
    }

    return {
      managed: true,
      repairedRuntime,
      startCommand: DEFAULT_MANAGED_START_COMMAND
    };
  }

  async function resolveLaunchCommand(serverId, server) {
    if (shouldUseManagedLaunchCommand(server)) {
      const ensured = await ensureManagedServerArtifacts(serverId, { repairRuntime: true });
      return {
        command: ensured.startCommand,
        managed: true
      };
    }

    return {
      command: server.startCommand || DEFAULT_EXISTING_START_COMMAND,
      managed: false
    };
  }

  async function createServer(spec, actor, options = {}) {
    const reportProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const serverId = safeFilename(spec.serverId || spec.directoryName || spec.name);
    if (!serverId) {
      throw new Error("A server name is required.");
    }
    if (await getServer(serverId)) {
      throw new Error("A server with that id already exists.");
    }

    const directoryName = safeFilename(spec.directoryName || serverId);
    const relativeDirectory = path.join("servers", directoryName);
    const serverDir = path.resolve(store.rootDir, relativeDirectory);
    if (!withinParent(serversRoot, serverDir)) {
      throw new Error("Server directory is outside the managed servers root.");
    }

    const mode = spec.mode === "existing" ? "existing" : "managed";
    const requestedLoader = String(spec.loader || "vanilla").trim().toLowerCase() || "vanilla";
    // Validate before provisioning: Forge and NeoForge run their installer with
    // this JDK, so a bad path should fail before anything is downloaded.
    const javaBin = await validateJavaBin(spec.javaBin);
    const effectiveLoader = mode === "existing" ? requestedLoader : requestedLoader;
    if (mode === "existing") {
      if (!(await exists(serverDir))) {
        throw new Error(`Existing server directory not found: ${relativeDirectory}`);
      }
    } else {
      if (await exists(serverDir)) {
        throw new Error(`Directory already exists: ${relativeDirectory}`);
      }

      reportProgress("creating server folders");
      await ensureDir(serverDir);
      await ensureDir(path.join(serverDir, "logs"));
      await ensureDir(path.join(serverDir, "backups"));
      await ensureDir(path.join(serverDir, "mods"));
      await ensureDir(path.join(serverDir, "plugins"));
      await ensureDir(path.join(serverDir, ".rippermoon"));
      await fsp.writeFile(path.join(serverDir, "eula.txt"), "eula=false\n", "utf8");
      await fsp.writeFile(path.join(serverDir, "server.properties"), `motd=${spec.name || displayNameFromSlug(serverId)}\nserver-port=${spec.port || 25565}\n`, "utf8");
      // Provision first: the launch script shape depends on what the loader
      // produced (a server.jar, or Forge/NeoForge argfiles).
      const runtime = await createJarManagedRuntime(
        requestedLoader,
        spec.minecraftVersion || "latest",
        serverDir,
        { javaBin, onProgress: reportProgress }
      );
      spec.minecraftVersion = runtime.targetVersion;
      spec.managedRuntime = runtime;
      reportProgress("writing launch script");
      const launchScriptPath = path.join(serverDir, ".rippermoon", "launch-server.sh");
      await fsp.writeFile(
        launchScriptPath,
        buildLaunchScript(spec.minMemory, spec.maxMemory, runtime.launch),
        "utf8"
      );
      await fsp.chmod(launchScriptPath, 0o755);
    }

    reportProgress("registering the server");
    const record = await store.updateServerRecord(serverId, normalizeServerRecord(serverId, {
      id: serverId,
      createdAt: nowIso(),
      createdBy: actor.username,
      description: spec.description || "",
      directory: relativeDirectory,
      javaBin,
      loader: effectiveLoader,
      logFile: spec.logFile || "logs/latest.log",
      maxMemory: spec.maxMemory || "4G",
      managedRuntime:
        mode === "existing"
          ? null
          : {
              kind: spec.managedRuntime?.kind || requestedLoader,
              // The launch shape must survive into the record; the managed
              // launch script is regenerated from it on every start.
              launch: spec.managedRuntime?.launch || { kind: "jar" },
              loaderVersion: spec.managedRuntime?.loaderVersion || null,
              source: spec.managedRuntime?.source || requestedLoader,
              updatedAt: nowIso()
            },
      minMemory: spec.minMemory || "2G",
      minecraftVersion: spec.minecraftVersion || (await detectVersion(serverDir)),
      modsDir: spec.modsDir || "mods",
      name: spec.name || displayNameFromSlug(serverId),
      passphraseHash: spec.passphrase ? hashSecret(spec.passphrase) : null,
      serverPropertiesFile: spec.serverPropertiesFile || "server.properties",
      startCommand: spec.startCommand || (mode === "existing" ? DEFAULT_EXISTING_START_COMMAND : DEFAULT_MANAGED_START_COMMAND),
      worldDir: spec.worldDir || "world"
    }));

    return record;
  }

  function shouldSpawnDirectly(command) {
    return /^\.?\/?[\w./-]+$/.test(command) && !command.includes(" ");
  }

  function buildStartFailureMessage(server, command, error, directCommandPath) {
    if (error && error.code === "ENOENT") {
      if (directCommandPath) {
        return `Unable to start ${server.name}. The launch command was not found at ${path.relative(store.rootDir, directCommandPath)}.`;
      }
      return `Unable to start ${server.name}. The launch command could not be found: ${command}.`;
    }

    if (error && error.code === "EACCES") {
      if (directCommandPath) {
        return `Unable to start ${server.name}. The launch command is not executable: ${path.relative(store.rootDir, directCommandPath)}.`;
      }
      return `Unable to start ${server.name}. Permission was denied while starting: ${command}.`;
    }

    return `Unable to start ${server.name}. ${error && error.message ? error.message : "The launch command failed before the server process could start."}`;
  }

  function resolveShellCommand() {
    const configuredShell = (readEnv("SHELL") || String(process.env.SHELL || "")).trim();
    if (configuredShell) {
      return {
        args: ["-lc"],
        command: configuredShell
      };
    }

    return {
      args: ["bash", "-lc"],
      command: "/usr/bin/env"
    };
  }

  async function startServer(serverId, actor) {
    const server = await getServer(serverId);
    if (!server) {
      throw userFacingError("Server not found.", 404);
    }
    if (!server.passphraseHash) {
      throw userFacingError("This server has no passphrase configured yet.");
    }

    const status = await getServerStatus(serverId);
    if (status.running) {
      return status;
    }

    if (!(await readEulaStatus(serverId))) {
      throw userFacingError(
        `Unable to start ${server.name}. The Minecraft server EULA has not been accepted yet. Open the server overview and accept the EULA first.`
      );
    }

    const paths = resolveRecordPaths(server);
    await ensureDir(paths.runtimeDir);
    await ensureDir(paths.modsDir);
    const runtimeLog = fs.createWriteStream(paths.runtimeLog, { flags: "a" });
    runtimeLog.write(`\n[${nowIso()}] Starting ${server.name} as ${actor.username}\n`);

    const launchSpec = await resolveLaunchCommand(serverId, server);
    const command = launchSpec.command;
    const spawnDirectly = shouldSpawnDirectly(command);
    const directCommandPath = spawnDirectly ? path.resolve(paths.serverDir, command) : null;

    if (spawnDirectly && !(await exists(directCommandPath))) {
      const message = buildStartFailureMessage(server, command, { code: "ENOENT" }, directCommandPath);
      runtimeLog.write(`[${nowIso()}] Start failed: ${message}\n`);
      runtimeLog.end();
      throw userFacingError(message);
    }

    const shellCommand = resolveShellCommand();
    // The launch script already prefers the JAVA_BIN override, so a per-server
    // override only needs to reach this child's environment.
    const childEnv = { ...process.env };
    if (server.javaBin) {
      childEnv[`${ENV_PREFIX}JAVA_BIN`] = server.javaBin;
      // Hand-written launch scripts in existing server folders read the
      // pre-rename variable, and this code cannot rewrite scripts it did not
      // generate. Exporting both means a per-server JDK keeps reaching them.
      childEnv[`${LEGACY_ENV_PREFIX}JAVA_BIN`] = server.javaBin;
      childEnv.JAVA_HOME = path.dirname(path.dirname(server.javaBin));
      runtimeLog.write(`[${nowIso()}] Using per-server Java: ${server.javaBin}\n`);
    }
    const child = spawnDirectly
      ? spawn(directCommandPath, [], {
          cwd: paths.serverDir,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"]
        })
      : spawn(shellCommand.command, [...shellCommand.args, command], {
          cwd: paths.serverDir,
          env: childEnv,
          stdio: ["pipe", "pipe", "pipe"]
        });

    let runtimeLogClosed = false;
    const closeRuntimeLog = (line) => {
      if (runtimeLogClosed) {
        return;
      }
      runtimeLogClosed = true;
      if (line) {
        runtimeLog.write(line);
      }
      runtimeLog.end();
    };

    child.stdout.on("data", (chunk) => runtimeLog.write(chunk));
    child.stderr.on("data", (chunk) => runtimeLog.write(chunk));

    const startedAt = nowIso();
    await new Promise((resolve, reject) => {
      let settled = false;

      const finishResolve = async () => {
        if (settled) {
          return;
        }
        settled = true;
        try {
          runningChildren.set(serverId, child);
          await writePidInfo(serverId, {
            pid: child.pid,
            startedAt,
            startedBy: actor.username
          });
          resolve();
        } catch (error) {
          runningChildren.delete(serverId);
          closeRuntimeLog(`[${nowIso()}] Start failed while recording pid info: ${error.message}\n`);
          reject(error);
        }
      };

      const finishReject = async (error) => {
        if (settled) {
          return;
        }
        settled = true;
        runningChildren.delete(serverId);
        await clearPidInfo(serverId);
        const message = buildStartFailureMessage(server, command, error, directCommandPath);
        closeRuntimeLog(`[${nowIso()}] Start failed: ${message}\n`);
        reject(userFacingError(message));
      };

      child.once("spawn", () => {
        finishResolve().catch(reject);
      });

      child.once("error", (error) => {
        finishReject(error).catch(reject);
      });

      child.once("close", (code) => {
        if (!settled && code !== null && code !== 0) {
          finishReject(new Error(`The server process exited immediately with code ${code}.`)).catch(reject);
        }
      });
    });

    child.on("close", async (code) => {
      closeRuntimeLog(`\n[${nowIso()}] Process exited with code ${code ?? "unknown"}\n`);
      runningChildren.delete(serverId);
      await clearPidInfo(serverId);
    });

    await sleep(500);
    return await getServerStatus(serverId);
  }

  async function stopServer(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const child = runningChildren.get(serverId);
    if (child && !child.killed) {
      try {
        child.stdin.write("stop\n");
      } catch {
        // ignore
      }

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (child.exitCode !== null || child.killed) {
          break;
        }
        await sleep(1_000);
      }

      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await sleep(3_000);
      }

      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    } else {
      const pidInfo = await getPidInfo(serverId);
      if (pidInfo && isProcessAlive(pidInfo.pid)) {
        process.kill(pidInfo.pid, "SIGTERM");
      }
    }

    await clearPidInfo(serverId);
    return await getServerStatus(serverId);
  }

  async function verifyServerPassphrase(serverId, passphrase) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    if (!server.passphraseHash) {
      return false;
    }
    const { verifySecret } = require("./auth");
    return verifySecret(passphrase, server.passphraseHash);
  }

  async function listWorldArchives(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await ensureDir(paths.worldLibraryDir);
    const entries = await fsp.readdir(paths.worldLibraryDir, { withFileTypes: true });
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".zip"))
        .map(async (entry) => {
          const stats = await fsp.stat(path.join(paths.worldLibraryDir, entry.name));
          return {
            name: entry.name,
            size: stats.size,
            modifiedAt: stats.mtime.toISOString()
          };
        })
    );
    return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  async function readWorldMetadata(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    return await readJson(paths.worldMetadataFile, { activeWorldName: null });
  }

  async function writeWorldMetadata(serverId, metadata) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await writeJson(paths.worldMetadataFile, {
      activeWorldName: metadata && metadata.activeWorldName ? String(metadata.activeWorldName).trim() : null,
      updatedAt: nowIso()
    });
  }

  async function setActiveWorldName(serverId, name) {
    const trimmed = String(name || "").trim();
    await writeWorldMetadata(serverId, {
      activeWorldName: trimmed || null
    });
  }

  async function listWorldEntries(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    const entries = [];
    const worldMetadata = await readWorldMetadata(serverId);
    const properties = parseServerPropertiesText(await readServerProperties(serverId));
    const activeWorldName =
      worldMetadata.activeWorldName ||
      properties["level-name"] ||
      path.basename(paths.worldDir);

    try {
      const stats = await fsp.stat(paths.worldDir);
      const levelStats = await fsp.stat(path.join(paths.worldDir, "level.dat")).catch(() => stats);
      entries.push({
        active: true,
        kind: "active",
        modifiedAt: levelStats.mtime.toISOString(),
        name: activeWorldName,
        pathName: path.basename(paths.worldDir),
        size: null
      });
    } catch {
      if (worldMetadata.activeWorldName) {
        entries.push({
          active: true,
          kind: "active",
          modifiedAt: worldMetadata.updatedAt || nowIso(),
          name: activeWorldName,
          pathName: path.basename(paths.worldDir),
          size: null
        });
      }
    }

    return [
      ...entries,
      ...(await listWorldArchives(serverId)).map((world) => ({
        ...world,
        active: false,
        kind: "archive"
      }))
    ];
  }

  async function readWorldArchivePath(serverId, archiveName) {
    const server = await getServer(serverId);
    const paths = resolveRecordPaths(server);
    const fullPath = path.join(paths.worldLibraryDir, safeFilename(archiveName));
    if (!withinParent(paths.worldLibraryDir, fullPath)) {
      throw new Error("Invalid archive path.");
    }
    return fullPath;
  }

  async function getServerUpdateSupport(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const loader = String(server.loader || "vanilla").toLowerCase();
    const paths = resolveRecordPaths(server);
    const loaderVersioned = LOADER_VERSIONED_LOADERS.has(loader);

    if (!COMBINED_UPDATE_LOADERS.has(loader)) {
      return {
        adoptable: false,
        loaderVersioned: false,
        reason:
          "Automatic runtime updates support vanilla, Paper, Purpur, Fabric, Forge, and NeoForge. Quilt and custom loaders still require manual runtime updates.",
        runtimeKind: loader,
        supported: false
      };
    }

    // A registered-existing server has no managed runtime, so the dashboard does
    // not know how it launches and must not overwrite its jar. Adoption is the
    // way in, and it is offered rather than performed silently.
    if (!server.managedRuntime && !shouldUseManagedLaunchCommand(server)) {
      return {
        adoptable: true,
        loaderVersioned,
        reason:
          "This server was registered from an existing folder and still uses its own launch script, so the dashboard does not manage its runtime yet. Adopt the runtime to enable version and loader updates.",
        runtimeKind: loader,
        supported: false
      };
    }

    if (
      (loader === "paper" || loader === "purpur") &&
      !(await exists(paths.serverJarFile)) &&
      !shouldUseManagedLaunchCommand(server)
    ) {
      return {
        adoptable: true,
        loaderVersioned,
        reason: "This server does not expose a managed server.jar runtime file yet, so automatic runtime replacement is not safe with its current launch setup.",
        runtimeKind: loader,
        supported: false
      };
    }

    return {
      adoptable: false,
      loaderVersioned,
      reason: null,
      runtimeKind: loader,
      supported: true
    };
  }

  // The installed mod set is the real authority on which loader builds are
  // usable. Both answers - the floor and the per-candidate verdict - come from
  // metadata inside the jars already on disk.
  async function scanServerLoaderRequirements(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const paths = resolveRecordPaths(server);
    return await scanLoaderRequirements(paths.modsDir, String(server.loader || "").toLowerCase());
  }

  // Builds the annotated loader catalog once and hands back the raw jar scan
  // alongside it, so a caller that also needs the per-mod detail - the update
  // planner - does not re-read every jar on disk to get it.
  async function buildLoaderCatalog(serverId, requestedGameVersion) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const loader = String(server.loader || "vanilla").toLowerCase();
    const currentLoaderVersion = (server.managedRuntime && server.managedRuntime.loaderVersion) || null;

    if (!LOADER_VERSIONED_LOADERS.has(loader)) {
      return {
        options: {
          currentLoaderVersion,
          gameVersion: requestedGameVersion || server.minecraftVersion || "",
          loader,
          loaderVersioned: false,
          modScan: { floor: null, supported: false, unreadable: [] },
          versions: []
        },
        scan: { floor: null, mods: [], supported: false, unreadable: [] }
      };
    }

    const gameVersion = await resolveRequestedReleaseVersion(requestedGameVersion || server.minecraftVersion);
    const [catalog, scan] = await Promise.all([
      listLoaderVersionsFor(loader, gameVersion),
      scanServerLoaderRequirements(serverId)
    ]);

    // Annotate every build with the verdict from the installed mods, so the
    // picker can show *why* an option is unavailable instead of hiding it.
    const versions = catalog.versions.map((entry) => {
      const verdict = evaluateLoaderCandidate(scan, entry.version);
      return {
        ...entry,
        conflicts: verdict.conflicts,
        current: entry.version === currentLoaderVersion,
        satisfiesInstalledMods: verdict.compatible
      };
    });

    const recommended =
      versions.find((entry) => entry.satisfiesInstalledMods && entry.recommended) ||
      versions.find((entry) => entry.satisfiesInstalledMods && entry.stable) ||
      versions.find((entry) => entry.satisfiesInstalledMods) ||
      null;

    return {
      options: {
        currentLoaderVersion,
        gameVersion,
        loader,
        loaderVersioned: true,
        // The per-mod metadata stays out of the response: the picker needs the
        // floor and the conflicts, not every mod's full manifest.
        modScan: {
          floor: scan.floor,
          scannedMods: scan.mods.length,
          supported: scan.supported,
          unreadable: scan.unreadable
        },
        recommendedLoaderVersion: recommended ? recommended.version : null,
        versions
      },
      scan
    };
  }

  async function getLoaderVersionOptions(serverId, requestedGameVersion) {
    return (await buildLoaderCatalog(serverId, requestedGameVersion)).options;
  }

  function describeVersionDirection(fromVersion, toVersion) {
    if (!fromVersion || !toVersion || fromVersion === toVersion) {
      return "unchanged";
    }
    return compareVersions(toVersion, fromVersion) > 0 ? "upgrade" : "downgrade";
  }

  async function planServerRuntimeUpdate(serverId, targetVersion, options = {}) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const currentVersion = server.minecraftVersion || "";
    const currentLoaderVersion = (server.managedRuntime && server.managedRuntime.loaderVersion) || null;
    const support = await getServerUpdateSupport(serverId);
    if (!support.supported) {
      return {
        adoptable: support.adoptable === true,
        currentLoaderVersion,
        currentVersion,
        reason: support.reason,
        runtimeKind: support.runtimeKind,
        supported: false,
        targetVersion: targetVersion || currentVersion
      };
    }

    const requestedLoaderVersion = String(options.loaderVersion || "").trim();

    if (support.runtimeKind === "vanilla" || support.runtimeKind === "paper" || support.runtimeKind === "purpur") {
      const runtime =
        support.runtimeKind === "vanilla"
          ? await resolveVanillaRuntime(targetVersion || currentVersion || "latest")
          : support.runtimeKind === "paper"
            ? await resolvePaperRuntime("paper", targetVersion || currentVersion)
            : await resolvePurpurRuntime(targetVersion || currentVersion);

      return {
        currentLoaderVersion,
        currentVersion,
        downloadUrl: runtime.downloadUrl,
        loaderVersion: null,
        loaderVersioned: false,
        mode: "version",
        runtimeKind: support.runtimeKind,
        sha1: runtime.sha1 || null,
        source: runtime.source || "mojang",
        supported: true,
        targetVersion: runtime.targetVersion,
        versionDirection: describeVersionDirection(currentVersion, runtime.targetVersion)
      };
    }

    // Fabric, Forge and NeoForge: the loader build is a separate axis from the
    // game version, so both are resolved here and either may move on its own.
    const resolvedGameVersion = await resolveRequestedReleaseVersion(targetVersion || currentVersion);
    let catalog;
    let scan;
    try {
      ({ options: catalog, scan } = await buildLoaderCatalog(serverId, resolvedGameVersion));
    } catch (error) {
      return {
        currentLoaderVersion,
        currentVersion,
        reason: `Unable to list ${displayNameFromSlug(support.runtimeKind)} builds for Minecraft ${resolvedGameVersion}. ${error.message}`,
        runtimeKind: support.runtimeKind,
        supported: false,
        targetVersion: resolvedGameVersion
      };
    }

    if (!catalog.versions.length) {
      return {
        currentLoaderVersion,
        currentVersion,
        reason: `${displayNameFromSlug(support.runtimeKind)} has no published build for Minecraft ${resolvedGameVersion}.`,
        runtimeKind: support.runtimeKind,
        supported: false,
        targetVersion: resolvedGameVersion
      };
    }

    // With no explicit pick, take the newest build the installed mods accept -
    // "the right one" rather than merely the newest.
    const chosenLoaderVersion =
      requestedLoaderVersion || catalog.recommendedLoaderVersion || catalog.versions[0].version;
    const selected = catalog.versions.find((entry) => entry.version === chosenLoaderVersion);
    if (!selected) {
      return {
        currentLoaderVersion,
        currentVersion,
        loaderVersions: catalog.versions,
        reason: `${displayNameFromSlug(support.runtimeKind)} ${chosenLoaderVersion} is not published for Minecraft ${resolvedGameVersion}.`,
        runtimeKind: support.runtimeKind,
        supported: false,
        targetVersion: resolvedGameVersion
      };
    }

    // Fabric is applied by swapping the launcher jar, so the plan has to carry
    // the download for the build that was selected. Forge and NeoForge re-run
    // their installer at apply time and need no URL here.
    let downloadUrl = null;
    if (support.runtimeKind === "fabric") {
      downloadUrl = (await resolveFabricRuntime(resolvedGameVersion, selected.version)).downloadUrl;
    }

    const gameVersionChanged = Boolean(resolvedGameVersion) && resolvedGameVersion !== currentVersion;
    // Reuses the scan the catalog already performed rather than re-reading every
    // jar. Only meaningful when the game version moves - mods keep running on
    // the version they were installed for.
    const minecraftVerdict = gameVersionChanged
      ? evaluateMinecraftCandidate(scan, resolvedGameVersion)
      : { compatible: true, conflicts: [] };

    const blockedReasons = [];
    if (!selected.satisfiesInstalledMods) {
      blockedReasons.push(
        `${displayNameFromSlug(support.runtimeKind)} ${selected.version} is rejected by ${selected.conflicts.length} installed mod(s): ${selected.conflicts
          .map((conflict) => `${conflict.name} needs ${conflict.range}`)
          .join("; ")}.`
      );
    }

    return {
      blockedReasons,
      currentLoaderVersion,
      currentVersion,
      downloadUrl,
      loaderConflicts: selected.conflicts,
      loaderDirection: describeVersionDirection(currentLoaderVersion, selected.version),
      loaderFloor: scan.floor,
      loaderVersion: selected.version,
      loaderVersioned: true,
      loaderVersions: catalog.versions,
      minecraftConflicts: minecraftVerdict.conflicts,
      // A loader-only change leaves every mod file untouched, so it does not
      // need the add-on re-resolution a game version change does.
      mode: gameVersionChanged ? "version" : "loader-only",
      modScan: catalog.modScan,
      runtimeKind: support.runtimeKind,
      source: `${support.runtimeKind} ${selected.version}`,
      supported: blockedReasons.length === 0,
      targetVersion: resolvedGameVersion,
      unsatisfiedByMods: !selected.satisfiesInstalledMods,
      versionDirection: describeVersionDirection(currentVersion, resolvedGameVersion),
      ...(blockedReasons.length ? { reason: blockedReasons[0] } : {})
    };
  }

  async function applyServerRuntimeUpdate(serverId, runtimePlan) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const paths = resolveRecordPaths(server);
    if (!runtimePlan || runtimePlan.supported !== true) {
      throw new Error(runtimePlan && runtimePlan.reason ? runtimePlan.reason : "Server runtime update is not supported.");
    }

    if (runtimePlan.runtimeKind === "vanilla") {
      const resolvedVersion = await createVanillaServer(runtimePlan.targetVersion, paths.serverDir);
      await setServerMetadata(serverId, {
        managedRuntime: {
          kind: "vanilla",
          source: "mojang",
          updatedAt: nowIso()
        },
        minecraftVersion: resolvedVersion,
        startCommand: DEFAULT_MANAGED_START_COMMAND
      });
      await ensureManagedServerArtifacts(serverId, { repairRuntime: false });
      return {
        runtimeKind: "vanilla",
        targetVersion: resolvedVersion
      };
    }

    const previousLoaderVersion = (server.managedRuntime && server.managedRuntime.loaderVersion) || null;

    // Forge and NeoForge ship no runnable jar - their installer lays down a
    // library tree and an argfile - so a build change means re-running it.
    if (INSTALLER_LOADERS.has(runtimePlan.runtimeKind)) {
      const runtime = await createJarManagedRuntime(
        runtimePlan.runtimeKind,
        runtimePlan.targetVersion,
        paths.serverDir,
        { javaBin: server.javaBin, loaderVersion: runtimePlan.loaderVersion || null }
      );
      await setServerMetadata(serverId, {
        managedRuntime: {
          kind: runtime.kind,
          launch: runtime.launch,
          loaderVersion: runtime.loaderVersion || null,
          previousLoaderVersion,
          source: runtime.source,
          updatedAt: nowIso()
        },
        minecraftVersion: runtime.targetVersion,
        startCommand: DEFAULT_MANAGED_START_COMMAND
      });
      // The argfile path embeds the loader version, so the launch script has to
      // be rewritten alongside the runtime it points at.
      await fsp.writeFile(
        paths.managedLaunchScript,
        buildLaunchScript(server.minMemory, server.maxMemory, runtime.launch),
        "utf8"
      );
      await fsp.chmod(paths.managedLaunchScript, 0o755);
      await ensureManagedServerArtifacts(serverId, { repairRuntime: false });

      return {
        loaderVersion: runtime.loaderVersion || null,
        previousLoaderVersion,
        runtimeKind: runtimePlan.runtimeKind,
        targetVersion: runtime.targetVersion
      };
    }

    await ensureDir(paths.runtimeBackupDir);
    if (await exists(paths.serverJarFile)) {
      const backupBuffer = await fsp.readFile(paths.serverJarFile);
      const backupPath = path.join(
        paths.runtimeBackupDir,
        `server-${server.loader}-${server.minecraftVersion || "unknown"}${
          previousLoaderVersion ? `-loader-${previousLoaderVersion}` : ""
        }-${Date.now()}.jar`
      );
      await fsp.writeFile(backupPath, backupBuffer);
    }

    const nextBuffer = await fetchBuffer(runtimePlan.downloadUrl);
    await fsp.rm(paths.serverJarFile, { force: true });
    await fsp.writeFile(paths.serverJarFile, nextBuffer);
    await setServerMetadata(serverId, {
      managedRuntime: {
        kind: runtimePlan.runtimeKind,
        launch: { kind: "jar" },
        loaderVersion: runtimePlan.loaderVersion || null,
        previousLoaderVersion,
        source: runtimePlan.source || runtimePlan.runtimeKind,
        updatedAt: nowIso()
      },
      minecraftVersion: runtimePlan.targetVersion,
      startCommand: DEFAULT_MANAGED_START_COMMAND
    });
    await ensureManagedServerArtifacts(serverId, { repairRuntime: false });

    return {
      loaderVersion: runtimePlan.loaderVersion || null,
      previousLoaderVersion,
      runtimeKind: runtimePlan.runtimeKind,
      targetVersion: runtimePlan.targetVersion
    };
  }

  // Best-effort read of the loader build a hand-installed server is already
  // running, so adoption can offer to keep it rather than forcing a move.
  async function detectInstalledLoaderVersion(serverDir, loader) {
    if (loader === "fabric") {
      for (const jarName of ["fabric-server-launch.jar", "server.jar"]) {
        try {
          const properties = await readJarTextEntry(path.join(serverDir, jarName), "install.properties");
          const match = properties && properties.match(/fabric-loader-version\s*=\s*([^\s]+)/);
          if (match) {
            return match[1].trim();
          }
        } catch {
          // Not a Fabric launcher jar, or unreadable. Try the library tree.
        }
      }

      try {
        const entries = await fsp.readdir(path.join(serverDir, "libraries", "net", "fabricmc", "fabric-loader"));
        const versions = entries.filter((entry) => /^\d/.test(entry)).sort(compareVersions);
        return versions.length ? versions[versions.length - 1] : null;
      } catch {
        return null;
      }
    }

    if (INSTALLER_LOADERS.has(loader)) {
      const vendorPath =
        loader === "forge"
          ? path.join(serverDir, "libraries", "net", "minecraftforge", "forge")
          : path.join(serverDir, "libraries", "net", "neoforged", "neoforge");
      try {
        const entries = await fsp.readdir(vendorPath);
        const artifacts = [];
        for (const entry of entries) {
          if (await exists(path.join(vendorPath, entry, "unix_args.txt"))) {
            // Forge artifacts are "<mc>-<forge>"; NeoForge uses its version bare.
            artifacts.push(loader === "forge" ? entry.split("-").slice(1).join("-") : entry);
          }
        }
        artifacts.sort(compareVersions);
        return artifacts.length ? artifacts[artifacts.length - 1] : null;
      } catch {
        return null;
      }
    }

    return null;
  }

  async function getRuntimeAdoptionPreview(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const loader = String(server.loader || "vanilla").toLowerCase();
    const paths = resolveRecordPaths(server);
    const detectedLoaderVersion = await detectInstalledLoaderVersion(paths.serverDir, loader);

    return {
      alreadyManaged: Boolean(server.managedRuntime),
      currentStartCommand: server.startCommand || DEFAULT_EXISTING_START_COMMAND,
      detectedLoaderVersion,
      installable: INSTALLABLE_LOADERS.has(loader),
      loader,
      minecraftVersion: server.minecraftVersion || ""
    };
  }

  /**
   * Bring a registered-existing server under managed runtime control.
   *
   * The server keeps its world, mods and configuration; what changes is that the
   * dashboard provisions the runtime and owns the launch script from here on.
   * The original launch script is kept next to the runtime backups, because a
   * hand-written one may carry flags worth recovering.
   */
  async function adoptManagedRuntime(serverId, options = {}) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    await ensureServerStopped(serverId);

    const loader = String(server.loader || "vanilla").toLowerCase();
    if (!INSTALLABLE_LOADERS.has(loader)) {
      throw userFacingError(
        `The dashboard cannot provision a ${displayNameFromSlug(loader)} runtime, so this server cannot be adopted. Supported loaders are ${[...INSTALLABLE_LOADERS].join(", ")}.`
      );
    }

    const paths = resolveRecordPaths(server);
    const targetVersion = String(options.minecraftVersion || server.minecraftVersion || "").trim();
    if (!targetVersion || targetVersion === "unknown") {
      throw userFacingError(
        `Set the Minecraft version for ${server.name} in server settings before adopting its runtime - the dashboard needs to know which build to install.`
      );
    }

    const detectedLoaderVersion = await detectInstalledLoaderVersion(paths.serverDir, loader);
    const requestedLoaderVersion = String(options.loaderVersion || "").trim() || detectedLoaderVersion || "";

    // Preserve whatever the operator was launching with before the dashboard
    // takes over, so nothing about the previous setup is lost.
    await ensureDir(paths.runtimeBackupDir);
    const existingScript = path.join(paths.serverDir, "launch-server.sh");
    if (await exists(existingScript)) {
      await fsp.copyFile(
        existingScript,
        path.join(paths.runtimeBackupDir, `launch-server.adopted-${Date.now()}.sh`)
      );
    }

    const runtime = await createJarManagedRuntime(loader, targetVersion, paths.serverDir, {
      javaBin: server.javaBin,
      loaderVersion: requestedLoaderVersion || undefined,
      onProgress: typeof options.onProgress === "function" ? options.onProgress : () => {}
    });

    await setServerMetadata(serverId, {
      managedRuntime: {
        adoptedAt: nowIso(),
        adoptedFromStartCommand: server.startCommand || DEFAULT_EXISTING_START_COMMAND,
        kind: runtime.kind,
        launch: runtime.launch || { kind: "jar" },
        loaderVersion: runtime.loaderVersion || null,
        source: runtime.source,
        updatedAt: nowIso()
      },
      minecraftVersion: runtime.targetVersion,
      startCommand: DEFAULT_MANAGED_START_COMMAND
    });

    await ensureManagedServerArtifacts(serverId, { repairRuntime: false });

    return {
      adopted: true,
      detectedLoaderVersion,
      loader,
      loaderVersion: runtime.loaderVersion || null,
      minecraftVersion: runtime.targetVersion,
      startCommand: DEFAULT_MANAGED_START_COMMAND
    };
  }

  async function deleteServer(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const status = await getServerStatus(serverId);
    if (status.running) {
      throw new Error("Stop the server before deleting it.");
    }

    const paths = resolveRecordPaths(server);
    await store.deleteServerRecord(serverId);
    await fsp.rm(paths.serverDir, { force: true, recursive: true });
    return {
      deleted: true,
      directory: server.directory,
      id: server.id
    };
  }

  async function getServerSnapshot(serverId, user, unlocked) {
    const server = await getServer(serverId);
    if (!server) {
      return null;
    }
    if (!userCanAccessServer(user, server)) {
      return null;
    }

    const paths = resolveRecordPaths(server);
    const lockedForUser = user.role !== "owner" && Boolean(server.passphraseHash) && !unlocked;
    const status = await getServerStatus(serverId);
    const worlds = lockedForUser ? [] : await listWorldEntries(serverId);
    const installedFiles = lockedForUser ? [] : await listInstalledFiles(serverId);
    const propertiesText = !lockedForUser && user.role === "owner" ? await readServerProperties(serverId) : null;
    const safeProperties = lockedForUser ? null : await readSafeAdminProperties(serverId);
    const operators = !lockedForUser && user.role === "owner" ? await listServerOperators(serverId) : [];
    const worldRules = lockedForUser ? null : await readWorldRules(serverId);
    const logs = lockedForUser ? null : await getServerLog(serverId);
    const updateSupport = user.role === "owner" ? await getServerUpdateSupport(serverId) : null;
    // Only computed when adoption is actually on offer: it touches the disk, and
    // the loader build catalog behind the update panel needs the network, so
    // that stays behind its own route rather than loading on every render.
    const runtimeAdoption =
      updateSupport && updateSupport.adoptable ? await getRuntimeAdoptionPreview(serverId) : null;
    const eulaAccepted = await readEulaStatus(serverId);

    return {
      server: {
        ...serializeServer(server),
        eulaAccepted,
        status,
        installTarget: PAPER_LIKE_LOADERS.has(server.loader) ? "plugins" : "mods",
        passphraseConfigured: Boolean(server.passphraseHash),
        permissions: {
          canAccessDangerousSettings: user.role === "owner",
          canManageAddonSettings: !lockedForUser && userCanManageAddons(user, server),
          canAdoptRuntime: user.role === "owner" && !lockedForUser && Boolean(runtimeAdoption && runtimeAdoption.installable),
          canApplyCombinedUpdates: user.role === "owner" && !lockedForUser && Boolean(updateSupport && updateSupport.supported),
          canCreateWorlds: !lockedForUser && userCanCreateWorld(user, serverId),
          canControlRuntime: !lockedForUser,
          canUseManualAddons: !lockedForUser && userCanManageAddons(user, server),
          canViewProtectedTools: !lockedForUser,
          canWriteSafeSettings: !lockedForUser,
          requiresUnlock: lockedForUser,
          unlocked: user.role === "owner" ? true : unlocked
        },
        runtimeAdoption,
        updateSupport
      },
      logs,
      mods: installedFiles,
      propertiesText,
      operators,
      safeProperties,
      safePropertyDefinitions: getSafeAdminSettingDefinitions(),
      settingsMode: user.role === "owner" ? "owner" : "admin-safe",
      runtime: {
        modsDir: path.relative(store.rootDir, paths.modsDir),
        worldDir: path.relative(store.rootDir, paths.worldDir)
      },
      unlocked: user.role === "owner" ? true : unlocked,
      worldRules,
      worlds
    };
  }

  async function ensureServerStopped(serverId) {
    const status = await getServerStatus(serverId);
    if (status.running) {
      throw new Error("Stop the server before making this change.");
    }
  }

  return {
    PAPER_LIKE_LOADERS,
    SAFE_ADMIN_SETTING_DEFINITIONS,
    adoptManagedRuntime,
    createServer,
    getLoaderVersionOptions,
    getRuntimeAdoptionPreview,
    scanServerLoaderRequirements,
    addServerOperator,
    deleteServer,
    downloadAndInstallFile,
    ensureManagedServerArtifacts,
    ensureServerStopped,
    getInstallableLoaders,
    listJavaRuntimes,
    getAllServers,
    getServerUpdateSupport,
    getServer,
    getServerLog,
    getServerSnapshot,
    getServerStatus,
    installManagedFile,
    listAvailableMinecraftVersions,
    listInstalledFiles,
    listServerOperators,
    listServersForUser,
    listWorldArchives,
    listWorldEntries,
    planServerRuntimeUpdate,
    readEulaStatus,
    readServerProperties,
    readAddonManifest,
    readSafeAdminProperties,
    readWorldArchivePath,
    readWorldMetadata,
    recordAddonInstalls,
    removeAddonFiles,
    removeServerOperator,
    repairServerOperators,
    removeInstalledFiles,
    resolveRecordPaths,
    serializeServer,
    setActiveWorldName,
    setAddonEnabled,
    setServerMetadata,
    startServer,
    stopServer,
    syncDiscoveredServers,
    userCanAccessServer,
    userCanCreateWorld,
    userCanManageAddons,
    verifyServerPassphrase,
    applyServerRuntimeUpdate,
    writeEulaStatus,
    writeServerOperators,
    writeSafeAdminProperties,
    writeAddonManifest,
    writeServerProperties
  };
}

module.exports = {
  createServerManager
};
