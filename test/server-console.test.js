const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  OWNER,
  SERVER_ID,
  STOPPED,
  createManager,
  createServerRoot,
  isAlive,
  isThere,
  plantPipe,
  procStarted,
  recordFor,
  settled,
  sleep,
  startFromAnotherProcess,
  stoppedBy,
  unlessItHangs,
  waitFor,
  whatArrived
} = require("../test-support/game-server");

// Where the files this process has open lead, for the ones under a folder.
// null where the system has no /proc to ask.
function openFilesUnder(directory) {
  let names;
  try {
    names = fs.readdirSync("/proc/self/fd");
  } catch {
    return null;
  }
  const targets = [];
  for (const name of names) {
    try {
      targets.push(fs.readlinkSync(`/proc/self/fd/${name}`));
    } catch {
      // Closed between the listing and the look.
    }
  }
  return targets.filter((target) => target.startsWith(`${directory}${path.sep}`));
}

// --- a console that outlasts the dashboard ------------------------------------------------------

test("a server the dashboard started is stopped through its console, and nothing is left behind", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);

  const started = await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();
  assert.equal(started.running, true);
  assert.equal(started.stopping, false);
  assert.equal(started.stoppingSince, null);
  assert.equal(started.pid, server.fakePid());
  assert.equal(started.startedBy, "owner");

  // Its console is a named pipe under the server's id, in a folder of the
  // dashboard's own, both for the account alone - and the pid file says that
  // it has one.
  assert.equal(server.consoleFile, path.join(server.root, "data", "consoles", SERVER_ID));
  const consoleStats = fs.lstatSync(server.consoleFile);
  assert.equal(consoleStats.isFIFO(), true);
  assert.equal(consoleStats.mode & 0o777, 0o600);
  assert.equal(fs.lstatSync(server.consolesDir).isDirectory(), true);
  assert.equal(fs.lstatSync(server.consolesDir).mode & 0o777, 0o700);
  assert.deepEqual(server.pidInfo(), recordFor(started.pid, started.startedAt, { console: "fifo" }));
  // Where /proc can say, the record holds what tells this process from any
  // other that is ever given its pid.
  if (procStarted(started.pid) !== null) {
    assert.deepEqual(Object.keys(server.pidInfo()).sort(), ["boot", "console", "group", "pid", "started", "startedAt", "startedBy"]);
    assert.match(server.pidInfo().boot, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.equal(Number.isSafeInteger(server.pidInfo().started), true);
  }
  assert.equal(fs.lstatSync(server.pidFile).isFile(), true);
  // The dashboard holds neither the console nor the log open: nothing of the
  // server depends on this process staying alive.
  const stillOpen = openFilesUnder(server.root);
  if (stillOpen) {
    assert.deepEqual(stillOpen.filter((target) => !target.startsWith(path.join(server.root, "data", "logs"))), []);
  }

  const stopped = await serverManager.stopServer(SERVER_ID, OWNER);
  // The status says how: by its console.
  assert.deepEqual(settled(stopped), stoppedBy("console"));
  // It was told to stop, and did. No signal was needed.
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.equal(isThere(server.pidFile), false);
  assert.equal(isThere(server.consoleFile), false);
  assert.deepEqual(problems(), []);

  // Its own log holds the dashboard's lines and both of the server's outputs,
  // in the order they happened.
  const log = server.runtimeLog();
  const order = [
    /^\[[^\]]+\] Starting DemoServer as owner$/m,
    /^fake server: a line on stderr$/m,
    /^fake server ready$/m,
    /^\[[^\]]+\] Stop requested by owner: sending "stop" to the console$/m,
    /^\[[^\]]+\] Process exited with code 0$/m
  ].map((line) => {
    assert.match(log, line);
    return log.search(line);
  });
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  const afterwards = openFilesUnder(server.root);
  if (afterwards) {
    assert.deepEqual(afterwards.filter((target) => !target.startsWith(path.join(server.root, "data", "logs"))), []);
  }
});

test("a server started through a shell is stopped through its console as well", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);
  // A space in the command sends it through the login shell, which hands its
  // own stdin on to the server.
  await serverManager.setServerMetadata(SERVER_ID, { startCommand: "./fake-server.js --nogui" });

  assert.equal((await serverManager.startServer(SERVER_ID, OWNER)).running, true);
  await server.whenReady();
  assert.equal(fs.lstatSync(server.consoleFile).isFIFO(), true);

  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.equal(isThere(server.consoleFile), false);
  assert.deepEqual(problems(), []);
});

test("a start script that stays between the dashboard and the server passes the console on", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);
  // Not `exec`: the script waits for the server, so the pid on record is the
  // script's, and the server is its child.
  fs.writeFileSync(path.join(server.serverDir, "wrapper.sh"), "#!/usr/bin/env bash\n./fake-server.js\n", { mode: 0o755 });
  await serverManager.setServerMetadata(SERVER_ID, { startCommand: "./wrapper.sh" });

  const started = await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();
  assert.equal(started.running, true);
  assert.notEqual(started.pid, pid);

  // "stop" gets to the server all the same: it was handed the script's stdin.
  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.equal(isAlive(pid), false);
  assert.deepEqual(problems(), []);
});

test("after a dashboard restart the server is found again, and still stopped through its console", async (t) => {
  const server = await createServerRoot(t);
  const first = await createManager(server.root);
  const started = await first.serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();

  // A second manager over the same folder knows what is on disk and no more,
  // as a dashboard process that has only just started does.
  const second = await createManager(server.root);
  assert.deepEqual(await second.serverManager.getServerStatus(SERVER_ID), started);

  assert.deepEqual(settled(await second.serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.equal(isThere(server.pidFile), false);
  assert.equal(isThere(server.consoleFile), false);
  assert.deepEqual(second.problems(), []);
  assert.match(server.runtimeLog(), /^\[[^\]]+\] Stop requested by owner: sending "stop" to the console$/m);
});

test("a server outlives the dashboard process that started it: its output still reaches its log, and it stops through its console", async (t) => {
  const server = await createServerRoot(t);
  const dashboard = await startFromAnotherProcess(t, server.root);
  const pid = await server.whenReady();
  assert.equal(dashboard.status.running, true);
  assert.equal(dashboard.status.pid, pid);

  // The dashboard goes the way a crash or a restart takes it: at once, with
  // no chance to tell the server anything.
  await dashboard.end();
  assert.equal(isAlive(dashboard.pid), false);
  assert.equal(isAlive(pid), true);

  // The server writes on, into the same log, with nobody there to carry it.
  const ticks = server.ticks();
  await waitFor(() => server.ticks() >= ticks + 5, "the server's output to go on reaching its log");
  // Its console did not close under it either.
  assert.deepEqual(server.received(), []);

  const later = await createManager(server.root);
  const found = await later.serverManager.getServerStatus(SERVER_ID);
  assert.deepEqual(found, dashboard.status);

  assert.deepEqual(settled(await later.serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.equal(isAlive(pid), false);
  assert.equal(isThere(server.pidFile), false);
  assert.equal(isThere(server.consoleFile), false);
  assert.deepEqual(later.problems(), []);
  // Nobody was there to be handed its exit code. The log says that it went.
  assert.match(server.runtimeLog(), new RegExp(`^\\[[^\\]]+\\] Process ${pid} is no longer running$`, "m"));
});

// --- where the pipes are kept ----------------------------------------------------------------------

test("a server's console pipe is not in its folder, so nothing that reads the folder waits on it", async (t) => {
  const { spawnSync } = require("node:child_process");
  const server = await createServerRoot(t);
  const { serverManager } = await createManager(server.root);
  await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();

  // No pipe anywhere under the server's folder while it runs.
  const pipes = fs
    .readdirSync(server.serverDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFIFO())
    .map((entry) => path.join(entry.parentPath, entry.name));
  assert.deepEqual(pipes, []);

  // A search through the folder comes back. On a pipe that a running server
  // reads it waited for ever: the server never closes its end.
  const search = spawnSync("grep", ["-R", "-l", "text that is nowhere in there", server.serverDir], { timeout: 10_000 });
  assert.equal(search.signal, null, "the search did not come back");
  assert.equal(search.status, 1);
  // And a copy of the folder takes no pipe with it.
  const copy = path.join(server.root, "a-copy");
  assert.equal(spawnSync("cp", ["-a", server.serverDir, copy], { timeout: 10_000 }).status, 0);
  assert.deepEqual(
    fs.readdirSync(copy, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFIFO()),
    []
  );

  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
});

test("each server has a pipe of its own, under a plain name even when its id is not one", async (t) => {
  const server = await createServerRoot(t);
  // A folder found in servers/ is a server, and its name is the server's id.
  const oddId = "Zweiter Server (März)";
  const oddDir = path.join(server.root, "servers", oddId);
  fs.mkdirSync(path.join(oddDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(oddDir, "eula.txt"), "eula=true\n");
  fs.copyFileSync(path.join(server.serverDir, "fake-server.js"), path.join(oddDir, "fake-server.js"));
  const { problems, serverManager } = await createManager(server.root);
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata(oddId, { passphrase: "lane-secret", startCommand: "./fake-server.js" });
  const received = (directory) => {
    try {
      return fs.readFileSync(path.join(directory, "received.log"), "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };

  assert.equal((await serverManager.startServer(SERVER_ID, OWNER)).running, true);
  assert.equal((await serverManager.startServer(oddId, OWNER)).running, true);
  await server.whenReady();
  await waitFor(() => fs.existsSync(path.join(oddDir, "fake-server.pid")), "the second server to be ready");

  const names = fs.readdirSync(server.consolesDir).sort();
  assert.equal(names.length, 2);
  assert.equal(names[0], SERVER_ID);
  assert.match(names[1], /^id-[0-9a-f]{40}$/);
  for (const name of names) {
    assert.equal(fs.lstatSync(path.join(server.consolesDir, name)).isFIFO(), true);
  }

  // "stop" for one of them reaches that one alone.
  assert.equal((await serverManager.stopServer(oddId, OWNER)).running, false);
  assert.deepEqual(received(oddDir), ["console: stop", "exit: stop"]);
  assert.deepEqual(server.received(), []);
  assert.deepEqual(fs.readdirSync(server.consolesDir), [SERVER_ID]);
  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.deepEqual(fs.readdirSync(server.consolesDir), []);
  assert.deepEqual(problems(), []);
});

test("a link where the folder of pipes belongs is not followed", async (t) => {
  const server = await createServerRoot(t);
  const elsewhere = path.join(server.root, "somewhere-else");
  fs.mkdirSync(elsewhere);

  // Before a server is started: no pipe is made through it.
  fs.mkdirSync(path.dirname(server.consolesDir), { recursive: true });
  fs.symlinkSync(elsewhere, server.consolesDir);
  const first = await createManager(server.root);
  assert.equal((await first.serverManager.startServer(SERVER_ID, OWNER)).running, true);
  await server.whenReady();
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  assert.deepEqual(
    first.problems().map((entry) => [entry.message, entry.meta.reason]),
    [["A server was started without a console that outlasts the dashboard", "data/consoles is not a folder of its own"]]
  );
  assert.deepEqual(settled(await first.serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  fs.rmSync(path.join(server.serverDir, "received.log"));
  fs.rmSync(path.join(server.serverDir, "fake-server.pid"));

  // While a server runs: the folder is swapped for a link to one that holds
  // another pipe of the same name, with something reading it.
  fs.unlinkSync(server.consolesDir);
  const second = await createManager(server.root);
  assert.equal((await second.serverManager.startServer(SERVER_ID, OWNER)).running, true);
  await server.whenReady();
  assert.equal(fs.lstatSync(server.consoleFile).isFIFO(), true);
  plantPipe(path.join(elsewhere, SERVER_ID));
  const reader = fs.openSync(path.join(elsewhere, SERVER_ID), fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  t.after(() => fs.closeSync(reader));
  fs.renameSync(server.consolesDir, `${server.consolesDir}.real`);
  fs.symlinkSync(elsewhere, server.consolesDir);

  assert.deepEqual(settled(await second.serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGTERM"));
  // Nothing was written through the link, and nothing was removed through it.
  assert.equal(whatArrived(reader), "");
  assert.equal(fs.lstatSync(path.join(elsewhere, SERVER_ID)).isFIFO(), true);
  assert.deepEqual(server.received(), ["signal: SIGTERM", "exit: SIGTERM"]);
  assert.deepEqual(
    second.problems().map((entry) => [entry.message, entry.meta.reason]),
    [['Server has no console the dashboard can reach: sent SIGTERM instead of "stop"', "data/consoles is not a folder of its own"]]
  );
});

// --- when something else is where the console was -------------------------------------------------

// What a mod could put where the console's pipe was, what the dashboard says
// when it finds it there, and what has to be true of it afterwards.
const IMPOSTORS = [
  {
    name: "a regular file",
    plant: (server) => fs.writeFileSync(server.consoleFile, "a file of the server's own\n"),
    reason: /not a named pipe/,
    untouched: (server) => {
      assert.equal(fs.lstatSync(server.consoleFile).isFile(), true);
      assert.equal(fs.readFileSync(server.consoleFile, "utf8"), "a file of the server's own\n");
    }
  },
  {
    name: "a link to a file somewhere else",
    plant: (server) => fs.symlinkSync(path.join(server.root, "elsewhere.txt"), server.consoleFile),
    reason: /a link is in its place/,
    untouched: (server) => {
      assert.equal(fs.lstatSync(server.consoleFile).isSymbolicLink(), true);
      assert.equal(fs.readlinkSync(server.consoleFile), path.join(server.root, "elsewhere.txt"));
    }
  },
  {
    name: "a link to another server's console",
    plant: (server, t) => {
      // A pipe that something is reading, the way a running server reads its
      // console. Following the link would tell that server to stop.
      const other = path.join(server.root, "another-console");
      plantPipe(other);
      const reader = fs.openSync(other, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      t.after(() => fs.closeSync(reader));
      fs.symlinkSync(other, server.consoleFile);
      return reader;
    },
    reason: /a link is in its place/,
    untouched: (server, reader) => {
      // Nothing has arrived there.
      assert.equal(whatArrived(reader), "");
      assert.equal(fs.lstatSync(server.consoleFile).isSymbolicLink(), true);
    }
  },
  {
    name: "a folder",
    plant: (server) => {
      fs.mkdirSync(server.consoleFile);
      fs.writeFileSync(path.join(server.consoleFile, "kept.txt"), "kept\n");
    },
    reason: /a folder is in its place/,
    untouched: (server) => assert.equal(fs.readFileSync(path.join(server.consoleFile, "kept.txt"), "utf8"), "kept\n")
  },
  {
    name: "a pipe that nothing reads",
    plant: (server) => plantPipe(server.consoleFile),
    reason: /nothing is reading it/,
    // A pipe at this path is taken for the server's own, and goes with it.
    untouched: (server) => assert.equal(isThere(server.consoleFile), false)
  }
];

for (const impostor of IMPOSTORS) {
  for (const who of ["the dashboard that started it", "a dashboard started later"]) {
    test(`with ${impostor.name} where the console was, ${who} writes nothing through it and stops the server by signal`, async (t) => {
      const server = await createServerRoot(t);
      const elsewhere = path.join(server.root, "elsewhere.txt");
      fs.writeFileSync(elsewhere, "nobody writes here\n");
      let dashboard = await createManager(server.root);
      await dashboard.serverManager.startServer(SERVER_ID, OWNER);
      const pid = await server.whenReady();
      if (who !== "the dashboard that started it") {
        dashboard = await createManager(server.root);
      }

      fs.unlinkSync(server.consoleFile);
      const planted = impostor.plant(server, t);

      // Opened carelessly, a pipe that nothing reads holds the stop for ever.
      assert.deepEqual(settled(await unlessItHangs(dashboard.serverManager.stopServer(SERVER_ID, OWNER))), stoppedBy("SIGTERM"));
      // The server never saw "stop": it was not sent anywhere.
      assert.deepEqual(server.received(), ["signal: SIGTERM", "exit: SIGTERM"]);
      // Not into what was planted, and not into what that led to.
      impostor.untouched(server, planted);
      assert.equal(fs.readFileSync(elsewhere, "utf8"), "nobody writes here\n");

      const problems = dashboard.problems();
      assert.equal(problems.length, 1, JSON.stringify(problems));
      assert.equal(problems[0].level, "warn");
      assert.equal(problems[0].message, 'Server has no console the dashboard can reach: sent SIGTERM instead of "stop"');
      assert.match(problems[0].meta.reason, impostor.reason);
      assert.equal(problems[0].meta.pid, pid);
      assert.match(server.runtimeLog(), /^\[[^\]]+\] No console to send "stop" to \([^)]+\): sent SIGTERM$/m);
      assert.equal(isThere(server.pidFile), false);
    });
  }
}

test("what is left where the console belongs is cleared away by the next start, without being followed", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);
  const elsewhere = path.join(server.root, "elsewhere.txt");
  fs.writeFileSync(elsewhere, "nobody writes here\n");
  fs.mkdirSync(server.consolesDir, { recursive: true });

  for (const plant of [
    () => fs.symlinkSync(elsewhere, server.consoleFile),
    () => fs.writeFileSync(server.consoleFile, "a file of the server's own\n"),
    () => plantPipe(server.consoleFile)
  ]) {
    plant();
    assert.equal((await serverManager.startServer(SERVER_ID, OWNER)).running, true);
    await server.whenReady();
    // A pipe of the dashboard's own making is there now.
    assert.equal(fs.lstatSync(server.consoleFile).isFIFO(), true);
    assert.equal(fs.lstatSync(server.consoleFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(elsewhere, "utf8"), "nobody writes here\n");

    assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
    assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
    fs.rmSync(path.join(server.serverDir, "received.log"));
    fs.rmSync(path.join(server.serverDir, "fake-server.pid"));
  }
  assert.deepEqual(problems(), []);
});

test("a file planted where the console was is not written to while the dashboard looks at it", async (t) => {
  const server = await createServerRoot(t, { onTerm: "wait" });
  const { serverManager } = await createManager(server.root);
  await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();

  fs.unlinkSync(server.consoleFile);
  fs.writeFileSync(server.consoleFile, "a file of the server's own\n");
  const stopping = serverManager.stopServer(SERVER_ID, OWNER);
  await waitFor(() => server.received().includes("signal: SIGTERM"), "the server to be sent SIGTERM");
  // The stop has been and gone past the console by now, and the file is as it was.
  assert.equal(fs.readFileSync(server.consoleFile, "utf8"), "a file of the server's own\n");

  server.release();
  assert.deepEqual(settled(await stopping), stoppedBy("SIGTERM"));
});

// --- when no pipe can be made ------------------------------------------------------------------

const NO_PIPE = [
  {
    name: "mkfifo is not installed",
    options: (server) => ({ mkfifoCommand: path.join(server.root, "no-such-program") }),
    reason: /no-such-program failed: .*ENOENT/
  },
  {
    name: "mkfifo fails",
    options: (server) => {
      const program = path.join(server.root, "failing-mkfifo");
      fs.writeFileSync(program, "#!/bin/sh\necho 'mkfifo: this file system has no pipes' >&2\nexit 1\n", { mode: 0o755 });
      return { mkfifoCommand: program };
    },
    reason: /failing-mkfifo failed: mkfifo: this file system has no pipes/
  },
  {
    name: "a folder is where the pipe belongs",
    options: (server) => {
      fs.mkdirSync(server.consoleFile, { recursive: true });
      fs.writeFileSync(path.join(server.consoleFile, "kept.txt"), "kept\n");
      return {};
    },
    reason: /a folder is in its place/
  }
];

for (const situation of NO_PIPE) {
  test(`when ${situation.name}, a server still starts, with a pipe from the dashboard, and the logs say so`, async (t) => {
    const server = await createServerRoot(t);
    const { logs, problems, serverManager } = await createManager(server.root, situation.options(server));

    const started = await serverManager.startServer(SERVER_ID, OWNER);
    const pid = await server.whenReady();
    assert.equal(started.running, true);
    assert.equal(started.pid, pid);
    // Nothing on record about a console, and no pipe in the folder.
    assert.deepEqual(server.pidInfo(), recordFor(pid, started.startedAt));
    if (isThere(server.consoleFile)) {
      assert.equal(fs.lstatSync(server.consoleFile).isDirectory(), true);
      assert.equal(fs.readFileSync(path.join(server.consoleFile, "kept.txt"), "utf8"), "kept\n");
    }

    assert.deepEqual(
      problems().map((entry) => [entry.level, entry.message, entry.meta.serverId]),
      [["warn", "A server was started without a console that outlasts the dashboard", SERVER_ID]]
    );
    assert.match(problems()[0].meta.reason, situation.reason);
    assert.match(
      server.runtimeLog(),
      /^\[[^\]]+\] No console pipe: .+\. Started with a pipe from the dashboard instead\. After a dashboard restart this server can only be stopped by signal\.$/m
    );
    // Its output goes to its log all the same.
    assert.match(server.runtimeLog(), /^fake server ready$/m);

    // The dashboard that started it still has its console, and uses it.
    assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
    assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
    assert.equal(isThere(server.pidFile), false);
    assert.equal(problems().length, 1);
    assert.equal(logs.some((entry) => entry.message === 'Stopping a server: sent "stop" to its console'), true);
  });
}

test("what is found where the pipe was just made is looked at before a server is given it", async (t) => {
  // A stand-in for mkfifo that leaves something else at the path, as a mod
  // would have to between the pipe being made and being opened.
  const swaps = [
    ["a link to a file somewhere else", (elsewhere) => `ln -s "${elsewhere}" "$3"`, /^the pipe could not be opened: a link is in its place$/],
    ["a regular file", () => `echo "not a pipe" > "$3"`, /^the pipe could not be opened: what was opened there is not a named pipe$/]
  ];
  for (const [label, command, reason] of swaps) {
    const server = await createServerRoot(t);
    const elsewhere = path.join(server.root, "elsewhere.txt");
    fs.writeFileSync(elsewhere, "nobody reads or writes here\n");
    const program = path.join(server.root, "swapping-mkfifo");
    fs.writeFileSync(program, `#!/bin/sh\n${command(elsewhere)}\n`, { mode: 0o755 });
    const { problems, serverManager } = await createManager(server.root, { mkfifoCommand: program });

    const started = await serverManager.startServer(SERVER_ID, OWNER);
    await server.whenReady();
    assert.equal(started.running, true, label);
    // It was not handed that for a console, and the record does not say it has one.
    assert.equal("console" in server.pidInfo(), false, label);
    assert.deepEqual(problems().map((entry) => entry.message), ["A server was started without a console that outlasts the dashboard"], label);
    assert.match(problems()[0].meta.reason, reason, label);
    await sleep(200);
    assert.deepEqual(server.received(), [], label);
    assert.equal(fs.readFileSync(elsewhere, "utf8"), "nobody reads or writes here\n", label);

    assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"), label);
    assert.deepEqual(server.received(), ["console: stop", "exit: stop"], label);
    assert.equal(fs.readFileSync(elsewhere, "utf8"), "nobody reads or writes here\n", label);
  }
});

test("a server started without a pipe loses its console with the dashboard, keeps its log, and is stopped by signal", async (t) => {
  const server = await createServerRoot(t);
  const dashboard = await startFromAnotherProcess(t, server.root, { mkfifoCommand: path.join(server.root, "no-such-program") });
  const pid = await server.whenReady();
  assert.equal(isThere(server.consoleFile), false);

  await dashboard.end();
  // Its console was a pipe from the process that has just gone.
  await waitFor(() => server.received().includes("console: closed"), "the server's console to close");
  assert.equal(isAlive(pid), true);
  // Its output never went through that process, and still arrives.
  const ticks = server.ticks();
  await waitFor(() => server.ticks() >= ticks + 5, "the server's output to go on reaching its log");

  const later = await createManager(server.root);
  assert.equal((await later.serverManager.getServerStatus(SERVER_ID)).pid, pid);
  assert.deepEqual(settled(await later.serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGTERM"));
  assert.deepEqual(server.received(), ["console: closed", "signal: SIGTERM", "exit: SIGTERM"]);
  assert.deepEqual(
    later.problems().map((entry) => entry.message),
    ['Server has no console the dashboard can reach: sent SIGTERM instead of "stop"']
  );
});
