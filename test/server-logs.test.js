const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tailTextFile } = require("../src/lib/utils");
const { SERVER_ID, STOPPED, createManager, createServerRoot, plantPipe, unlessItHangs, whatArrived } = require("../test-support/game-server");

// A server's logs are in its own folder, where a mod can leave anything. These
// are about what the dashboard does when what it finds there is not a file.

test("a log is read from its end, through a link as before, and what is not a file reads as empty", async (t) => {
  const server = await createServerRoot(t);
  const file = path.join(server.root, "a.log");
  fs.writeFileSync(file, "first line\nsecond line\nlast line\n");
  const link = path.join(server.root, "linked.log");
  fs.symlinkSync(file, link);
  const folder = path.join(server.root, "folder.log");
  fs.mkdirSync(folder);
  const unread = path.join(server.root, "pipe.log");
  plantPipe(unread);
  const written = path.join(server.root, "written-pipe.log");
  plantPipe(written);
  const writer = fs.openSync(written, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
  t.after(() => fs.closeSync(writer));
  fs.writeSync(writer, "something in the pipe\n");

  assert.equal(await tailTextFile(file), "first line\nsecond line\nlast line\n");
  assert.equal(await tailTextFile(file, 10), "last line\n");
  assert.equal(await tailTextFile(link, 10), "last line\n");
  assert.equal(await tailTextFile(path.join(server.root, "no-such.log")), "");
  assert.equal(await unlessItHangs(tailTextFile(folder)), "");
  // A pipe that nothing writes to holds an ordinary open for ever.
  assert.equal(await unlessItHangs(tailTextFile(unread)), "");
  // One that has something in it is not a log either, and is left unread.
  assert.equal(await unlessItHangs(tailTextFile(written)), "");
  assert.equal(whatArrived(writer), "something in the pipe\n");
});

test("pipes where a server's logs belong do not hold up its page, or the dashboard", async (t) => {
  const server = await createServerRoot(t);
  const { serverManager } = await createManager(server.root);
  fs.mkdirSync(server.runtimeDir, { recursive: true });
  fs.rmSync(path.join(server.serverDir, "logs"), { force: true, recursive: true });
  fs.mkdirSync(path.join(server.serverDir, "logs"));
  plantPipe(path.join(server.serverDir, "logs", "latest.log"));
  plantPipe(path.join(server.runtimeDir, "runtime.log"));
  // And a folder nobody has registered yet, whose log is read to tell its version.
  fs.mkdirSync(path.join(server.root, "servers", "Planted", "logs"), { recursive: true });
  plantPipe(path.join(server.root, "servers", "Planted", "logs", "latest.log"));

  // More reads than the dashboard has threads to read with.
  for (let round = 0; round < 6; round += 1) {
    assert.deepEqual(await unlessItHangs(serverManager.getServerLog(SERVER_ID)), { latestLog: "", runtimeLog: "" });
  }
  const discovered = await unlessItHangs(serverManager.syncDiscoveredServers());
  assert.equal(discovered.Planted.minecraftVersion, "unknown");
  // Everything else still answers.
  assert.deepEqual(await unlessItHangs(serverManager.getServerStatus(SERVER_ID)), STOPPED);
  assert.equal(await unlessItHangs(fs.promises.readFile(__filename, "utf8").then((text) => text.length > 0)), true);
});
