const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setHashCostForTests } = require("../src/lib/auth");
const { ADMIN_PASSWORD, startApp } = require("../test-support/app");
const {
  QUICK_WAITS,
  SERVER_ID,
  STOPPED,
  describeServerDir,
  fakeServerSource,
  isAlive,
  isThere,
  settled,
  stoppedBy,
  waitFor
} = require("../test-support/game-server");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

test("stopping over HTTP is answered at once, shows as stopping everywhere, and ends as stopped", async (t) => {
  const app = await startApp(t, { app: { stopWaits: QUICK_WAITS } });
  const server = describeServerDir(app.root);
  // The server the test app comes with, with a stand-in that takes its time
  // over "stop" for a start command.
  fs.writeFileSync(path.join(server.serverDir, "launch-server.sh"), fakeServerSource({ onStop: "wait" }), { mode: 0o755 });
  fs.chmodSync(path.join(server.serverDir, "launch-server.sh"), 0o755);
  fs.writeFileSync(path.join(server.serverDir, "eula.txt"), "eula=true\n");
  // Should the test fail half-way, the stand-in is not left running. Its pid
  // is kept here: the folder it wrote it in may be gone by then.
  let standIn = null;
  t.after(() => {
    if (standIn && isAlive(standIn)) {
      process.kill(standIn, "SIGKILL");
    }
  });
  const owner = await app.setupOwner();
  assert.equal((await owner("PUT", "/api/servers/DemoServer/settings", { json: { passphrase: "lane-secret" } })).status, 200);
  const statusOf = async () => (await owner("GET", "/api/servers")).json.servers.find((entry) => entry.id === SERVER_ID).status;

  // Not running: as before, an answer that says so.
  const idle = await owner("POST", "/api/servers/DemoServer/stop");
  assert.equal(idle.status, 200);
  assert.deepEqual(idle.json, { status: STOPPED });

  const started = await owner("POST", "/api/servers/DemoServer/start");
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.status.running, true);
  const pid = await server.whenReady();
  standIn = pid;

  // The server will not exit before it is released, so this answer can only
  // have come while it was still running.
  const stopping = await owner("POST", "/api/servers/DemoServer/stop");
  assert.equal(stopping.status, 200, stopping.text);
  assert.deepEqual(Object.keys(stopping.json), ["status"]);
  assert.deepEqual({ ...stopping.json.status, stoppingSince: null }, { ...started.json.status, stopping: true });
  assert.match(stopping.json.status.stoppingSince, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(isAlive(pid), true);

  // The list and the server's own page say the same.
  assert.deepEqual(await statusOf(), stopping.json.status);
  assert.deepEqual((await owner("GET", "/api/servers/DemoServer")).json.server.status, stopping.json.status);

  // A second press is the same stop.
  const again = await owner("POST", "/api/servers/DemoServer/stop");
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, stopping.json);

  // Start is refused, in words, and so is what needs a stopped server.
  const refused = await owner("POST", "/api/servers/DemoServer/start");
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.json, { error: "DemoServer is still stopping. Wait until it has stopped, then start it again." });
  const deleting = await owner("DELETE", "/api/servers/DemoServer", { json: { confirmServerId: "DemoServer" } });
  assert.equal(deleting.status, 409);
  assert.deepEqual(server.received(), ["console: stop"]);

  server.release();
  await waitFor(async () => !(await statusOf()).running, "the server to have stopped");
  // Stopped, and the answer says how: it took "stop" on its console.
  assert.deepEqual(settled(await statusOf()), stoppedBy("console"));
  assert.deepEqual((await owner("GET", "/api/servers/DemoServer")).json.server.status, await statusOf());
  assert.deepEqual(server.received(), ["console: stop", "exit: stop"]);
  assert.equal(isThere(server.pidFile), false);
  assert.equal(isThere(server.consoleFile), false);

  // The dashboard's log has who asked, and nothing went wrong on the way.
  const asked = app.logs.filter((entry) => entry.message === "Server stop requested");
  assert.deepEqual(
    asked.map((entry) => entry.meta),
    [
      { actor: "owner", serverId: SERVER_ID, stopping: false },
      { actor: "owner", serverId: SERVER_ID, stopping: true },
      { actor: "owner", serverId: SERVER_ID, stopping: true }
    ]
  );
  assert.equal(app.logs.some((entry) => entry.message === 'Stopping a server: sent "stop" to its console'), true);
  assert.deepEqual(app.logs.filter((entry) => entry.level === "error"), []);
  assert.match(server.runtimeLog(), /^\[[^\]]+\] Stop requested by owner: sending "stop" to the console$/m);
});

test("a server that had to be killed is reported as killed, to the list and to its page, until it is started again", async (t) => {
  const app = await startApp(t, { app: { stopWaits: { ...QUICK_WAITS, console: 200, term: 200 } } });
  const server = describeServerDir(app.root);
  // A stand-in that does nothing with "stop", and nothing with SIGTERM.
  fs.writeFileSync(path.join(server.serverDir, "launch-server.sh"), fakeServerSource({ onStop: "ignore", onTerm: "ignore" }), { mode: 0o755 });
  fs.chmodSync(path.join(server.serverDir, "launch-server.sh"), 0o755);
  fs.writeFileSync(path.join(server.serverDir, "eula.txt"), "eula=true\n");
  let standIn = null;
  t.after(() => {
    if (standIn && isAlive(standIn)) {
      process.kill(standIn, "SIGKILL");
    }
  });
  const owner = await app.setupOwner();
  assert.equal((await owner("PUT", "/api/servers/DemoServer/settings", { json: { passphrase: "lane-secret" } })).status, 200);
  const statusOf = async () => (await owner("GET", "/api/servers")).json.servers.find((entry) => entry.id === SERVER_ID).status;
  const pageStatus = async () => (await owner("GET", "/api/servers/DemoServer")).json.server.status;

  assert.equal((await owner("POST", "/api/servers/DemoServer/start")).status, 200);
  standIn = await server.whenReady();
  const stopping = await owner("POST", "/api/servers/DemoServer/stop");
  assert.equal(stopping.json.status.stopping, true);
  // While it is stopping, nothing is said yet about how the stop ended.
  assert.equal(stopping.json.status.lastStop, null);

  await waitFor(async () => !(await statusOf()).running, "the server to have been killed");
  assert.equal(isAlive(standIn), false);
  assert.deepEqual(server.received(), ["console: stop", "signal: SIGTERM"]);
  // What the page asks for says so, in the list and on the server's own page.
  const killed = await statusOf();
  assert.deepEqual(settled(killed), stoppedBy("SIGKILL"));
  assert.deepEqual(await pageStatus(), killed);
  // Pressing Stop again changes nothing, and does not make it a clean stop.
  assert.deepEqual((await owner("POST", "/api/servers/DemoServer/stop")).json, { status: killed });

  // Started again, it is a running server with nothing said against it; and
  // the next stop is reported for what it is.
  fs.rmSync(path.join(server.serverDir, "fake-server.pid"));
  const again = await owner("POST", "/api/servers/DemoServer/start");
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.status.running, true);
  assert.equal(again.json.status.lastStop, null);
  standIn = await server.whenReady();
  assert.equal((await statusOf()).lastStop, null);
  assert.equal((await owner("POST", "/api/servers/DemoServer/stop")).json.status.stopping, true);
  await waitFor(async () => !(await statusOf()).running, "the server to have been killed again");
  assert.deepEqual(settled(await statusOf()), stoppedBy("SIGKILL"));
});

test("a restricted admin has to unlock a server before stopping it, as before", async (t) => {
  const app = await startApp(t, { app: { stopWaits: QUICK_WAITS } });
  const owner = await app.setupOwner();
  assert.equal((await owner("PUT", "/api/servers/DemoServer/settings", { json: { passphrase: "lane-secret" } })).status, 200);
  assert.equal(
    (await owner("POST", "/api/users", { json: { password: ADMIN_PASSWORD, servers: ["DemoServer"], username: "lane" } })).status,
    201
  );
  const admin = app.client();
  assert.equal((await admin("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "lane" } })).status, 200);

  const locked = await admin("POST", "/api/servers/DemoServer/stop");
  assert.equal(locked.status, 403);
  assert.deepEqual(locked.json, { error: "Unlock the server with its passphrase before stopping it." });
  assert.equal(app.logs.some((entry) => entry.message === "Server stop requested"), false);

  assert.equal((await admin("POST", "/api/servers/DemoServer/unlock", { json: { passphrase: "lane-secret" } })).status, 200);
  const unlocked = await admin("POST", "/api/servers/DemoServer/stop");
  assert.equal(unlocked.status, 200);
  assert.deepEqual(unlocked.json, { status: STOPPED });
});
