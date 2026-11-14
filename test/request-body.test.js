const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { once } = require("node:events");
const { setHashCostForTests } = require("../src/lib/auth");
const { JSON_BODY_LIMIT_BYTES } = require("../src/lib/http");
const { startApp } = require("../test-support/app");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const MEGABYTE = 1024 * 1024;
const TOO_LARGE = { error: "The request body is larger than the 1 MB allowed here." };

// A raw connection, so the test decides exactly which bytes are sent and when,
// and can see when the server closes its side.
async function connect(port) {
  const socket = net.connect(port, "127.0.0.1");
  const state = { closedAt: null, received: "", startedAt: Date.now() };
  socket.on("data", (chunk) => {
    state.received += chunk.toString("latin1");
  });
  socket.on("error", () => {});
  socket.on("close", () => {
    state.closedAt = Date.now();
  });
  await once(socket, "connect");

  async function waitFor(check, what, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for ${what}; received so far: ${JSON.stringify(state.received.slice(0, 200))}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  return {
    socket,
    state,
    // The status code and parsed JSON body of the first response on the wire.
    async response() {
      await waitFor(() => /\r\n\r\n[\s\S]*\n/.test(state.received), "a response");
      const [head, ...rest] = state.received.split("\r\n\r\n");
      const text = rest.join("\r\n\r\n");
      const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      return { head, json, status: Number(head.split(" ")[1]) };
    },
    waitForClose: (timeoutMs) => waitFor(() => state.closedAt !== null, "the server to close the connection", timeoutMs)
  };
}

function head(method, path, headers) {
  return [`${method} ${path} HTTP/1.1`, "Host: 127.0.0.1", ...headers, "", ""].join("\r\n");
}

test("the JSON body limit is one megabyte", () => {
  assert.equal(JSON_BODY_LIMIT_BYTES, MEGABYTE);
});

test("a login body that declares more than the limit is refused without being read", async (t) => {
  const app = await startApp(t);
  const connection = await connect(app.port);

  // 32 MB promised, a few bytes sent. An answer can only arrive if the server
  // did not wait for the rest.
  connection.socket.write(
    head("POST", "/api/login", ["Content-Type: application/json", `Content-Length: ${32 * MEGABYTE}`]) + '{"username":"owner"'
  );
  const response = await connection.response();
  assert.equal(response.status, 413);
  assert.deepEqual(response.json, TOO_LARGE);
  const answeredAfter = Date.now() - connection.state.startedAt;
  assert.ok(answeredAfter < 1000, `took ${answeredAfter} ms to refuse`);

  // The rest never comes, so the connection is not kept: it is closed after a
  // short grace period rather than held open for the full request timeout.
  await connection.waitForClose(5000);
  const closedAfter = connection.state.closedAt - connection.state.startedAt;
  assert.ok(closedAfter >= 1500 && closedAfter < 4500, `closed after ${closedAfter} ms`);
});

test("a body with no declared length is cut off at the first byte over the limit", async (t) => {
  const app = await startApp(t);
  const connection = await connect(app.port);
  connection.socket.write(head("POST", "/api/login", ["Content-Type: application/json", "Transfer-Encoding: chunked"]));

  // Feed 64 KB chunks for as long as the server will take them.
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const frame = Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")]);
  let sent = 0;
  let sentWhenAnswered = null;
  const feeder = setInterval(() => {
    if (connection.state.closedAt !== null || connection.socket.destroyed) {
      clearInterval(feeder);
      return;
    }
    if (sentWhenAnswered === null && connection.state.received.includes("\r\n\r\n")) {
      sentWhenAnswered = sent;
    }
    if (connection.socket.writableLength < MEGABYTE) {
      connection.socket.write(frame);
      sent += chunk.length;
    }
  }, 1);
  t.after(() => clearInterval(feeder));

  const response = await connection.response();
  assert.equal(response.status, 413);
  assert.deepEqual(response.json, TOO_LARGE);

  // The refusal came as the limit was crossed, not after some larger amount.
  await connection.waitForClose(6000);
  clearInterval(feeder);
  assert.ok(sentWhenAnswered !== null);
  assert.ok(sentWhenAnswered <= 4 * MEGABYTE, `the answer only came after ${sentWhenAnswered} bytes`);

  // And the stream that kept coming was not allowed to continue for long.
  const closedAfter = connection.state.closedAt - connection.state.startedAt;
  assert.ok(closedAfter < 5000, `still open after ${closedAfter} ms`);
});

test("a client that sends the whole oversized body still receives the 413", async (t) => {
  const app = await startApp(t);

  // An ordinary HTTP client: it writes all 32 MB before reading the answer. If
  // the server slammed the connection shut it would see a reset instead.
  for (const path of ["/api/login", "/api/setup-owner"]) {
    const response = await app.request({
      body: Buffer.alloc(32 * MEGABYTE, 0x61),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      path
    });
    assert.equal(response.status, 413, path);
    assert.deepEqual(response.json, TOO_LARGE, path);
  }

  const refused = app.logs.filter((entry) => entry.message === "HTTP request refused");
  assert.equal(refused.length, 2);
  assert.equal(refused[0].meta.statusCode, 413);
  assert.equal("stack" in refused[0].meta, false);
  assert.equal(app.logs.some((entry) => entry.level === "error"), false);
});

test("a body exactly at the limit is accepted", async (t) => {
  const app = await startApp(t);
  await app.setupOwner();

  const frame = '{"username":"owner","password":""}';
  const padded = `{"username":"owner","password":"${"p".repeat(JSON_BODY_LIMIT_BYTES - frame.length)}"}`;
  assert.equal(Buffer.byteLength(padded), JSON_BODY_LIMIT_BYTES);

  const atLimit = await app.request({ body: padded, headers: { "Content-Type": "application/json" }, method: "POST", path: "/api/login" });
  // Read, parsed and treated as a wrong password.
  assert.equal(atLimit.status, 401);

  const overByOne = await app.request({
    body: `${padded} `,
    headers: { "Content-Type": "application/json" },
    method: "POST",
    path: "/api/login"
  });
  assert.equal(overByOne.status, 413);
});

test("bodies that are not a JSON object are client errors, not server faults", async (t) => {
  const app = await startApp(t);
  await app.setupOwner();
  const post = (body) =>
    app.request({ body, headers: { "Content-Type": "application/json" }, method: "POST", path: "/api/login" });

  for (const body of ["{not json", '{"username":', "\u0000\u0001", "undefined"]) {
    const response = await post(body);
    assert.equal(response.status, 400, body);
    assert.deepEqual(response.json, { error: "The request body is not valid JSON." }, body);
  }
  for (const body of ["null", "[]", '["owner","password"]', "42", '"owner"', "true"]) {
    const response = await post(body);
    assert.equal(response.status, 400, body);
    assert.deepEqual(response.json, { error: "The request body must be a JSON object." }, body);
  }

  // No body at all is an empty form: a failed login, as before.
  assert.equal((await post(undefined)).status, 401);
  assert.equal((await post("{}")).status, 401);

  // None of that was logged as a server error, and none of it echoed the body.
  assert.equal(app.logs.some((entry) => entry.level === "error"), false);
});

test("a request that is refused before its body is read does not get to keep sending", async (t) => {
  const app = await startApp(t);
  await app.setupOwner();

  // Not logged in, on a route that needs the owner: answered straight away,
  // although 32 MB was announced and none of it has arrived.
  const connection = await connect(app.port);
  connection.socket.write(head("POST", "/api/users", ["Content-Type: application/json", `Content-Length: ${32 * MEGABYTE}`]));
  const response = await connection.response();
  assert.equal(response.status, 401);
  assert.deepEqual(response.json, { error: "Login required." });
  assert.ok(Date.now() - connection.state.startedAt < 1000);
  await connection.waitForClose(5000);

  // A well-behaved client on a kept-alive connection is not affected: the
  // refused request's small body arrives in full, and the next one is served.
  const polite = await connect(app.port);
  const body = '{"username":"lane","password":"some-password-1"}';
  polite.socket.write(head("POST", "/api/users", ["Content-Type: application/json", `Content-Length: ${body.length}`]) + body);
  assert.equal((await polite.response()).status, 401);
  polite.state.received = "";
  polite.socket.write(head("GET", "/api/session", []));
  const second = await polite.response();
  assert.equal(second.status, 200);
  assert.deepEqual(second.json, { loggedIn: false, user: null });
  await new Promise((resolve) => setTimeout(resolve, 2300));
  assert.equal(polite.state.closedAt, null, "a connection whose request arrived in full was closed anyway");
  polite.socket.destroy();
});

test("a kept-alive connection can be answered early any number of times without piling up listeners", async (t) => {
  const app = await startApp(t);
  await app.setupOwner();
  const warnings = [];
  const onWarning = (warning) => warnings.push(`${warning.name}: ${warning.message}`);
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));

  // Each request is refused (not logged in) as soon as its headers arrive; its
  // small body only follows once the answer has been read. The connection is
  // healthy every time, so it is kept - twenty-five times over.
  const connection = await connect(app.port);
  const body = '{"x":1}';
  for (let index = 0; index < 25; index += 1) {
    connection.state.received = "";
    connection.socket.write(head("POST", "/api/users", ["Content-Type: application/json", `Content-Length: ${body.length}`]));
    const response = await connection.response();
    assert.equal(response.status, 401, `request ${index + 1}`);
    connection.socket.write(body);
  }
  // Long enough for every grace period to have run out.
  await new Promise((resolve) => setTimeout(resolve, 2300));

  assert.equal(connection.state.closedAt, null, "the connection was closed although every body arrived");
  connection.state.received = "";
  connection.socket.write(head("GET", "/api/session", []));
  assert.equal((await connection.response()).status, 200);
  assert.deepEqual(warnings, []);
  connection.socket.destroy();
});
