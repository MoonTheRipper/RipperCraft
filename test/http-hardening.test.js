const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { once } = require("node:events");
const { createSessionManager, hashSecret, parseCookieHeader, setHashCostForTests } = require("../src/lib/auth");
const { createStore } = require("../src/lib/store");
const { SECURITY_HEADERS, sendFile } = require("../src/lib/http");
const { ADMIN_PASSWORD, OWNER_PASSWORD, request, sessionCookieFrom, startApp } = require("../test-support/app");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const EXPECTED_SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; " +
    "font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY"
};

function securityHeadersOf(response) {
  return Object.fromEntries(Object.keys(EXPECTED_SECURITY_HEADERS).map((name) => [name, response.headers[name]]));
}

// Fails the test if anything in this process throws outside a request handler,
// which is how the old static file code misbehaved.
function watchForUncaught(t) {
  const seen = [];
  const record = (error) => seen.push(error && (error.code || error.message));
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  t.after(() => {
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
  });
  return seen;
}

async function loggedInAdmin(app, owner, username = "lane", servers = ["DemoServer"]) {
  const created = await owner("POST", "/api/users", { json: { password: ADMIN_PASSWORD, servers, username } });
  assert.equal(created.status, 201);
  const admin = app.client();
  assert.equal((await admin("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username } })).status, 200);
  return { client: admin, id: created.json.user.id };
}

// --- security headers --------------------------------------------------------

test("the security headers are exactly the four agreed, with the full content security policy", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(SECURITY_HEADERS).map(([name, value]) => [name.toLowerCase(), value])),
    EXPECTED_SECURITY_HEADERS
  );
});

test("every response carries the security headers, whatever its status", async (t) => {
  const app = await startApp(t);
  const anonymous = app.client();
  const owner = await app.setupOwner();
  const cases = [];
  const collect = (label, response, status) => {
    assert.equal(response.status, status, label);
    cases.push([label, response]);
  };

  collect("the page", await anonymous("GET", "/"), 200);
  collect("a script", await anonymous("GET", "/app.js"), 200);
  collect("a stylesheet", await anonymous("GET", "/styles.css"), 200);
  collect("an image", await anonymous("GET", "/logo.png"), 200);
  collect("an app route served by the page", await anonymous("GET", "/servers/somewhere"), 200);
  collect("a missing file", await anonymous("GET", "/missing.js"), 404);
  collect("a directory", await anonymous("GET", "/js"), 404);
  collect("a non-GET outside the API", await anonymous("POST", "/"), 404);
  collect("bootstrap", await anonymous("GET", "/api/bootstrap"), 200);
  collect("login required", await anonymous("GET", "/api/servers"), 401);
  collect("a wrong password", await anonymous("POST", "/api/login", { json: { password: "nope", username: "owner" } }), 401);
  collect("invalid JSON", await anonymous("POST", "/api/login", { body: "{", headers: { "Content-Type": "application/json" } }), 400);
  collect("the wrong content type", await anonymous("POST", "/api/login", { body: "{}", headers: { "Content-Type": "text/plain" } }), 415);
  collect(
    "a body over the limit",
    await anonymous("POST", "/api/login", { body: Buffer.alloc(1024 * 1024 + 1, 0x20), headers: { "Content-Type": "application/json" } }),
    413
  );
  collect(
    "a cross-site request",
    await anonymous("POST", "/api/login", { headers: { Origin: "https://evil.example" }, json: { password: "x", username: "owner" } }),
    403
  );
  collect("an unknown API route", await owner("GET", "/api/nope"), 404);
  collect("an API success", await owner("GET", "/api/users"), 200);
  collect("a download that is not there", await owner("GET", "/api/servers/DemoServer/worlds/download?name=nope.zip"), 404);
  collect("a text download", await owner("GET", "/api/servers/DemoServer/mods/client-list"), 200);
  collect("logout", await owner("POST", "/api/logout"), 204);

  // Too many failures: the sixth attempt from one address.
  let throttled;
  for (let index = 0; index < 6; index += 1) {
    throttled = await app.request({
      headers: { "CF-Connecting-IP": "198.51.100.77" },
      json: { password: "nope", username: "owner" },
      method: "POST",
      path: "/api/login"
    });
  }
  collect("too many attempts", throttled, 429);

  // A fault inside a handler.
  await fsp.writeFile(path.join(app.root, "data", "users.json"), "{ broken");
  collect("a server error", await anonymous("GET", "/api/bootstrap"), 500);

  assert.equal(cases.length, 22);
  for (const [label, response] of cases) {
    assert.deepEqual(securityHeadersOf(response), EXPECTED_SECURITY_HEADERS, label);
    // The API still offers nothing to other origins.
    assert.equal(response.headers["access-control-allow-origin"], undefined, label);
  }
});

// --- static files and downloads ----------------------------------------------

test("asking for a directory under the site root is a prompt 404, not a hang", async (t) => {
  const uncaught = watchForUncaught(t);
  const app = await startApp(t);

  for (const urlPath of ["/js", "/js/", "/js/views", "/js/views/", "/js/actions"]) {
    for (const method of ["GET", "HEAD"]) {
      const startedAt = Date.now();
      const response = await app.request({ method, path: urlPath });
      assert.equal(response.status, 404, `${method} ${urlPath}`);
      assert.equal(response.headers["content-type"], "application/json; charset=utf-8");
      if (method === "GET") {
        assert.deepEqual(response.json, { error: "Not found." });
      }
      assert.ok(Date.now() - startedAt < 1000, `${method} ${urlPath} took too long`);
    }
  }

  // The server is still answering, and what should be served still is.
  const script = await app.request({ path: "/js/api.js" });
  assert.equal(script.status, 200);
  assert.equal(script.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(script.headers["cache-control"], "no-store, max-age=0");
  assert.equal(script.text, await fsp.readFile(path.join(__dirname, "..", "public", "js", "api.js"), "utf8"));

  const page = await app.request({ path: "/" });
  assert.equal(page.status, 200);
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8");
  // A path that is no file at all is an app route and gets the page...
  assert.equal((await app.request({ path: "/owner/admins" })).text, page.text);
  // ...unless it names a file by extension, which simply is not there.
  assert.equal((await app.request({ path: "/js/gone.js" })).status, 404);
  assert.equal((await app.request({ path: "/site.webmanifest" })).headers["content-type"], "application/manifest+json; charset=utf-8");

  const head = await app.request({ method: "HEAD", path: "/app.js" });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");

  assert.deepEqual(uncaught, []);
  assert.equal(app.logs.some((entry) => entry.level === "error"), false);
});

test("a client that hangs up before a file is opened costs nothing and breaks nothing", async (t) => {
  // pipeline() throws synchronously when its destination is already destroyed.
  // Inside the stream's "open" handler that was an uncaught exception, a
  // request that never finished, and a file descriptor that never closed.
  const uncaught = watchForUncaught(t);
  const opened = [];
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (...args) => {
    const stream = createReadStream(...args);
    opened.push(stream);
    return stream;
  });
  const target = path.join(__dirname, "..", "public", "logo.png");

  const outcomes = [];
  const server = http.createServer(async (req, res) => {
    // The connection is gone by the time the file has been opened.
    res.destroy();
    outcomes.push(await sendFile(res, target, { "Content-Type": "image/png" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  for (let index = 0; index < 5; index += 1) {
    const socket = net.connect(server.address().port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write("GET /logo.png HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
    await once(socket, "close");
  }
  const deadline = Date.now() + 3000;
  while (outcomes.length < 5 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  // Every call returned, saying there was nothing left for the caller to do...
  assert.deepEqual(outcomes, [true, true, true, true, true]);
  // ...every file that was opened has been closed again...
  assert.equal(opened.length, 5);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    opened.map((stream) => stream.destroyed),
    [true, true, true, true, true]
  );
  // ...and nothing was thrown past the handler.
  assert.deepEqual(uncaught, []);
});

test("a download whose headers cannot be sent is a 500 the client can read, with the file closed", async (t) => {
  const uncaught = watchForUncaught(t);
  const opened = [];
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (...args) => {
    const stream = createReadStream(...args);
    opened.push(stream);
    return stream;
  });
  const target = path.join(__dirname, "..", "public", "logo.png");

  // A server folder may be named in any script; an HTTP header may not.
  const server = http.createServer(async (req, res) => {
    try {
      await sendFile(res, target, { "Content-Disposition": 'attachment; filename="\u4e16\u754c-active-world.zip"' });
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: error.code }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const response = await request(server.address().port, { path: "/" });
  assert.equal(response.status, 500);
  assert.deepEqual(response.json, { code: "ERR_INVALID_CHAR" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(
    opened.map((stream) => stream.destroyed),
    [true]
  );
  assert.deepEqual(uncaught, []);
});

test("files outside the site root are never served", async (t) => {
  const app = await startApp(t);
  await app.setupOwner();

  async function raw(target) {
    const socket = net.connect(app.port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
    });
    await once(socket, "close");
    return received;
  }

  for (const target of [
    "/../data/users.json",
    "/..%2f..%2fdata%2fusers.json",
    "/%2e%2e/%2e%2e/data/app.json",
    "/js/../../data/users.json",
    "/js/%2e%2e/%2e%2e/data/users.json",
    "//data/app.json",
    "/data/app.json",
    "/..\\..\\data\\app.json"
  ]) {
    const response = await raw(target);
    assert.match(response, /^HTTP\/1\.1 404 /, target);
    assert.equal(/cookieSecret|passwordHash/.test(response), false, target);
  }
});

test("a world archive that is not there is a 404, and a bad name a 400", async (t) => {
  const uncaught = watchForUncaught(t);
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const library = path.join(app.root, "servers", "DemoServer", ".rippermoon", "world-library");
  await fsp.mkdir(path.join(library, "a-directory.zip"), { recursive: true });
  const archive = crypto.randomBytes(70_000);
  await fsp.writeFile(path.join(library, "kept-world.zip"), archive);
  const download = (query) => owner("GET", `/api/servers/DemoServer/worlds/download${query}`);

  for (const query of ["?name=never-existed.zip", "?name=a-directory.zip", "?name=.", "?name=kept-world", "?name=%2Fetc%2Fpasswd"]) {
    const startedAt = Date.now();
    const response = await download(query);
    assert.equal(response.status, 404, query);
    assert.deepEqual(response.json, { error: "That world archive does not exist." }, query);
    assert.ok(Date.now() - startedAt < 1000, `${query} took too long`);
  }
  for (const query of ["", "?name=", "?other=x"]) {
    const response = await download(query);
    assert.equal(response.status, 400, query);
    assert.deepEqual(response.json, { error: "Archive name is required." }, query);
  }
  const outside = await download("?name=..");
  assert.equal(outside.status, 400);
  assert.deepEqual(outside.json, { error: "Invalid archive path." });

  // One that is there still downloads, whole.
  const found = await download("?name=kept-world.zip");
  assert.equal(found.status, 200);
  assert.equal(found.headers["content-type"], "application/zip");
  assert.equal(found.headers["content-disposition"], 'attachment; filename="kept-world.zip"');
  assert.ok(found.buffer.equals(archive));

  // The server is still up, and nothing escaped the request handler.
  assert.equal((await owner("GET", "/api/session")).json.loggedIn, true);
  assert.deepEqual(uncaught, []);
});

test("exporting the active world still streams a zip", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();

  const exported = await owner("GET", "/api/servers/DemoServer/worlds/export-active");
  assert.equal(exported.status, 200);
  assert.equal(exported.headers["content-type"], "application/zip");
  assert.equal(exported.headers["content-disposition"], 'attachment; filename="DemoServer-active-world.zip"');
  // "PK": a zip local file header.
  assert.equal(exported.buffer.subarray(0, 2).toString("latin1"), "PK");
});

test("a request URL that cannot be parsed is a 400", async (t) => {
  const app = await startApp(t);
  const socket = net.connect(app.port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write("GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  await once(socket, "close");

  assert.match(received, /^HTTP\/1\.1 400 /);
  assert.match(received, /"error":"The request URL is not valid\."/);
  assert.match(received, /X-Content-Type-Options: nosniff/i);
});

// --- cookies -----------------------------------------------------------------

test("a cookie that cannot be decoded is ignored, not fatal", async (t) => {
  assert.deepEqual(parseCookieHeader("a=1; bad=%E0%A4%A; b=two%20words; alsobad=%; c=x=y"), {
    a: "1",
    b: "two words",
    c: "x=y"
  });
  assert.deepEqual(parseCookieHeader(""), {});
  assert.deepEqual(parseCookieHeader(undefined), {});
  assert.deepEqual(parseCookieHeader("; =nameless; lonely"), { lonely: "" });

  const app = await startApp(t);
  const owner = await app.setupOwner();

  // Somebody else's cookie on the same host, with a stray percent sign.
  const stranger = await app.request({ headers: { Cookie: "other=%E0%A4%A" }, path: "/api/bootstrap" });
  assert.equal(stranger.status, 200);
  assert.equal(stranger.json.loggedIn, false);

  // It does not cost a logged-in user their session either, wherever it sits.
  for (const cookie of [`other=%E0%A4%A; ${owner.cookie()}`, `${owner.cookie()}; other=%`, `a=%zz; ${owner.cookie()}; b=%`]) {
    const response = await app.request({ headers: { Cookie: cookie }, path: "/api/session" });
    assert.equal(response.status, 200, cookie);
    assert.equal(response.json.loggedIn, true, cookie);
  }

  // A mangled session cookie is just not a session.
  for (const cookie of ["rippermoon_session=%E0%A4%A", "rippermoon_session=%", "rippermoon_session=sess_x.notasignature", "rippermoon_session="]) {
    const response = await app.request({ headers: { Cookie: cookie }, path: "/api/session" });
    assert.equal(response.status, 200, cookie);
    assert.deepEqual(response.json, { loggedIn: false, user: null }, cookie);
  }
  assert.equal(app.logs.some((entry) => entry.level === "error"), false);
});

test("the session cookie is Secure exactly when a loopback proxy says the visitor used HTTPS", async (t) => {
  const app = await startApp(t);
  const setup = await app.request({
    headers: { "X-Forwarded-Proto": "https" },
    json: { password: OWNER_PASSWORD, setupCode: app.setupCodes[0], username: "owner" },
    method: "POST",
    path: "/api/setup-owner"
  });
  assert.equal(setup.status, 201);
  assert.match(setup.headers["set-cookie"][0], /; Secure$/);

  const login = (headers) =>
    app.request({ headers, json: { password: OWNER_PASSWORD, username: "owner" }, method: "POST", path: "/api/login" });
  const cookieShape = /^rippermoon_session=sess_[0-9a-f]{16}\.[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\/; Max-Age=86400$/;

  // Plain HTTP - a browser on the LAN, or curl on the box: the cookie is the
  // one the previous version set, attribute for attribute.
  const plain = await login({});
  assert.equal(plain.headers["set-cookie"].length, 1);
  assert.match(plain.headers["set-cookie"][0], cookieShape);
  assert.match((await login({ "X-Forwarded-Proto": "http" })).headers["set-cookie"][0], cookieShape);
  assert.match((await login({ "CF-Visitor": '{"scheme":"http"}' })).headers["set-cookie"][0], cookieShape);

  // Through the tunnel: the same cookie, plus Secure.
  for (const headers of [
    { "X-Forwarded-Proto": "https" },
    { "CF-Visitor": '{"scheme":"https"}' },
    { "CF-Connecting-IP": "203.0.113.9", "CF-Visitor": '{"scheme":"https"}', "X-Forwarded-Proto": "https" }
  ]) {
    const cookie = (await login(headers)).headers["set-cookie"][0];
    assert.match(cookie, /; Secure$/, JSON.stringify(headers));
    assert.match(cookie.replace(/; Secure$/, ""), cookieShape);
  }

  // Logging out clears it with the matching attribute.
  const session = sessionCookieFrom(plain);
  const logout = (headers) =>
    app.request({ headers: { "Content-Type": "application/json", Cookie: session, ...headers }, method: "POST", path: "/api/logout" });
  assert.deepEqual((await logout({ "X-Forwarded-Proto": "https" })).headers["set-cookie"], [
    "rippermoon_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure"
  ]);
  assert.deepEqual((await logout({})).headers["set-cookie"], ["rippermoon_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"]);
});

// --- session revocation ------------------------------------------------------

test("destroyUserSessions ends one user's sessions and can spare the caller's", async () => {
  const sessions = createSessionManager(async () => ({ cookieSecret: "s", sessionTtlHours: 24, unlockTtlMinutes: 20 }));
  const cookieFor = async (session) => ({ headers: { cookie: (await sessions.serializeSessionCookie(session)).split(";")[0] } });
  const laneA = await sessions.createSession("usr_lane");
  const laneB = await sessions.createSession("usr_lane");
  const laneC = await sessions.createSession("usr_lane");
  const moss = await sessions.createSession("usr_moss");

  assert.equal(sessions.destroyUserSessions("usr_lane", { exceptSessionId: laneB.id }), 2);
  assert.equal(await sessions.getSessionFromRequest(await cookieFor(laneA)), null);
  assert.equal(await sessions.getSessionFromRequest(await cookieFor(laneC)), null);
  assert.equal((await sessions.getSessionFromRequest(await cookieFor(laneB))).id, laneB.id);
  assert.equal((await sessions.getSessionFromRequest(await cookieFor(moss))).id, moss.id);

  assert.equal(sessions.destroyUserSessions("usr_lane"), 1);
  assert.equal(sessions.destroyUserSessions("usr_lane"), 0);
  assert.equal(sessions.destroyUserSessions("usr_nobody"), 0);
  assert.equal((await sessions.getSessionFromRequest(await cookieFor(moss))).id, moss.id);
});

test("a password reset logs that user out everywhere, and nobody else", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const lane = await loggedInAdmin(app, owner, "lane");
  const moss = await loggedInAdmin(app, owner, "moss");
  // The same admin on a second device.
  const laneElsewhere = app.client();
  await laneElsewhere("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "lane" } });
  for (const who of [lane.client, laneElsewhere, moss.client]) {
    assert.equal((await who("GET", "/api/servers")).status, 200);
  }

  const reset = await owner("POST", `/api/users/${lane.id}/reset-password`, { json: { password: "a-new-password-1" } });
  assert.equal(reset.status, 200);

  // Both of lane's sessions are gone; the old cookie is now just a stranger's.
  for (const who of [lane.client, laneElsewhere]) {
    assert.equal((await who("GET", "/api/servers")).status, 401);
    assert.deepEqual((await who("GET", "/api/session")).json, { loggedIn: false, user: null });
  }
  // The owner who did it, and the other admin, carry on.
  assert.equal((await owner("GET", "/api/users")).status, 200);
  assert.equal((await moss.client("GET", "/api/servers")).status, 200);

  // The old password is dead; the new one opens a fresh session.
  const login = (password) => lane.client("POST", "/api/login", { json: { password, username: "lane" } });
  assert.equal((await login(ADMIN_PASSWORD)).status, 401);
  assert.equal((await login("a-new-password-1")).status, 200);
  assert.equal((await lane.client("GET", "/api/servers")).status, 200);

  assert.deepEqual(app.logs.find((entry) => entry.message === "Password reset").meta, {
    actor: "owner",
    endedSessions: 2,
    username: "lane"
  });
});

test("changing a password in the account editor does the same; other edits do not", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const lane = await loggedInAdmin(app, owner, "lane");
  const edit = (password) =>
    owner("PUT", `/api/users/${lane.id}`, {
      json: { displayName: "Lane", password, role: "admin", servers: ["DemoServer"], username: "lane" }
    });

  // Renaming, re-scoping, leaving the password blank: the session survives.
  assert.equal((await edit("")).status, 200);
  assert.equal((await edit(undefined)).status, 200);
  assert.equal((await lane.client("GET", "/api/servers")).status, 200);

  assert.equal((await edit("changed-password-2")).status, 200);
  assert.equal((await lane.client("GET", "/api/servers")).status, 401);
  assert.equal((await owner("GET", "/api/users")).status, 200);
});

test("an owner changing their own password keeps this session and ends their others", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const ownerElsewhere = app.client();
  await ownerElsewhere("POST", "/api/login", { json: { password: OWNER_PASSWORD, username: "owner" } });
  const ownerId = (await owner("GET", "/api/session")).json.user.id;

  const changed = await owner("PUT", `/api/users/${ownerId}`, {
    json: { displayName: "Owner", password: "my-next-password-3", role: "owner", username: "owner" }
  });
  assert.equal(changed.status, 200);

  assert.equal((await owner("GET", "/api/users")).status, 200);
  assert.equal((await ownerElsewhere("GET", "/api/users")).status, 401);

  // The same through the reset dialog.
  await ownerElsewhere("POST", "/api/login", { json: { password: "my-next-password-3", username: "owner" } });
  assert.equal((await ownerElsewhere("GET", "/api/users")).status, 200);
  assert.equal(
    (await owner("POST", `/api/users/${ownerId}/reset-password`, { json: { password: "my-third-password-4" } })).status,
    200
  );
  assert.equal((await owner("GET", "/api/users")).status, 200);
  assert.equal((await ownerElsewhere("GET", "/api/users")).status, 401);
});

test("a login that was already being checked when the password was reset gets no usable session", async (t) => {
  // Someone holding the old password only has to keep logging in: one attempt
  // is always part-way through its check, and it used to come out the other
  // side of the reset with a brand new session.
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const lane = await loggedInAdmin(app, owner, "lane");

  // Hold every password check open until told to continue.
  const realScrypt = crypto.scrypt;
  const held = [];
  let holding = true;
  t.mock.method(crypto, "scrypt", (...args) => {
    if (holding) {
      held.push(() => realScrypt(...args));
    } else {
      realScrypt(...args);
    }
  });
  const release = () => {
    holding = false;
    while (held.length) {
      held.shift()();
    }
  };

  const intruder = app.client();
  const inFlight = intruder("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "lane" } });
  const deadline = Date.now() + 3000;
  while (held.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(held.length, 1, "the login never reached its password check");

  // The reset happens now, while that check is suspended. (It hashes the new
  // password, so it has to be let through; the held login stays held.)
  const resetting = owner("POST", `/api/users/${lane.id}/reset-password`, { json: { password: "after-the-reset-1" } });
  while (held.length < 2 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  held.pop()();
  assert.equal((await resetting).status, 200);

  // Now the suspended login finishes checking the old password.
  release();
  const late = await inFlight;

  // Whatever it was told, it must not be logged in.
  assert.equal(late.status, 401);
  assert.equal(late.headers["set-cookie"], undefined);
  assert.equal((await intruder("GET", "/api/servers")).status, 401);
  // The session lane had before the reset is gone as well, and the new password works.
  assert.equal((await lane.client("GET", "/api/servers")).status, 401);
  assert.equal(
    (await app.request({ json: { password: "after-the-reset-1", username: "lane" }, method: "POST", path: "/api/login" })).status,
    200
  );
});

test("none of the logins racing a password change keeps a session", async (t) => {
  // The same thing without holding anything open: sign in over and over on the
  // old password while it is being changed, as someone who had stolen it might.
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const lane = await loggedInAdmin(app, owner, "lane");

  for (const change of ["reset", "edit"]) {
    const oldPassword = change === "reset" ? ADMIN_PASSWORD : "after-the-reset-1";
    const newPassword = change === "reset" ? "after-the-reset-1" : "after-the-edit-22";
    const attempts = [];
    const signIn = async () => {
      const client = app.client();
      const response = await client("POST", "/api/login", { json: { password: oldPassword, username: "lane" } });
      return { client, status: response.status };
    };
    for (let index = 0; index < 12; index += 1) {
      attempts.push(signIn());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const changed =
      change === "reset"
        ? owner("POST", `/api/users/${lane.id}/reset-password`, { json: { password: newPassword } })
        : owner("PUT", `/api/users/${lane.id}`, {
            json: { displayName: "Lane", password: newPassword, role: "admin", servers: ["DemoServer"], username: "lane" }
          });
    for (let index = 0; index < 12; index += 1) {
      attempts.push(signIn());
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal((await changed).status, 200);
    const settled = await Promise.all(attempts);

    // Some were told 200 and some 401, depending on when they landed; what
    // matters is that not one of those sessions works now.
    assert.ok(settled.some((attempt) => attempt.status === 200), "no login got in before the change at all");
    for (const attempt of settled) {
      assert.equal((await attempt.client("GET", "/api/servers")).status, 401, `${change}: a session outlived the change`);
    }
    assert.equal(
      (await app.request({ json: { password: newPassword, username: "lane" }, method: "POST", path: "/api/login" })).status,
      200
    );
  }
});

test("a session stops working when the account's stored password is no longer the one it was opened with", async (t) => {
  // Even a change that revoked nothing: the session is checked against the
  // account every time it is used.
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const lane = await loggedInAdmin(app, owner, "lane");
  assert.equal((await lane.client("GET", "/api/servers")).status, 200);

  const store = createStore(app.root);
  await store.updateUser(lane.id, { passwordHash: await hashSecret("changed-behind-the-app") });

  assert.equal((await lane.client("GET", "/api/servers")).status, 401);
  assert.deepEqual((await lane.client("GET", "/api/session")).json, { loggedIn: false, user: null });
  // Other accounts' sessions are untouched, and edits that leave the password alone end nothing.
  assert.equal((await owner("GET", "/api/users")).status, 200);
  await store.updateUser((await owner("GET", "/api/session")).json.user.id, { displayName: "Renamed" });
  assert.equal((await owner("GET", "/api/session")).json.user.displayName, "Renamed");
});

test("logging in again after a hash upgrade does not end other sessions", async (t) => {
  // The transparent rehash on login is not a password change.
  const app = await startApp(t);
  const owner = await app.setupOwner();
  setHashCostForTests({ ln: 11, r: 8, p: 1 });
  t.after(() => setHashCostForTests({ ln: 10, r: 8, p: 1 }));

  const second = app.client();
  assert.equal((await second("POST", "/api/login", { json: { password: OWNER_PASSWORD, username: "owner" } })).status, 200);
  const users = JSON.parse(await fsp.readFile(path.join(app.root, "data", "users.json"), "utf8")).users;
  assert.match(users[0].passwordHash, /^\$scrypt\$ln=11,/);

  assert.equal((await owner("GET", "/api/users")).status, 200);
  assert.equal((await second("GET", "/api/users")).status, 200);
});

// --- cross-site request checks -----------------------------------------------

test("calls that change something must be sent as JSON", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const credentials = JSON.stringify({ password: OWNER_PASSWORD, username: "owner" });
  const loginAs = (contentType) =>
    app.request({
      body: credentials,
      headers: contentType === null ? {} : { "Content-Type": contentType },
      method: "POST",
      path: "/api/login"
    });

  // What a form on another site can send: never JSON.
  for (const contentType of [null, "text/plain", "text/plain; charset=utf-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp", "text/json"]) {
    const response = await loginAs(contentType);
    assert.equal(response.status, 415, String(contentType));
    assert.deepEqual(response.json, { error: "Send this request with Content-Type: application/json." });
    assert.equal(response.headers["set-cookie"], undefined);
  }
  for (const contentType of ["application/json", "application/json; charset=utf-8", "Application/JSON", " application/json ;charset=UTF-8"]) {
    assert.equal((await loginAs(contentType)).status, 200, contentType);
  }

  // Logged in, on a route that creates an account.
  const sneaky = await owner("POST", "/api/users", {
    body: JSON.stringify({ password: ADMIN_PASSWORD, username: "viaform" }),
    headers: { "Content-Type": "text/plain" }
  });
  assert.equal(sneaky.status, 415);
  assert.deepEqual(
    (await owner("GET", "/api/users")).json.users.map((user) => user.username),
    ["owner"]
  );

  // Calls with no body are held to it as well, on every changing method.
  for (const [method, urlPath] of [
    ["POST", "/api/servers/DemoServer/start"],
    ["POST", "/api/servers/DemoServer/stop"],
    ["DELETE", "/api/servers/DemoServer"],
    ["PUT", "/api/servers/DemoServer/settings"],
    ["PATCH", "/api/servers/DemoServer"],
    ["POST", "/api/settings/integrations/test"],
    ["POST", "/api/logout"],
    ["POST", "/api/nope"]
  ]) {
    const response = await app.request({ headers: { Cookie: owner.cookie() }, method, path: urlPath });
    assert.equal(response.status, 415, `${method} ${urlPath}`);
  }
  // That logout did not happen.
  assert.equal((await owner("GET", "/api/session")).json.loggedIn, true);

  // Reading is unaffected, and so is being told to log in first.
  assert.equal((await app.request({ headers: { Cookie: owner.cookie() }, path: "/api/users" })).status, 200);
  assert.equal((await app.request({ body: "x", headers: { "Content-Type": "text/plain" }, method: "POST", path: "/api/users" })).status, 401);
});

test("a request from another site's page is refused; our own page and plain scripts are not", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const host = `127.0.0.1:${app.port}`;
  const createUser = (headers, username) =>
    app.request({
      headers: { Cookie: owner.cookie(), ...headers },
      json: { password: ADMIN_PASSWORD, username },
      method: "POST",
      path: "/api/users"
    });
  const usernames = async () => (await owner("GET", "/api/users")).json.users.map((user) => user.username);

  // Valid session, JSON body, but the browser says the page was someone else's.
  for (const origin of [
    "https://evil.example",
    "http://evil.example",
    `http://127.0.0.1:${app.port + 1}`,
    "http://127.0.0.1",
    `http://localhost:${app.port}`,
    `http://127.0.0.1:${app.port}.evil.example`,
    `http://evil.example/?${host}`,
    "null",
    "",
    "file://",
    "chrome-extension://abcdefghijklmnop",
    "not a url"
  ]) {
    const response = await createUser({ Origin: origin }, "planted");
    assert.equal(response.status, 403, origin);
    assert.match(response.json.error, /^This request came from another site and was refused\./, origin);
  }
  assert.deepEqual(await usernames(), ["owner"]);

  // The dashboard's own page, however the browser spells the origin.
  assert.equal((await createUser({ Origin: `http://${host}` }, "same-origin")).status, 201);
  assert.equal((await createUser({ Origin: `HTTP://${host}/` }, "same-origin-2")).status, 201);
  // No Origin at all: curl, a script, a test.
  assert.equal((await createUser({}, "no-origin")).status, 201);

  // Behind the tunnel the Host header is the public name, not this address.
  assert.equal((await createUser({ Host: "dash.example.com", Origin: "https://dash.example.com" }, "tunnel")).status, 201);
  assert.equal((await createUser({ Host: "Dash.Example.com:443", Origin: "https://dash.example.com" }, "tunnel-port")).status, 201);
  assert.equal((await createUser({ Host: "dash.example.com:80", Origin: "http://DASH.example.com" }, "tunnel-http")).status, 201);
  assert.equal((await createUser({ Host: "dash.example.com", Origin: "https://dash.example.com:8443" }, "x")).status, 403);
  assert.equal((await createUser({ Host: "dash.example.com", Origin: "https://dash.example.com.evil.net" }, "x")).status, 403);
  assert.equal((await createUser({ Host: "dash.example.com", Origin: "https://evil.net" }, "x")).status, 403);

  // Logging in and logging out are protected too, before any password is checked.
  const login = await app.request({
    headers: { Origin: "https://evil.example" },
    json: { password: OWNER_PASSWORD, username: "owner" },
    method: "POST",
    path: "/api/login"
  });
  assert.equal(login.status, 403);
  assert.equal(login.headers["set-cookie"], undefined);
  const logout = await app.request({
    headers: { "Content-Type": "application/json", Cookie: owner.cookie(), Origin: "https://evil.example" },
    method: "POST",
    path: "/api/logout"
  });
  assert.equal(logout.status, 403);
  assert.equal((await owner("GET", "/api/session")).json.loggedIn, true);

  // The two upload routes take multipart bodies, which is the one kind of
  // request a plain form on another site can send. They have no JSON rule to
  // fall back on, so the Origin check is what stands in the way.
  const boundary = "----ForeignFormBoundary";
  const form = (field, name) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\n\r\nplanted\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="confirmManualCompatibility"\r\n\r\ntrue\r\n--${boundary}--\r\n`;
  assert.equal(
    (await owner("PUT", "/api/servers/DemoServer/settings", { json: { loader: "fabric", passphrase: "lane-secret" } })).status,
    200
  );
  for (const [urlPath, field, name] of [
    ["/api/servers/DemoServer/mods/upload", "file", "planted.jar"],
    ["/api/servers/DemoServer/worlds/import", "archive", "planted.zip"]
  ]) {
    const send = (headers) =>
      app.request({
        body: form(field, name),
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, Cookie: owner.cookie(), ...headers },
        method: "POST",
        path: urlPath
      });
    assert.equal((await send({ Origin: "https://evil.example" })).status, 403, urlPath);
    assert.equal((await send({ Origin: "null" })).status, 403, urlPath);
    assert.equal((await send({ Origin: `http://${host}` })).status, 201, urlPath);
  }
  const serverDir = path.join(app.root, "servers", "DemoServer");
  assert.deepEqual(await fsp.readdir(path.join(serverDir, "mods")), ["planted.jar"]);
  assert.equal((await fsp.readdir(path.join(serverDir, ".rippermoon", "world-library"))).length, 1);

  // Reading is not blocked by Origin, and gets no permission to be read cross-site.
  const read = await app.request({ headers: { Origin: "https://evil.example" }, path: "/api/bootstrap" });
  assert.equal(read.status, 200);
  assert.equal(read.headers["access-control-allow-origin"], undefined);

  const refused = app.logs.filter((entry) => entry.message === "Cross-site request refused");
  assert.equal(refused.length, 21);
  assert.deepEqual(refused[0].meta, { host, method: "POST", origin: "https://evil.example", path: "/api/users" });
});

test("a proxy that rewrites Host can be allowed for by listing the dashboard's origins", async (t) => {
  const warnings = [];
  const app = await startApp(t, {
    app: { trustedOrigins: " https://dash.example.com , https://www.example.com/ignored-path, ftp://nope, junk " }
  });
  warnings.push(...app.logs.filter((entry) => entry.level === "warn").map((entry) => entry.meta.entry));
  assert.deepEqual(warnings, ["ftp://nope", "junk"]);

  const setupFrom = (origin, username) =>
    app.request({
      // The proxy talks to us by address, so that is what Host says.
      headers: { Host: "127.0.0.1:4300", Origin: origin },
      json: { password: OWNER_PASSWORD, setupCode: app.setupCodes[0], username },
      method: "POST",
      path: "/api/setup-owner"
    });

  assert.equal((await setupFrom("https://evil.example", "owner")).status, 403);
  assert.equal((await setupFrom("http://dash.example.com", "owner")).status, 403);
  assert.equal((await setupFrom("https://dash.example.com", "owner")).status, 201);
  const login = await app.request({
    headers: { Host: "127.0.0.1:4300", Origin: "https://www.example.com" },
    json: { password: OWNER_PASSWORD, username: "owner" },
    method: "POST",
    path: "/api/login"
  });
  assert.equal(login.status, 200);
});

test("an Origin with no Host header to compare it with is refused", async (t) => {
  const app = await startApp(t);
  // HTTP/1.0 allows a request without Host. No browser sends one, so an Origin
  // arriving this way cannot be shown to be ours.
  const body = JSON.stringify({ password: OWNER_PASSWORD, setupCode: app.setupCodes[0], username: "owner" });
  const socket = net.connect(app.port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(
    `POST /api/setup-owner HTTP/1.0\r\nOrigin: http://undefined\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`
  );
  let received = "";
  socket.on("data", (chunk) => {
    received += chunk.toString("latin1");
  });
  await once(socket, "close");

  assert.match(received, /^HTTP\/1\.[01] 403 /);
  assert.equal((await app.request({ path: "/api/bootstrap" })).json.needsSetup, true);
});
