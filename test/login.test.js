const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { hashSecret, setHashCostForTests, verifySecret } = require("../src/lib/auth");
const { createStore } = require("../src/lib/store");
const { ADMIN_PASSWORD, OWNER_PASSWORD, createRoot, startApp } = require("../test-support/app");

// Dozens of logins per test; test/auth.test.js covers hashing at its real cost.
setHashCostForTests({ ln: 10, r: 8, p: 1 });

// Made by the previous version's hashSecret for "correct horse battery staple".
const LEGACY_PASSWORD = "correct horse battery staple";
const LEGACY_HASH =
  "00112233445566778899aabbccddeeff:56b72380dc8efdd13cf6d33e683401766d75f4577128d6d15ca9156639f00cb1";

// What the previous version's hashSecret did, for passwords the fixture above
// does not cover.
function legacyHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.pbkdf2Sync(password, salt, 210_000, 32, "sha256").toString("hex")}`;
}

function withoutDate(headers) {
  const { date, ...rest } = headers;
  return rest;
}

test("an unknown username gets the same answer and the same work as a wrong password", async (t) => {
  const app = await startApp(t);
  await app.setupOwner();

  const original = crypto.scrypt;
  let derivations = 0;
  t.mock.method(crypto, "scrypt", (...args) => {
    derivations += 1;
    return original(...args);
  });
  const attempt = async (username) => {
    derivations = 0;
    const response = await app.request({
      json: { password: "not-the-right-one", username },
      method: "POST",
      path: "/api/login"
    });
    return { derivations, response };
  };

  const known = await attempt("owner");
  const unknown = await attempt("nobody-by-this-name");

  assert.equal(known.response.status, 401);
  assert.equal(unknown.response.status, 401);
  assert.equal(unknown.response.text, known.response.text);
  assert.deepEqual(withoutDate(unknown.response.headers), withoutDate(known.response.headers));
  assert.deepEqual(known.response.json, { error: "Invalid username or password." });
  assert.equal(known.response.headers["set-cookie"], undefined);

  // The unknown name is checked against a decoy hash rather than skipped.
  assert.equal(known.derivations, 1);
  assert.equal(unknown.derivations, 1);
});

test("an account with a legacy hash logs in and has its hash upgraded in place", async (t) => {
  const root = await createRoot(t);
  const store = createStore(root);
  const legacyOwner = await store.createUser({
    displayName: "Ripper Moon",
    passwordHash: LEGACY_HASH,
    role: "owner",
    username: "owner"
  });
  // Shorter than today's minimum: it was set before there was one.
  const shortAdmin = await store.createUser({
    passwordHash: legacyHash("a"),
    role: "admin",
    servers: [],
    username: "lane"
  });
  const usersBefore = await fsp.readFile(store.USERS_FILE, "utf8");
  assert.equal(usersBefore.includes("$scrypt$"), false);

  const app = await startApp(t, { root });

  // A wrong password changes nothing on disk.
  const wrong = await app.request({
    json: { password: "correct horse battery stapler", username: "owner" },
    method: "POST",
    path: "/api/login"
  });
  assert.equal(wrong.status, 401);
  assert.equal(await fsp.readFile(store.USERS_FILE, "utf8"), usersBefore);

  const owner = app.client();
  const login = await owner("POST", "/api/login", { json: { password: LEGACY_PASSWORD, username: "Owner" } });
  assert.equal(login.status, 200);
  assert.equal(login.json.user.username, "owner");
  assert.equal("passwordHash" in login.json.user, false);

  const [savedOwner, savedAdmin] = await store.getUsers();
  assert.match(savedOwner.passwordHash, /^\$scrypt\$ln=10,r=8,p=1\$/);
  assert.equal(await verifySecret(LEGACY_PASSWORD, savedOwner.passwordHash), true);
  // Everything else about the account is as it was, updatedAt included.
  assert.deepEqual({ ...savedOwner, passwordHash: LEGACY_HASH }, legacyOwner);
  // The other account is untouched until it logs in itself.
  assert.deepEqual(savedAdmin, shortAdmin);
  assert.equal((await fsp.stat(store.USERS_FILE)).mode & 0o777, 0o600);

  // The upgraded hash keeps working, and the session from the first login too.
  assert.equal((await owner("GET", "/api/users")).status, 200);
  const again = await app.request({
    json: { password: LEGACY_PASSWORD, username: "owner" },
    method: "POST",
    path: "/api/login"
  });
  assert.equal(again.status, 200);
  assert.equal((await store.getUsers())[0].passwordHash, savedOwner.passwordHash);

  // One character was enough when it was set, and it still is.
  const admin = await app.request({ json: { password: "a", username: "lane" }, method: "POST", path: "/api/login" });
  assert.equal(admin.status, 200);
  assert.match((await store.getUsers())[1].passwordHash, /^\$scrypt\$/);
});

test("a password reset that lands during a login is not undone by the hash upgrade", async (t) => {
  const root = await createRoot(t);
  const store = createStore(root);
  const user = await store.createUser({ passwordHash: LEGACY_HASH, role: "owner", username: "owner" });
  const app = await startApp(t, { root });
  const resetHash = await hashSecret("a-brand-new-password");

  // The login has read the legacy hash and is busy deriving; the reset is saved
  // before it gets as far as storing the upgraded hash of the old password.
  const login = app.request({
    json: { password: LEGACY_PASSWORD, username: "owner" },
    method: "POST",
    path: "/api/login"
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await store.updateUser(user.id, { passwordHash: resetHash });
  const response = await login;

  // Normally the login read the old hash before the reset landed, so it was
  // valid when it was checked. On a machine slow enough for the reset to win
  // the race outright, the old password is simply wrong by then.
  assert.ok([200, 401].includes(response.status), `unexpected status ${response.status}`);
  // Either way the reset is what is stored afterwards, not a rehash of the old
  // password written over it.
  assert.equal((await store.getUsers())[0].passwordHash, resetHash);
});

test("every newly set password needs twelve characters, checked on the server", async (t) => {
  const app = await startApp(t);
  const tooShort = "eleven-char";
  const justEnough = "twelve-chars";
  assert.equal(tooShort.length, 11);
  assert.equal(justEnough.length, 12);

  assert.equal((await app.request({ path: "/api/bootstrap" })).json.passwordMinLength, 12);
  const setupCode = app.setupCodes.at(-1);

  // Owner setup.
  const refusedOwner = await app.request({
    json: { password: tooShort, setupCode, username: "owner" },
    method: "POST",
    path: "/api/setup-owner"
  });
  assert.equal(refusedOwner.status, 400);
  assert.deepEqual(refusedOwner.json, { error: "Password must be at least 12 characters." });
  assert.equal((await app.request({ path: "/api/bootstrap" })).json.needsSetup, true);

  // Characters are counted, not UTF-16 units: eleven emoji are 22 units.
  const emoji = await app.request({
    json: { password: "\u{1F512}".repeat(11), setupCode, username: "owner" },
    method: "POST",
    path: "/api/setup-owner"
  });
  assert.equal(emoji.status, 400);

  const owner = await app.setupOwner({ password: justEnough });

  // Admin creation.
  const refusedAdmin = await owner("POST", "/api/users", { json: { password: tooShort, username: "lane" } });
  assert.equal(refusedAdmin.status, 400);
  assert.deepEqual(refusedAdmin.json, { error: "Password must be at least 12 characters." });
  const createdAdmin = await owner("POST", "/api/users", { json: { password: ADMIN_PASSWORD, username: "lane" } });
  assert.equal(createdAdmin.status, 201);
  const adminId = createdAdmin.json.user.id;

  // Password reset.
  const refusedReset = await owner("POST", `/api/users/${adminId}/reset-password`, { json: { password: tooShort } });
  assert.equal(refusedReset.status, 400);
  assert.deepEqual(refusedReset.json, { error: "Password must be at least 12 characters." });
  assert.equal(
    (await owner("POST", `/api/users/${adminId}/reset-password`, { json: { password: "reset-to-this-1" } })).status,
    200
  );

  // Password change through the account editor.
  const refusedChange = await owner("PUT", `/api/users/${adminId}`, {
    json: { displayName: "Lane", password: tooShort, role: "admin", username: "lane" }
  });
  assert.equal(refusedChange.status, 400);
  assert.deepEqual(refusedChange.json, { error: "Password must be at least 12 characters." });
  // Leaving the field blank keeps the current password and is not a short one.
  const keptPassword = await owner("PUT", `/api/users/${adminId}`, {
    json: { displayName: "Lane Admin", password: "", role: "admin", username: "lane" }
  });
  assert.equal(keptPassword.status, 200);
  assert.equal(keptPassword.json.user.displayName, "Lane Admin");

  const login = async (password) =>
    (await app.request({ json: { password, username: "lane" }, method: "POST", path: "/api/login" })).status;
  assert.equal(await login(tooShort), 401);
  assert.equal(await login("reset-to-this-1"), 200);

  const changed = await owner("PUT", `/api/users/${adminId}`, {
    json: { displayName: "Lane Admin", password: "changed-to-this-2", role: "admin", username: "lane" }
  });
  assert.equal(changed.status, 200);
  assert.equal(await login("changed-to-this-2"), 200);
});

test("a short password that already exists keeps working after the upgrade", async (t) => {
  const root = await createRoot(t);
  const store = createStore(root);
  await store.createUser({ passwordHash: await hashSecret(OWNER_PASSWORD), role: "owner", username: "owner" });
  await store.createUser({ passwordHash: await hashSecret("short"), role: "admin", servers: [], username: "lane" });
  const app = await startApp(t, { root });

  const response = await app.request({
    json: { password: "short", username: "lane" },
    method: "POST",
    path: "/api/login"
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.user.username, "lane");
  // Nor is it held against the account afterwards: the hash is left as it is.
  assert.match((await store.getUsers())[1].passwordHash, /^\$scrypt\$ln=10,/);
});
