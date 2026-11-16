const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

// The project was renamed from RipperMoonStash to RipperCraft. Configuration
// lives in the environment of whoever deployed it - a systemd unit, an env file,
// a shell profile - none of which this code can rewrite, so the old prefix keeps
// working. New installs use RIPPERCRAFT_*; existing ones do not break on upgrade.
const ENV_PREFIX = "RIPPERCRAFT_";
const LEGACY_ENV_PREFIX = "RIPPERMOONSTASH_";

function readEnv(name, fallbackValue = "") {
  for (const prefix of [ENV_PREFIX, LEGACY_ENV_PREFIX]) {
    const value = process.env[`${prefix}${name}`];
    if (value !== undefined && String(value).trim() !== "") {
      return String(value);
    }
  }
  return fallbackValue;
}

// What a process the dashboard starts is given from the dashboard's own
// environment. Everything else stays behind.
//
// A game server runs mods, and a loader installer is a jar from the internet:
// both are other people's code. They used to inherit the dashboard's whole
// environment - the CurseForge key, and whatever else the service was started
// with - where any mod could read it. So a child gets a list instead: what a
// program needs to run at all, what Java reads, and the three variables the
// launch scripts look at to find Java.
const CHILD_ENVIRONMENT_NAMES = new Set([
  // Finding programs, the home directory, and who is running.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  // Language, character set and time zone. Java takes its file-name encoding
  // from these; without them a world or a mod with an accent in its name is
  // mangled.
  "LANG",
  "LANGUAGE",
  "TZ",
  // Where Java is, as the generated launch scripts and hand-written ones from
  // before the rename look for it.
  "JAVA_HOME",
  `${ENV_PREFIX}JAVA_BIN`,
  `${LEGACY_ENV_PREFIX}JAVA_BIN`,
  // Options the JVM itself reads from its environment. Whoever set them for
  // the service set them for the servers it runs.
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "_JAVA_OPTIONS"
]);
// LC_ALL, LC_CTYPE and the rest of the locale family.
const CHILD_ENVIRONMENT_PREFIXES = ["LC_"];

// The environment for a child process: the listed variables as the dashboard
// has them, then `extra` - whatever the dashboard sets for this child on
// purpose, such as a server's own Java.
function childEnvironment(extra = {}, source = process.env) {
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    if (CHILD_ENVIRONMENT_NAMES.has(name) || CHILD_ENVIRONMENT_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      environment[name] = value;
    }
  }
  return { ...environment, ...extra };
}

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function readJson(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return typeof fallbackValue === "function" ? fallbackValue() : fallbackValue;
    }
    throw error;
  }
}

// Replaces a file in one step. The new contents go to a temporary file in the
// same directory, are flushed to disk, and are then renamed over the target, so
// a reader sees either the complete old file or the complete new one. Writing
// in place could not promise that: two overlapping writes interleaved their
// bytes and left data/users.json unparseable, and a crash mid-write left it cut
// short.
//
// options.mode sets the permissions exactly, and the temporary file is created
// with them, so a secret never sits in a more readable file even briefly.
// Without it, an existing file keeps the permissions it already has.
async function writeFileAtomic(filePath, data, options = {}) {
  // Follow a symlink in the last position, so the link survives and the file it
  // points at is the one replaced.
  let targetPath = filePath;
  try {
    targetPath = await fs.realpath(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  const directory = path.dirname(targetPath);
  await ensureDir(directory);

  let mode = options.mode;
  if (mode === undefined) {
    try {
      mode = (await fs.stat(targetPath)).mode & 0o7777;
    } catch {
      // A new file: the process umask decides, as it does for writeFile.
    }
  }

  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  let handle = null;
  try {
    handle = await fs.open(temporaryPath, "wx", mode === undefined ? 0o666 : mode);
    if (mode !== undefined) {
      // open() masks the mode with the umask; this makes it exact.
      await handle.chmod(mode);
    }
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, targetPath);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }

  // The rename lives in the directory, so flush that too. Not every platform
  // allows a directory to be opened or synced; the write itself has succeeded.
  try {
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch {
    // Best effort.
  }
}

async function writeJson(filePath, value, options = {}) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

// Runs async tasks one at a time, in the order they were queued. A task that
// throws rejects its own caller and does not hold up the ones behind it.
function createMutex() {
  let tail = Promise.resolve();
  return function runExclusive(task) {
    const result = tail.then(() => task());
    tail = result.then(
      () => {},
      () => {}
    );
    return result;
  };
}

function randomId(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function safeFilename(input) {
  return String(input || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180) || "file";
}

function displayNameFromSlug(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

// The end of a text file: its last `maxBytes`, or "" when there is no file.
//
// What is read this way is a log in a server's folder, and what a mod leaves
// at that path need not be a file. A named pipe, opened the ordinary way,
// holds the open until something writes to it, and with it one of the four
// threads that every file operation in the dashboard shares. Four such reads,
// and nothing is read or written any more, the steps of stopping a server
// among them. So the path is opened without waiting, and looked at before it
// is read: anything but a regular file reads as empty.
async function tailTextFile(filePath, maxBytes = 160_000) {
  let handle;
  try {
    handle = await fs.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      return "";
    }
    const start = Math.max(0, stats.size - maxBytes);
    const buffer = Buffer.alloc(stats.size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

function coerceBoolean(value) {
  return value === true || value === "true" || value === "1" || value === 1;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Runs a program and resolves to what it printed. It is given the minimal
// environment above, never the dashboard's own: zip reads options from its
// environment, a Java installer is somebody else's code, and neither has any
// use for the dashboard's settings.
async function runCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || childEnvironment(),
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;

    child.on("error", (error) => {
      if (timer) {
        clearTimeout(timer);
      }
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const error = new Error(`Command failed: ${command} ${args.join(" ")}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function withinParent(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  return child === parent || child.startsWith(`${parent}${path.sep}`);
}

module.exports = {
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
  randomId,
  readJson,
  runCommand,
  safeFilename,
  sleep,
  slugify,
  tailTextFile,
  withinParent,
  writeFileAtomic,
  writeJson
};
