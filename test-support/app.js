// Shared by the tests that drive the dashboard over real HTTP. It lives outside
// test/ because `node --test` runs every file in there as a test of its own.
//
// Each app gets a throwaway root directory and an ephemeral loopback port, so
// nothing here can reach a real deployment.
const fsp = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../src/app");

const PUBLIC_DIR = path.join(__dirname, "..", "public");

// A password that satisfies the minimum length, for tests about something else.
const OWNER_PASSWORD = "owner-password-1";
const ADMIN_PASSWORD = "admin-password-1";

async function createRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-http-"));
  t.after(async () => {
    // Retried: a request that failed part-way can leave the app still writing
    // here for a moment, and a removal that fails skips the hooks after it -
    // including the one that closes the server, which then keeps the test
    // process alive for ever.
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  const serverDir = path.join(root, "servers", "DemoServer");
  for (const name of ["logs", "mods", "plugins", "world"]) {
    await fsp.mkdir(path.join(serverDir, name), { recursive: true });
  }
  await fsp.writeFile(path.join(serverDir, "launch-server.sh"), "#!/usr/bin/env bash\nexit 0\n");
  await fsp.writeFile(path.join(serverDir, "server.properties"), "motd=Demo\n");
  await fsp.writeFile(
    path.join(serverDir, "logs", "latest.log"),
    "[Server thread/INFO]: Starting minecraft server version 1.21.11\n"
  );
  await fsp.writeFile(path.join(serverDir, "world", "level.dat"), "demo");
  // The real front end, so static file handling is exercised as deployed.
  await fsp.symlink(PUBLIC_DIR, path.join(root, "public"));
  return root;
}

// One request, with nothing added that the caller did not ask for. `json` sets
// the body and the JSON content type; `body` sends bytes exactly as given.
function request(port, options = {}) {
  const headers = { ...(options.headers || {}) };
  let payload = options.body;
  if (options.json !== undefined) {
    payload = JSON.stringify(options.json);
    if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
  }
  if (payload !== undefined && !Object.keys(headers).some((name) => name.toLowerCase() === "transfer-encoding")) {
    headers["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = http.request(
      { agent: false, headers, host: "127.0.0.1", method: options.method || "GET", path: options.path || "/", port },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // Not every response is JSON.
          }
          resolve({ buffer, headers: res.headers, json: parsed, status: res.statusCode, text });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function sessionCookieFrom(response) {
  for (const line of response.headers["set-cookie"] || []) {
    const [pair] = line.split(";");
    if (pair.startsWith("rippermoon_session=")) {
      return pair;
    }
  }
  return null;
}

async function startApp(t, options = {}) {
  const root = options.root || (await createRoot(t));
  const setupCodes = [];
  const logs = [];
  const record = (level) => (message, meta) => logs.push({ level, message, meta });

  const server = await createApp(root, {
    logger: { error: record("error"), info: record("info"), warn: record("warn") },
    onSetupCode: (code) => setupCodes.push(code),
    ...(options.app || {})
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const { port } = server.address();

  // A browser-like client: remembers the session cookie between calls.
  function client(defaultHeaders = {}) {
    let cookie = null;
    async function call(method, urlPath, options_ = {}) {
      const headers = { ...defaultHeaders, ...(options_.headers || {}) };
      if (cookie && !Object.keys(headers).some((name) => name.toLowerCase() === "cookie")) {
        headers.Cookie = cookie;
      }
      // The front end sends a JSON content type on every call it makes.
      if (options_.json === undefined && options_.body === undefined && method !== "GET") {
        headers["Content-Type"] = headers["Content-Type"] || "application/json";
      }
      const response = await request(port, { ...options_, headers, method, path: urlPath });
      const next = sessionCookieFrom(response);
      if (next !== null) {
        cookie = next === "rippermoon_session=" ? null : next;
      }
      return response;
    }
    call.cookie = () => cookie;
    call.setCookie = (value) => {
      cookie = value;
    };
    return call;
  }

  // Creates the owner through the real first-run endpoint and returns a client
  // that is logged in as them.
  async function setupOwner(overrides = {}) {
    const owner = client();
    const response = await owner("POST", "/api/setup-owner", {
      json: {
        password: OWNER_PASSWORD,
        setupCode: setupCodes[setupCodes.length - 1],
        username: "owner",
        ...overrides
      }
    });
    if (response.status !== 201) {
      throw new Error(`Owner setup failed: ${response.status} ${response.text}`);
    }
    return owner;
  }

  return {
    client,
    logs,
    origin: `http://127.0.0.1:${port}`,
    port,
    request: (options_) => request(port, options_),
    root,
    server,
    setupCodes,
    setupOwner
  };
}

module.exports = {
  ADMIN_PASSWORD,
  OWNER_PASSWORD,
  createRoot,
  request,
  sessionCookieFrom,
  startApp
};
