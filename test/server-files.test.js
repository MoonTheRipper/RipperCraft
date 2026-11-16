const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { readJson, readRegularFile } = require("../src/lib/utils");
const {
  OWNER,
  SERVER_ID,
  STOPPED,
  createManager,
  createServerRoot,
  isAlive,
  plantPipe,
  settled,
  sleep,
  stoppedBy,
  unlessItHangs,
  waitFor,
  whatArrived
} = require("../test-support/game-server");

// A server's folder is the server's to write in, and a mod can leave anything
// at a name the dashboard reads. These are about what the dashboard does when
// what it finds at one of those names is not a file - above all a named pipe,
// which holds an ordinary open until something writes to it.

const PAGE_OWNER = Object.freeze({ id: "usr_owner", role: "owner", servers: [], username: "owner" });
const NOT_A_FILE = "Something that is not a file is where a server's file belongs: read as if there were none";

// How long an answer took, with the answer.
async function timed(answer) {
  const from = Date.now();
  const value = await unlessItHangs(answer);
  return { ms: Date.now() - from, value };
}

// A socket to try the reader on, at a path short enough to be one whatever
// TMPDIR is. null, with a note, where none can be made.
async function listenOnAShortPath(t) {
  let folder;
  try {
    folder = fs.mkdtempSync(path.join("/tmp", "rc-"));
  } catch (error) {
    t.diagnostic(`no socket was tried: a short folder for one could not be made (${error.code || error.message})`);
    return null;
  }
  t.after(() => fs.rmSync(folder, { force: true, recursive: true }));
  const target = path.join(folder, "socket.txt");
  const listening = net.createServer();
  const failure = await new Promise((resolve) => {
    listening.once("error", resolve);
    listening.listen(target, () => resolve(null));
  });
  if (failure) {
    t.diagnostic(`no socket was tried: one could not be made at ${target} (${failure.code || failure.message})`);
    return null;
  }
  t.after(() => new Promise((resolve) => listening.close(resolve)));
  return target;
}

test("a whole file is read only when it is a file, and nothing else is waited on", async (t) => {
  const server = await createServerRoot(t);
  const at = (name) => path.join(server.root, name);
  fs.writeFileSync(at("a.txt"), "eula=true\n");
  fs.symlinkSync(at("a.txt"), at("linked.txt"));
  fs.symlinkSync(at("nowhere.txt"), at("dangling.txt"));
  fs.symlinkSync("/dev/zero", at("endless.txt"));
  fs.mkdirSync(at("folder.txt"));
  plantPipe(at("pipe.txt"));
  plantPipe(at("written-pipe.txt"));
  const writer = fs.openSync(at("written-pipe.txt"), fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  t.after(() => fs.closeSync(writer));
  fs.writeSync(writer, "something in the pipe\n");
  // A socket's path has to fit in about a hundred bytes, and the temporary
  // folder's own may be most of that already: it is made in a short folder
  // of its own, and where there is no such folder that one case is left out.
  const socket = await listenOnAShortPath(t);

  assert.equal(await readRegularFile(at("a.txt")), "eula=true\n");
  // Through a link, as readFile reads: it is what the link leads to that counts.
  assert.equal(await readRegularFile(at("linked.txt")), "eula=true\n");
  assert.deepEqual(await readRegularFile(at("a.txt"), { encoding: null }), Buffer.from("eula=true\n"));
  await assert.rejects(readRegularFile(at("no-such.txt")), { code: "ENOENT" });
  await assert.rejects(readRegularFile(at("dangling.txt")), { code: "ENOENT" });

  for (const target of [at("folder.txt"), at("pipe.txt"), at("written-pipe.txt"), at("endless.txt"), ...(socket ? [socket] : [])]) {
    const outcome = await unlessItHangs(readRegularFile(target).then(() => "read", (error) => error));
    assert.equal(outcome.code, "ERR_NOT_A_FILE", target);
    assert.equal(outcome.message, `${target} is not a regular file, and was not read.`, target);
  }
  // What was in the pipe is still in it.
  assert.equal(whatArrived(writer), "something in the pipe\n");

  // No more of a file is taken into memory than is asked for.
  assert.equal(await readRegularFile(at("a.txt"), { maxBytes: 10 }), "eula=true\n");
  await assert.rejects(readRegularFile(at("a.txt"), { maxBytes: 9 }), {
    code: "ERR_FILE_TOO_LARGE",
    message: `${at("a.txt")} is 10 bytes, which is more than is read of a file like it.`
  });

  // JSON is read the same way. Only a file that is not there is the fallback.
  fs.writeFileSync(at("a.json"), '{"a":1}\n');
  assert.deepEqual(await readJson(at("a.json"), null), { a: 1 });
  assert.equal(await readJson(at("no-such.json"), "fallback"), "fallback");
  const outcome = await unlessItHangs(readJson(at("pipe.txt"), "fallback").then(() => "read", (error) => error));
  assert.equal(outcome.code, "ERR_NOT_A_FILE");
});

test("pipes where a server's files belong do not hold up its page, and a stop is answered at once", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);
  // A Fabric server that the dashboard does not manage yet: its page also
  // looks into the launcher jars, to say which loader is installed.
  await serverManager.setServerMetadata(SERVER_ID, { loader: "fabric" });
  const started = await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();

  // Everything the page reads, each replaced by a pipe that nothing writes to.
  const planted = [
    "eula.txt",
    "server.properties",
    "ops.json",
    "server.jar",
    "fabric-server-launch.jar",
    path.join(".rippermoon", "addons.json"),
    path.join(".rippermoon", "worlds.json"),
    path.join("logs", "latest.log")
  ];
  for (const name of planted) {
    fs.rmSync(path.join(server.serverDir, name), { force: true });
    plantPipe(path.join(server.serverDir, name));
  }

  // The page, more times at once than the dashboard has threads to read with.
  const pages = await timed(Promise.all(Array.from({ length: 6 }, () => serverManager.getServerSnapshot(SERVER_ID, PAGE_OWNER, true))));
  assert.notEqual(pages.value, "the dashboard is still waiting");
  assert.equal(pages.ms < 5000, true, `six pages took ${pages.ms} ms`);
  for (const page of pages.value) {
    // The server is shown as it is, with what could not be read left empty.
    assert.deepEqual(page.server.status, started);
    assert.equal(page.server.eulaAccepted, false);
    assert.equal(page.propertiesText, "");
    assert.deepEqual(page.operators, []);
    assert.deepEqual(page.mods, []);
    assert.equal(page.logs.latestLog, "");
    assert.equal(page.server.runtimeAdoption.detectedLoaderVersion, null);
  }
  // The log says what was found, once for each file.
  assert.deepEqual(
    problems()
      .map((entry) => [entry.level, entry.message, entry.meta.file])
      .sort(),
    [
      ["warn", NOT_A_FILE, `servers/${SERVER_ID}/eula.txt`],
      ["warn", NOT_A_FILE, `servers/${SERVER_ID}/server.properties`]
    ]
  );

  // And the stop is answered, and reaches the server, while they are there.
  const stop = await timed(serverManager.requestStop(SERVER_ID, OWNER));
  assert.equal(stop.ms < 2000, true, `the stop request took ${stop.ms} ms`);
  assert.equal(stop.value.stopping, true);
  await waitFor(() => server.received().includes("exit: stop"), "the server to be told to stop");
  await waitFor(() => !isAlive(pid), "the server to have gone");
  await waitFor(async () => (await serverManager.getServerStatus(SERVER_ID)).running === false, "the stop to be over");
  assert.deepEqual(settled(await serverManager.getServerStatus(SERVER_ID)), stoppedBy("console"));
  // Nothing was read out of any of them, and nothing replaced.
  for (const name of planted) {
    assert.equal(fs.lstatSync(path.join(server.serverDir, name)).isFIFO(), true, name);
  }
});

test("accepting the EULA and saving the settings put a file where a pipe was, without waiting on it", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);
  const eula = path.join(server.serverDir, "eula.txt");
  const properties = path.join(server.serverDir, "server.properties");
  fs.rmSync(eula);
  plantPipe(eula);
  plantPipe(properties);

  // Read as if neither were there: not accepted, and nothing set.
  assert.equal(await unlessItHangs(serverManager.readEulaStatus(SERVER_ID)), false);
  assert.equal(await unlessItHangs(serverManager.readServerProperties(SERVER_ID)), "");
  // So the server is not started, and the reason given is the one to act on.
  await assert.rejects(unlessItHangs(serverManager.startServer(SERVER_ID, OWNER)), {
    message: /The Minecraft server EULA has not been accepted yet/,
    statusCode: 409
  });
  assert.equal(server.fakePid(), null);

  // More writes than there are threads, each of which an ordinary write would hold.
  for (let round = 0; round < 6; round += 1) {
    fs.rmSync(eula);
    plantPipe(eula);
    assert.equal(await unlessItHangs(serverManager.writeEulaStatus(SERVER_ID, true)), true);
    assert.equal(fs.lstatSync(eula).isFile(), true);
    assert.equal(fs.readFileSync(eula, "utf8"), "eula=true\n");

    fs.rmSync(properties);
    plantPipe(properties);
    const saved = await unlessItHangs(serverManager.writeSafeAdminProperties(SERVER_ID, { motd: `Round ${round}` }));
    assert.equal(saved.motd, `Round ${round}`);
    assert.equal(fs.lstatSync(properties).isFile(), true);
    assert.match(fs.readFileSync(properties, "utf8"), new RegExp(`^motd=Round ${round}$`, "m"));
  }
  // The log said what was found: once while it stayed that way, and again
  // each time a pipe was read where a file had been read in between. Saving
  // the settings reads them first; accepting the EULA reads nothing first.
  assert.equal(problems().every((entry) => entry.level === "warn" && entry.message === NOT_A_FILE), true);
  const said = (name) => problems().filter((entry) => entry.meta.file === `servers/${SERVER_ID}/${name}`).length;
  assert.deepEqual([said("eula.txt"), said("server.properties"), problems().length], [1, 6, 7]);

  // With files there, it starts.
  const started = await serverManager.startServer(SERVER_ID, OWNER);
  assert.equal(started.running, true);
  await server.whenReady();
  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
});

test("settings that are a link to a file are read and written through it, as before", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);
  // Somebody's own arrangement: one properties file kept beside the servers.
  const shared = path.join(server.root, "shared.properties");
  fs.writeFileSync(shared, "motd=Shared\nmax-players=7\n", { mode: 0o640 });
  fs.chmodSync(shared, 0o640);
  const properties = path.join(server.serverDir, "server.properties");
  fs.symlinkSync(shared, properties);

  assert.equal(await serverManager.readServerProperties(SERVER_ID), "motd=Shared\nmax-players=7\n");
  const saved = await serverManager.writeSafeAdminProperties(SERVER_ID, { motd: "Changed" });
  assert.equal(saved.motd, "Changed");
  // The link is still a link, and the file it leads to is the one that changed,
  // with the permissions it had.
  assert.equal(fs.lstatSync(properties).isSymbolicLink(), true);
  assert.match(fs.readFileSync(shared, "utf8"), /^motd=Changed$/m);
  assert.match(fs.readFileSync(shared, "utf8"), /^max-players=7$/m);
  assert.equal(fs.statSync(shared).mode & 0o777, 0o640);
  assert.deepEqual(problems(), []);
});

test("a launch command that is not a file is refused before anything is run", async (t) => {
  const server = await createServerRoot(t);
  const { serverManager } = await createManager(server.root);
  const command = path.join(server.serverDir, "fake-server.js");
  const refusal = `Unable to start DemoServer. The launch command at servers/${SERVER_ID}/fake-server.js is not a file.`;

  for (const [what, plant] of [
    ["a named pipe", () => plantPipe(command)],
    ["a folder", () => fs.mkdirSync(command)],
    ["a link to a folder", () => fs.symlinkSync(server.root, command)]
  ]) {
    fs.rmSync(command, { force: true, recursive: true });
    plant();
    const outcome = await timed(serverManager.startServer(SERVER_ID, OWNER).then(() => "started", (error) => error));
    assert.equal(outcome.value.message, refusal, what);
    assert.equal(outcome.value.statusCode, 409, what);
    assert.equal(outcome.ms < 2000, true, `${what}: ${outcome.ms} ms`);
    assert.equal(server.fakePid(), null, what);
    assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), STOPPED, what);
    assert.equal(server.runtimeLog().trimEnd().endsWith(`Start failed: ${refusal}`), true, what);
  }

  // And one that is not there at all is said to be missing, as it was.
  fs.rmSync(command, { force: true, recursive: true });
  await assert.rejects(serverManager.startServer(SERVER_ID, OWNER), {
    message: `Unable to start DemoServer. The launch command was not found at servers/${SERVER_ID}/fake-server.js.`,
    statusCode: 409
  });
});

test("the launch script the dashboard writes replaces what is at its name, and is written through nothing", async (t) => {
  const server = await createServerRoot(t);
  const { serverManager } = await createManager(server.root);
  await serverManager.setServerMetadata(SERVER_ID, {
    loader: "fabric",
    managedRuntime: { kind: "fabric", launch: { kind: "jar" }, source: "fabric" },
    maxMemory: "2G",
    minMemory: "1G",
    minecraftVersion: "1.21.1"
  });
  fs.mkdirSync(server.runtimeDir, { recursive: true });
  const script = path.join(server.runtimeDir, "launch-server.sh");
  const isTheScript = () => {
    const stats = fs.lstatSync(script);
    assert.equal(stats.isFile(), true);
    assert.equal(stats.mode & 0o777, 0o755);
    assert.match(fs.readFileSync(script, "utf8"), /-jar server\.jar nogui/);
    // Nothing is left beside it from the writing.
    assert.deepEqual(fs.readdirSync(server.runtimeDir).filter((name) => name.endsWith(".tmp")), []);
  };

  // A link to a file the dashboard depends on, where the script belongs.
  const users = path.join(server.root, "data", "users.json");
  const usersBefore = fs.readFileSync(users, "utf8");
  fs.symlinkSync(users, script);
  await serverManager.ensureManagedServerArtifacts(SERVER_ID);
  isTheScript();
  assert.equal(fs.readFileSync(users, "utf8"), usersBefore);

  // A pipe, which an ordinary write would wait on for a reader.
  for (let round = 0; round < 6; round += 1) {
    fs.rmSync(script);
    plantPipe(script);
    assert.notEqual(await unlessItHangs(serverManager.ensureManagedServerArtifacts(SERVER_ID)), "the dashboard is still waiting");
    isTheScript();
  }

  // And with the folder it is kept in swapped for a link to another server's,
  // it is not written at all.
  const other = path.join(server.root, "servers", "Other", ".rippermoon");
  fs.mkdirSync(other, { recursive: true });
  fs.rmSync(server.runtimeDir, { recursive: true });
  fs.symlinkSync(other, server.runtimeDir);
  await assert.rejects(serverManager.ensureManagedServerArtifacts(SERVER_ID), {
    message: new RegExp(`^servers/${SERVER_ID}/\\.rippermoon is a link\\.`)
  });
  await sleep(50);
  assert.deepEqual(fs.readdirSync(other), []);
});
