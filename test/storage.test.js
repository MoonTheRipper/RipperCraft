const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const { createStore } = require("../src/lib/store");
const { createMutex, writeFileAtomic, writeJson } = require("../src/lib/utils");

async function scratchDir(t) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-storage-"));
  t.after(async () => {
    await fsp.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function modeOf(filePath) {
  return (await fsp.stat(filePath)).mode & 0o777;
}

test("writeJson replaces the file by rename, keeps mode 600 and leaves no temporary file", async (t) => {
  const directory = await scratchDir(t);
  const filePath = path.join(directory, "users.json");

  await writeJson(filePath, { users: [] }, { mode: 0o600 });
  const firstInode = (await fsp.stat(filePath)).ino;
  assert.equal(await modeOf(filePath), 0o600);

  await writeJson(filePath, { users: [{ username: "owner" }] }, { mode: 0o600 });
  const second = await fsp.stat(filePath);

  // Writing in place would have kept the inode; a rename swaps in a new file.
  assert.notEqual(second.ino, firstInode);
  assert.equal(second.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await fsp.readFile(filePath, "utf8")), { users: [{ username: "owner" }] });
  assert.equal((await fsp.readFile(filePath, "utf8")).endsWith("}\n"), true);
  assert.deepEqual(await fsp.readdir(directory), ["users.json"]);
});

test("writeJson tightens a file that was readable by others and keeps other files' own mode", async (t) => {
  const directory = await scratchDir(t);

  const secret = path.join(directory, "app.json");
  await fsp.writeFile(secret, "{}\n", { mode: 0o644 });
  await fsp.chmod(secret, 0o644);
  await writeJson(secret, { cookieSecret: "x" }, { mode: 0o600 });
  assert.equal(await modeOf(secret), 0o600);

  // ops.json and friends are written without a mode: whatever the file had stays.
  const plain = path.join(directory, "ops.json");
  await fsp.writeFile(plain, "[]\n");
  await fsp.chmod(plain, 0o640);
  await writeJson(plain, [{ name: "Moon" }]);
  assert.equal(await modeOf(plain), 0o640);
});

test("a symlinked data file stays a symlink and its target is what gets replaced", async (t) => {
  const directory = await scratchDir(t);
  const realFile = path.join(directory, "real", "users.json");
  const linkFile = path.join(directory, "users.json");
  await fsp.mkdir(path.dirname(realFile));
  await fsp.writeFile(realFile, "{}\n");
  await fsp.symlink(realFile, linkFile);

  await writeJson(linkFile, { users: ["kept"] }, { mode: 0o600 });

  assert.equal((await fsp.lstat(linkFile)).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(await fsp.readFile(realFile, "utf8")), { users: ["kept"] });
});

test("overlapping writers never expose a partial file to a reader", async (t) => {
  const directory = await scratchDir(t);
  const filePath = path.join(directory, "users.json");
  // Large enough that an in-place write is visibly incomplete while it runs.
  const payload = (label) => ({ label, filler: "x".repeat(400_000) });
  await writeJson(filePath, payload("start"));

  let writing = true;
  const unreadable = [];
  let reads = 0;
  const reader = (async () => {
    while (writing) {
      const raw = await fsp.readFile(filePath, "utf8");
      reads += 1;
      try {
        JSON.parse(raw);
      } catch (error) {
        unreadable.push(`${raw.length} bytes: ${error.message.slice(0, 40)}`);
      }
    }
  })();

  for (let round = 0; round < 8; round += 1) {
    await Promise.all(Array.from({ length: 6 }, (_, index) => writeJson(filePath, payload(`${round}-${index}`))));
  }
  writing = false;
  await reader;

  assert.ok(reads > 0);
  assert.deepEqual(unreadable, []);
  assert.match(JSON.parse(await fsp.readFile(filePath, "utf8")).label, /^7-\d$/);
  assert.deepEqual(await fsp.readdir(directory), ["users.json"]);
});

test("a write that fails leaves the previous contents alone and removes its temporary file", async (t) => {
  const directory = await scratchDir(t);

  // The destination is a non-empty directory, so the final rename cannot happen.
  const blocked = path.join(directory, "blocked.json");
  await fsp.mkdir(blocked);
  await fsp.writeFile(path.join(blocked, "keep.txt"), "still here");
  await assert.rejects(writeFileAtomic(blocked, "new contents"));
  assert.deepEqual(await fsp.readdir(blocked), ["keep.txt"]);
  assert.deepEqual(await fsp.readdir(directory), ["blocked.json"]);

  // A value that cannot be serialised never touches the disk at all.
  const filePath = path.join(directory, "users.json");
  await writeJson(filePath, { users: ["before"] });
  const circular = {};
  circular.self = circular;
  await assert.rejects(writeJson(filePath, circular));
  assert.deepEqual(JSON.parse(await fsp.readFile(filePath, "utf8")), { users: ["before"] });
  assert.deepEqual((await fsp.readdir(directory)).sort(), ["blocked.json", "users.json"]);
});

test("createMutex runs tasks one at a time and survives a task that throws", async () => {
  const runExclusive = createMutex();
  const order = [];
  let running = 0;
  let maxRunning = 0;
  const task = (label, fail) => async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(label);
    running -= 1;
    if (fail) {
      throw new Error(`${label} failed`);
    }
    return label;
  };

  const results = await Promise.allSettled([
    runExclusive(task("a")),
    runExclusive(task("b", true)),
    runExclusive(task("c"))
  ]);

  assert.equal(maxRunning, 1);
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["fulfilled", "rejected", "fulfilled"]
  );
});

test("users created at the same moment are all kept", async (t) => {
  const root = await scratchDir(t);
  const store = createStore(root);

  const created = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      store.createUser({ username: `user-${index}`, passwordHash: "x:y", role: "admin" })
    )
  );

  const users = await store.getUsers();
  assert.equal(users.length, 12);
  assert.deepEqual(users.map((user) => user.username).sort(), created.map((user) => user.username).sort());
  assert.equal(await modeOf(store.USERS_FILE), 0o600);
});

test("a missing users.json being recreated cannot wipe a user saved at the same moment", async (t) => {
  const root = await scratchDir(t);
  const store = createStore(root);
  await store.ensureInitialized();
  await fsp.rm(store.USERS_FILE);

  // Several callers all find the file missing; exactly one writes the default.
  await Promise.all([
    store.createUser({ username: "first", passwordHash: "x:y", role: "owner" }),
    store.getUsers(),
    store.hasUsers(),
    store.createUser({ username: "second", passwordHash: "x:y", role: "admin" }),
    store.ensureInitialized()
  ]);

  const users = await store.getUsers();
  assert.deepEqual(users.map((user) => user.username).sort(), ["first", "second"]);
  assert.equal(await store.hasOwner(), true);
});

test("an update and a password hash upgrade at the same moment do not lose each other", async (t) => {
  const root = await scratchDir(t);
  const store = createStore(root);
  const user = await store.createUser({ username: "lane", displayName: "Lane", passwordHash: "old:hash", role: "admin" });

  const [updated, upgraded] = await Promise.all([
    store.updateUser(user.id, { displayName: "Lane Admin" }),
    store.upgradePasswordHash(user.id, "old:hash", "new-hash")
  ]);
  assert.equal(updated.displayName, "Lane Admin");
  assert.equal(upgraded, true);

  const [saved] = await store.getUsers();
  assert.equal(saved.displayName, "Lane Admin");
  assert.equal(saved.passwordHash, "new-hash");

  // The password changed in between: the upgrade must not put the old one back.
  assert.equal(await store.upgradePasswordHash(user.id, "old:hash", "stale-upgrade"), false);
  assert.equal((await store.getUsers())[0].passwordHash, "new-hash");
  assert.equal(await store.upgradePasswordHash("usr_missing", "x", "y"), false);
});

test("data files written by the previous version still load unchanged", async (t) => {
  const root = await scratchDir(t);
  const dataDir = path.join(root, "data");
  await fsp.mkdir(dataDir);
  // Byte-for-byte what the previous version wrote: two-space JSON, trailing newline.
  const app = {
    appName: "RipperCraft",
    cookieSecret: "5f2c0d0b8a4e4f0e9c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a69788796a5b4c3d2",
    integrations: { curseforgeApiKey: "$2a$10$example" },
    sessionTtlHours: 24,
    unlockTtlMinutes: 20,
    createdAt: "2026-05-01T10:00:00.000Z",
    updatedAt: "2026-05-01T10:00:00.000Z"
  };
  const users = {
    users: [
      {
        id: "usr_0123456789abcdef",
        displayName: "Ripper Moon",
        role: "owner",
        servers: [],
        createdAt: "2026-05-01T10:00:00.000Z",
        updatedAt: "2026-05-01T10:00:00.000Z",
        username: "owner",
        passwordHash: "00112233445566778899aabbccddeeff:6b1f0c1d",
        permissions: { createWorldServers: [] }
      }
    ]
  };
  const servers = { servers: { Alpha: { id: "Alpha", directory: "servers/Alpha", passphraseHash: "aa:bb" } } };
  await fsp.writeFile(path.join(dataDir, "app.json"), `${JSON.stringify(app, null, 2)}\n`);
  await fsp.writeFile(path.join(dataDir, "users.json"), `${JSON.stringify(users, null, 2)}\n`);
  await fsp.writeFile(path.join(dataDir, "servers.json"), `${JSON.stringify(servers, null, 2)}\n`);

  const store = createStore(root);
  await store.ensureInitialized();

  assert.deepEqual(await store.getAppConfig(), app);
  assert.deepEqual(await store.getUsers(), users.users);
  assert.deepEqual(await store.getServerRecords(), servers.servers);
  assert.equal(await store.hasOwner(), true);
  // Nothing needed rewriting, so the files are still exactly what was there...
  assert.equal(await fsp.readFile(path.join(dataDir, "users.json"), "utf8"), `${JSON.stringify(users, null, 2)}\n`);
  // ...apart from being made private, as the previous version also did.
  for (const name of ["app.json", "users.json", "servers.json"]) {
    assert.equal(await modeOf(path.join(dataDir, name)), 0o600, name);
  }
});
