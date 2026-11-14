const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { createApp } = require("../src/app");
const { hashSecret, setHashCostForTests } = require("../src/lib/auth");
const { generateSetupCode, normalizeSetupCode, setupCodeBanner, setupCodeMatches } = require("../src/lib/setup-code");
const { createStore } = require("../src/lib/store");
const { OWNER_PASSWORD, createRoot, startApp } = require("../test-support/app");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;
const WRONG_CODE_ERROR =
  "The setup code is missing or wrong. It is printed in the terminal, or the service journal, each time RipperCraft starts without an owner account.";

function setup(app, body) {
  return app.request({ json: body, method: "POST", path: "/api/setup-owner" });
}

async function readUsers(app) {
  return JSON.parse(await fsp.readFile(path.join(app.root, "data", "users.json"), "utf8")).users;
}

test("setup codes are random, typeable and compared forgivingly but exactly", (t) => {
  const codes = new Set(Array.from({ length: 200 }, generateSetupCode));
  assert.equal(codes.size, 200);
  for (const code of codes) {
    assert.match(code, CODE_SHAPE);
  }

  const code = "7KQ0-1ZXA-M4TV-9HBC";
  assert.equal(normalizeSetupCode(" 7kq0-1zxa m4tv_9hbc\n"), "7KQ01ZXAM4TV9HBC");
  // What it looks like read aloud or copied by eye: letter O for zero, I or L for one.
  for (const typed of [code, code.toLowerCase(), "7KQ01ZXAM4TV9HBC", "7kqo izxa m4tv 9hbc", "7KQO-LZXA-M4TV-9HBC"]) {
    assert.equal(setupCodeMatches(code, typed), true, typed);
  }
  for (const typed of ["", undefined, null, 0, {}, "7KQ0-1ZXA-M4TV-9HBD", "7KQ0-1ZXA-M4TV", `${code}0`, "0".repeat(16)]) {
    assert.equal(setupCodeMatches(code, typed), false, String(typed));
  }
  // With no code issued, nothing matches - an empty submission included.
  assert.equal(setupCodeMatches(null, ""), false);
  assert.equal(setupCodeMatches("", ""), false);

  // The comparison itself is the constant-time one, over fixed-length digests.
  const compare = t.mock.method(crypto, "timingSafeEqual");
  setupCodeMatches(code, "a much longer wrong guess than the real code is");
  assert.equal(compare.mock.callCount(), 1);
  const [left, right] = compare.mock.calls[0].arguments;
  assert.equal(left.length, 32);
  assert.equal(right.length, 32);

  assert.ok(setupCodeBanner(code).includes(`Owner setup code:   ${code}`));
});

test("creating the owner needs the code that was issued at start", async (t) => {
  const app = await startApp(t);

  // Issued once, before anything asked for it.
  assert.equal(app.setupCodes.length, 1);
  const [code] = app.setupCodes;
  assert.match(code, CODE_SHAPE);

  // The page is told that setup is needed, never what the code is.
  const bootstrap = await app.request({ path: "/api/bootstrap" });
  assert.equal(bootstrap.json.needsSetup, true);
  assert.equal(bootstrap.text.includes(code), false);
  assert.equal(JSON.stringify(app.logs).includes(code), false);

  const original = crypto.scrypt;
  let derivations = 0;
  t.mock.method(crypto, "scrypt", (...args) => {
    derivations += 1;
    return original(...args);
  });

  const account = { password: OWNER_PASSWORD, username: "intruder" };
  for (const body of [
    account,
    { ...account, setupCode: "" },
    { ...account, setupCode: "0000-0000-0000-0000" },
    { ...account, setupCode: code.slice(0, -1) },
    { ...account, setupCode: null },
    { ...account, setupCode: { $ne: "" } },
    { ...account, setupCode: false }
  ]) {
    const refused = await setup(app, body);
    assert.equal(refused.status, 403, JSON.stringify(body));
    assert.deepEqual(refused.json, { error: WRONG_CODE_ERROR });
    assert.equal(refused.headers["set-cookie"], undefined);
  }
  // Refused before any password was hashed, and nothing was created.
  assert.equal(derivations, 0);
  assert.deepEqual(await readUsers(app), []);
  assert.equal(app.setupCodes.length, 1);

  // The code is checked first: without it, nothing is said about the other fields.
  assert.equal((await setup(app, {})).status, 403);
  // With it, the usual checks apply.
  assert.equal((await setup(app, { setupCode: code })).status, 400);

  const created = await setup(app, { ...account, displayName: "Ripper Moon", setupCode: code, username: "owner" });
  assert.equal(created.status, 201);
  assert.equal(created.json.user.role, "owner");
  assert.equal(created.json.user.displayName, "Ripper Moon");
  assert.ok(created.headers["set-cookie"][0].startsWith("rippermoon_session="));
  assert.equal(JSON.stringify(created.json).includes(code), false);

  // Used up: the same code creates nothing more.
  const again = await setup(app, { ...account, setupCode: code });
  assert.equal(again.status, 409);
  assert.deepEqual(again.json, { error: "Initial setup is already complete." });
  assert.deepEqual(
    (await readUsers(app)).map((user) => `${user.username}:${user.role}`),
    ["owner:owner"]
  );
  assert.equal((await app.request({ path: "/api/bootstrap" })).json.needsSetup, false);
  assert.equal(app.setupCodes.length, 1);
});

test("a code typed without dashes, in lower case, with look-alike letters is accepted", async (t) => {
  const app = await startApp(t);
  const typed = app.setupCodes[0].replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l").toLowerCase();

  const created = await setup(app, { password: OWNER_PASSWORD, setupCode: `  ${typed} `, username: "owner" });
  assert.equal(created.status, 201);
});

test("setup requests arriving together create exactly one owner", async (t) => {
  for (const contenders of [2, 2, 2, 8]) {
    const app = await startApp(t);
    const [code] = app.setupCodes;

    const responses = await Promise.all(
      Array.from({ length: contenders }, (_, index) =>
        setup(app, { password: OWNER_PASSWORD, setupCode: code, username: `contender-${index}` })
      )
    );
    const statuses = responses.map((response) => response.status).sort();

    assert.deepEqual(statuses, [201, ...new Array(contenders - 1).fill(409)]);
    // The file is valid JSON holding the one winner, who can log in.
    const users = await readUsers(app);
    assert.equal(users.length, 1);
    assert.equal(users[0].role, "owner");
    const winner = responses.find((response) => response.status === 201);
    assert.equal(users[0].username, winner.json.user.username);
    for (const loser of responses.filter((response) => response.status === 409)) {
      assert.deepEqual(loser.json, { error: "Initial setup is already complete." });
      assert.equal(loser.headers["set-cookie"], undefined);
    }
    const login = await app.request({
      json: { password: OWNER_PASSWORD, username: users[0].username },
      method: "POST",
      path: "/api/login"
    });
    assert.equal(login.status, 200);
  }
});

test("an existing deployment gets no setup code and cannot be set up again", async (t) => {
  const root = await createRoot(t);
  const store = createStore(root);
  await store.createUser({ passwordHash: await hashSecret(OWNER_PASSWORD), role: "owner", username: "owner" });

  const app = await startApp(t, { root });
  assert.deepEqual(app.setupCodes, []);
  assert.equal((await app.request({ path: "/api/bootstrap" })).json.needsSetup, false);

  for (const body of [
    { password: OWNER_PASSWORD, username: "second-owner" },
    { password: OWNER_PASSWORD, setupCode: "", username: "second-owner" },
    { password: OWNER_PASSWORD, setupCode: "0000-0000-0000-0000", username: "second-owner" }
  ]) {
    const response = await setup(app, body);
    assert.equal(response.status, 409);
    assert.deepEqual(response.json, { error: "Initial setup is already complete." });
  }
  assert.deepEqual(app.setupCodes, []);
});

test("losing users.json while running does not hand the dashboard to the next visitor", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const usedCode = app.setupCodes[0];
  assert.equal((await owner("GET", "/api/users")).status, 200);

  await fsp.rm(path.join(app.root, "data", "users.json"));

  // The page shows the first-run screen again, and a fresh code is issued for
  // whoever can read the server's output - once, however often it is asked.
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await app.request({ path: "/api/bootstrap" })).json.needsSetup, true);
  }
  assert.equal(app.setupCodes.length, 2);
  const freshCode = app.setupCodes[1];
  assert.notEqual(freshCode, usedCode);

  // A visitor without it gets nowhere - not with nothing, not with the old code.
  const [first, second] = await Promise.all([
    setup(app, { password: OWNER_PASSWORD, username: "first" }),
    setup(app, { password: OWNER_PASSWORD, setupCode: usedCode, username: "second" })
  ]);
  assert.equal(first.status, 403);
  assert.equal(second.status, 403);
  assert.deepEqual(await readUsers(app), []);

  // The operator, who has it, recovers the installation.
  const recovered = await setup(app, { password: OWNER_PASSWORD, setupCode: freshCode, username: "owner" });
  assert.equal(recovered.status, 201);
  assert.deepEqual(
    (await readUsers(app)).map((user) => user.role),
    ["owner"]
  );
});

test("every start issues a different code, and an old one stops working", async (t) => {
  const root = await createRoot(t);
  const first = await startApp(t, { root });
  const second = await startApp(t, { root });

  assert.notEqual(first.setupCodes[0], second.setupCodes[0]);
  const stale = await setup(second, { password: OWNER_PASSWORD, setupCode: first.setupCodes[0], username: "owner" });
  assert.equal(stale.status, 403);
  const current = await setup(second, { password: OWNER_PASSWORD, setupCode: second.setupCodes[0], username: "owner" });
  assert.equal(current.status, 201);
});

test("accounts without any owner among them still need the code to gain one", async (t) => {
  const root = await createRoot(t);
  const store = createStore(root);
  await store.createUser({ passwordHash: await hashSecret(OWNER_PASSWORD), role: "admin", servers: [], username: "lane" });

  const app = await startApp(t, { root });
  assert.equal(app.setupCodes.length, 1);
  assert.equal((await app.request({ path: "/api/bootstrap" })).json.needsSetup, true);

  assert.equal((await setup(app, { password: OWNER_PASSWORD, username: "owner" })).status, 403);
  // The new owner cannot take over an existing account's name.
  const duplicate = await setup(app, { password: OWNER_PASSWORD, setupCode: app.setupCodes[0], username: "LANE" });
  assert.equal(duplicate.status, 409);
  assert.deepEqual(duplicate.json, { error: "That username already exists." });

  const created = await setup(app, { password: OWNER_PASSWORD, setupCode: app.setupCodes[0], username: "owner" });
  assert.equal(created.status, 201);
  assert.deepEqual(
    (await readUsers(app)).map((user) => `${user.username}:${user.role}`),
    ["lane:admin", "owner:owner"]
  );
});

test("by default the code goes to standard output in a banner, and not into the log", async (t) => {
  const root = await createRoot(t);
  const printed = [];
  t.mock.method(console, "log", (...args) => printed.push(args.join(" ")));
  const logged = [];
  const record = (message, meta) => logged.push(`${message} ${JSON.stringify(meta || {})}`);

  const server = await createApp(root, { logger: { error: record, info: record, warn: record } });
  t.after(() => server.close());

  assert.equal(printed.length, 1);
  const match = /Owner setup code: {3}([0-9A-Z-]{19})\n/.exec(printed[0]);
  assert.ok(match, printed[0]);
  assert.match(match[1], CODE_SHAPE);
  assert.match(printed[0], /^\n={66}\n {2}RipperCraft has no owner account yet\./);

  // The log file is readable by other local users, so it only says where to look.
  assert.equal(logged.some((line) => line.includes(match[1])), false);
  assert.equal(
    logged.filter((line) => line.includes("A setup code was printed to standard output")).length,
    1
  );
});
