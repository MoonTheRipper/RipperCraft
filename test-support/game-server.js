// Stand-ins for a game server, for tests of how the dashboard starts one,
// talks to it and stops it. Each is a small Node script: it prints lines the
// way a server logs, reads its console, and writes down everything it is told
// - every console command, every signal - so that a test can say exactly how
// it was stopped. None of them is Minecraft, and none uses more memory than
// an idle Node process.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");
const { hashSecret, setHashCostForTests } = require("../src/lib/auth");
const { DEFAULT_STOP_WAITS, createServerManager } = require("../src/lib/servers");
const { createStore } = require("../src/lib/store");
// Loaded for what it does on the way in: managers made here are given a
// fetcher that connects to nothing.
require("./outbound");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const SERVER_ID = "DemoServer";
const OWNER = Object.freeze({ username: "owner" });
const START_COMMAND = "./fake-server.js";
// Short enough for a test, long enough that nothing escalates by accident.
const QUICK_WAITS = Object.freeze({ console: 10_000, kill: 10_000, poll: 20, signalOnly: 10_000, term: 10_000 });

// The source of a stand-in server. `behaviour` says what it does when it is
// told to stop:
//
//   onStop   what "stop" on the console does: "exit" (the default), "ignore",
//            or "wait" - it exits, but not before a file called `release` is
//            there beside it, the way a server takes its time over a save.
//   onTerm   the same three, for SIGTERM.
//
// Whatever it is told, it ends by itself after a minute: a test that fails
// half-way must not leave processes behind on the machine it ran on.
function fakeServerSource(behaviour = {}) {
  const settings = { lifetimeMs: 60_000, onStop: "exit", onTerm: "exit", tickMs: 40, ...behaviour };
  return `#!${process.execPath}
// A stand-in for a game server, written by test-support/game-server.js.
const fs = require("node:fs");
const settings = ${JSON.stringify(settings)};
const record = (line) => fs.appendFileSync("received.log", line + "\\n");

function leave(how) {
  record("exit: " + how);
  process.exit(0);
}

function told(how, reaction) {
  if (reaction === "exit") {
    leave(how);
  } else if (reaction === "wait") {
    const timer = setInterval(() => {
      if (fs.existsSync("release")) {
        clearInterval(timer);
        leave(how);
      }
    }, 10);
  }
}

process.on("SIGTERM", () => {
  record("signal: SIGTERM");
  told("SIGTERM", settings.onTerm);
});

let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  pending += chunk;
  for (let end = pending.indexOf("\\n"); end !== -1; end = pending.indexOf("\\n")) {
    const line = pending.slice(0, end);
    pending = pending.slice(end + 1);
    record("console: " + line);
    if (line === "stop") {
      told("stop", settings.onStop);
    }
  }
});
process.stdin.on("end", () => record("console: closed"));
process.stdin.on("error", (error) => record("console: error " + error.code));

setTimeout(() => {
  record("exit: nobody stopped it");
  process.exit(9);
}, settings.lifetimeMs);

let ticks = 0;
setInterval(() => {
  ticks += 1;
  console.log("tick " + ticks);
}, settings.tickMs);

fs.writeFileSync("fake-server.pid", String(process.pid));
console.error("fake server: a line on stderr");
console.log("fake server ready");
`;
}

async function waitFor(check, what, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// When a process was started, as /proc counts it, and which run of the
// machine this is. null where there is no /proc to ask.
function procStarted(pid) {
  try {
    const line = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(line.slice(line.lastIndexOf(")") + 2).split(" ")[19]);
  } catch {
    return null;
  }
}

function bootIdNow() {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return null;
  }
}

// What the dashboard writes down about a server it has just started, given
// the pid and the time it reported.
function recordFor(pid, startedAt, extra = {}) {
  const record = { group: true, pid, startedAt, startedBy: OWNER.username, ...extra };
  if (bootIdNow() !== null) {
    record.boot = bootIdNow();
  }
  if (procStarted(pid) !== null) {
    record.started = procStarted(pid);
  }
  return record;
}

// Whether anything is at a path - a link that leads nowhere included.
function isThere(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

// Everything a test needs to look at one server's folder.
function describeServerDir(root, serverId = SERVER_ID) {
  const serverDir = path.join(root, "servers", serverId);
  const runtimeDir = path.join(serverDir, ".rippermoon");
  const read = (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    }
  };
  const layout = {
    // The console pipes are together in data/, each under its server's id.
    consoleFile: path.join(root, "data", "consoles", serverId),
    consolesDir: path.join(root, "data", "consoles"),
    // The pid the stand-in wrote down for itself, or null before it has.
    fakePid: () => Number(read(path.join(serverDir, "fake-server.pid"))) || null,
    pidFile: path.join(runtimeDir, "pid.json"),
    pidInfo: () => JSON.parse(read(path.join(runtimeDir, "pid.json")) || "null"),
    // What the stand-in was told, in order: "console: stop", "signal: SIGTERM",
    // "exit: stop" and so on.
    received: () => read(path.join(serverDir, "received.log")).split("\n").filter(Boolean),
    // Lets a stand-in that is waiting over its "save" finish.
    release: () => fs.writeFileSync(path.join(serverDir, "release"), ""),
    root,
    runtimeDir,
    runtimeLog: () => read(path.join(runtimeDir, "runtime.log")),
    serverDir,
    // The highest "tick N" the stand-in has got into the runtime log.
    ticks: () => Math.max(0, ...[...read(path.join(runtimeDir, "runtime.log")).matchAll(/^tick (\d+)$/gm)].map((match) => Number(match[1]))),
    whenReady: () => waitFor(() => /^fake server ready$/m.test(layout.runtimeLog()) && layout.fakePid(), "the stand-in server to be ready")
  };
  return layout;
}

// A dashboard root with one server in it, DemoServer, set up far enough to be
// started: the EULA accepted, a passphrase set, and a stand-in for a start
// command. Removed after the test, along with any stand-in still running.
async function createServerRoot(t, behaviour = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-stop-"));
  const layout = describeServerDir(root);
  await fsp.mkdir(path.join(layout.serverDir, "logs"), { recursive: true });
  await fsp.writeFile(path.join(layout.serverDir, "eula.txt"), "eula=true\n");
  await fsp.writeFile(path.join(layout.serverDir, "fake-server.js"), fakeServerSource(behaviour), { mode: 0o755 });

  const store = createStore(root);
  await store.ensureInitialized();
  await store.createUser({ passwordHash: await hashSecret("owner-password-1"), role: "owner", servers: [], username: OWNER.username });
  const setup = createServerManager(store);
  await setup.syncDiscoveredServers();
  await setup.setServerMetadata(SERVER_ID, { passphrase: "lane-secret", startCommand: START_COMMAND });

  t.after(async () => {
    const pid = layout.fakePid();
    if (pid && isAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Gone in the meantime.
      }
    }
    // Whatever is still waiting on a pipe is let go, and again for as long as
    // the clearing up takes: a reader that has been let go of one pipe may
    // go straight on to wait on the next, and the removal below needs one of
    // the threads they hold.
    releasePipesUnder(root);
    const releasing = setInterval(() => releasePipesUnder(root), 50);
    try {
      await fsp.rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
    } finally {
      clearInterval(releasing);
    }
  });
  return layout;
}

// A server manager over a root, the way one dashboard process makes it: with
// a store of its own, and a logger that keeps what it is told. Making a
// second one over the same root is what a restarted dashboard amounts to.
async function createManager(root, options = {}) {
  const logs = [];
  const keep = (level) => (message, meta) => logs.push({ level, message, meta });
  const store = createStore(root);
  await store.ensureInitialized();
  const serverManager = createServerManager(store, {
    logger: { error: keep("error"), info: keep("info"), warn: keep("warn") },
    stopWaits: QUICK_WAITS,
    ...options
  });
  return {
    logs,
    // The warnings and errors: what a stop that went as it should leaves none of.
    problems: () => logs.filter((entry) => entry.level !== "info"),
    serverManager
  };
}

// Starts a server from a dashboard process of its own - a separate program,
// test-support/first-dashboard.js - and returns once that server is running.
// `end()` then ends the dashboard the way a crash would, with SIGKILL, and
// leaves the server it started behind.
async function startFromAnotherProcess(t, root, options = {}) {
  const dashboard = spawn(process.execPath, [path.join(__dirname, "first-dashboard.js"), root, JSON.stringify(options)], {
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"]
  });
  const exited = new Promise((resolve) => dashboard.once("exit", resolve));
  t.after(() => {
    dashboard.kill("SIGKILL");
    return exited;
  });

  let printed = "";
  dashboard.stdout.setEncoding("utf8");
  dashboard.stdout.on("data", (chunk) => {
    printed += chunk;
  });
  await waitFor(() => printed.includes("\n") || dashboard.exitCode !== null, "the other dashboard process to start the server");
  assert.ok(printed.includes("\n"), `the other dashboard process ended without starting the server: ${printed}`);

  return {
    end: async () => {
      dashboard.kill("SIGKILL");
      await exited;
    },
    pid: dashboard.pid,
    status: JSON.parse(printed.split("\n")[0])
  };
}

// What a server that is not running is reported as.
const STOPPED = Object.freeze({ pid: null, running: false, startedAt: null, startedBy: null, stopping: false, stoppingSince: null });

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// The answer, or "the dashboard is still waiting" when none has come in ten
// seconds: for what a test plants in a server's folder that would hold a
// careless open for ever.
async function unlessItHangs(answer) {
  let timer;
  const waiting = new Promise((resolve) => {
    timer = setTimeout(() => resolve("the dashboard is still waiting"), 10_000);
  });
  try {
    return await Promise.race([answer, waiting]);
  } finally {
    clearTimeout(timer);
  }
}

// Makes a named pipe where a test wants one left: in place of a console, a
// pid file, a log. Nothing reads or writes it.
function plantPipe(target) {
  execFileSync("mkfifo", [target]);
}

// Opens every named pipe under a folder once, at both ends, and closes it
// again.
//
// Code that opens a planted pipe the ordinary way waits there for ever, in a
// thread the process cannot exit without. A test that catches such code
// would still leave the whole test run hanging. Opening the pipe from here
// lets any open that is waiting on it go.
function releasePipesUnder(directory) {
  let entries = [];
  try {
    entries = fs.readdirSync(directory, { recursive: true, withFileTypes: true });
  } catch {
    // Nothing there to release.
  }
  for (const entry of entries) {
    if (entry.isFIFO()) {
      try {
        fs.closeSync(fs.openSync(path.join(entry.parentPath, entry.name), fs.constants.O_RDWR | fs.constants.O_NONBLOCK));
      } catch {
        // Gone in the meantime.
      }
    }
  }
}

// What has been written to a pipe this test is holding open for reading, or
// "" when nothing has.
function whatArrived(reader) {
  const buffer = Buffer.alloc(256);
  try {
    return buffer.toString("utf8", 0, fs.readSync(reader, buffer));
  } catch (error) {
    assert.equal(error.code, "EAGAIN");
    return "";
  }
}

// A server as a dashboard from before this change leaves it behind when it is
// restarted: running, its console gone with the process that held the other
// end, and a pid file that says nothing about one.
function startLegacyServer(t, server) {
  fs.mkdirSync(server.runtimeDir, { recursive: true });
  const log = fs.openSync(path.join(server.runtimeDir, "runtime.log"), "a");
  const child = spawn(path.join(server.serverDir, "fake-server.js"), [], { cwd: server.serverDir, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  t.after(() => child.kill("SIGKILL"));
  fs.writeFileSync(
    server.pidFile,
    `${JSON.stringify({ pid: child.pid, startedAt: "2026-11-16T09:00:00.000Z", startedBy: "owner" }, null, 2)}\n`
  );
  return child;
}

module.exports = {
  DEFAULT_STOP_WAITS,
  OWNER,
  QUICK_WAITS,
  SERVER_ID,
  STOPPED,
  bootIdNow,
  createManager,
  createServerRoot,
  describeServerDir,
  fakeServerSource,
  isAlive,
  isThere,
  plantPipe,
  procStarted,
  recordFor,
  sleep,
  startFromAnotherProcess,
  startLegacyServer,
  unlessItHangs,
  waitFor,
  whatArrived
};
