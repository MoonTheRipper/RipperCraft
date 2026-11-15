const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { setHashCostForTests } = require("../src/lib/auth");
const { createModManager } = require("../src/lib/mod-sources");
const { createServerManager } = require("../src/lib/servers");
const { createStore } = require("../src/lib/store");
const { startWithAdmin } = require("../test-support/lane");
const { PUBLIC_ADDRESS, scriptedOutbound } = require("../test-support/outbound");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const SECRET = "INTERNAL-ONLY-RESPONSE-BODY";

function modsFolder(app) {
  return path.join(app.root, "servers", "DemoServer", "mods");
}

async function manifestOf(app) {
  const file = path.join(app.root, "servers", "DemoServer", ".rippermoon", "addons.json");
  return fs.existsSync(file) ? JSON.parse(await fsp.readFile(file, "utf8")).addons : [];
}

function installDirect(client, url, extra = {}) {
  return client("POST", "/api/servers/DemoServer/mods/install", {
    json: { confirmManualCompatibility: true, provider: "direct", url, ...extra }
  });
}

// Something listening on this machine that must never hear from the dashboard.
async function internalService(t) {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket.remoteAddress);
    socket.on("error", () => {});
    socket.end("HTTP/1.1 200 OK\r\nContent-Length: 27\r\nConnection: close\r\n\r\n" + SECRET);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { connections, port: server.address().port };
}

// --- an address typed by an admin -----------------------------------------------------------

test("installing from this machine or a private network is refused, and nothing is contacted", async (t) => {
  // No stand-in for the network here: this is the real fetcher, refusing.
  const { admin, app } = await startWithAdmin(t);
  const internal = await internalService(t);
  const port = internal.port;

  const refused = {
    // Not https at all.
    "plain http to loopback": `http://127.0.0.1:${port}/a.jar`,
    "plain http to a public name": "http://files.example/a.jar",
    "a file": "file:///etc/hostname",
    "ftp": "ftp://files.example/a.jar",
    // https, to this machine, spelled every way a URL can spell it.
    "loopback": `https://127.0.0.1:${port}/a.jar`,
    "loopback by name": `https://localhost:${port}/a.jar`,
    "loopback as one number": `https://2130706433:${port}/a.jar`,
    "loopback in hex": `https://0x7f.1:${port}/a.jar`,
    "loopback in octal": `https://0177.0.0.1:${port}/a.jar`,
    "loopback, short": `https://127.1:${port}/a.jar`,
    "IPv6 loopback": `https://[::1]:${port}/a.jar`,
    "loopback inside IPv6": `https://[::ffff:127.0.0.1]:${port}/a.jar`,
    "the unspecified address": `https://0.0.0.0:${port}/a.jar`,
    // https, to the networks around it.
    "a home network": "https://192.168.178.1/a.jar",
    "a private network": "https://10.0.0.1/a.jar",
    "another private network": "https://172.16.5.4/a.jar",
    "the tailnet": "https://100.64.0.1/a.jar",
    "a cloud metadata service": "https://169.254.169.254/latest/meta-data/a.jar",
    "a unique local IPv6 address": "https://[fd7a:115c:a1e0::1]/a.jar",
    "a link-local IPv6 address": "https://[fe80::1]/a.jar",
    // And things that are not an address.
    "a user name in it": "https://admin:hunter2@files.example/a.jar",
    "nothing": "",
    "an object": { href: `https://127.0.0.1:${port}/a.jar` },
    "a list": [`https://127.0.0.1:${port}/a.jar`]
  };

  for (const [label, url] of Object.entries(refused)) {
    const startedAt = Date.now();
    const response = await installDirect(admin, url);
    assert.equal(response.status, 400, `${label}: ${response.text}`);
    assert.equal(response.text.includes(SECRET), false, label);
    // Refused on the address alone, not after waiting on a connection.
    assert.ok(Date.now() - startedAt < 2000, `${label} took ${Date.now() - startedAt}ms`);
  }

  assert.deepEqual(internal.connections, []);
  assert.deepEqual(fs.readdirSync(modsFolder(app)), []);
  assert.deepEqual(await manifestOf(app), []);
});

test("an add-on is downloaded from a public https address, to disk, under the name asked for", async (t) => {
  const jar = Buffer.alloc(300_000, "jar ");
  const { calls, outbound } = scriptedOutbound({
    addresses: { "files.example": [PUBLIC_ADDRESS] },
    respond: () => ({ body: Readable.from([jar.subarray(0, 100_000), jar.subarray(100_000)]) })
  });
  const { admin, app } = await startWithAdmin(t, { app: { outbound } });

  const response = await installDirect(admin, "https://files.example/mods/Example%20Mod-1.2.jar");
  assert.equal(response.status, 201, response.text);
  assert.deepEqual(response.json.installed, [
    { fileName: "Example-20Mod-1.2.jar", provider: "direct", sourceId: "https://files.example/mods/Example%20Mod-1.2.jar" }
  ]);
  assert.deepEqual(calls.map((call) => [call.url, call.address]), [["https://files.example/mods/Example%20Mod-1.2.jar", PUBLIC_ADDRESS]]);

  // The file is there, whole, and no half-written copy is left beside it.
  assert.deepEqual(fs.readdirSync(modsFolder(app)), ["Example-20Mod-1.2.jar"]);
  assert.ok(jar.equals(await fsp.readFile(path.join(modsFolder(app), "Example-20Mod-1.2.jar"))));
  const [tracked] = await manifestOf(app);
  assert.equal(tracked.provider, "direct");
  assert.equal(tracked.manual, true);

  // A name of its own, when the address does not end in one.
  const named = await installDirect(admin, "https://files.example/download?id=7", { fileName: "chosen.jar" });
  assert.equal(named.status, 201, named.text);
  assert.ok(fs.existsSync(path.join(modsFolder(app), "chosen.jar")));
  for (const fileName of [{ name: "x.jar" }, ["x.jar"], true]) {
    assert.equal((await installDirect(admin, "https://files.example/download?id=7", { fileName })).status, 400);
  }
});

test("a download that is redirected somewhere private is refused, and nothing is kept", async (t) => {
  const targets = ["https://127.0.0.1/secret", "https://internal.example/secret", "https://100.64.0.1/secret", "http://files.example/a.jar"];
  for (const location of targets) {
    const { calls, outbound } = scriptedOutbound({
      addresses: { "files.example": [PUBLIC_ADDRESS], "internal.example": ["10.0.0.5"] },
      respond: ({ url }) => (url.pathname === "/a.jar" && url.protocol === "https:" && url.hostname === "files.example" ? { headers: { location }, status: 302 } : { body: SECRET })
    });
    const { admin, app } = await startWithAdmin(t, { app: { outbound } });

    const response = await installDirect(admin, "https://files.example/a.jar");
    assert.equal(response.status, 400, `${location}: ${response.text}`);
    assert.equal(response.text.includes(SECRET), false);
    assert.deepEqual(calls.map((call) => call.url), ["https://files.example/a.jar"], location);
    assert.deepEqual(fs.readdirSync(modsFolder(app)), [], location);
    assert.deepEqual(await manifestOf(app), [], location);
  }
});

test("a download larger than the limit is stopped, and what had arrived is removed", async (t) => {
  for (const headers of [{}, { "content-length": String(5_000_000) }]) {
    const { outbound } = scriptedOutbound(
      {
        addresses: { "files.example": [PUBLIC_ADDRESS] },
        respond: () => ({ body: Readable.from(Array.from({ length: 50 }, () => Buffer.alloc(100_000, 1))), headers })
      },
      { downloadLimitBytes: 1024 * 1024 }
    );
    const { admin, app } = await startWithAdmin(t, { app: { outbound } });

    const response = await installDirect(admin, "https://files.example/huge.jar");
    assert.equal(response.status, 413, response.text);
    assert.match(response.json.error, /larger than the 1 MB limit/);
    assert.deepEqual(fs.readdirSync(modsFolder(app)), []);
    assert.deepEqual(await manifestOf(app), []);
  }
});

test("a failed download says which status came back and nothing else", async (t) => {
  const { outbound } = scriptedOutbound({
    addresses: { "files.example": [PUBLIC_ADDRESS] },
    respond: () => ({ body: `<html>${SECRET}</html>`, status: 418 })
  });
  const { admin, app } = await startWithAdmin(t, { app: { outbound } });

  const response = await installDirect(admin, "https://files.example/a.jar");
  assert.equal(response.status, 502);
  assert.equal(response.json.error, "The download failed: files.example answered with HTTP 418.");
  assert.equal(response.text.includes(SECRET), false);
  assert.deepEqual(fs.readdirSync(modsFolder(app)), []);
  // Nor is it in what the dashboard logged for the request.
  assert.equal(JSON.stringify(app.logs).includes(SECRET), false);
});

// --- an address handed back by a provider ---------------------------------------------------------

function modrinthAnswering(fileUrl) {
  return scriptedOutbound({
    addresses: { "api.modrinth.com": [PUBLIC_ADDRESS], "cdn.modrinth.com": [PUBLIC_ADDRESS], "internal.example": ["192.168.1.9"] },
    respond: ({ url }) => {
      if (url.hostname === "api.modrinth.com" && url.pathname.endsWith("/version")) {
        return {
          body: JSON.stringify([
            {
              date_published: "2026-02-01T00:00:00Z",
              dependencies: [],
              files: [{ filename: "from-modrinth.jar", primary: true, url: fileUrl }],
              version_type: "release"
            }
          ])
        };
      }
      if (url.hostname === "api.modrinth.com") {
        return { body: JSON.stringify({ client_side: "optional", server_side: "required", slug: "example", title: "Example" }) };
      }
      return { body: url.hostname === "cdn.modrinth.com" ? "jar from the CDN" : SECRET };
    }
  });
}

test("a file address that came from a provider is held to the same rules", async (t) => {
  // The provider's API is trusted to describe a project, not to aim the
  // dashboard at the home network.
  for (const fileUrl of ["https://192.168.1.9/a.jar", "https://internal.example/a.jar", "https://[::1]/a.jar", "http://cdn.modrinth.com/a.jar", "file:///etc/hostname"]) {
    const { calls, outbound } = modrinthAnswering(fileUrl);
    const { admin, app } = await startWithAdmin(t, { app: { outbound } });

    const response = await admin("POST", "/api/servers/DemoServer/mods/install", { json: { projectId: "example", provider: "modrinth" } });
    assert.equal(response.status, 400, `${fileUrl}: ${response.text}`);
    assert.ok(calls.every((call) => new URL(call.url).hostname === "api.modrinth.com"), fileUrl);
    assert.deepEqual(fs.readdirSync(modsFolder(app)), [], fileUrl);
    assert.deepEqual(await manifestOf(app), [], fileUrl);
  }

  const { calls, outbound } = modrinthAnswering("https://cdn.modrinth.com/data/example/versions/1/from-modrinth.jar");
  const { admin, app } = await startWithAdmin(t, { app: { outbound } });
  const response = await admin("POST", "/api/servers/DemoServer/mods/install", { json: { projectId: "example", provider: "modrinth" } });
  assert.equal(response.status, 201, response.text);
  assert.equal(await fsp.readFile(path.join(modsFolder(app), "from-modrinth.jar"), "utf8"), "jar from the CDN");
  assert.ok(calls.some((call) => call.url === "https://cdn.modrinth.com/data/example/versions/1/from-modrinth.jar"));
});

test("a project id can name a project and nothing else", async (t) => {
  const { calls, outbound } = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: () => ({ body: "[]" }) });
  const { admin, app, owner } = await startWithAdmin(t, { app: { outbound } });
  // A key, so that CurseForge requests would be made - and would carry it.
  assert.equal((await owner("PUT", "/api/settings/integrations", { json: { curseforgeApiKey: "the-owner's-key", skipVerify: true } })).status, 200);
  const install = (json) => admin("POST", "/api/servers/DemoServer/mods/install", { json });

  for (const projectId of ["../../v2/search", "example/../../tag", "example?x=1", "example#x", "a b", "", { id: "example" }, ["example"], "x".repeat(65), "%2e%2e%2fsearch"]) {
    const response = await install({ projectId, provider: "modrinth" });
    assert.equal(response.status, 400, JSON.stringify(projectId));
  }
  for (const modId of ["1/../../games", "12?gameId=1", "../games", "abc", "-1", "1e3", "", { id: 1 }, [1], "1".repeat(13)]) {
    const response = await install({ modId, provider: "curseforge" });
    assert.equal(response.status, 400, JSON.stringify(modId));
  }
  for (const provider of ["", "ftp", { name: "modrinth" }, null, undefined]) {
    assert.equal((await install({ projectId: "example", provider })).status, 400, JSON.stringify(provider));
  }
  // None of it reached a provider.
  assert.deepEqual(calls, []);
  assert.deepEqual(await manifestOf(app), []);

  // A real id is asked about, in the path and nowhere else.
  assert.equal((await install({ projectId: "AANobbMI", provider: "modrinth" })).status >= 400, true);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).pathname, "/v2/project/AANobbMI/version");
});

test("a search takes text, and only from a provider the dashboard knows", async (t) => {
  const { calls, outbound } = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: () => ({ body: JSON.stringify({ hits: [] }) }) });
  const { admin } = await startWithAdmin(t, { app: { outbound } });
  const search = (json) => admin("POST", "/api/servers/DemoServer/mods/search", { json });

  for (const query of [{ a: 1 }, ["sodium"], true, null, "", "   "]) {
    const response = await search({ provider: "modrinth", query });
    assert.equal(response.status, 200, JSON.stringify(query));
    assert.deepEqual(response.json.results, []);
  }
  assert.deepEqual(calls, []);
  assert.equal((await search({ provider: "somewhere-else", query: "sodium" })).status, 400);
  assert.equal((await search({ provider: { name: "modrinth" }, query: "sodium" })).status, 400);

  assert.equal((await search({ provider: "modrinth", query: `  ${"long ".repeat(100)}` })).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(new URL(calls[0].url).searchParams.get("query").length, 200);
});

// --- the combined update ---------------------------------------------------------------------------

async function managersWith(t, outbound) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-update-"));
  t.after(() => fsp.rm(root, { force: true, recursive: true }));
  const mods = path.join(root, "servers", "DemoServer", "mods");
  await fsp.mkdir(mods, { recursive: true });
  const store = createStore(root);
  await store.ensureInitialized();
  const serverManager = createServerManager(store, { outbound });
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", { loader: "fabric", minecraftVersion: "1.21.1" });
  const modManager = createModManager(serverManager, { outbound });
  await fsp.writeFile(path.join(mods, "old-a.jar"), "old a");
  await fsp.writeFile(path.join(mods, "old-b.jar"), "old b");
  await serverManager.recordAddonInstalls("DemoServer", [
    { fileName: "old-a.jar", provider: "modrinth", sourceId: "aaaa" },
    { fileName: "old-b.jar", provider: "modrinth", sourceId: "bbbb" }
  ]);
  return { modManager, mods, serverManager };
}

const planFor = (entries) => ({
  planEntries: entries.map(([fileName, downloadUrl, sourceId]) => ({ downloadUrl, fileName, provider: "modrinth", sourceId })),
  safe: true
});

test("a combined update swaps every add-on once all of them have arrived", async (t) => {
  const { calls, outbound } = scriptedOutbound({
    addresses: { "cdn.modrinth.com": [PUBLIC_ADDRESS] },
    respond: ({ url }) => (url.hostname === "cdn.modrinth.com" ? { body: `new ${url.pathname}` } : { body: "{}" })
  });
  const { modManager, mods } = await managersWith(t, outbound);

  const result = await modManager.applyCombinedAddonUpdate(
    "DemoServer",
    planFor([
      ["new-a.jar", "https://cdn.modrinth.com/a.jar", "aaaa"],
      ["new-b.jar", "https://cdn.modrinth.com/b.jar", "bbbb"]
    ])
  );
  assert.equal(result.updatedCount, 2);
  assert.deepEqual(fs.readdirSync(mods).sort(), ["new-a.jar", "new-b.jar"]);
  assert.equal(await fsp.readFile(path.join(mods, "new-a.jar"), "utf8"), "new /a.jar");
  assert.ok(calls.filter((call) => call.url.startsWith("https://cdn.modrinth.com/")).every((call) => call.address === PUBLIC_ADDRESS));
});

test("a combined update that cannot fetch one add-on leaves all of them as they were", async (t) => {
  for (const second of ["https://10.0.0.7/b.jar", "http://cdn.modrinth.com/b.jar", "https://cdn.modrinth.com/missing.jar"]) {
    const { outbound } = scriptedOutbound({
      addresses: { "cdn.modrinth.com": [PUBLIC_ADDRESS] },
      respond: ({ url }) => (url.pathname === "/missing.jar" ? { body: SECRET, status: 404 } : { body: "new" })
    });
    const { modManager, mods } = await managersWith(t, outbound);

    await assert.rejects(
      modManager.applyCombinedAddonUpdate(
        "DemoServer",
        planFor([
          ["new-a.jar", "https://cdn.modrinth.com/a.jar", "aaaa"],
          ["new-b.jar", second, "bbbb"]
        ])
      ),
      (error) => !error.message.includes(SECRET),
      second
    );
    // The old jars are untouched and the one that did arrive is not left lying about.
    assert.deepEqual(fs.readdirSync(mods).sort(), ["old-a.jar", "old-b.jar"], second);
    assert.equal(await fsp.readFile(path.join(mods, "old-a.jar"), "utf8"), "old a");
  }
});

// --- nothing else reaches out ----------------------------------------------------------------------------

test("lib/outbound.js is the only file in src/ that makes a request", () => {
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js") && path.basename(full) !== "outbound.js") {
        const code = fs
          .readFileSync(full, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        if (/\bfetch\s*\(|https?\.(request|get)\s*\(|net\.(connect|createConnection)\s*\(|tls\.connect\s*\(|require\(["']node:(dgram|http2|dns)["']\)|new\s+WebSocket/.test(code)) {
          offenders.push(path.relative(path.join(__dirname, ".."), full));
        }
      }
    }
  };
  walk(path.join(__dirname, "..", "src"));
  assert.deepEqual(offenders, []);
});
