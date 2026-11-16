const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  OWNER,
  QUICK_WAITS,
  SERVER_ID,
  STOPPED,
  createManager,
  createServerRoot,
  isAlive,
  isThere,
  plantPipe,
  sleep,
  startLegacyServer,
  unlessItHangs,
  waitFor,
  whatArrived
} = require("../test-support/game-server");

// --- what is believed of a pid file, and of a runtime log ------------------------------------------

test("a pid file that does not hold a game server's pid is never signalled", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);
  fs.mkdirSync(server.runtimeDir, { recursive: true });

  // A process of this account that has nothing to do with the dashboard, in a
  // group of its own: a signal to "minus its pid" would reach it too.
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  t.after(() => bystander.kill("SIGKILL"));
  const stillThere = () => bystander.exitCode === null && bystander.signalCode === null;

  // Every signal this process sends from here on, and every look at whether a
  // process is there. Only the bystander is really reached.
  const realKill = process.kill;
  const sent = [];
  process.kill = (pid, signal) => {
    sent.push([pid, signal]);
    if (pid === bystander.pid) {
      return realKill.call(process, pid, signal);
    }
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  };
  t.after(() => {
    process.kill = realKill;
  });

  const elsewhere = path.join(server.root, "a-real-record.json");
  const believable = `${JSON.stringify({ pid: bystander.pid, startedAt: "2026-11-16T09:00:00.000Z", startedBy: "owner" }, null, 2)}\n`;
  fs.writeFileSync(elsewhere, believable);
  const write = (contents) => () => fs.writeFileSync(server.pidFile, contents);
  const records = [
    ["a pid written as text", write(JSON.stringify({ pid: String(bystander.pid) }))],
    ["a pid with a fraction", write(`{"pid": ${bystander.pid}.5}`)],
    ["a negative pid, which is a whole process group", write(JSON.stringify({ pid: -bystander.pid }))],
    ["pid 1, which is init", write(JSON.stringify({ pid: 1 }))],
    ["pid 0, which is the dashboard's own process group", write(JSON.stringify({ pid: 0 }))],
    ["pid -1, which is every process of the account", write(JSON.stringify({ pid: -1 }))],
    ["the dashboard's own pid", write(JSON.stringify({ pid: process.pid }))],
    ["a pid past the largest there is", write(JSON.stringify({ pid: bystander.pid + 2 ** 32 }))],
    ["a pid that is true", write(JSON.stringify({ pid: true }))],
    ["no pid", write(JSON.stringify({ startedBy: "owner" }))],
    ["a list", write(JSON.stringify([bystander.pid]))],
    ["a bare number", write(String(bystander.pid))],
    ["not JSON", write(`pid=${bystander.pid}`)],
    ["nothing", write("")],
    ["a real record with a megabyte after it", write(`${believable}${" ".repeat(1024 * 1024)}`)],
    ["a link to a real record somewhere else", () => fs.symlinkSync(elsewhere, server.pidFile)],
    ["a named pipe", () => plantPipe(server.pidFile)],
    [
      "a named pipe with a real record waiting in it",
      () => {
        plantPipe(server.pidFile);
        const writer = fs.openSync(server.pidFile, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        t.after(() => fs.closeSync(writer));
        fs.writeSync(writer, believable);
      }
    ]
  ];

  for (const [label, plant] of records) {
    plant();
    const answers = await unlessItHangs(
      (async () => [await serverManager.getServerStatus(SERVER_ID), await serverManager.stopServer(SERVER_ID, OWNER)])()
    );
    assert.deepEqual(answers, [STOPPED, STOPPED], label);
    // Not signalled, and not so much as looked for.
    assert.deepEqual(sent, [], label);
    assert.equal(stillThere(), true, label);
    // What cannot be believed is cleared away, without following it.
    assert.equal(isThere(server.pidFile), false, label);
    assert.equal(fs.readFileSync(elsewhere, "utf8"), believable, label);
  }

  // A folder cannot be cleared away. It is still no server.
  fs.mkdirSync(server.pidFile);
  assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), STOPPED);
  assert.deepEqual(sent, []);
  fs.rmdirSync(server.pidFile);
  assert.deepEqual(problems(), []);

  // The same record as a file of its own is believed - so every refusal
  // above was of what the file held, not of the process it named.
  fs.writeFileSync(server.pidFile, believable);
  const found = await serverManager.getServerStatus(SERVER_ID);
  assert.deepEqual(found, { pid: bystander.pid, running: true, startedAt: "2026-11-16T09:00:00.000Z", startedBy: "owner", stopping: false, stoppingSince: null });
  assert.deepEqual(sent, [[bystander.pid, 0]]);
  assert.deepEqual(await serverManager.stopServer(SERVER_ID, OWNER), STOPPED);
  assert.equal(bystander.signalCode, "SIGTERM");
  assert.equal(sent.some(([pid, signal]) => pid === bystander.pid && signal === "SIGTERM"), true);
  assert.equal(sent.every(([pid]) => pid === bystander.pid), true);
});

test("a server the dashboard started is known by its process, whatever becomes of its pid file", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);
  const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => bystander.kill("SIGKILL"));
  const started = await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();

  const damage = [
    ["removed", () => fs.unlinkSync(server.pidFile)],
    ["emptied", () => fs.writeFileSync(server.pidFile, "")],
    ["pointed at init", () => fs.writeFileSync(server.pidFile, JSON.stringify({ pid: 1 }))],
    ["pointed at another process", () => fs.writeFileSync(server.pidFile, JSON.stringify({ pid: bystander.pid, startedBy: "someone else" }))]
  ];
  for (const [label, apply] of damage) {
    apply();
    assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), started, label);
    // Start finds it running, and does not put a second one beside it.
    assert.deepEqual(await serverManager.startServer(SERVER_ID, OWNER), started, label);
    assert.equal(server.fakePid(), pid, label);
  }

  // Stop goes to the server, by its own console, and to nothing else - with
  // the record still pointing at the other process.
  await serverManager.stopServer(SERVER_ID, OWNER);
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.equal(isAlive(pid), false);
  assert.equal(bystander.exitCode, null);
  assert.equal(bystander.signalCode, null);
  assert.deepEqual(problems(), []);

  // What is left is a record of a process that is running, written by
  // something else. Clearing up after the server leaves it where it is (it
  // could be a newer start's), and it is believed like any other until it is
  // gone. That much a mod can always arrange; a pid file is all there is to
  // go on for a server this process did not start.
  assert.equal((await serverManager.getServerStatus(SERVER_ID)).pid, bystander.pid);
  fs.unlinkSync(server.pidFile);
  assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), STOPPED);
});

test("two starts at once start one server", async (t) => {
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root);

  const [first, second, third] = await Promise.all([
    serverManager.startServer(SERVER_ID, OWNER),
    serverManager.startServer(SERVER_ID, OWNER),
    serverManager.startServer(SERVER_ID, OWNER)
  ]);
  await server.whenReady();
  await sleep(300);
  // One process, known to all three callers by the same pid.
  assert.equal(first.running, true);
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  assert.equal((server.runtimeLog().match(/^fake server ready$/gm) || []).length, 1);
  assert.equal(server.pidInfo().pid, first.pid);

  assert.deepEqual(await serverManager.stopServer(SERVER_ID, OWNER), STOPPED);
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.deepEqual(problems(), []);
});

test("a start that cannot record the server's pid ends the server again", async (t) => {
  const server = await createServerRoot(t);
  const { logs, serverManager } = await createManager(server.root);
  // A folder with something in it, where the pid file belongs: it cannot be replaced.
  fs.mkdirSync(server.pidFile, { recursive: true });
  fs.writeFileSync(path.join(server.pidFile, "in-the-way"), "");

  await assert.rejects(serverManager.startServer(SERVER_ID, OWNER), {
    message: /^Unable to start DemoServer\. Its process could not be recorded in servers\/DemoServer\/\.rippermoon\/pid\.json \(.+\), so it was ended again\.$/,
    statusCode: 409
  });
  // The process that had been made is gone: not left running where no later
  // dashboard would find it.
  const exited = await waitFor(() => logs.find((entry) => entry.message === "Server process exited"), "the server to have been ended");
  assert.equal(exited.meta.signal, "SIGKILL");
  assert.equal(isAlive(exited.meta.pid), false);
  assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), STOPPED);
  await waitFor(() => !isThere(server.consoleFile), "its console to be removed");
  assert.deepEqual(fs.readdirSync(server.runtimeDir).sort(), ["pid.json", "runtime.log"]);
  assert.match(server.runtimeLog(), /^\[[^\]]+\] Start failed: Unable to start DemoServer\. Its process could not be recorded/m);
});

test("clearing up after a server that has gone leaves a newer record alone", async (t) => {
  const server = await createServerRoot(t);
  const { serverManager } = await createManager(server.root);
  await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();

  // As if a dashboard started later had started the server afresh while this
  // one was still clearing up after the old process: a record of another
  // process that is running, with the console that goes with it.
  const newer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  t.after(() => newer.kill("SIGKILL"));
  const record = `${JSON.stringify({ console: "fifo", pid: newer.pid, startedAt: "2026-11-16T09:00:00.000Z", startedBy: "owner" }, null, 2)}\n`;
  fs.writeFileSync(server.pidFile, record);

  process.kill(pid, "SIGKILL");
  await waitFor(() => /^\[[^\]]+\] Process was ended by SIGKILL$/m.test(server.runtimeLog()), "the old process to be cleared up after");
  await sleep(150);
  assert.equal(fs.readFileSync(server.pidFile, "utf8"), record);
  assert.equal(fs.lstatSync(server.consoleFile).isFIFO(), true);
  assert.equal((await serverManager.getServerStatus(SERVER_ID)).pid, newer.pid);
});

test("a pid file is replaced when a server starts, never written through", async (t) => {
  const server = await createServerRoot(t);
  const { serverManager } = await createManager(server.root);
  const elsewhere = path.join(server.root, "elsewhere.txt");
  fs.writeFileSync(elsewhere, "nobody writes here\n");
  fs.mkdirSync(server.runtimeDir, { recursive: true });
  fs.symlinkSync(elsewhere, server.pidFile);

  const started = await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();
  assert.equal(started.running, true);
  assert.equal(fs.lstatSync(server.pidFile).isFile(), true);
  assert.equal(server.pidInfo().pid, started.pid);
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "nobody writes here\n");
  // Nothing but the record, the console and the log is left in the folder.
  assert.deepEqual(fs.readdirSync(server.runtimeDir).sort(), ["console", "pid.json", "runtime.log"]);

  assert.deepEqual(await serverManager.stopServer(SERVER_ID, OWNER), STOPPED);
  assert.deepEqual(fs.readdirSync(server.runtimeDir), ["runtime.log"]);

  // That link was found and cleared before the server was started. This one
  // turns up later, once the start is under way: a stand-in for mkfifo makes
  // the pipe and then leaves it, as a mod would have to in that moment.
  const program = path.join(server.root, "planting-mkfifo");
  fs.writeFileSync(program, `#!/bin/sh\nmkfifo "$@" && ln -s "${elsewhere}" "${server.pidFile}"\n`, { mode: 0o755 });
  const later = await createManager(server.root, { mkfifoCommand: program });
  fs.rmSync(path.join(server.serverDir, "fake-server.pid"));

  const again = await later.serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();
  assert.equal(again.running, true);
  assert.equal(fs.lstatSync(server.pidFile).isFile(), true);
  assert.deepEqual(server.pidInfo(), { console: "fifo", pid: again.pid, startedAt: again.startedAt, startedBy: "owner" });
  assert.equal(fs.readFileSync(elsewhere, "utf8"), "nobody writes here\n");
  assert.deepEqual(fs.readdirSync(server.runtimeDir).sort(), ["console", "pid.json", "runtime.log"]);
  assert.deepEqual(await later.serverManager.stopServer(SERVER_ID, OWNER), STOPPED);
  assert.deepEqual(later.problems(), []);
});

test("a runtime log that is not a file of its own is not written through, and the server is not started on it", async (t) => {
  const server = await createServerRoot(t);
  const elsewhere = path.join(server.root, "elsewhere.txt");
  const logFile = path.join(server.runtimeDir, "runtime.log");
  const plants = [
    [
      "a link to a file somewhere else",
      () => {
        fs.symlinkSync(elsewhere, logFile);
      },
      /cannot be written to: a link is in its place\.$/
    ],
    [
      "a folder",
      () => {
        fs.mkdirSync(logFile);
      },
      /cannot be written to: a folder is in its place\.$/
    ],
    [
      "a named pipe that nothing reads",
      () => {
        plantPipe(logFile);
      },
      /cannot be written to: a pipe that nothing reads is in its place\.$/
    ],
    [
      "a named pipe that something reads",
      () => {
        plantPipe(logFile);
        const reader = fs.openSync(logFile, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
        t.after(() => fs.closeSync(reader));
        return reader;
      },
      /cannot be written to: it is not a regular file\.$/
    ]
  ];

  for (const [label, plant, message] of plants) {
    fs.writeFileSync(elsewhere, "nobody writes here\n");
    fs.rmSync(server.runtimeDir, { force: true, recursive: true });
    fs.mkdirSync(server.runtimeDir, { recursive: true });
    const reader = plant();
    const { problems, serverManager } = await createManager(server.root);

    const refused = await unlessItHangs(
      serverManager.startServer(SERVER_ID, OWNER).then(
        () => "it started",
        (error) => error
      )
    );
    assert.match(String(refused.message || refused), message, label);
    assert.equal(refused.statusCode, 409, label);
    assert.match(refused.message, /^Unable to start DemoServer\. Its runtime log, servers\/DemoServer\/\.rippermoon\/runtime\.log, /, label);

    assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), { ...STOPPED }, label);
    assert.equal(server.fakePid(), null, label);
    assert.equal(fs.readFileSync(elsewhere, "utf8"), "nobody writes here\n", label);
    if (reader !== undefined) {
      // Not a line of the dashboard's own went into the pipe either.
      assert.equal(whatArrived(reader), "", label);
    }
    // No pipe is left behind for a server that never ran.
    assert.equal(isThere(server.consoleFile), false, label);
    assert.equal(isThere(server.pidFile), false, label);
    assert.equal(problems().every((entry) => entry.message === "Could not write to a server's runtime log"), true, label);
    assert.ok(problems().length > 0, label);
  }
});

test("only the exact marker in a pid file says that a server has a console", async (t) => {
  // A pipe where a console would be, with something reading it, so that
  // whatever the dashboard writes there can be seen.
  const consoleWithAReader = (server) => {
    plantPipe(server.consoleFile);
    const reader = fs.openSync(server.consoleFile, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
    t.after(() => fs.closeSync(reader));
    return () => whatArrived(reader);
  };
  const stopWaits = { ...QUICK_WAITS, console: 250 };

  for (const marker of [true, 1, "FIFO", "fifo ", ["fifo"], { fifo: true }, "pipe", null]) {
    const server = await createServerRoot(t);
    const { problems, serverManager } = await createManager(server.root, { stopWaits });
    const legacy = startLegacyServer(t, server);
    await server.whenReady();
    fs.writeFileSync(server.pidFile, JSON.stringify({ console: marker, pid: legacy.pid, startedAt: "2026-11-16T09:00:00.000Z", startedBy: "owner" }));
    const arrived = consoleWithAReader(server);

    assert.deepEqual(await serverManager.stopServer(SERVER_ID, OWNER), STOPPED, JSON.stringify(marker));
    // Nothing was written to the pipe: the record does not say it is a console.
    assert.equal(arrived(), "", JSON.stringify(marker));
    assert.equal(server.received().includes("signal: SIGTERM"), true, JSON.stringify(marker));
    assert.deepEqual(
      problems().map((entry) => [entry.message, entry.meta.reason]),
      [['Server has no console the dashboard can reach: sent SIGTERM instead of "stop"', "it was started without one that outlasts the dashboard"]],
      JSON.stringify(marker)
    );
  }

  // With the marker as the dashboard writes it, the same pipe is written to.
  const server = await createServerRoot(t);
  const { problems, serverManager } = await createManager(server.root, { stopWaits });
  const legacy = startLegacyServer(t, server);
  await server.whenReady();
  fs.writeFileSync(server.pidFile, JSON.stringify({ console: "fifo", pid: legacy.pid, startedAt: "2026-11-16T09:00:00.000Z", startedBy: "owner" }));
  const arrived = consoleWithAReader(server);

  assert.deepEqual(await serverManager.stopServer(SERVER_ID, OWNER), STOPPED);
  assert.equal(arrived(), "stop\n");
  // This server was never listening there, so the wait ran out and a signal followed.
  assert.deepEqual(
    problems().map((entry) => entry.message),
    ['Server did not exit after "stop" on its console: sent SIGTERM']
  );
});
