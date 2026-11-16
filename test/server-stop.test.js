const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_STOP_WAITS,
  OWNER,
  QUICK_WAITS,
  SERVER_ID,
  STOPPED,
  createManager,
  createServerRoot,
  isAlive,
  isThere,
  procStarted,
  settled,
  sleep,
  startLegacyServer,
  stoppedBy,
  waitFor
} = require("../test-support/game-server");

// Fails the test if anything in this process throws where nobody catches it:
// a stop runs on after the request that began it has been answered.
function watchForUncaught(t) {
  const seen = [];
  const record = (error) => seen.push(error && (error.stack || error.message || String(error)));
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  t.after(() => {
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
  });
  return seen;
}

// --- patience --------------------------------------------------------------------------------

test("a dashboard that is told nothing else waits three minutes, then one, or four without a console", async (t) => {
  // The numbers themselves. Every other test here shortens them, so nothing
  // else would notice if they went back to the 20 seconds that cost a world.
  assert.deepEqual({ ...DEFAULT_STOP_WAITS }, { console: 180_000, kill: 10_000, poll: 1_000, signalOnly: 240_000, term: 60_000 });
  assert.equal(Object.isFrozen(DEFAULT_STOP_WAITS), true);

  // A manager made the way the dashboard makes it, with no waits of its own, uses them.
  const server = await createServerRoot(t);
  const asDeployed = await createManager(server.root, { stopWaits: undefined });
  assert.deepEqual(asDeployed.serverManager.stopWaits, DEFAULT_STOP_WAITS);
  // A test's waits replace the ones it names and no others.
  const shortened = await createManager(server.root, { stopWaits: { console: 5 } });
  assert.deepEqual(shortened.serverManager.stopWaits, { ...DEFAULT_STOP_WAITS, console: 5 });
  assert.equal(Object.isFrozen(asDeployed.serverManager.stopWaits), true);

  // And the dashboard is told nothing: the program that starts it names no
  // waits, and the app hands on only what it was given.
  const source = (file) => fs.readFileSync(path.join(__dirname, "..", "src", file), "utf8");
  assert.doesNotMatch(source("server.js"), /stopWaits/);
  assert.deepEqual(source("app.js").match(/stopWaits[^\n]*/g), ["stopWaits shortens", "stopWaits: options.stopWaits"]);
});

test("a server that is slow to save is waited for, not signalled", async (t) => {
  const server = await createServerRoot(t, { onStop: "wait" });
  // Every other wait is far too short for this server; the one after "stop" is not.
  const { problems, serverManager } = await createManager(server.root, {
    stopWaits: { ...QUICK_WAITS, console: 60_000, signalOnly: 50, term: 50 }
  });
  await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();

  const stopping = serverManager.stopServer(SERVER_ID, OWNER);
  await waitFor(() => server.received().length > 0, "the server to be told to stop");
  // Long past the moment a test's own waits would have run out.
  await sleep(400);
  assert.deepEqual(server.received(), ["console: stop"]);
  assert.equal((await serverManager.getServerStatus(SERVER_ID)).stopping, true);

  server.release();
  assert.deepEqual(settled(await stopping), stoppedBy("console"));
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.deepEqual(problems(), []);
});

test("a server that saves on SIGTERM is waited for in its turn, not killed", async (t) => {
  const server = await createServerRoot(t, { onStop: "ignore", onTerm: "wait" });
  // The wait after "stop" is over at once; the one after SIGTERM is not.
  const { problems, serverManager } = await createManager(server.root, {
    stopWaits: { ...QUICK_WAITS, console: 100, signalOnly: 50, term: 60_000 }
  });
  await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();

  const stopping = serverManager.stopServer(SERVER_ID, OWNER);
  await waitFor(() => server.received().includes("signal: SIGTERM"), "the server to be sent SIGTERM");
  await sleep(400);
  assert.equal(isAlive(pid), true);
  assert.deepEqual(server.received(), ["console: stop", "signal: SIGTERM"]);
  assert.deepEqual(
    problems().map((entry) => entry.message),
    ['Server did not exit after "stop" on its console: sent SIGTERM']
  );

  server.release();
  assert.deepEqual(settled(await stopping), stoppedBy("SIGTERM"));
  assert.deepEqual(server.received(), ["console: stop", "signal: SIGTERM", "exit: SIGTERM"]);
  assert.equal(problems().length, 1);
  assert.doesNotMatch(server.runtimeLog(), /SIGKILL/);
});

for (const who of ["the dashboard that started it", "a dashboard started later"]) {
  test(`a server that ignores "stop" is sent SIGTERM after the wait, by ${who}`, async (t) => {
    const server = await createServerRoot(t, { onStop: "ignore" });
    const stopWaits = { ...QUICK_WAITS, console: 250 };
    let dashboard = await createManager(server.root, { stopWaits });
    await dashboard.serverManager.startServer(SERVER_ID, OWNER);
    const pid = await server.whenReady();
    if (who !== "the dashboard that started it") {
      dashboard = await createManager(server.root, { stopWaits });
    }

    assert.deepEqual(settled(await dashboard.serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGTERM"));
    assert.deepEqual(server.received(), ["console: stop", "signal: SIGTERM", "exit: SIGTERM"]);
    assert.equal(isThere(server.pidFile), false);
    assert.equal(isThere(server.consoleFile), false);

    // One step past the first, said once, at WARN: which server, what was
    // sent, and how long it had been given.
    const problems = dashboard.problems();
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.equal(problems[0].level, "warn");
    assert.equal(problems[0].message, 'Server did not exit after "stop" on its console: sent SIGTERM');
    assert.deepEqual(Object.keys(problems[0].meta).sort(), ["pid", "server", "serverId", "waitedSeconds"]);
    assert.equal(problems[0].meta.pid, pid);
    assert.equal(problems[0].meta.server, SERVER_ID);
    assert.equal(problems[0].meta.serverId, SERVER_ID);
    assert.equal(typeof problems[0].meta.waitedSeconds, "number");
    assert.match(server.runtimeLog(), /^\[[^\]]+\] No exit \d+ s after "stop" on the console: sent SIGTERM$/m);
    assert.doesNotMatch(server.runtimeLog(), /SIGKILL/);
  });

  test(`a server that ignores "stop" and SIGTERM is killed last of all, by ${who}, and the logs say what that costs`, async (t) => {
    const server = await createServerRoot(t, { onStop: "ignore", onTerm: "ignore" });
    const stopWaits = { ...QUICK_WAITS, console: 200, term: 200 };
    let dashboard = await createManager(server.root, { stopWaits });
    await dashboard.serverManager.startServer(SERVER_ID, OWNER);
    const pid = await server.whenReady();
    if (who !== "the dashboard that started it") {
      dashboard = await createManager(server.root, { stopWaits });
    }

    // Stopped, and the status says what it took: the page must not call this a success.
    assert.deepEqual(settled(await dashboard.serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGKILL"));
    assert.deepEqual(
      dashboard.logs.filter((entry) => entry.message === "Server stopped").map((entry) => [entry.meta.how, entry.meta.pid, entry.meta.serverId]),
      [["SIGKILL", pid, SERVER_ID]]
    );
    // It heard both, and was given no chance to say goodbye.
    assert.deepEqual(server.received(), ["console: stop", "signal: SIGTERM"]);
    assert.equal(isAlive(pid), false);
    assert.equal(isThere(server.pidFile), false);
    assert.equal(isThere(server.consoleFile), false);

    assert.deepEqual(
      dashboard.problems().map((entry) => [entry.level, entry.message]),
      [
        ["warn", 'Server did not exit after "stop" on its console: sent SIGTERM'],
        ["warn", "Server did not exit after SIGTERM: sent SIGKILL. The world may not have been saved."]
      ]
    );
    const killed = dashboard.problems()[1].meta;
    assert.deepEqual([killed.pid, killed.server, killed.serverId, typeof killed.waitedSeconds], [pid, SERVER_ID, SERVER_ID, "number"]);
    const log = server.runtimeLog();
    assert.match(log, /^\[[^\]]+\] No exit \d+ s after "stop" on the console: sent SIGTERM$/m);
    assert.match(log, /^\[[^\]]+\] No exit \d+ s after the stop began: sent SIGKILL\. The world may not have been saved\.$/m);
    assert.ok(log.indexOf("sent SIGTERM") < log.indexOf("sent SIGKILL"));
  });
}

// --- a start script that does not hand over to the server -------------------------------------------

// A start script that does not end in `exec`: it stays, as a shell, and the
// server is its child. The pid the dashboard has is the shell's.
function behindAStartScript(server) {
  fs.writeFileSync(path.join(server.serverDir, "run.sh"), "#!/usr/bin/env sh\n./fake-server.js\n", { mode: 0o755 });
  return { startCommand: "./run.sh" };
}

test("a signal goes to the server behind a start script as well, and the server is not called stopped while it runs", async (t) => {
  const server = await createServerRoot(t, { onStop: "ignore", onTerm: "wait" });
  const { problems, serverManager } = await createManager(server.root, { stopWaits: { ...QUICK_WAITS, console: 200, term: 60_000 } });
  await serverManager.setServerMetadata(SERVER_ID, behindAStartScript(server));
  const started = await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();
  assert.notEqual(started.pid, pid);
  // The script is the leader of a group of its own, and the server is in it.
  if (fs.existsSync(`/proc/${pid}/stat`)) {
    const groupOf = (id) => Number(fs.readFileSync(`/proc/${id}/stat`, "utf8").split(") ")[1].split(" ")[2]);
    assert.equal(groupOf(started.pid), started.pid);
    assert.equal(groupOf(pid), started.pid);
  }

  const stopping = serverManager.stopServer(SERVER_ID, OWNER);
  // It ignores "stop", so SIGTERM follows: to the script, which it ends, and
  // to the server, which takes it as its cue to save.
  await waitFor(() => server.received().includes("signal: SIGTERM"), "the server itself to be sent SIGTERM");
  await waitFor(() => !isAlive(started.pid), "the start script to have gone");
  await sleep(300);
  assert.equal(isAlive(pid), true);

  // The script has gone and the server has not: it is running, and stopping,
  // and nothing is cleared away or started beside it.
  // The status says that this is what is left of what was started: one
  // process, the server.
  const status = await serverManager.getServerStatus(SERVER_ID);
  assert.deepEqual({ ...status, stoppingSince: null }, { ...started, leftover: { count: 1 }, stopping: true });
  await assert.rejects(serverManager.startServer(SERVER_ID, OWNER), { message: /still stopping/, statusCode: 409 });
  assert.equal(isThere(server.pidFile), true);
  assert.equal(isThere(server.consoleFile), true);
  assert.equal(server.fakePid(), pid);

  server.release();
  assert.deepEqual(settled(await stopping), stoppedBy("SIGTERM"));
  assert.deepEqual(server.received(), ["console: stop", "signal: SIGTERM", "exit: SIGTERM"]);
  assert.equal(isAlive(pid), false);
  assert.equal(isThere(server.pidFile), false);
  assert.equal(isThere(server.consoleFile), false);
  // One server from first to last.
  assert.equal((server.runtimeLog().match(/^fake server ready$/gm) || []).length, 1);
  assert.deepEqual(
    problems().map((entry) => entry.message),
    [
      'Server did not exit after "stop" on its console: sent SIGTERM',
      "The process that started a server has exited, and others it started run on: the server counts as running"
    ]
  );
  const log = server.runtimeLog();
  assert.match(log, /^\[[^\]]+\] Process (was ended by SIGTERM|exited with code \d+)\. Others it started are still running: the server counts as running until they have gone\.$/m);
  assert.match(log, /^\[[^\]]+\] The last of the server's processes has gone$/m);
});

test("a server behind a start script that ignores everything is killed along with the script", async (t) => {
  const server = await createServerRoot(t, { onStop: "ignore", onTerm: "ignore" });
  const { problems, serverManager } = await createManager(server.root, { stopWaits: { ...QUICK_WAITS, console: 200, term: 300 } });
  await serverManager.setServerMetadata(SERVER_ID, behindAStartScript(server));
  const started = await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();

  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGKILL"));
  assert.deepEqual(server.received(), ["console: stop", "signal: SIGTERM"]);
  assert.equal(isAlive(pid), false);
  assert.equal(isAlive(started.pid), false);
  assert.equal(isThere(server.pidFile), false);
  assert.equal(isThere(server.consoleFile), false);
  assert.deepEqual(
    problems()
      .map((entry) => entry.message)
      .filter((message) => /sent SIG/.test(message)),
    [
      'Server did not exit after "stop" on its console: sent SIGTERM',
      "Server did not exit after SIGTERM: sent SIGKILL. The world may not have been saved."
    ]
  );

  // Gone, so it can be started again: one server, not two.
  fs.rmSync(path.join(server.serverDir, "fake-server.pid"));
  const again = await serverManager.startServer(SERVER_ID, OWNER);
  const second = await server.whenReady();
  assert.equal(again.running, true);
  // A new run: how the last one ended is not said of this one.
  assert.equal(again.lastStop, null);
  assert.notEqual(second, pid);
  assert.equal(isAlive(pid), false);
  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGKILL"));
  assert.equal(isAlive(second), false);
});

for (const who of ["the dashboard that started it", "a dashboard started later"]) {
  test(`a server whose start script has gone is still running, as far as ${who} is concerned, and is stopped through its console`, async (t) => {
    const server = await createServerRoot(t);
    let dashboard = await createManager(server.root);
    await dashboard.serverManager.setServerMetadata(SERVER_ID, behindAStartScript(server));
    const started = await dashboard.serverManager.startServer(SERVER_ID, OWNER);
    const pid = await server.whenReady();

    // The script goes, on its own. The server it started does not.
    process.kill(started.pid, "SIGKILL");
    await waitFor(() => !isAlive(started.pid), "the start script to have gone");
    await sleep(200);
    assert.equal(isAlive(pid), true);
    if (who !== "the dashboard that started it") {
      dashboard = await createManager(server.root);
    }
    const manager = dashboard.serverManager;

    // Running, and marked as what is left of what was started: the process
    // on record has exited, and one that it started has not.
    assert.deepEqual(await manager.getServerStatus(SERVER_ID), { ...started, leftover: { count: 1 } });
    // Start puts no second one beside it, and says why not.
    await assert.rejects(manager.startServer(SERVER_ID, OWNER), {
      message:
        "DemoServer cannot be started yet. The process it was started as has exited, but 1 process that it started is still running, and may be using its world. Stop the server to end it, then start it again.",
      statusCode: 409
    });
    assert.equal(server.fakePid(), pid);
    assert.equal(isThere(server.pidFile), true);
    assert.equal((server.runtimeLog().match(/^fake server ready$/gm) || []).length, 1);

    assert.deepEqual(settled(await manager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
    assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
    assert.equal(isAlive(pid), false);
    assert.equal(isThere(server.pidFile), false);
    assert.equal(isThere(server.consoleFile), false);
    assert.equal((server.runtimeLog().match(/^fake server ready$/gm) || []).length, 1);
  });
}

// --- what a start script leaves running beside the server -------------------------------------------

// A start script that starts something else as well - a tunnel, a watcher -
// and then hands over to the server. The server is the process on record;
// the other thing is in its group, and has no console.
function besideAHelper(server) {
  fs.writeFileSync(
    path.join(server.serverDir, "run.sh"),
    `#!/bin/sh\n"${process.execPath}" -e "setTimeout(() => {}, 60000)" &\nexec ./fake-server.js\n`,
    { mode: 0o755 }
  );
  return { startCommand: "./run.sh" };
}

function groupIsThere(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const who of ["the dashboard that started it", "a dashboard started later"]) {
  test(`a server that has gone, with something its start script started still running, is said to be so by ${who}, is not started beside it, and is cleared by Stop`, async (t) => {
    const server = await createServerRoot(t);
    let dashboard = await createManager(server.root);
    await dashboard.serverManager.setServerMetadata(SERVER_ID, besideAHelper(server));
    const started = await dashboard.serverManager.startServer(SERVER_ID, OWNER);
    const pid = await server.whenReady();
    assert.equal(started.pid, pid);
    t.after(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // Gone already.
      }
    });

    // The server crashes, or is stopped from inside the game.
    process.kill(pid, "SIGKILL");
    await waitFor(() => !isAlive(pid), "the server to have gone");
    await sleep(200);
    assert.equal(groupIsThere(pid), true);
    if (who !== "the dashboard that started it") {
      dashboard = await createManager(server.root);
    }
    const manager = dashboard.serverManager;

    // Still counted as running - what is left may be using the world - and
    // marked as what it is: the process on record has exited, and one that
    // it started has not. Where that cannot be counted the count is null.
    const counted = procStarted(process.pid) === null ? null : 1;
    assert.deepEqual(await manager.getServerStatus(SERVER_ID), { ...started, leftover: { count: counted } });

    // Start does not answer "it is running" and do nothing: it says why not.
    fs.rmSync(path.join(server.serverDir, "fake-server.pid"));
    await assert.rejects(manager.startServer(SERVER_ID, OWNER), {
      message: /^DemoServer cannot be started yet\. The process it was started as has exited, but (1 process that it started is|processes that it started are) still running, and may be using its world\. Stop the server to end (it|them), then start it again\.$/,
      statusCode: 409
    });
    await sleep(300);
    assert.equal(server.fakePid(), null);
    assert.equal(isThere(server.pidFile), true);

    // Stop ends what is left. Nothing reads the console any more, so it is
    // signalled at once.
    const began = Date.now();
    assert.deepEqual(settled(await manager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGTERM"));
    assert.ok(Date.now() - began < 5000, `the stop took ${Date.now() - began} ms`);
    assert.equal(groupIsThere(pid), false);
    assert.equal(isThere(server.pidFile), false);
    assert.equal(isThere(server.consoleFile), false);

    // And then it is started again, a server like any other.
    const again = await manager.startServer(SERVER_ID, OWNER);
    const second = await server.whenReady();
    assert.deepEqual([again.running, again.pid, again.leftover], [true, second, null]);
    t.after(() => {
      try {
        process.kill(-second, "SIGKILL");
      } catch {
        // Gone already.
      }
    });

    // Stopped the ordinary way, the server takes "stop" and exits, and what
    // its script started beside it is ended there and then: not after the
    // minutes a server is given to save. It counts as a stop by the console.
    const stopBegan = Date.now();
    assert.deepEqual(settled(await manager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
    assert.ok(Date.now() - stopBegan < 5000, `the stop took ${Date.now() - stopBegan} ms`);
    assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
    assert.equal(groupIsThere(second), false);
    assert.match(
      server.runtimeLog(),
      /^\[[^\]]+\] The process the server was started as has exited, \d+ s after "stop"\. (1 process that it started is|processes that it started are) still running: sent SIGTERM to end (it|them)$/m
    );
    // No warning for it: nothing went wrong.
    assert.deepEqual(
      dashboard.problems().map((entry) => entry.message).filter((message) => /SIGTERM|SIGKILL/.test(message)),
      ['Server has no console the dashboard can reach: sent SIGTERM instead of "stop"']
    );
  });
}

// --- a server with no console ----------------------------------------------------------------

test("a server on record without a console is stopped by signal, and given as long", async (t) => {
  const server = await createServerRoot(t, { onTerm: "wait" });
  // The wait before SIGKILL that a server with a console gets is far too
  // short here; the one for a server without is not.
  const { problems, serverManager } = await createManager(server.root, {
    stopWaits: { ...QUICK_WAITS, console: 50, signalOnly: 60_000, term: 50 }
  });
  const legacy = startLegacyServer(t, server);
  const pid = await server.whenReady();
  assert.equal(pid, legacy.pid);
  await waitFor(() => server.received().includes("console: closed"), "the server to find its console closed");

  const found = await serverManager.getServerStatus(SERVER_ID);
  assert.deepEqual(found, { ...STOPPED, pid, running: true, startedAt: "2026-11-16T09:00:00.000Z", startedBy: "owner" });

  const stopping = serverManager.stopServer(SERVER_ID, OWNER);
  await waitFor(() => server.received().includes("signal: SIGTERM"), "the server to be sent SIGTERM");
  await sleep(400);
  // Still saving, and left to.
  assert.equal(legacy.exitCode, null);
  assert.equal(legacy.signalCode, null);
  assert.deepEqual(server.received(), ["console: closed", "signal: SIGTERM"]);
  assert.deepEqual(
    problems().map((entry) => [entry.level, entry.message, entry.meta.pid, entry.meta.server]),
    [["warn", 'Server has no console the dashboard can reach: sent SIGTERM instead of "stop"', pid, SERVER_ID]]
  );
  assert.match(problems()[0].meta.reason, /started without one/);

  server.release();
  assert.deepEqual(settled(await stopping), stoppedBy("SIGTERM"));
  assert.deepEqual(server.received(), ["console: closed", "signal: SIGTERM", "exit: SIGTERM"]);
  assert.equal(isThere(server.pidFile), false);
  assert.equal(problems().length, 1);
  const log = server.runtimeLog();
  assert.match(log, /^\[[^\]]+\] Stop requested by owner$/m);
  assert.match(log, /^\[[^\]]+\] No console to send "stop" to \(it was started without one that outlasts the dashboard\): sent SIGTERM$/m);
  assert.doesNotMatch(log, /SIGKILL/);
});

test("a server without a console that ignores SIGTERM is killed, with the same warning", async (t) => {
  const server = await createServerRoot(t, { onTerm: "ignore" });
  const { problems, serverManager } = await createManager(server.root, { stopWaits: { ...QUICK_WAITS, signalOnly: 250 } });
  const legacy = startLegacyServer(t, server);
  await server.whenReady();
  await waitFor(() => server.received().includes("console: closed"), "the server to find its console closed");

  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGKILL"));
  assert.equal(legacy.signalCode, "SIGKILL");
  assert.deepEqual(server.received(), ["console: closed", "signal: SIGTERM"]);
  assert.deepEqual(
    problems().map((entry) => entry.message),
    [
      'Server has no console the dashboard can reach: sent SIGTERM instead of "stop"',
      "Server did not exit after SIGTERM: sent SIGKILL. The world may not have been saved."
    ]
  );
  assert.match(server.runtimeLog(), /sent SIGKILL\. The world may not have been saved\.$/m);
});

// --- one stop at a time, in the background -----------------------------------------------------

test("two stops at once are one stop, and the server is not started again in the middle of it", async (t) => {
  const server = await createServerRoot(t, { onStop: "wait" });
  const { problems, serverManager } = await createManager(server.root);
  const owner = { id: "usr_owner", role: "owner", servers: [], username: "owner" };
  const started = await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();

  const first = serverManager.stopServer(SERVER_ID, OWNER);
  const second = serverManager.stopServer(SERVER_ID, OWNER);
  // Asked for the way a request asks: answered at once, with the server
  // still running and now stopping.
  const answered = await serverManager.requestStop(SERVER_ID, OWNER);
  assert.deepEqual(Object.keys(answered).sort(), ["lastStop", "leftover", "pid", "running", "startedAt", "startedBy", "stopping", "stoppingSince", "unknown"]);
  assert.deepEqual({ ...answered, stoppingSince: null }, { ...started, stopping: true });
  assert.match(answered.stoppingSince, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(answered.stoppingSince) >= Date.parse(started.startedAt));
  // Asking again begins nothing new: it is the same stop, begun when it was.
  assert.deepEqual(await serverManager.requestStop(SERVER_ID, OWNER), answered);

  // Everything that reads the status says so.
  assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), answered);
  assert.deepEqual((await serverManager.listServersForUser(owner))[0].status, answered);
  assert.deepEqual((await serverManager.getServerSnapshot(SERVER_ID, owner, true)).server.status, answered);

  // It is still running, so it is not started, and nothing that needs it
  // stopped goes ahead.
  await assert.rejects(serverManager.startServer(SERVER_ID, OWNER), {
    message: "DemoServer is still stopping. Wait until it has stopped, then start it again.",
    statusCode: 409
  });
  await assert.rejects(serverManager.ensureServerStopped(SERVER_ID), /Stop the server before making this change/);
  await assert.rejects(serverManager.deleteServer(SERVER_ID), /Stop the server before deleting it/);

  await waitFor(() => server.received().length > 0, "the server to be told to stop");
  await sleep(200);
  // Four requests, one "stop".
  assert.deepEqual(server.received(), ["console: stop"]);
  assert.equal((server.runtimeLog().match(/Stop requested/g) || []).length, 1);

  server.release();
  assert.deepEqual((await Promise.all([first, second])).map(settled), [stoppedBy("console"), stoppedBy("console")]);
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.deepEqual(settled(await serverManager.getServerStatus(SERVER_ID)), stoppedBy("console"));
  assert.deepEqual(problems(), []);

  // Stopped, it starts again, and is a server like any other.
  const again = await serverManager.startServer(SERVER_ID, OWNER);
  assert.equal(again.running, true);
  assert.equal(again.stopping, false);
  assert.equal(again.lastStop, null);
  assert.notEqual(again.pid, started.pid);
  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
});

test("how a stop ended is said of that stop only: a server started again and gone by itself has no last stop", async (t) => {
  const server = await createServerRoot(t, { onStop: "ignore", onTerm: "ignore" });
  const { serverManager } = await createManager(server.root, { stopWaits: { ...QUICK_WAITS, console: 100, term: 100 } });
  await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();
  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGKILL"));
  // Asking again changes nothing about it, and neither does a stop of nothing.
  assert.deepEqual(settled(await serverManager.getServerStatus(SERVER_ID)), stoppedBy("SIGKILL"));
  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGKILL"));
  assert.deepEqual(settled(await serverManager.requestStop(SERVER_ID, OWNER)), stoppedBy("SIGKILL"));

  // Started again, it is a running server with nothing said about any stop.
  fs.rmSync(path.join(server.serverDir, "fake-server.pid"));
  const again = await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();
  assert.equal(again.running, true);
  assert.equal(again.lastStop, null);

  // It goes by itself - a crash, as far as the dashboard can tell - and that
  // was not the dashboard's doing: nothing is said to have killed it.
  process.kill(pid, "SIGKILL");
  await waitFor(async () => !(await serverManager.getServerStatus(SERVER_ID)).running, "the server to be found gone");
  assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), STOPPED);
});

test("a server that another dashboard process has started since is not held to this one's last stop of it", async (t) => {
  const server = await createServerRoot(t);
  const first = await createManager(server.root);
  const second = await createManager(server.root);
  await first.serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();
  assert.deepEqual(settled(await first.serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("console"));
  // The other one did not stop it, and says nothing about how it was.
  assert.deepEqual(await second.serverManager.getServerStatus(SERVER_ID), STOPPED);

  // Started by the other one, it is running as far as both can tell.
  fs.rmSync(path.join(server.serverDir, "fake-server.pid"));
  const again = await second.serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();
  assert.deepEqual(await first.serverManager.getServerStatus(SERVER_ID), again);
  assert.equal(again.lastStop, null);

  // It goes by itself. What the first one stopped was the run before this
  // one, and it does not say of this run that it stopped it.
  process.kill(pid, "SIGKILL");
  await waitFor(async () => !(await second.serverManager.getServerStatus(SERVER_ID)).running, "the server to be found gone");
  assert.deepEqual(await second.serverManager.getServerStatus(SERVER_ID), STOPPED);
  assert.deepEqual(await first.serverManager.getServerStatus(SERVER_ID), STOPPED);
});

test("a server that does not come up is not said to have been killed by the stop before it", async (t) => {
  const server = await createServerRoot(t, { onStop: "ignore", onTerm: "ignore" });
  const { serverManager } = await createManager(server.root, { stopWaits: { ...QUICK_WAITS, console: 100, term: 100 } });
  await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();
  assert.deepEqual(settled(await serverManager.stopServer(SERVER_ID, OWNER)), stoppedBy("SIGKILL"));

  // The next start gets as far as a process, which exits at once: as a rule
  // before anybody has seen it running.
  fs.writeFileSync(path.join(server.serverDir, "fake-server.js"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
  await serverManager.startServer(SERVER_ID, OWNER);
  await waitFor(async () => !(await serverManager.getServerStatus(SERVER_ID)).running, "the failed start to be over");
  assert.deepEqual(await serverManager.getServerStatus(SERVER_ID), STOPPED);
  await waitFor(() => /^\[[^\]]+\] Process exited with code 3$/m.test(server.runtimeLog()), "the exit to be written down");
});

test("a look at a server that began just before it went does not take away what its stop sets down", async (t) => {
  const fsp = require("node:fs/promises");
  const server = await createServerRoot(t, { onStop: "wait" });
  const first = await createManager(server.root);
  await first.serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();
  // A dashboard started later: it knows the server by its record, and has to
  // ask the system about the process each time it is asked for the status.
  // The record is one from before it said which server it is of: only such
  // a record is held against the folder its process runs in, and that is
  // the one look into the system that takes any time.
  const { server: omitted, ...older } = server.pidInfo();
  assert.equal(omitted, SERVER_ID);
  fs.writeFileSync(server.pidFile, `${JSON.stringify(older, null, 2)}\n`);
  const { serverManager } = await createManager(server.root);
  assert.equal((await serverManager.requestStop(SERVER_ID, OWNER)).stopping, true);
  await waitFor(() => server.received().includes("console: stop"), "the server to be told to stop");

  // One look is held between finding the process alive and answering. A
  // look resolves the server's folder twice: once on the way to its record,
  // and once more after it has found the recorded process alive, to see
  // where that process runs. The second is the one that is held.
  const realRealpath = fsp.realpath;
  t.after(() => {
    fsp.realpath = realRealpath;
  });
  let letGo;
  const held = new Promise((resolve) => {
    letGo = resolve;
  });
  let reached;
  const holding = new Promise((resolve) => {
    reached = resolve;
  });
  let resolved = 0;
  fsp.realpath = async (target, ...rest) => {
    if (target === server.serverDir) {
      resolved += 1;
      if (resolved === 2) {
        fsp.realpath = realRealpath;
        reached();
        await held;
      }
    }
    return await realRealpath.call(fsp, target, ...rest);
  };
  const early = serverManager.getServerStatus(SERVER_ID);
  await holding;
  assert.equal(isAlive(pid), true);

  // In that time the server goes, and the stop is over.
  server.release();
  await waitFor(() => !isAlive(pid), "the server to have gone");
  await waitFor(async () => (await serverManager.getServerStatus(SERVER_ID)).lastStop !== null, "the stop to be over");
  assert.deepEqual(settled(await serverManager.getServerStatus(SERVER_ID)), stoppedBy("console"));

  // The early look comes back with the server it had found.
  letGo();
  const answered = await early;
  assert.equal(answered.pid, pid);
  // What the stop set down is still there.
  assert.deepEqual(settled(await serverManager.getServerStatus(SERVER_ID)), stoppedBy("console"));
});

test("three stops at once escalate once", async (t) => {
  const server = await createServerRoot(t, { onStop: "ignore" });
  const { problems, serverManager } = await createManager(server.root, { stopWaits: { ...QUICK_WAITS, console: 250 } });
  await serverManager.startServer(SERVER_ID, OWNER);
  await server.whenReady();

  const results = await Promise.all([
    serverManager.stopServer(SERVER_ID, OWNER),
    serverManager.stopServer(SERVER_ID, OWNER),
    serverManager.requestStop(SERVER_ID, OWNER).then(() => serverManager.stopServer(SERVER_ID, OWNER))
  ]);
  assert.deepEqual(results.map(settled), [stoppedBy("SIGTERM"), stoppedBy("SIGTERM"), stoppedBy("SIGTERM")]);
  // One "stop", one SIGTERM, one warning.
  assert.deepEqual(server.received(), ["console: stop", "signal: SIGTERM", "exit: SIGTERM"]);
  assert.deepEqual(
    problems().map((entry) => entry.message),
    ['Server did not exit after "stop" on its console: sent SIGTERM']
  );
});

test("stopping a server that is not running changes nothing and says it is stopped", async (t) => {
  const server = await createServerRoot(t);
  const { logs, serverManager } = await createManager(server.root);

  assert.deepEqual(await serverManager.stopServer(SERVER_ID, OWNER), STOPPED);
  assert.deepEqual(await serverManager.requestStop(SERVER_ID, OWNER), STOPPED);
  assert.deepEqual(logs, []);
  assert.equal(isThere(server.runtimeDir), false);
  await assert.rejects(serverManager.stopServer("NoSuchServer", OWNER), /Server not found/);
  await assert.rejects(serverManager.requestStop("NoSuchServer", OWNER), /Server not found/);
});

test("a stop that fails in the background is logged, and takes nothing down with it", async (t) => {
  const uncaught = watchForUncaught(t);
  const server = await createServerRoot(t);
  const logs = [];
  const { serverManager } = await createManager(server.root, {
    logger: {
      error: (message, meta) => logs.push({ level: "error", message, meta }),
      // Something goes wrong in the middle of the stop, after the request
      // that began it has had its answer.
      info: (message) => {
        if (message.startsWith("Stopping a server")) {
          throw new Error("the disk the log is on has gone");
        }
      },
      warn: (message, meta) => logs.push({ level: "warn", message, meta })
    }
  });
  await serverManager.startServer(SERVER_ID, OWNER);
  const pid = await server.whenReady();

  const answered = await serverManager.requestStop(SERVER_ID, OWNER);
  assert.equal(answered.stopping, true);
  await waitFor(() => logs.length > 0, "the failure to be logged");
  assert.deepEqual(
    logs.map((entry) => [entry.level, entry.message, entry.meta.error, entry.meta.pid, entry.meta.serverId]),
    [["error", "Stopping a server failed", "the disk the log is on has gone", pid, SERVER_ID]]
  );
  // The stop is over, and the next one is a new one. The server had been
  // told to stop before the failure, and goes by itself.
  await waitFor(async () => !(await serverManager.getServerStatus(SERVER_ID)).stopping, "the failed stop to be forgotten");
  await waitFor(() => !isAlive(pid), "the server to act on the stop it was sent");
  assert.deepEqual(await serverManager.stopServer(SERVER_ID, OWNER), STOPPED);
  await sleep(50);
  assert.deepEqual(uncaught, []);
});
