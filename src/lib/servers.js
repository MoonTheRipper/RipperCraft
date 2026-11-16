const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { hashSecret, verifySecret } = require("./auth");
const { HttpError } = require("./http");
const { getDefaultOutbound } = require("./outbound");
const { isUploadTempName, newUploadTempPath } = require("./upload");
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
  childEnvironment,
  coerceBoolean,
  createMutex,
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
const {
  integerInRange,
  invalid,
  isArgFilePath,
  displayText,
  httpsAddress,
  isMemorySetting,
  isMinecraftVersion,
  normalizeLoader,
  normalizeMemory,
  normalizeMinecraftVersion,
  plainText,
  propertyValue,
  singleLine
} = require("./validate");

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

// What a Minecraft server is told on its console to make it save and exit.
const STOP_COMMAND = "stop\n";
// In pid.json: this server reads its console from the named pipe beside it.
const CONSOLE_PIPE = "fifo";
// In memory only: this process holds the server's stdin itself, as a pipe.
const CONSOLE_STDIN = "stdin";
// pid.json is a few short lines. Whatever is found in its place is not read
// past this.
const PID_FILE_MAX_BYTES = 4096;
// The largest pid Linux hands out. A pid is only ever taken from between 2 and
// this: 1 is init, 0 is the dashboard's own process group, and a negative
// number is a whole group or, as -1, every process of the account.
const PID_MAX = 4_194_304;
// How long stopping a server waits at each step, in milliseconds. Saving a
// large world takes a server seconds on a quiet machine and minutes on one
// that is short of memory, and a server killed before it has finished loses
// what it had not written.
const DEFAULT_STOP_WAITS = Object.freeze({
  // After "stop" on the console, before SIGTERM.
  console: 180_000,
  // After that SIGTERM, before SIGKILL.
  term: 60_000,
  // After SIGTERM when there was no console to ask, before SIGKILL.
  signalOnly: 240_000,
  // After SIGKILL, for the process to be gone.
  kill: 10_000,
  // Between two looks at a process this dashboard did not start itself.
  poll: 1_000
});

// What the kernel calls one run of the machine, from start to shutdown.
const BOOT_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

// The three things below ask /proc, where there is one. They read at once, in
// the thread that asks: /proc never waits on a disk, and these must not wait
// for the handful of threads every other file operation shares. Each answers
// null where /proc cannot say: on a system that has none, for a process that
// has gone, and for one this process is not allowed to look at.

// The run of the machine this process is in.
function readBootId() {
  try {
    const id = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return BOOT_ID.test(id) ? id : null;
  } catch {
    return null;
  }
}

// A process's group, its session, and when it was started, in the kernel's
// ticks since the machine was. The line is "pid (name) state ppid pgrp
// session ...", and a name can hold anything, a ")" included, so the fields
// are counted from the last one.
function readProcStat(pid) {
  let fields;
  try {
    const line = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    fields = line.slice(line.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
  const [group, session, started] = [fields[2], fields[3], fields[19]].map(Number);
  return [group, session, started].every(Number.isSafeInteger) ? { group, session, started } : null;
}

// The folder a process is running in.
function readProcCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

// The processes of a group, each with the above. null with no /proc to list.
function readProcGroup(pgid) {
  let names;
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  const members = [];
  for (const name of names) {
    const stat = /^\d+$/.test(name) ? readProcStat(Number(name)) : null;
    if (stat && stat.group === pgid) {
      members.push({ ...stat, cwd: readProcCwd(Number(name)) });
    }
  }
  return members;
}

// What pid.json holds, as far as it can be believed. The file is in the
// server's own folder, where a mod can write anything: a pid that is not a
// whole number in range is no pid, the dashboard's own is not a game server,
// and only the exact marker says there is a console.
function parsePidInfo(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const { pid } = parsed;
  if (!Number.isInteger(pid) || pid <= 1 || pid > PID_MAX || pid === process.pid) {
    return null;
  }
  return {
    console: parsed.console === CONSOLE_PIPE ? CONSOLE_PIPE : null,
    // Only `true` says the pid is a process group's as well: a record from
    // before servers were started in a group of their own names one process.
    // Which run of the machine the pid is from, and when in that run the
    // process was started. A record without them, from before they were
    // written, is believed without.
    boot: typeof parsed.boot === "string" && BOOT_ID.test(parsed.boot) ? parsed.boot : null,
    group: parsed.group === true,
    pid,
    started: Number.isSafeInteger(parsed.started) && parsed.started >= 0 ? parsed.started : null,
    startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : null,
    startedBy: typeof parsed.startedBy === "string" && parsed.startedBy ? parsed.startedBy : "unknown"
  };
}

// The name of a server's console pipe in data/consoles: the server's id where
// that is a plain file name, and otherwise a name made from it that is one.
// An id is the name a folder in servers/ was found under, so it can hold
// anything a folder name can.
function consoleFileName(serverId) {
  const id = String(serverId);
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(id) && !/^id-[0-9a-f]{40}$/.test(id)) {
    return id;
  }
  return `id-${crypto.createHash("sha256").update(id).digest("hex").slice(0, 40)}`;
}

// What is in the way when a file in a server's folder cannot be opened the way
// the dashboard opens them, in words for a log line.
const OPEN_FAILURES = Object.freeze({
  EISDIR: "a folder is in its place",
  ELOOP: "a link is in its place",
  ENOENT: "it is gone",
  ENOTDIR: "it is gone",
  ENXIO: "a pipe that nothing reads is in its place"
});

// Why a console could not be written to.
function describeConsoleFailure(error) {
  const code = error && error.code;
  if (code === "ENXIO") {
    return "nothing is reading it";
  }
  if (code === "EAGAIN") {
    return "it is full and nothing is reading it";
  }
  if (code === "EPIPE") {
    return "the server has closed it";
  }
  return OPEN_FAILURES[code] || code || (error && error.message) || "it could not be opened";
}

function createServerManager(store, options = {}) {
  // Everything this file fetches from another machine - version lists, server
  // jars, installers, add-ons - goes through the one checked fetcher.
  const outbound = options.outbound || getDefaultOutbound();
  const logger = options.logger || {
    error() {},
    info() {},
    warn() {}
  };
  // options.stopWaits shortens the waits, for tests that cannot spend four
  // minutes on a server that will not stop. Nothing else sets it: a dashboard
  // waits as long as DEFAULT_STOP_WAITS says.
  const stopWaits = Object.freeze({ ...DEFAULT_STOP_WAITS, ...(options.stopWaits || {}) });
  // The program that makes a named pipe: Node cannot make one itself.
  const mkfifoCommand = options.mkfifoCommand || "mkfifo";
  // Which run of the machine this is. A pid means nothing in another one.
  const bootId = readBootId();
  const serversRoot = path.join(store.rootDir, "servers");
  // The console pipes are kept together in a folder of the dashboard's own,
  // not in each server's folder. A pipe that a running server reads holds up
  // whatever opens it to read as well: `grep -R` or a backup of a server's
  // folder stopped dead on one, and a copy of the folder took the pipe along.
  const consolesDir = path.join(store.rootDir, "data", "consoles");
  // The servers this process started and has not seen exit: for each, the
  // child, its pid, who started it and when, and how its console is reached.
  const runningChildren = new Map();
  // The stops that are under way, by server: the pid being stopped, when the
  // stop began, and a promise for its end. Kept in memory only. A dashboard
  // that is restarted in the middle of one has already asked the server to
  // stop, and the next press of Stop begins a new, equally patient one.
  const stopsInProgress = new Map();
  // Launching a server, and clearing up after one that has gone, take turns
  // for each server. Without that a status check that found a dead pid could
  // remove the pid file a start had just written, and the dashboard would lose
  // track of a server that is running.
  const lifecycleTurns = new Map();
  // The dashboard's own lines in a server's runtime log, kept in the order
  // they were written.
  const runtimeLogTurns = new Map();
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

  async function fetchJson(url, requestOptions = {}) {
    return await outbound.fetchJson(url, { headers: requestOptions.headers });
  }

  async function fetchText(url, requestOptions = {}) {
    return await outbound.fetchText(url, { headers: requestOptions.headers });
  }

  async function fetchBuffer(url, requestOptions = {}) {
    return await outbound.fetchBuffer(url, { headers: requestOptions.headers });
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
      consoleFile: path.join(consolesDir, consoleFileName(record.id)),
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

    // A number or one of a few words, sent as text or as a number. An object
    // or a list is neither, and is not asked to turn itself into text: one
    // that could not answered the request with a server fault.
    if (definition.type === "number") {
      const text = (plainText(value) ?? "").trim();
      return /^-?\d+$/.test(text) ? text : definition.defaultValue;
    }

    if (definition.type === "enum") {
      const text = (plainText(value) ?? "").trim().toLowerCase();
      return definition.options.includes(text) ? text : definition.defaultValue;
    }

    // Free text, which is what makes it the one to check: it goes into the
    // file as typed, and a line break in it would start a line of its own.
    return propertyValue(value, `The ${definition.key} setting`, { maxLength: 512 });
  }

  // The first lines of a new server.properties. The name is the owner's, and
  // has been through the record's checks; it is held to the file's as well,
  // and a name that cannot be a value there is replaced by the plain id.
  function initialPropertiesText(name, fallbackName, port = 25565) {
    let motd;
    try {
      motd = propertyValue(name, "The server name");
    } catch {
      motd = displayNameFromSlug(safeFilename(fallbackName));
    }
    return `motd=${motd}\nserver-port=${integerInRange(port, "The server port", 1, 65535)}\n`;
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
    // The version asked for in an update or an adoption. It goes into request
    // paths and, once the runtime is installed, into the record; checked here
    // it is refused before anything is fetched rather than after.
    const requested = !version || version === "latest" ? "" : normalizeMinecraftVersion(version, "The target Minecraft version");
    const manifest = await fetchMinecraftVersionManifest();
    return requested || manifest.latest.release;
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
      // These four are shown in the browser and read all over this file as
      // text. A record written before they were checked on the way in could
      // hold anything JSON can, so one that is not text is replaced here.
      description: typeof withDirectory.description === "string" ? withDirectory.description : "",
      loader: typeof withDirectory.loader === "string" ? withDirectory.loader : "vanilla",
      minecraftVersion: typeof withDirectory.minecraftVersion === "string" ? withDirectory.minecraftVersion : "unknown",
      name:
        typeof withDirectory.name === "string" && withDirectory.name
          ? withDirectory.name
          : displayNameFromSlug(recordId),
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
      // Read from the server's own log or jar link, which a mod can write.
      const detected = await detectVersion(path.join(store.rootDir, relativeDirectory));
      const version = isMinecraftVersion(detected) ? detected : "unknown";
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
      return entries.filter((entry) => entry.isFile() && !isUploadTempName(entry.name)).length;
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

  // --- a server's process: its record, its console, its log -------------------------------

  function takeTurn(turns, key, task) {
    let turn = turns.get(key);
    if (!turn) {
      turn = createMutex();
      turns.set(key, turn);
    }
    return turn(task);
  }

  const fromRoot = (target) => path.relative(store.rootDir, target);

  // Whether a server has the folder the dashboard keeps its record and its
  // log in, .rippermoon in the server's own folder.
  //
  // The files in it are opened without following a link, but that guards the
  // last step of the path only. With the folder itself swapped for a link to
  // another server's, a stop wrote its lines into that server's log and
  // cleared that server's record away. So the folder has to be a folder, in
  // the place it is looked for; anything else there is refused out loud, and
  // nothing is read, written or removed through it.
  async function runtimeDirIsThere(paths) {
    let stats;
    try {
      stats = await fsp.lstat(paths.runtimeDir);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        return false;
      }
      throw new Error(`${fromRoot(paths.runtimeDir)} could not be looked at (${error.code || error.message}). Nothing in it has been touched.`);
    }
    const [real, realServerDir] = stats.isDirectory()
      ? await Promise.all([fsp.realpath(paths.runtimeDir), fsp.realpath(paths.serverDir)])
      : [null, null];
    if (!stats.isDirectory() || real !== path.join(realServerDir, path.basename(paths.runtimeDir))) {
      throw new Error(
        `${fromRoot(paths.runtimeDir)} is ${stats.isSymbolicLink() ? "a link" : "not a folder of the server's own"}. The dashboard keeps this server's record and log there, and reads, writes and removes nothing through it as it is. Put a folder there, or remove what is there.`
      );
    }
    return true;
  }

  // Opens a server's runtime log to add to the end of it. Never through a
  // link, and never waiting: a named pipe left at this path would hold a plain
  // open until something read from it. O_NONBLOCK means nothing on the regular
  // file this has to turn out to be.
  async function openRuntimeLog(runtimeLog) {
    const handle = await fsp.open(
      runtimeLog,
      fs.constants.O_WRONLY |
        fs.constants.O_APPEND |
        fs.constants.O_CREAT |
        fs.constants.O_NOFOLLOW |
        fs.constants.O_NONBLOCK,
      0o666
    );
    try {
      if (!(await handle.stat()).isFile()) {
        throw new Error("it is not a regular file");
      }
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
    return handle;
  }

  // Adds a line of the dashboard's own to a server's runtime log. The server
  // writes its output to the same file itself, so the dashboard keeps nothing
  // open there: each line is opened for, added to the end and closed. A log
  // that cannot be written to is said in the dashboard's log, and never stops
  // what the line was about.
  async function appendRuntimeLog(paths, text) {
    return await takeTurn(runtimeLogTurns, paths.runtimeLog, async () => {
      let handle = null;
      try {
        await runtimeDirIsThere(paths);
        handle = await openRuntimeLog(paths.runtimeLog);
        await handle.write(text);
        return true;
      } catch (error) {
        logger.warn("Could not write to a server's runtime log", {
          error: OPEN_FAILURES[error.code] || error.message,
          file: fromRoot(paths.runtimeLog)
        });
        return false;
      } finally {
        if (handle) {
          await handle.close().catch(() => {});
        }
      }
    });
  }

  // Removes what is at a path without following it: of a link, the link goes
  // and what it points to stays. A folder stays too. Says whether anything
  // was removed.
  async function removeWithoutFollowing(target) {
    try {
      await fsp.unlink(target);
      return true;
    } catch {
      // Not there, or a folder.
      return false;
    }
  }

  // Whether data/consoles is there as a folder of its own. A link in its
  // place is not one: the pipes would be made, written to and removed
  // wherever it led.
  async function consolesDirIsUsable() {
    try {
      return (await fsp.lstat(consolesDir)).isDirectory();
    } catch {
      return false;
    }
  }

  // Makes data/consoles, for the account alone: whoever can write to a
  // server's console pipe can type commands into that server.
  async function prepareConsolesDir() {
    await fsp.mkdir(consolesDir, { mode: 0o700, recursive: true });
    const stats = await fsp.lstat(consolesDir);
    if (!stats.isDirectory()) {
      throw new Error(`${path.relative(store.rootDir, consolesDir)} is not a folder of its own`);
    }
    if ((stats.mode & 0o777) !== 0o700) {
      await fsp.chmod(consolesDir, 0o700);
    }
  }

  // Removes a server's console pipe once nothing runs behind it. Only a pipe:
  // anything else found at that path is not the dashboard's, and is left for
  // the next start to deal with.
  async function removeConsolePipe(consoleFile) {
    try {
      if ((await consolesDirIsUsable()) && (await fsp.lstat(consoleFile)).isFIFO()) {
        await fsp.unlink(consoleFile);
      }
    } catch {
      // Not there.
    }
  }

  // Reads a server's pid.json.
  //
  //   { exists: false }             there is none
  //   { exists: true, info }        what it holds, when that can be believed
  //   { exists: true, why }         it is there and cannot be a record: a link,
  //                                 not a file, or holding nothing parsePidInfo()
  //                                 lets through
  //
  // Anything else that goes wrong - no permission, a disk error, no file
  // handles left - says nothing about the record, and is thrown. The record
  // of a running server was once cleared away on the strength of an EACCES;
  // what cannot be read is now left exactly as it is.
  async function readPidFile(paths) {
    if (!(await runtimeDirIsThere(paths))) {
      return { exists: false };
    }
    const unreadable = (error) =>
      Object.assign(
        new Error(
          `${fromRoot(paths.pidFile)} could not be read (${error.code || error.message}). Whether this server is running is not known, and nothing has been removed.`
        ),
        { code: error.code }
      );
    let handle;
    try {
      // Not through a link, and without waiting on a named pipe left there.
      handle = await fsp.open(paths.pidFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") {
        return { exists: false };
      }
      if (error.code === "ELOOP") {
        return { exists: true, why: OPEN_FAILURES.ELOOP };
      }
      throw unreadable(error);
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile()) {
        return { exists: true, why: "it is not a regular file" };
      }
      if (stats.size > PID_FILE_MAX_BYTES) {
        return { exists: true, why: "it is far too large to be a pid file" };
      }
      const buffer = Buffer.alloc(PID_FILE_MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const info = parsePidInfo(buffer.toString("utf8", 0, bytesRead));
      return info ? { exists: true, info } : { exists: true, why: "it does not hold a game server's pid" };
    } catch (error) {
      throw unreadable(error);
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // Written beside its final name and moved into place, so that whatever is
  // at that name - a link a mod left there, say - is replaced and never
  // written through.
  async function writePidFile(pidFile, info) {
    const temporaryPath = `${pidFile}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fsp.writeFile(temporaryPath, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      await fsp.rename(temporaryPath, pidFile);
    } catch (error) {
      await fsp.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  // Whether a process is there and this account's to signal. Only ever asked
  // about a pid that parsePidInfo() let through, or one of this process's own
  // children.
  function isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Whether a process group has anything in it that this account may signal.
  // Only ever asked about a pid that parsePidInfo() let through, which is 2 or
  // more: minus that is a group, never "every process" (-1) or "my own group"
  // (0).
  function isGroupAlive(pgid) {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // Whether a server is still running.
  //
  // A server is started as the leader of a process group of its own, and
  // counts as running while anything is left in that group. The process the
  // dashboard started need not be the server: a start script that does not
  // end in `exec` stays as a shell with the server as its child, and when
  // that shell was all the dashboard watched, a SIGTERM ended the shell, the
  // server ran on, and the dashboard called it stopped and started a second
  // one beside it.
  //
  // A server on record without a group - one started before this - is the
  // one process its record names.
  function isServerAlive(serverProcess) {
    if (serverProcess.group) {
      return isGroupAlive(serverProcess.pid);
    }
    if (serverProcess.child) {
      return serverProcess.child.exitCode === null && serverProcess.child.signalCode === null;
    }
    return isProcessAlive(serverProcess.pid);
  }

  // Sends a signal to a server: to its whole group where it has one, so that
  // a start script and the server behind it get it alike.
  function signalServer(serverProcess, signal) {
    try {
      if (serverProcess.group) {
        process.kill(-serverProcess.pid, signal);
      } else if (serverProcess.child) {
        serverProcess.child.kill(signal);
      } else {
        process.kill(serverProcess.pid, signal);
      }
    } catch {
      // Gone already. The wait that follows sees that.
    }
  }

  // Whether what a record names is still there, and is this server.
  //
  // A pid alone does not say. Copy a running server's folder and the copy's
  // record names the original's process: the copy showed as running, and
  // stopping it stopped the original. Restart the machine and the pid is
  // some other program's. So, where /proc can answer:
  //
  //   - the record is from this run of the machine;
  //   - the process was started when the record says it was;
  //   - it is running in this server's folder, or under it.
  //
  // What fails one of these is not this server, and the record goes. What
  // /proc cannot answer - there is none, or the process is one this
  // dashboard may signal and not look at - is believed as before, on the pid.
  //
  // A group whose leader has exited has no process under the recorded pid to
  // ask about. Then its members are asked instead: one of them has to be in
  // the session the leader made, no older than the leader, and in this
  // server's folder.
  async function examineRecorded(info, paths) {
    if (info.boot && bootId && info.boot !== bootId) {
      return { gone: true, running: false, why: "it is from before this machine was last started" };
    }
    const leaderAlive = isProcessAlive(info.pid);
    if (!leaderAlive && !(info.group && isGroupAlive(info.pid))) {
      return { gone: true, running: false, why: "its process has gone" };
    }
    const home = await fsp.realpath(paths.serverDir).catch(() => null);
    const inItsFolder = (cwd) => cwd === null || home === null || cwd === home || cwd.startsWith(`${home}${path.sep}`);

    if (leaderAlive) {
      const stat = readProcStat(info.pid);
      if (stat && info.started !== null && stat.started !== info.started) {
        return { gone: false, running: false, why: `pid ${info.pid} is another process now, started at another time` };
      }
      const cwd = readProcCwd(info.pid);
      if (!inItsFolder(cwd)) {
        return { gone: false, running: false, why: `pid ${info.pid} is a process running in ${cwd}, not in this server's folder` };
      }
      return { running: true };
    }

    const members = readProcGroup(info.pid);
    if (!members || !members.length) {
      return { running: true };
    }
    const itsOwn = members.some(
      (member) => member.session === info.pid && (info.started === null || member.started >= info.started) && inItsFolder(member.cwd)
    );
    return itsOwn
      ? { running: true }
      : { gone: false, running: false, why: `process group ${info.pid} is not this server's: nothing in it runs in this server's folder` };
  }

  // The server this process started itself, while it runs. The child is the
  // truth about it. pid.json is for the dashboard process that comes after
  // this one, and sits where a mod can rewrite it.
  function ownProcess(serverId) {
    const own = runningChildren.get(serverId);
    return own && isServerAlive(own) ? own : null;
  }

  // The process a server is running as: this dashboard's own child, or the one
  // an earlier dashboard process recorded in pid.json and that is still there.
  // `stale` says why pid.json holds something else: a process that has gone,
  // or nothing that can be a record. Throws when the record cannot be read.
  async function findServerProcess(serverId) {
    const own = ownProcess(serverId);
    if (own) {
      return { process: own, stale: null };
    }
    const server = await getServer(serverId);
    if (!server) {
      return { process: null, stale: null };
    }
    const paths = resolveRecordPaths(server);
    const recorded = await readPidFile(paths);
    if (!recorded.exists) {
      return { process: null, stale: null };
    }
    if (!recorded.info) {
      return { process: null, stale: recorded.why };
    }
    const state = await examineRecorded(recorded.info, paths);
    return state.running ? { process: { ...recorded.info, child: null }, stale: null } : { process: null, stale: state.why };
  }

  // Removes the record and the console of a server that is no longer running.
  // Run in the server's turn, and it looks again before it removes anything:
  // by now the record may be that of a server that has just been started. A
  // record that cannot be read is not removed: this throws, like the read.
  // The pid file goes after the console, so that once it has gone the console
  // has too.
  async function clearProcessRecord(serverId, paths, { announce = false } = {}) {
    if (ownProcess(serverId)) {
      return;
    }
    const recorded = await readPidFile(paths);
    const state = recorded.info ? await examineRecorded(recorded.info, paths) : null;
    if (state && state.running) {
      return;
    }
    await removeConsolePipe(paths.consoleFile);
    if (!recorded.exists) {
      return;
    }
    const removed = await removeWithoutFollowing(paths.pidFile);
    if (!removed) {
      return;
    }
    if (!recorded.info) {
      // Not a record at all. Said, because something put it there.
      logger.warn("Removed a server's pid file that could not be a record", {
        file: fromRoot(paths.pidFile),
        reason: recorded.why,
        serverId
      });
    } else if (!state.gone) {
      // A record, of something that is running and is not this server.
      logger.warn("Removed a server's record of a process that is not that server", {
        file: fromRoot(paths.pidFile),
        pid: recorded.info.pid,
        reason: state.why,
        serverId
      });
    } else if (announce) {
      // A server an earlier dashboard process started. Its exit code went to
      // that process, so all there is to say is that it is gone. Said once:
      // only when the record went with it.
      logger.info("A recorded server process is no longer running", { pid: recorded.info.pid, serverId });
      await appendRuntimeLog(paths, `\n[${nowIso()}] Process ${recorded.info.pid} is no longer running\n`);
    }
  }

  // The same for a server that is known to have gone: one this process
  // started, or one it has just stopped. Its console goes whatever becomes of
  // its record. A record that cannot be read or reached stays where it is,
  // and that is said.
  async function forgetServer(serverId, paths, options) {
    try {
      await clearProcessRecord(serverId, paths, options);
    } catch (error) {
      await removeConsolePipe(paths.consoleFile);
      logger.warn("A server has gone, and its record could not be cleared", { error: error.message, serverId });
    }
  }

  async function clearStaleRecord(serverId) {
    const server = await getServer(serverId);
    if (!server) {
      return;
    }
    const paths = resolveRecordPaths(server);
    await takeTurn(lifecycleTurns, serverId, () => clearProcessRecord(serverId, paths, { announce: true }));
  }

  // `stopping` is only ever true of a server that is running: the moment its
  // process has gone it is stopped, whether or not the stop has noticed yet.
  function describeStatus(serverId, serverProcess) {
    if (!serverProcess) {
      return {
        running: false,
        pid: null,
        startedAt: null,
        startedBy: null,
        stopping: false,
        stoppingSince: null
      };
    }
    const stop = stopsInProgress.get(serverId);
    const stopping = Boolean(stop && stop.pid === serverProcess.pid);
    return {
      running: true,
      pid: serverProcess.pid,
      startedAt: serverProcess.startedAt,
      startedBy: serverProcess.startedBy || "unknown",
      stopping,
      stoppingSince: stopping ? stop.since : null
    };
  }

  async function getServerStatus(serverId) {
    const found = await findServerProcess(serverId);
    if (found.stale) {
      await clearStaleRecord(serverId);
    }
    return describeStatus(serverId, found.process);
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

  // Checks a change to a server record, field by field, and returns it ready to
  // store. Every caller goes through here - the settings route for owners and
  // admins alike, and this file's own runtime updates - so no route can hand a
  // record something that was never looked at.
  //
  // A field that is absent or undefined is left out of the result, and so
  // keeps the value the record already has. It used to be written as
  // undefined, which dropped it from the record: saving only a Minecraft
  // version erased the loader.
  function checkMetadataPatch(patch) {
    const checked = {};
    for (const [field, value] of Object.entries(patch || {})) {
      if (value === undefined) {
        continue;
      }
      switch (field) {
        case "name":
          checked.name = singleLine(value, "The server name", { maxLength: 80, required: true });
          break;
        case "description":
          checked.description = singleLine(value, "The description", { maxLength: 500 });
          break;
        case "loader":
          checked.loader = normalizeLoader(value);
          break;
        case "minecraftVersion":
          checked.minecraftVersion = normalizeMinecraftVersion(value);
          break;
        case "startCommand":
          checked.startCommand = singleLine(value, "The start command", { maxLength: 1000 });
          break;
        case "javaBin":
          if (plainText(value) === null) {
            throw invalid("The Java binary must be a path, written as text.");
          }
          checked.javaBin = plainText(value);
          break;
        case "passphrase":
          if (typeof value !== "string") {
            throw invalid("The passphrase must be text.");
          }
          checked.passphrase = value;
          break;
        // Both are written into the launch script.
        case "maxMemory":
          checked.maxMemory = normalizeMemory(value, "Max memory");
          break;
        case "minMemory":
          checked.minMemory = normalizeMemory(value, "Min memory");
          break;
        // Written by this file after it has provisioned a runtime, never taken
        // from a request body.
        case "managedRuntime":
          checked.managedRuntime = value;
          break;
        default:
          throw new Error(`Server records have no "${field}" field that can be changed here.`);
      }
    }
    return checked;
  }

  async function setServerMetadata(serverId, patch) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const nextPatch = checkMetadataPatch(patch);
    if (nextPatch.javaBin !== undefined) {
      nextPatch.javaBin = await validateJavaBin(nextPatch.javaBin);
    }
    if (typeof nextPatch.passphrase === "string") {
      const trimmed = nextPatch.passphrase.trim();
      nextPatch.passphraseHash = trimmed ? await hashSecret(trimmed) : null;
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

    // Every value is checked before the file is touched, so a refused one
    // leaves all of them as they were.
    const checked = {};
    for (const definition of SAFE_ADMIN_SETTING_DEFINITIONS) {
      if (!Object.hasOwn(nextSafeProperties, definition.key)) {
        continue;
      }
      checked[definition.key] = normalizeAdminSettingValue(definition, nextSafeProperties[definition.key]);
    }
    Object.assign(propertyMap, checked);

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
    const response = await outbound.get(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`);
    if (response.status === 404 || response.status === 204) {
      throw userFacingError(`No Minecraft account named "${name}" exists. Check the spelling.`, 404);
    }
    if (response.status < 200 || response.status > 299) {
      throw userFacingError(
        `Could not reach Mojang to look up "${name}" (HTTP ${response.status}). Try again in a moment.`,
        502
      );
    }
    let payload = {};
    try {
      payload = JSON.parse(response.buffer.toString("utf8")) || {};
    } catch {
      // Falls through to the "unexpected id" answer below.
    }
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

  // One operator out of ops.json. That file is the server's as much as the
  // dashboard's - the game writes it, and so can anything else the server
  // runs - and the owner's page draws what is in it. An entry is a record with
  // a name that is text; anything else in the list is not an operator.
  function normalizeOperator(entry) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const name = displayText(entry.name, 64);
    const uuid = displayText(entry.uuid, 64).toLowerCase();
    if (!name) {
      return null;
    }
    const level = typeof entry.level === "number" || typeof entry.level === "string" ? Number.parseInt(entry.level, 10) : NaN;
    return {
      uuid: uuid || offlinePlayerUuid(name),
      name,
      level: Math.min(4, Math.max(1, level || 4)),
      bypassesPlayerLimit: entry.bypassesPlayerLimit === true
    };
  }

  // The operators in ops.json. For showing them, a file that cannot be read as
  // a list counts as an empty one, so that it cannot keep the server's page
  // from loading. `forChange` is for the routes that go on to write the list
  // back: they stop instead, and leave a file they could not read as it is.
  async function listServerOperators(serverId, { forChange = false } = {}) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    let payload = [];
    try {
      payload = await readJson(paths.opsFile, []);
    } catch {
      if (forChange) {
        throw userFacingError("This server's ops.json could not be read, so it has been left as it is. Correct or remove the file, then try again.");
      }
    }
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

    const current = await listServerOperators(serverId, { forChange: true });
    // Always derive the uuid from the server's auth mode rather than trusting
    // whatever the caller sent, so the entry can actually match a player.
    const uuid = await resolveOperatorUuid(serverId, name);
    const next = current.filter((entry) => entry.name.toLowerCase() !== name.toLowerCase());
    return await writeServerOperators(serverId, [...next, { ...operator, level, name, uuid }]);
  }

  // Rewrites existing operators to the uuid form the server's auth mode needs.
  // Fixes entries added before the mode was known or changed afterwards.
  async function repairServerOperators(serverId) {
    const current = await listServerOperators(serverId, { forChange: true });
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
    const current = await listServerOperators(serverId, { forChange: true });
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
    // Not through a runtime folder that is a link to somewhere else: that
    // would show another server's log as this one's.
    const runtimeLog = (await runtimeDirIsThere(paths).catch(() => false)) ? await tailTextFile(paths.runtimeLog, 60_000) : "";
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
      // An upload in progress writes its temporary file here; it is not an add-on.
      .filter((entry) => entry.isFile() && !isUploadTempName(entry.name))
      .map((entry) => ({ enabled: true, fileName: entry.name }));
    const disabled = disabledEntries
      .filter((entry) => entry.isFile())
      .map((entry) => ({ enabled: false, fileName: entry.name }));

    // Join the tracked manifest onto what is actually on disk, so the add-on
    // list can show a title, artwork and which side the mod belongs on instead
    // of a bare filename. Files with no manifest entry were dropped in by hand
    // and stay deliberately bare - there is nothing truthful to show for them.
    const manifest = await readAddonManifest(serverId);
    const detailsByFileName = new Map(manifest.filter(Boolean).map((entry) => [entry.fileName, entry]));
    // The manifest is a file in the server's folder, and the page draws these
    // fields. Whatever the file holds, what is sent to the page is text.
    const text = (value, fallback = "") => (typeof value === "string" && value ? value : fallback);

    return [...active, ...disabled]
      .map((entry) => {
        const tracked = detailsByFileName.get(entry.fileName);
        if (!tracked) {
          return { ...entry, tracked: false };
        }
        return {
          ...entry,
          clientSide: text(tracked.clientSide, "unknown"),
          // A picture the page loads and a link it offers: https, or neither.
          iconUrl: httpsAddress(tracked.iconUrl),
          pageUrl: httpsAddress(tracked.pageUrl),
          provider: text(tracked.provider),
          serverSide: text(tracked.serverSide, "unknown"),
          sourceId: text(tracked.sourceId),
          title: text(tracked.title),
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
    // A manifest that cannot be read at all tracks nothing: every add-on shows
    // as one dropped in by hand, and the next install writes the file afresh.
    let payload = null;
    try {
      payload = await readJson(paths.addonManifestFile, null);
    } catch {
      payload = null;
    }
    const addons = payload && typeof payload === "object" && Array.isArray(payload.addons) ? payload.addons : [];
    // An entry is the record of one file, and each field of it is a word, a
    // number or a yes/no. The manifest sits in the server's folder, so it can
    // hold anything. What is not a record with a file name is not an entry,
    // and a field holding anything else is left out - here, once, so that no
    // reader of the manifest (the add-on list, the update check, the update
    // plan) passes an object on to a page that expects text.
    const plain = (value) => value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
    return addons
      .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.fileName === "string")
      .map((entry) => Object.fromEntries(Object.entries(entry).filter(([, value]) => plain(value))));
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

  // Moves a file that is already on disk into the add-on directory. An upload
  // is received into that same directory, so this is a rename, not a copy.
  async function installManagedFileFromPath(serverId, fileName, sourcePath) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await ensureDir(paths.modsDir);
    const targetFile = path.join(paths.modsDir, safeFilename(fileName));
    await fsp.rename(sourcePath, targetFile);
    return path.basename(targetFile);
  }

  // Downloads a file into the server's add-on folder under a temporary name and
  // resolves to { path, size }. The caller renames it into place, or removes it.
  //
  // It is written to disk as it arrives and never held in memory, stops at the
  // download limit, and - like everything fetched from another machine - only
  // comes from an https address on the public internet.
  async function downloadAddonToTempFile(serverId, url) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const paths = resolveRecordPaths(server);
    await ensureDir(paths.modsDir);
    const tempPath = newUploadTempPath(paths.modsDir);
    let sink = null;
    try {
      // The file is only created once there is a response to put in it.
      const size = await outbound.download(url, () => {
        sink = fs.createWriteStream(tempPath, { flags: "wx" });
        return sink;
      });
      return { path: tempPath, size };
    } catch (error) {
      if (sink) {
        // Removed after the stream has let go of it, not before it exists.
        sink.destroy();
        if (!sink.closed) {
          await new Promise((resolve) => sink.once("close", resolve));
        }
        await fsp.rm(tempPath, { force: true });
      }
      throw error;
    }
  }

  async function downloadAndInstallFile(serverId, url, fileNameHint) {
    // Refused here, before anything is created, if it is not an https address.
    const parsedUrl = outbound.parseAddress(url);
    const fallbackName = path.basename(parsedUrl.pathname) || "download.jar";
    const downloaded = await downloadAddonToTempFile(serverId, parsedUrl.href);
    try {
      const installedName = await installManagedFileFromPath(serverId, fileNameHint || fallbackName, downloaded.path);
      return {
        fileName: installedName,
        size: downloaded.size
      };
    } catch (error) {
      await fsp.rm(downloaded.path, { force: true });
      throw error;
    }
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

  // Three values are written into the script: the two memory sizes and, for
  // Forge and NeoForge, the path of the argfile. All three sit inside double
  // quotes in a bash script, where a quote, a "$(...)" or a backtick in the
  // value would be a command. The settings route checks the memory sizes on
  // the way in; this checks all three again on the way out, so a record that
  // was written before that - or edited by hand - cannot put anything else
  // into a script that is about to be run. Nothing is escaped: a value is
  // either of the right shape or the script is not written.
  function buildLaunchScript(minMemoryValue, maxMemoryValue, launch = null) {
    const minMemory = minMemoryValue || "2G";
    const maxMemory = maxMemoryValue || "4G";
    for (const [label, value] of [["min memory", minMemory], ["max memory", maxMemory]]) {
      if (!isMemorySetting(value)) {
        throw userFacingError(
          `This server's ${label} setting is not a memory size the dashboard will write into a launch script. Set it to a whole number followed by K, M or G, such as 4G, in the server's settings.`
        );
      }
    }
    if (launch && launch.kind === "argfile" && launch.argFile && !isArgFilePath(launch.argFile)) {
      throw userFacingError(
        "This server's recorded loader argfile is not a plain path inside the server folder, so no launch script was written for it. Reinstall the loader from the update panel."
      );
    }
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
      await fsp.writeFile(paths.propertiesFile, initialPropertiesText(server.name, server.id), "utf8");
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

  // A field of the create-server form read as text. Left blank it is "", and
  // the caller supplies the default; given as anything but text it is refused.
  function optionalText(value, label) {
    if (value === undefined || value === null || value === "") {
      return "";
    }
    const text = plainText(value);
    if (text === null) {
      throw invalid(`${label} must be text.`);
    }
    return text.trim();
  }

  async function createServer(spec, actor, options = {}) {
    const reportProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const serverId = safeFilename(
      optionalText(spec.serverId, "The server id") ||
        optionalText(spec.directoryName, "The directory name") ||
        optionalText(spec.name, "The server name")
    );
    if (!serverId) {
      throw new Error("A server name is required.");
    }
    if (await getServer(serverId)) {
      throw new Error("A server with that id already exists.");
    }

    const directoryName = safeFilename(optionalText(spec.directoryName, "The directory name") || serverId);
    const relativeDirectory = path.join("servers", directoryName);
    const serverDir = path.resolve(store.rootDir, relativeDirectory);
    if (!withinParent(serversRoot, serverDir)) {
      throw new Error("Server directory is outside the managed servers root.");
    }

    const mode = spec.mode === "existing" ? "existing" : "managed";
    // The whole request body arrives here as `spec`. Everything in it that is
    // stored in the record or written into a file is checked now, before any
    // folder is created or anything is downloaded.
    const details = checkMetadataPatch({
      description: optionalText(spec.description, "The description"),
      loader: optionalText(spec.loader, "The loader") || "vanilla",
      maxMemory: optionalText(spec.maxMemory, "Max memory") || "4G",
      minMemory: optionalText(spec.minMemory, "Min memory") || "2G",
      minecraftVersion: optionalText(spec.minecraftVersion, "The Minecraft version"),
      name: optionalText(spec.name, "The server name") || displayNameFromSlug(serverId),
      startCommand: optionalText(spec.startCommand, "The start command")
    });
    const requestedLoader = details.loader;
    const port = optionalText(spec.port, "The server port")
      ? integerInRange(spec.port, "The server port", 1, 65535)
      : 25565;
    const filePaths = {
      logFile: optionalText(spec.logFile, "The log file") || "logs/latest.log",
      modsDir: optionalText(spec.modsDir, "The add-on folder") || "mods",
      serverPropertiesFile: optionalText(spec.serverPropertiesFile, "The properties file") || "server.properties",
      worldDir: optionalText(spec.worldDir, "The world folder") || "world"
    };
    for (const [field, value] of Object.entries(filePaths)) {
      filePaths[field] = singleLine(value, `The ${field} path`, { maxLength: 200 });
    }
    if (spec.passphrase !== undefined && spec.passphrase !== null && typeof spec.passphrase !== "string") {
      throw invalid("The passphrase must be text.");
    }
    // Validate before provisioning: Forge and NeoForge run their installer with
    // this JDK, so a bad path should fail before anything is downloaded.
    const javaBin = await validateJavaBin(optionalText(spec.javaBin, "The Java binary"));
    let minecraftVersion = details.minecraftVersion;
    let managedRuntime = null;
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
      await fsp.writeFile(path.join(serverDir, "server.properties"), initialPropertiesText(details.name, serverId, port), "utf8");
      // Provision first: the launch script shape depends on what the loader
      // produced (a server.jar, or Forge/NeoForge argfiles).
      const runtime = await createJarManagedRuntime(
        requestedLoader,
        minecraftVersion || "latest",
        serverDir,
        { javaBin, onProgress: reportProgress }
      );
      minecraftVersion = runtime.targetVersion;
      managedRuntime = runtime;
      reportProgress("writing launch script");
      const launchScriptPath = path.join(serverDir, ".rippermoon", "launch-server.sh");
      await fsp.writeFile(
        launchScriptPath,
        buildLaunchScript(details.minMemory, details.maxMemory, runtime.launch),
        "utf8"
      );
      await fsp.chmod(launchScriptPath, 0o755);
    }

    if (!minecraftVersion) {
      const detected = await detectVersion(serverDir);
      minecraftVersion = isMinecraftVersion(detected) ? detected : "unknown";
    }

    reportProgress("registering the server");
    const record = await store.updateServerRecord(serverId, normalizeServerRecord(serverId, {
      id: serverId,
      createdAt: nowIso(),
      createdBy: actor.username,
      description: details.description,
      directory: relativeDirectory,
      javaBin,
      loader: requestedLoader,
      logFile: filePaths.logFile,
      maxMemory: details.maxMemory,
      managedRuntime:
        mode === "existing"
          ? null
          : {
              kind: managedRuntime.kind || requestedLoader,
              // The launch shape must survive into the record; the managed
              // launch script is regenerated from it on every start.
              launch: managedRuntime.launch || { kind: "jar" },
              loaderVersion: managedRuntime.loaderVersion || null,
              source: managedRuntime.source || requestedLoader,
              updatedAt: nowIso()
            },
      minMemory: details.minMemory,
      minecraftVersion,
      modsDir: filePaths.modsDir,
      name: details.name,
      passphraseHash: spec.passphrase ? await hashSecret(spec.passphrase) : null,
      serverPropertiesFile: filePaths.serverPropertiesFile,
      startCommand:
        details.startCommand || (mode === "existing" ? DEFAULT_EXISTING_START_COMMAND : DEFAULT_MANAGED_START_COMMAND),
      worldDir: filePaths.worldDir
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

  // Refused, and worded for whoever pressed Start: not a fault to be logged
  // with a stack trace.
  function stillStopping(server) {
    return new HttpError(409, `${server.name} is still stopping. Wait until it has stopped, then start it again.`);
  }

  // Makes the named pipe a server reads its console from, and opens it.
  //
  // A server used to read its console from a pipe whose other end was this
  // process. When the dashboard was restarted that end closed, the server was
  // left with no console at all, and the only way to stop it was a signal. A
  // named pipe has a name instead, data/consoles/<the server's id>, and any
  // later dashboard process can open it to write "stop".
  //
  // Returns the open pipe, or null and why there is none.
  async function createConsole(paths) {
    try {
      await prepareConsolesDir();
    } catch (error) {
      return { handle: null, reason: error.message };
    }
    // Whatever is at the path goes first: the pipe of an earlier run, or
    // something a mod left there. unlink removes a link and not what it points
    // to. It fails on a folder, and then there is no console.
    try {
      await fsp.unlink(paths.consoleFile);
    } catch (error) {
      if (error.code !== "ENOENT") {
        // Linux says EISDIR of a folder, and macOS EPERM.
        const isFolder = await fsp.lstat(paths.consoleFile).then(
          (stats) => stats.isDirectory(),
          () => false
        );
        return {
          handle: null,
          reason: isFolder ? OPEN_FAILURES.EISDIR : `what is at its path could not be removed: ${error.message}`
        };
      }
    }
    try {
      // Given half a minute: on a machine short of memory even this can crawl,
      // and a server started without its pipe is one that can only be
      // signalled once the dashboard has been restarted.
      await runCommand(mkfifoCommand, ["-m", "600", paths.consoleFile], { timeoutMs: 30_000 });
    } catch (error) {
      const said = typeof error.stderr === "string" ? error.stderr.trim() : "";
      return { handle: null, reason: `${mkfifoCommand} failed: ${said || error.message}` };
    }
    let handle = null;
    try {
      // Read-write: opened that way a pipe never waits for its other end, and
      // the server, which is handed this as its stdin, holds both ends. It
      // then never reads an end of file, however many writers come and go.
      // Not through a link, and looked at before it is believed: the pipe was
      // made a moment ago, but in a folder a mod can write to as well.
      handle = await fsp.open(paths.consoleFile, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
      if (!(await handle.stat()).isFIFO()) {
        throw new Error("what was opened there is not a named pipe");
      }
      return { handle, reason: null };
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      await removeConsolePipe(paths.consoleFile);
      return { handle: null, reason: `the pipe could not be opened: ${OPEN_FAILURES[error.code] || error.message}` };
    }
  }

  // Writes a line to a server's console pipe.
  //
  // The path is in data/, where a mod running in any server can write too,
  // and can put something else there: a file, a link to one, a folder, a pipe
  // of its own. So it is opened without following a link, and looked at before
  // anything is written: only a named pipe is written to. It is opened
  // without waiting, too. A pipe that nothing reads would hold a plain open
  // for ever; opened this way it fails at once, which is how the dashboard
  // learns that the console is no longer attached to anything.
  async function writeToConsole(consoleFile, text) {
    if (!(await consolesDirIsUsable())) {
      return { reason: `${path.relative(store.rootDir, consolesDir)} is not a folder of its own`, sent: false };
    }
    let handle;
    try {
      handle = await fsp.open(consoleFile, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    } catch (error) {
      return { reason: describeConsoleFailure(error), sent: false };
    }
    try {
      if (!(await handle.stat()).isFIFO()) {
        return { reason: "what is in its place is not a named pipe", sent: false };
      }
      await handle.write(text);
      return { reason: null, sent: true };
    } catch (error) {
      return { reason: describeConsoleFailure(error), sent: false };
    } finally {
      await handle.close().catch(() => {});
    }
  }

  // A server this process started has gone, all of it. It is forgotten at
  // once, so that nothing takes it for running, and cleared up after in its
  // turn. `line` is what its own log is told. Once only, however it is found
  // out: by its exit, by the watch below, or by the stop that was waiting.
  function onServerGone(serverId, own, paths, line) {
    if (own.gone) {
      return;
    }
    own.gone = true;
    clearInterval(own.watch);
    own.watch = null;
    if (runningChildren.get(serverId) === own) {
      runningChildren.delete(serverId);
    }
    takeTurn(lifecycleTurns, serverId, async () => {
      await appendRuntimeLog(paths, `\n[${nowIso()}] ${line}\n`);
      await forgetServer(serverId, paths);
    }).catch((error) => {
      logger.error("Clearing up after a server that exited failed", { error: error.message, serverId, stack: error.stack });
    });
  }

  // The process this dashboard started for a server has exited.
  //
  // As a rule that is the server, and the end of it. But the process may have
  // been a start script that left the server running as its child. Then
  // others of its group are still there, the server still counts as running -
  // it can be stopped, and is not started again - and the group is looked at
  // until the last of it has gone.
  function onLeaderExit(serverId, own, paths, code, signal) {
    const how = code === null ? `Process was ended by ${signal}` : `Process exited with code ${code}`;
    logger.info("Server process exited", { code, pid: own.pid, serverId, signal });
    if (!isServerAlive(own)) {
      onServerGone(serverId, own, paths, how);
      return;
    }
    logger.warn("The process that started a server has exited, and others it started run on: the server counts as running", {
      pid: own.pid,
      serverId
    });
    appendRuntimeLog(
      paths,
      `\n[${nowIso()}] ${how}. Others it started are still running: the server counts as running until they have gone.\n`
    );
    own.watch = setInterval(() => {
      if (!isServerAlive(own)) {
        onServerGone(serverId, own, paths, "The last of the server's processes has gone");
      }
    }, stopWaits.poll);
  }

  // The launch itself, in the server's turn. Returns false when there was
  // nothing to launch because the server is running after all.
  async function launchServer({ actor, command, directCommandPath, paths, server, serverId }) {
    // Getting ready can take minutes when a runtime has to be repaired first.
    // In that time someone else may have started this server.
    const found = await findServerProcess(serverId);
    if (found.process) {
      if (describeStatus(serverId, found.process).stopping) {
        throw stillStopping(server);
      }
      return false;
    }
    await clearProcessRecord(serverId, paths, { announce: true });

    const shellCommand = resolveShellCommand();
    // The server gets a short list of variables, not the dashboard's own
    // environment: it runs mods, and they have no business with the
    // dashboard's keys. See childEnvironment() in utils.js for the list.
    //
    // The launch script already prefers the JAVA_BIN override, so a per-server
    // override only needs to reach this child's environment.
    const childEnv = childEnvironment();
    if (server.javaBin) {
      childEnv[`${ENV_PREFIX}JAVA_BIN`] = server.javaBin;
      // Hand-written launch scripts in existing server folders read the
      // pre-rename variable, and this code cannot rewrite scripts it did not
      // generate. Exporting both means a per-server JDK keeps reaching them.
      childEnv[`${LEGACY_ENV_PREFIX}JAVA_BIN`] = server.javaBin;
      childEnv.JAVA_HOME = path.dirname(path.dirname(server.javaBin));
      await appendRuntimeLog(paths, `[${nowIso()}] Using per-server Java: ${server.javaBin}\n`);
    }

    // The server's output goes straight into its runtime log, not through
    // this process. It is then still written down after a dashboard restart,
    // where a pipe would have been closed under the server, and a dashboard
    // that has stalled can never hold a server up on a pipe that is full.
    await runtimeDirIsThere(paths);
    let logHandle;
    try {
      logHandle = await openRuntimeLog(paths.runtimeLog);
    } catch (error) {
      throw userFacingError(
        `Unable to start ${server.name}. Its runtime log, ${path.relative(store.rootDir, paths.runtimeLog)}, cannot be written to: ${OPEN_FAILURES[error.code] || error.message}.`
      );
    }

    const own = {
      child: null,
      console: CONSOLE_STDIN,
      gone: false,
      group: true,
      pid: null,
      started: null,
      startedAt: nowIso(),
      startedBy: actor.username,
      watch: null
    };
    let consoleHandle = null;
    let outcome = null;
    let launchError = null;
    try {
      const consolePipe = await createConsole(paths);
      consoleHandle = consolePipe.handle;
      if (consoleHandle) {
        own.console = CONSOLE_PIPE;
      } else {
        // The server is started the way it always was, with a pipe from this
        // process for its console. That works for as long as this process
        // lives.
        logger.warn("A server was started without a console that outlasts the dashboard", {
          reason: consolePipe.reason,
          serverId
        });
        await appendRuntimeLog(
          paths,
          `[${nowIso()}] No console pipe: ${consolePipe.reason}. Started with a pipe from the dashboard instead. After a dashboard restart this server can only be stopped by signal.\n`
        );
      }

      const stdio = [consoleHandle ? consoleHandle.fd : "pipe", logHandle.fd, logHandle.fd];
      // `detached` makes the process the leader of a session and a process
      // group of its own, with whatever it starts in that group too: the
      // whole of a server can then be signalled, and told from everything
      // else, by one number. It also means that Ctrl-C on a dashboard run
      // from a terminal no longer reaches the game servers, which outlive it
      // as they outlive a restart of the service.
      const child = directCommandPath
        ? spawn(directCommandPath, [], {
            cwd: paths.serverDir,
            detached: true,
            env: childEnv,
            stdio
          })
        : spawn(shellCommand.command, [...shellCommand.args, command], {
            cwd: paths.serverDir,
            detached: true,
            env: childEnv,
            stdio
          });
      own.child = child;
      own.pid = child.pid;
      own.started = (readProcStat(child.pid) || { started: null }).started;
      // Listened for before anything is awaited. Whether the process was made
      // is already known, and the event that says so comes on the next tick.
      outcome = new Promise((resolve) => {
        child.once("spawn", () => resolve(null));
        child.once("error", (error) => resolve(error));
      });
      child.once("exit", (code, signal) => onLeaderExit(serverId, own, paths, code, signal));
    } catch (error) {
      launchError = error;
    } finally {
      // The server has its own copies by now: spawn() returns after the
      // process has been made. The dashboard keeps neither open, so nothing
      // of a running server depends on this process staying alive.
      if (consoleHandle) {
        await consoleHandle.close().catch(() => {});
      }
      await logHandle.close().catch(() => {});
    }
    if (outcome) {
      launchError = await outcome;
    }

    if (launchError) {
      if (consoleHandle) {
        await removeConsolePipe(paths.consoleFile);
      }
      const message = buildStartFailureMessage(server, command, launchError, directCommandPath);
      await appendRuntimeLog(paths, `[${nowIso()}] Start failed: ${message}\n`);
      throw userFacingError(message);
    }

    const { child } = own;
    // An 'error' that nobody listens for ends the process it is raised in.
    // One can still come later, from a signal that could not be sent.
    child.on("error", (error) => {
      logger.warn("A server's process reported an error", { error: error.message, pid: own.pid, serverId });
    });
    if (child.stdin) {
      // The same goes for the pipe: "stop" written to a server that has just
      // exited fails, and must not take the dashboard with it.
      child.stdin.on("error", () => {});
    }
    if (!own.gone) {
      // Unless all of it has gone already: that was then found out a moment
      // ago, and will not be found out again to take this record back out.
      runningChildren.set(serverId, own);
    }

    try {
      await writePidFile(paths.pidFile, {
        pid: own.pid,
        startedAt: own.startedAt,
        startedBy: own.startedBy,
        ...(own.console === CONSOLE_PIPE ? { console: CONSOLE_PIPE } : {}),
        group: true,
        // What tells this process from another that is given its pid later:
        // which run of the machine it is from, and when in it it was started.
        ...(bootId ? { boot: bootId } : {}),
        ...(own.started !== null ? { started: own.started } : {})
      });
    } catch (error) {
      // A server the next dashboard process cannot find would be shown as
      // stopped while it runs, and be started a second time on the same
      // world. This one has only just begun, so it is ended instead.
      signalServer(own, "SIGKILL");
      const message = `Unable to start ${server.name}. Its process could not be recorded in ${path.relative(store.rootDir, paths.pidFile)} (${error.message}), so it was ended again.`;
      await appendRuntimeLog(paths, `[${nowIso()}] Start failed: ${message}\n`);
      throw userFacingError(message);
    }
    return true;
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
    if (status.stopping) {
      // The process is still there, saving. A second one on the same world
      // and the same port is the last thing it needs.
      throw stillStopping(server);
    }
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
    await appendRuntimeLog(paths, `\n[${nowIso()}] Starting ${server.name} as ${actor.username}\n`);

    let launchSpec;
    try {
      launchSpec = await resolveLaunchCommand(serverId, server);
    } catch (error) {
      // Say in the server's own log why nothing started.
      await appendRuntimeLog(paths, `[${nowIso()}] Start failed: ${error.message}\n`);
      throw error;
    }
    const command = launchSpec.command;
    const spawnDirectly = shouldSpawnDirectly(command);
    const directCommandPath = spawnDirectly ? path.resolve(paths.serverDir, command) : null;

    if (spawnDirectly && !(await exists(directCommandPath))) {
      const message = buildStartFailureMessage(server, command, { code: "ENOENT" }, directCommandPath);
      await appendRuntimeLog(paths, `[${nowIso()}] Start failed: ${message}\n`);
      throw userFacingError(message);
    }

    const launched = await takeTurn(lifecycleTurns, serverId, () =>
      launchServer({ actor, command, directCommandPath, paths, server, serverId })
    );
    if (launched) {
      await sleep(500);
    }
    return await getServerStatus(serverId);
  }

  // Asks a server to stop through its console: the named pipe in its folder,
  // or, for a server this process had to start without one, the pipe this
  // process still holds.
  async function sendStopCommand(serverProcess, paths) {
    if (serverProcess.console === CONSOLE_PIPE) {
      return await writeToConsole(paths.consoleFile, STOP_COMMAND);
    }
    const stdin = serverProcess.child && serverProcess.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) {
      return { reason: "the pipe to it has closed", sent: false };
    }
    return await new Promise((resolve) => {
      stdin.write(STOP_COMMAND, (error) => {
        resolve(error ? { reason: describeConsoleFailure(error), sent: false } : { reason: null, sent: true });
      });
    });
  }

  // Waits for a server to be gone, for at most `waitMs`, and says whether it
  // is.
  //
  // A server this process started says when its own process has exited, and
  // that is looked at at once. What has no such event - a server this process
  // did not start, or the rest of a group whose leader has exited - is looked
  // at again and again. Timers only, no clock: the wait is as long as the
  // timer says.
  function waitForExit(serverProcess, waitMs) {
    return new Promise((resolve) => {
      if (!isServerAlive(serverProcess)) {
        resolve(true);
        return;
      }
      const { child } = serverProcess;
      let again = null;
      const finish = (gone) => {
        clearTimeout(deadline);
        clearInterval(again);
        if (child) {
          child.off("exit", look);
        }
        resolve(gone);
      };
      const look = () => {
        if (!isServerAlive(serverProcess)) {
          finish(true);
        }
      };
      const deadline = setTimeout(() => finish(!isServerAlive(serverProcess)), waitMs);
      if (child) {
        child.once("exit", look);
      }
      if (!child || serverProcess.group) {
        again = setInterval(look, stopWaits.poll);
      }
    });
  }

  // Stops a server, and takes its time over it.
  //
  // "stop" on the console is what a Minecraft server expects: it tells the
  // players, saves the world and exits, in seconds on a quiet machine. A
  // signal is the second choice. Minecraft saves on SIGTERM as well, but a
  // server short of memory has been seen to do nothing with one for 20
  // seconds, which was all it used to get before SIGKILL. SIGKILL saves
  // nothing: whatever the server had not written is lost. So each step waits
  // minutes, not seconds, and each step past the first is said out loud, in
  // the dashboard's log and in the server's own.
  async function runStop(serverId, server, serverProcess, actor) {
    const paths = resolveRecordPaths(server);
    const { pid } = serverProcess;
    const began = performance.now();
    const waitedSeconds = () => Math.round((performance.now() - began) / 1000);
    const note = (text) => appendRuntimeLog(paths, `[${nowIso()}] ${text}\n`);
    const by = actor && actor.username ? ` by ${actor.username}` : "";
    const stopped = async () => {
      if (serverProcess.child) {
        // This process started it. Its exit has said so already, unless the
        // last of it to go was not the process that was started.
        onServerGone(serverId, serverProcess, paths, "The last of the server's processes has gone");
      }
      // The record of a server this process did not start is cleared here.
      // One it did start is cleared a turn ahead of this.
      await takeTurn(lifecycleTurns, serverId, () => forgetServer(serverId, paths, { announce: true }));
      logger.info("Server stopped", { pid, serverId, waitedSeconds: waitedSeconds() });
    };

    // A server this process did not start is known by its record alone, and
    // minutes pass between one step and the next. What is about to be
    // signalled is looked at again each time: by then the pid could be some
    // other program's.
    const stillThisServer = async () => Boolean(serverProcess.child) || (await examineRecorded(serverProcess, paths)).running;

    // A server on record without a console was started before the dashboard
    // kept one for its servers, or by a dashboard process that could not make
    // one and has since gone. A signal is all that reaches it.
    let asked = { reason: "it was started without one that outlasts the dashboard", sent: false };
    if (serverProcess.console) {
      // Written down before it is sent, so that what the server says in
      // answer comes after it in the log.
      await note(`Stop requested${by}: sending "stop" to the console`);
      asked = await sendStopCommand(serverProcess, paths);
    } else {
      await note(`Stop requested${by}`);
    }

    if (asked.sent) {
      logger.info('Stopping a server: sent "stop" to its console', { pid, server: server.name, serverId });
      if (await waitForExit(serverProcess, stopWaits.console)) {
        return await stopped();
      }

      if (!(await stillThisServer())) {
        return await stopped();
      }
      const waited = waitedSeconds();
      signalServer(serverProcess, "SIGTERM");
      logger.warn('Server did not exit after "stop" on its console: sent SIGTERM', {
        pid,
        server: server.name,
        serverId,
        waitedSeconds: waited
      });
      await note(`No exit ${waited} s after "stop" on the console: sent SIGTERM`);
      if (await waitForExit(serverProcess, stopWaits.term)) {
        return await stopped();
      }
    } else {
      if ((await waitForExit(serverProcess, 0)) || !(await stillThisServer())) {
        // It went while it was being asked.
        return await stopped();
      }
      signalServer(serverProcess, "SIGTERM");
      logger.warn('Server has no console the dashboard can reach: sent SIGTERM instead of "stop"', {
        pid,
        reason: asked.reason,
        server: server.name,
        serverId,
        waitedSeconds: waitedSeconds()
      });
      await note(`No console to send "stop" to (${asked.reason}): sent SIGTERM`);
      if (await waitForExit(serverProcess, stopWaits.signalOnly)) {
        return await stopped();
      }
    }

    if (!(await stillThisServer())) {
      return await stopped();
    }
    const waited = waitedSeconds();
    signalServer(serverProcess, "SIGKILL");
    logger.warn("Server did not exit after SIGTERM: sent SIGKILL. The world may not have been saved.", {
      pid,
      server: server.name,
      serverId,
      waitedSeconds: waited
    });
    await note(`No exit ${waited} s after the stop began: sent SIGKILL. The world may not have been saved.`);
    if (await waitForExit(serverProcess, stopWaits.kill)) {
      return await stopped();
    }
    logger.error("Server is still running after SIGKILL", { pid, server: server.name, serverId, waitedSeconds: waitedSeconds() });
    await note(`Still running ${waitedSeconds()} s after the stop began, after SIGKILL`);
  }

  // Begins stopping a server, or finds the stop that is already under way.
  // Returns null when the server is not running.
  async function beginStop(serverId, actor) {
    const server = await getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }
    const found = await findServerProcess(serverId);
    if (!found.process) {
      if (found.stale) {
        await clearStaleRecord(serverId);
      }
      return null;
    }

    // Nothing is awaited between this look and the set below, so two requests
    // that arrive together find one stop between them. Pressing Stop three
    // times used to start three, each with a SIGKILL of its own at the end.
    const underWay = stopsInProgress.get(serverId);
    if (underWay && underWay.pid === found.process.pid) {
      return underWay;
    }
    const stop = { finished: null, pid: found.process.pid, since: nowIso() };
    stopsInProgress.set(serverId, stop);
    stop.finished = runStop(serverId, server, found.process, actor)
      .catch((error) => {
        // Nobody may be waiting for this: it runs on after the request that
        // began it has been answered. A failure is logged, and ends here.
        logger.error("Stopping a server failed", { error: error.message, pid: stop.pid, serverId, stack: error.stack });
      })
      .finally(() => {
        if (stopsInProgress.get(serverId) === stop) {
          stopsInProgress.delete(serverId);
        }
      });
    return stop;
  }

  // Begins stopping a server and answers at once, with its status as it is
  // now: still running, and stopping. The stop carries on by itself. This is
  // what a request calls: a stop can take minutes, and a request that was
  // held open for all of them left the page with nothing to show.
  async function requestStop(serverId, actor) {
    await beginStop(serverId, actor);
    return await getServerStatus(serverId);
  }

  // The same, and waits until the stop has run its course.
  async function stopServer(serverId, actor) {
    const stop = await beginStop(serverId, actor);
    if (stop) {
      await stop.finished;
    }
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
    return await verifySecret(passphrase, server.passphraseHash);
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
    // What the dashboard remembers about a server's worlds: what the live one
    // is called and when that was set. The file is in the server's folder,
    // where the server - and any mod it runs - can write, and both fields are
    // drawn on the page. So a name comes back as a short piece of text or as
    // nothing, a time as a time or as nothing, and a file that cannot be read
    // counts as one that is not there.
    let stored = null;
    try {
      stored = await readJson(paths.worldMetadataFile, null);
    } catch {
      stored = null;
    }
    const fields = stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    const updatedAt = typeof fields.updatedAt === "string" ? Date.parse(fields.updatedAt) : Number.NaN;
    return {
      activeWorldName: displayText(fields.activeWorldName) || null,
      updatedAt: Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : null
    };
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
      // A name such as ".." - the caller's mistake, not a server fault.
      throw userFacingError("Invalid archive path.", 400);
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
    const asked = options.minecraftVersion;
    const targetVersion =
      asked === undefined || asked === null || asked === ""
        ? String(server.minecraftVersion || "").trim()
        : normalizeMinecraftVersion(asked, "The target Minecraft version");
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
    // Its console pipe is not in that folder. One is only still there if the
    // server went while no dashboard was watching.
    await removeConsolePipe(paths.consoleFile);
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
    downloadAddonToTempFile,
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
    installManagedFileFromPath,
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
    requestStop,
    startServer,
    stopServer,
    stopWaits,
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
  DEFAULT_STOP_WAITS,
  createServerManager
};
