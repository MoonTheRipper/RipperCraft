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

// --- throttling over HTTP ---------------------------------------------------

const MINUTE = 60 * 1000;

function clock(start = 1_800_000_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (milliseconds) => {
    current += milliseconds;
  };
  return now;
}

// The test client connects from loopback, as the tunnel does, so the address
// it names in CF-Connecting-IP is believed.
function loginFrom(app, address, username, password) {
  return app.request({
    headers: address ? { "CF-Connecting-IP": address } : {},
    json: { password, username },
    method: "POST",
    path: "/api/login"
  });
}

function countDerivations(t) {
  const original = crypto.scrypt;
  const counter = { count: 0 };
  t.mock.method(crypto, "scrypt", (...args) => {
    counter.count += 1;
    return original(...args);
  });
  return counter;
}

test("five wrong passwords get 429 with Retry-After, and the right password is refused unchecked until it passes", async (t) => {
  const now = clock();
  const app = await startApp(t, { app: { now } });
  await app.setupOwner();
  const derivations = countDerivations(t);
  const attacker = "198.51.100.7";

  for (let index = 0; index < 5; index += 1) {
    const response = await loginFrom(app, attacker, "owner", `wrong-guess-${index}`);
    assert.equal(response.status, 401);
    assert.equal(response.headers["retry-after"], undefined);
    now.advance(1000);
  }
  assert.equal(derivations.count, 5);

  // The sixth is refused: fifteen minutes from the fifth failure, a second ago.
  const refused = await loginFrom(app, attacker, "owner", "wrong-guess-5");
  assert.equal(refused.status, 429);
  assert.equal(refused.headers["retry-after"], "899");
  assert.deepEqual(refused.json, {
    error: "Too many failed login attempts. Try again in 15 minutes.",
    retryAfterSeconds: 899
  });
  assert.equal(refused.headers["set-cookie"], undefined);

  // The right password is refused in exactly the same way, and is not checked:
  // otherwise the limit would only ever stop wrong guesses, which need no stopping.
  const rightButLocked = await loginFrom(app, attacker, "owner", OWNER_PASSWORD);
  assert.equal(rightButLocked.status, 429);
  assert.deepEqual(rightButLocked.json, refused.json);
  assert.equal(rightButLocked.headers["set-cookie"], undefined);
  assert.equal(derivations.count, 5);

  // Asking again does not extend the wait.
  now.advance(14 * MINUTE);
  assert.equal((await loginFrom(app, attacker, "owner", OWNER_PASSWORD)).headers["retry-after"], "59");

  // Another address was never locked out of the account.
  const elsewhere = await loginFrom(app, "203.0.113.9", "owner", OWNER_PASSWORD);
  assert.equal(elsewhere.status, 200);

  // Once the wait is over the right password works, and wipes the slate.
  now.advance(59 * 1000);
  const afterWait = await loginFrom(app, attacker, "owner", OWNER_PASSWORD);
  assert.equal(afterWait.status, 200);
  assert.ok(afterWait.headers["set-cookie"][0].startsWith("rippermoon_session="));
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await loginFrom(app, attacker, "owner", "wrong-again")).status, 401);
  }
  assert.equal((await loginFrom(app, attacker, "owner", "wrong-again")).status, 429);

  const refusals = app.logs.filter((entry) => entry.message === "Login refused after too many failed attempts");
  assert.equal(refusals.length, 4);
  assert.deepEqual(refusals[0].meta, { address: attacker, limit: "address+username", retryAfterSeconds: 899 });
});

test("the right password before the limit logs in and resets the count", async (t) => {
  const app = await startApp(t, { app: { now: clock() } });
  await app.setupOwner();
  const address = "198.51.100.8";

  for (let round = 0; round < 3; round += 1) {
    for (let index = 0; index < 4; index += 1) {
      assert.equal((await loginFrom(app, address, "owner", "a-typing-mistake")).status, 401);
    }
    assert.equal((await loginFrom(app, address, "owner", OWNER_PASSWORD)).status, 200);
  }
});

test("unknown usernames are throttled like real ones, so 429 does not reveal which exist", async (t) => {
  const app = await startApp(t, { app: { now: clock() } });
  await app.setupOwner();

  const statuses = async (address, username) => {
    const seen = [];
    for (let index = 0; index < 7; index += 1) {
      const response = await loginFrom(app, address, username, "not-the-password");
      seen.push(`${response.status} ${response.text}`);
    }
    return seen;
  };

  const real = await statuses("198.51.100.20", "owner");
  const unreal = await statuses("198.51.100.21", "no-such-account");
  assert.deepEqual(unreal, real);
  assert.equal(real.filter((line) => line.startsWith("401")).length, 5);
  assert.equal(real.filter((line) => line.startsWith("429")).length, 2);
});

test("one address spraying usernames is cut off after twenty failures", async (t) => {
  const app = await startApp(t, { app: { now: clock() } });
  await app.setupOwner();
  const address = "198.51.100.30";

  for (let index = 0; index < 20; index += 1) {
    assert.equal((await loginFrom(app, address, `guess-${index}`, "password-list-entry")).status, 401);
  }
  const refused = await loginFrom(app, address, "owner", OWNER_PASSWORD);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers["retry-after"], "900");
});

test("a username under attack from several addresses costs each of them longer waits, and nobody else anything", async (t) => {
  const now = clock();
  const app = await startApp(t, { app: { now } });
  await app.setupOwner();
  const guess = (address) => loginFrom(app, address, "owner", "from-a-list");

  // Three addresses failing are not yet a crowd: each still has its five tries.
  for (let index = 1; index <= 3; index += 1) {
    assert.equal((await guess(`198.51.100.${index}`)).status, 401);
    assert.equal((await guess(`198.51.100.${index}`)).status, 401);
  }

  // The fourth makes one, and from here a single failure means a fifteen-minute wait.
  assert.equal((await guess("198.51.100.4")).status, 401);
  const waiting = await guess("198.51.100.4");
  assert.equal(waiting.status, 429);
  assert.equal(waiting.headers["retry-after"], "900");
  assert.deepEqual(waiting.json, {
    error: "Too many failed login attempts. Try again in 15 minutes.",
    retryAfterSeconds: 900
  });
  // An address that was already failing is caught by its next failure too.
  assert.equal((await guess("198.51.100.1")).status, 401);
  assert.equal((await guess("198.51.100.1")).status, 429);

  // The wait doubles each time the same address comes back and fails.
  now.advance(15 * MINUTE);
  assert.equal((await guess("198.51.100.4")).status, 401);
  assert.equal((await guess("198.51.100.4")).headers["retry-after"], "1800");
  now.advance(30 * MINUTE);
  assert.equal((await guess("198.51.100.4")).status, 401);
  const hour = await guess("198.51.100.4");
  assert.equal(hour.headers["retry-after"], "3600");
  assert.equal(hour.json.error, "Too many failed login attempts. Try again in 60 minutes.");

  // Through all of it, the right password from an address that has not been
  // failing is checked at once: nobody is waiting on anybody else.
  for (const address of ["203.0.113.50", "203.0.113.51", null]) {
    assert.equal((await loginFrom(app, address, "owner", OWNER_PASSWORD)).status, 200, String(address));
  }
  // So is the right password from a crowd member once its own wait is over, and it clears the slate.
  now.advance(60 * MINUTE);
  assert.equal((await loginFrom(app, "198.51.100.4", "owner", OWNER_PASSWORD)).status, 200);
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await guess("198.51.100.4")).status, 401);
  }

  const refusals = app.logs.filter((entry) => entry.message === "Login refused after too many failed attempts");
  assert.deepEqual(refusals[0].meta, { address: "198.51.100.4", limit: "address+username", retryAfterSeconds: 900 });
});

test("one address guessing for hours never costs another address its login", async (t) => {
  const now = clock();
  const app = await startApp(t, { app: { now } });
  await app.setupOwner();

  let refusedOthers = 0;
  for (let round = 0; round < 24; round += 1) {
    // Five wrong guesses and a sixth that is refused, every fifteen minutes, for six hours.
    for (let index = 0; index < 6; index += 1) {
      await loginFrom(app, "198.51.100.66", "owner", `guess-${round}-${index}`);
    }
    const other = await loginFrom(app, `203.0.113.${round + 1}`, "owner", OWNER_PASSWORD);
    if (other.status !== 200) {
      refusedOthers += 1;
    }
    now.advance(15 * MINUTE);
  }
  assert.equal(refusedOthers, 0);
});

test("the visitor's address is read from the tunnel's headers: IPv6 per /64, X-Forwarded-For as the fallback", async (t) => {
  const app = await startApp(t, { app: { now: clock() } });
  await app.setupOwner();
  const attempt = async (headers, username = "owner") =>
    (await app.request({ headers, json: { password: "not-the-password", username }, method: "POST", path: "/api/login" })).status;

  // Five addresses out of one customer's /64 are one visitor.
  for (let index = 1; index <= 5; index += 1) {
    assert.equal(await attempt({ "CF-Connecting-IP": `2001:db8:77:1::${index}` }), 401);
  }
  assert.equal(await attempt({ "CF-Connecting-IP": "2001:db8:77:1:ffff:ffff:ffff:ffff" }), 429);
  assert.equal(await attempt({ "CF-Connecting-IP": "2001:0DB8:0077:0001:0000:0000:0000:0009" }), 429);
  // The neighbouring /64 is somebody else.
  assert.equal(await attempt({ "CF-Connecting-IP": "2001:db8:77:2::1" }), 401);

  // A proxy that only sets X-Forwarded-For: the first hop is the visitor.
  for (let index = 0; index < 5; index += 1) {
    assert.equal(await attempt({ "X-Forwarded-For": `198.51.100.90, 10.0.0.${index + 1}` }, "lane"), 401);
  }
  assert.equal(await attempt({ "X-Forwarded-For": "198.51.100.90" }, "lane"), 429);
  assert.equal(await attempt({ "X-Forwarded-For": "198.51.100.91, 198.51.100.90" }, "lane"), 401);
  // Cloudflare's header counts when X-Forwarded-For bears it out...
  assert.equal(
    await attempt({ "CF-Connecting-IP": "198.51.100.90", "X-Forwarded-For": "203.0.113.1, 198.51.100.90" }, "lane"),
    429
  );
  // ...and not when it does not: that is a visitor behind some other proxy
  // sending the header themselves, to be counted as somebody else.
  assert.equal(await attempt({ "CF-Connecting-IP": "198.51.100.92", "X-Forwarded-For": "198.51.100.90" }, "lane"), 429);
  assert.equal(await attempt({ "CF-Connecting-IP": "198.51.100.90", "X-Forwarded-For": "198.51.100.93" }, "lane"), 401);
});

test("many guesses sent at once are not all checked", async (t) => {
  const app = await startApp(t, { app: { now: clock() } });
  await app.setupOwner();
  const derivations = countDerivations(t);

  const responses = await Promise.all(
    Array.from({ length: 30 }, (_, index) => loginFrom(app, "198.51.100.40", "owner", `parallel-guess-${index}`))
  );
  const statuses = responses.map((response) => response.status).sort();

  assert.equal(statuses.filter((status) => status === 401).length, 5);
  assert.equal(statuses.filter((status) => status === 429).length, 25);
  assert.equal(derivations.count, 5);
});

test("a login that fails for another reason does not count as a wrong password", async (t) => {
  const app = await startApp(t, { app: { now: clock() } });
  await app.setupOwner();
  const usersFile = path.join(app.root, "data", "users.json");
  const saved = await fsp.readFile(usersFile, "utf8");

  // The account list cannot be read, so no password is ever checked.
  await fsp.writeFile(usersFile, "{ this is not json");
  for (let index = 0; index < 8; index += 1) {
    assert.equal((await loginFrom(app, "198.51.100.60", "owner", OWNER_PASSWORD)).status, 500);
  }
  await fsp.writeFile(usersFile, saved);

  assert.equal((await loginFrom(app, "198.51.100.60", "owner", OWNER_PASSWORD)).status, 200);
});

test("wrong server passphrases are limited per account and per server", async (t) => {
  const now = clock();
  const app = await startApp(t, { app: { now } });
  const owner = await app.setupOwner();

  assert.equal(
    (await owner("PUT", "/api/servers/DemoServer/settings", { json: { loader: "fabric", passphrase: "lane-secret" } })).status,
    200
  );
  for (const username of ["lane", "moss"]) {
    const created = await owner("POST", "/api/users", {
      json: { password: ADMIN_PASSWORD, servers: ["DemoServer"], username }
    });
    assert.equal(created.status, 201);
  }
  const lane = app.client();
  const moss = app.client();
  assert.equal((await lane("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "lane" } })).status, 200);
  assert.equal((await moss("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "moss" } })).status, 200);
  const unlock = (who, passphrase) => who("POST", "/api/servers/DemoServer/unlock", { json: { passphrase } });

  for (let index = 0; index < 5; index += 1) {
    const wrong = await unlock(lane, `guess-${index}`);
    assert.equal(wrong.status, 403);
    assert.deepEqual(wrong.json, { error: "Passphrase did not match." });
  }

  // Refused now, even with the right passphrase, and told for how long.
  const refused = await unlock(lane, "lane-secret");
  assert.equal(refused.status, 429);
  assert.equal(refused.headers["retry-after"], "900");
  assert.deepEqual(refused.json, {
    error: "Too many wrong passphrases for this server. Try again in 15 minutes.",
    retryAfterSeconds: 900
  });
  assert.equal((await lane("GET", "/api/servers/DemoServer")).json.unlocked, false);

  // Another admin of the same server is not affected, and neither is the owner.
  assert.equal((await unlock(moss, "lane-secret")).status, 200);
  assert.equal((await unlock(owner, "")).status, 200);

  // A passphrase that is not text is simply wrong, not a server error.
  assert.equal((await unlock(moss, { $ne: null })).status, 403);

  now.advance(15 * MINUTE);
  const afterWait = await unlock(lane, "lane-secret");
  assert.equal(afterWait.status, 200);
  assert.equal(afterWait.json.unlocked, true);

  // Getting it right cleared the count.
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await unlock(lane, "another-wrong-one")).status, 403);
  }
  assert.equal((await unlock(lane, "lane-secret")).status, 200);

  // Used up again, the wait is back. From here on there is one try per wait,
  // and each wrong one doubles the next wait, as a wrong password does.
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await unlock(lane, "still-wrong")).status, 403);
  }
  assert.equal((await unlock(lane, "lane-secret")).headers["retry-after"], "900");
  now.advance(15 * MINUTE);
  assert.equal((await unlock(lane, "still-wrong")).status, 403);
  const doubled = await unlock(lane, "lane-secret");
  assert.equal(doubled.status, 429);
  assert.deepEqual(doubled.json, {
    error: "Too many wrong passphrases for this server. Try again in 30 minutes.",
    retryAfterSeconds: 1800
  });
  // Still nobody else's wait.
  assert.equal((await unlock(moss, "lane-secret")).status, 200);

  // The right passphrase after the longer wait ends it: five tries again.
  now.advance(30 * MINUTE);
  assert.equal((await unlock(lane, "lane-secret")).status, 200);
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await unlock(lane, "wrong-once-more")).status, 403);
  }
  assert.equal((await unlock(lane, "lane-secret")).status, 200);
});

test("a server passphrase hashed by the previous version still unlocks the server", async (t) => {
  const root = await createRoot(t);
  const store = createStore(root);
  await store.createUser({ passwordHash: await hashSecret(OWNER_PASSWORD), role: "owner", username: "owner" });
  await store.createUser({
    passwordHash: await hashSecret(ADMIN_PASSWORD),
    role: "admin",
    servers: ["DemoServer"],
    username: "lane"
  });
  // The record as the previous version left it in data/servers.json.
  const passphraseHash = legacyHash("lane-secret");
  await store.updateServerRecord("DemoServer", { directory: "servers/DemoServer", name: "Demo", passphraseHash });

  const app = await startApp(t, { root });
  const lane = app.client();
  assert.equal((await lane("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "lane" } })).status, 200);
  assert.equal((await lane("GET", "/api/servers/DemoServer")).json.unlocked, false);

  const wrong = await lane("POST", "/api/servers/DemoServer/unlock", { json: { passphrase: "lane-secrets" } });
  assert.equal(wrong.status, 403);
  const right = await lane("POST", "/api/servers/DemoServer/unlock", { json: { passphrase: "lane-secret" } });
  assert.equal(right.status, 200);
  assert.equal((await lane("GET", "/api/servers/DemoServer")).json.unlocked, true);

  // Unlocking does not rewrite the stored hash; setting the passphrase again does.
  assert.equal((await store.getServerRecords()).DemoServer.passphraseHash, passphraseHash);
  const owner = app.client();
  await owner("POST", "/api/login", { json: { password: OWNER_PASSWORD, username: "owner" } });
  assert.equal((await owner("PUT", "/api/servers/DemoServer/settings", { json: { passphrase: "a-new-secret" } })).status, 200);
  assert.match((await store.getServerRecords()).DemoServer.passphraseHash, /^\$scrypt\$/);
});
