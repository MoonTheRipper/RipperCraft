const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { hashSecret, setHashCostForTests } = require("../src/lib/auth");
const { createServerManager } = require("../src/lib/servers");
const { createStore } = require("../src/lib/store");
const { isArgFilePath, isMemorySetting, normalizeMemory } = require("../src/lib/validate");
const { startApp } = require("../test-support/app");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

// The script the dashboard writes for a server that launches from a jar with
// 2G and 12G - the settings of a server that is running today.
const JAR_SCRIPT = `#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MIN_MEMORY="2G"
MAX_MEMORY="12G"

JAVA_BIN=""
if [ -n "\${RIPPERCRAFT_JAVA_BIN:-}" ]; then
  JAVA_BIN="\${RIPPERCRAFT_JAVA_BIN}"
elif [ -n "\${RIPPERMOONSTASH_JAVA_BIN:-}" ]; then
  # Pre-rename variable, still honoured so an existing deployment keeps working.
  JAVA_BIN="\${RIPPERMOONSTASH_JAVA_BIN}"
elif [ -n "\${JAVA_HOME:-}" ] && [ -x "\${JAVA_HOME}/bin/java" ]; then
  JAVA_BIN="\${JAVA_HOME}/bin/java"
elif command -v /usr/libexec/java_home >/dev/null 2>&1; then
  JAVA_HOME="$("/usr/libexec/java_home" -v 21 2>/dev/null || "/usr/libexec/java_home")"
  export JAVA_HOME
  JAVA_BIN="\${JAVA_HOME}/bin/java"
elif command -v java >/dev/null 2>&1; then
  JAVA_BIN="$(command -v java)"
else
  echo "Java was not found. Install Java or set JAVA_HOME or RIPPERCRAFT_JAVA_BIN." >&2
  exit 1
fi

exec "$JAVA_BIN" -Xms\${MIN_MEMORY} -Xmx\${MAX_MEMORY} -jar server.jar nogui
`;

const FORGE_ARG_FILE = "libraries/net/minecraftforge/forge/1.20.1-47.4.10/unix_args.txt";

// A managed server on disk, with whatever its record says, and a stand-in for
// Java that writes down the arguments it was started with.
async function managedServer(t, record) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-launch-"));
  const serverDir = path.join(root, "servers", "Managed");
  await fsp.mkdir(path.join(serverDir, ".rippermoon"), { recursive: true });
  await fsp.mkdir(path.join(serverDir, path.dirname(FORGE_ARG_FILE)), { recursive: true });
  await fsp.writeFile(path.join(serverDir, FORGE_ARG_FILE), "");
  await fsp.writeFile(path.join(serverDir, "server.jar"), "jar");
  await fsp.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  const javaLog = path.join(root, "java-arguments.txt");
  const fakeJava = path.join(root, "fake-java");
  await fsp.writeFile(fakeJava, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${javaLog}\nread -r -t 20 _line\n`, { mode: 0o755 });

  await fsp.mkdir(path.join(root, "data"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "data", "servers.json"),
    JSON.stringify({
      servers: {
        Managed: {
          directory: "servers/Managed",
          id: "Managed",
          javaBin: fakeJava,
          loader: "vanilla",
          managedRuntime: { kind: "vanilla", launch: { kind: "jar" } },
          minecraftVersion: "1.21.1",
          name: "Managed",
          passphraseHash: await hashSecret("lane-secret"),
          startCommand: "./.rippermoon/launch-server.sh",
          ...record
        }
      }
    })
  );

  const store = createStore(root);
  await store.ensureInitialized();
  const owner = await store.createUser({ passwordHash: await hashSecret("owner-password-1"), role: "owner", servers: [], username: "owner" });
  const serverManager = createServerManager(store);
  // In this order: stopping a server writes to its record, and a folder that
  // was removed first is made again to hold it.
  t.after(async () => {
    await serverManager.stopServer("Managed").catch(() => {});
    await fsp.rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
  });
  return {
    javaArguments: async () => {
      for (let attempt = 0; attempt < 100 && !fs.existsSync(javaLog); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return (await fsp.readFile(javaLog, "utf8")).trim().split("\n");
    },
    owner,
    root,
    script: () => fsp.readFile(path.join(serverDir, ".rippermoon", "launch-server.sh"), "utf8"),
    scriptExists: () => fs.existsSync(path.join(serverDir, ".rippermoon", "launch-server.sh")),
    serverDir,
    serverManager
  };
}

// --- the rules ---------------------------------------------------------------------------

test("a memory size is a whole number and a unit, and nothing else", () => {
  for (const value of ["2G", "12G", "8G", "10G", "4g", "512M", "512m", "2048K", "1G", "999999M"]) {
    assert.equal(isMemorySetting(value), true, value);
    assert.equal(normalizeMemory(` ${value} `, "Max memory"), value);
  }
  // Blank means "use the default".
  assert.equal(normalizeMemory("", "Max memory"), "");
  assert.equal(normalizeMemory("   ", "Max memory"), "");

  const refused = [
    '4G"; touch /tmp/pwned; echo "',
    "4G$(id)",
    "4G`id`",
    "$(id)G",
    "4G\nexec id",
    "4G; id",
    "4G && id",
    "4G|id",
    "4G -XX:+Whatever",
    "4 G",
    "4GB",
    "4T",
    "1.5G",
    "-4G",
    "+4G",
    "4",
    "G",
    "0x4G",
    "1e3G",
    "1234567G",
    "4G\\"
  ];
  for (const value of refused) {
    assert.equal(isMemorySetting(value), false, JSON.stringify(value));
    assert.throws(() => normalizeMemory(value, "Max memory"), { statusCode: 400 }, JSON.stringify(value));
  }
  for (const value of [{ size: "4G" }, ["4G"], null, undefined, true]) {
    assert.equal(isMemorySetting(value), false);
    assert.throws(() => normalizeMemory(value, "Max memory"), { statusCode: 400 }, JSON.stringify(value));
  }
});

test("an argfile path is plain names under the server folder", () => {
  for (const value of [FORGE_ARG_FILE, "libraries/net/neoforged/neoforge/21.1.209/unix_args.txt", "libraries/net/neoforged/neoforge/21.1.209-beta/unix_args.txt", "unix_args.txt"]) {
    assert.equal(isArgFilePath(value), true, value);
  }
  for (const value of [
    'x"; touch /tmp/pwned; echo "',
    "libraries/$(id)/unix_args.txt",
    "libraries/`id`/unix_args.txt",
    "../outside/unix_args.txt",
    "libraries/../../outside.txt",
    "/etc/passwd",
    "libraries//unix_args.txt",
    "libraries/unix args.txt",
    "libraries/.hidden/unix_args.txt",
    "libraries/unix_args.txt\n",
    "",
    "a/".repeat(200),
    { path: "unix_args.txt" },
    null
  ]) {
    assert.equal(isArgFilePath(value), false, JSON.stringify(value));
  }
});

// --- the settings route ------------------------------------------------------------------------

test("the owner's memory settings are refused unless they are memory sizes", async (t) => {
  const app = await startApp(t);
  const owner = await app.setupOwner();
  const save = (json) => owner("PUT", "/api/servers/DemoServer/settings", { json });
  const recordOf = async () => JSON.parse(await fsp.readFile(path.join(app.root, "data", "servers.json"), "utf8")).servers.DemoServer;

  assert.equal((await save({ maxMemory: "12G", minMemory: "2G" })).status, 200);
  for (const body of [
    { maxMemory: '4G"; touch /tmp/pwned; echo "' },
    { minMemory: "2G$(id)" },
    { maxMemory: "4G\nid" },
    { maxMemory: "lots" },
    { minMemory: { size: "2G" } },
    { maxMemory: ["4G"] }
  ]) {
    const response = await save(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.match(response.json.error, /memory must be a whole number followed by K, M or G/);
  }
  const record = await recordOf();
  assert.equal(record.maxMemory, "12G");
  assert.equal(record.minMemory, "2G");

  // Blank goes back to the default the page shows.
  assert.equal((await save({ maxMemory: "", minMemory: "" })).status, 200);
  const snapshot = (await owner("GET", "/api/servers/DemoServer")).json;
  assert.equal(snapshot.server.maxMemory, "4G");
  assert.equal(snapshot.server.minMemory, "2G");
});

// --- the script ----------------------------------------------------------------------------------

test("the script written for real settings is what it has always been, and runs", async (t) => {
  const server = await managedServer(t, { maxMemory: "12G", minMemory: "2G" });
  await server.serverManager.startServer("Managed", server.owner);

  assert.equal(await server.script(), JAR_SCRIPT);
  assert.deepEqual(await server.javaArguments(), ["-Xms2G", "-Xmx12G", "-jar", "server.jar", "nogui"]);
});

test("a Forge server's script names its argfile, and runs", async (t) => {
  const server = await managedServer(t, {
    loader: "forge",
    managedRuntime: { kind: "forge", launch: { argFile: FORGE_ARG_FILE, kind: "argfile" }, loaderVersion: "47.4.10" },
    maxMemory: "10G",
    minMemory: "2G",
    minecraftVersion: "1.20.1"
  });
  await server.serverManager.startServer("Managed", server.owner);

  const script = await server.script();
  assert.match(script, /MIN_MEMORY="2G"\nMAX_MEMORY="10G"\n/);
  assert.ok(script.endsWith(`exec "$JAVA_BIN" -Xms\${MIN_MEMORY} -Xmx\${MAX_MEMORY} \${JVM_ARGS} "@${FORGE_ARG_FILE}" nogui\n`));
  assert.deepEqual(await server.javaArguments(), ["-Xms2G", "-Xmx10G", `@${FORGE_ARG_FILE}`, "nogui"]);
});

test("a record with no memory settings gets the defaults", async (t) => {
  const server = await managedServer(t, {});
  await server.serverManager.startServer("Managed", server.owner);
  assert.deepEqual(await server.javaArguments(), ["-Xms2G", "-Xmx4G", "-jar", "server.jar", "nogui"]);
});

test("a record that already holds a command where a memory size belongs is not turned into a script", async (t) => {
  for (const field of ["maxMemory", "minMemory"]) {
    const marker = path.join(os.tmpdir(), `rippercraft-pwned-${process.pid}-${field}`);
    await fsp.rm(marker, { force: true });
    t.after(() => fsp.rm(marker, { force: true }));
    // What an owner could save before the settings were checked.
    const server = await managedServer(t, { [field]: `4G"; touch ${marker}; echo "` });

    await assert.rejects(server.serverManager.startServer("Managed", server.owner), {
      message: /memory setting is not a memory size/,
      statusCode: 409
    });
    // It was written into the script, in quotes it closed itself, and run.
    assert.equal(fs.existsSync(marker), false, `${field}: the command ran`);
    assert.equal(server.scriptExists(), false, `${field}: a script was written`);
    assert.equal((await server.serverManager.getServerStatus("Managed")).running, false);

    // The server's own log says why it did not start, and is not left open:
    // refusing a hundred starts in a row does not use up a hundred handles.
    // /dev/fd lists this process's open files on Linux and macOS alike.
    const openFiles = () => fs.readdirSync("/dev/fd").length;
    const openBefore = openFiles();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await assert.rejects(server.serverManager.startServer("Managed", server.owner), { statusCode: 409 });
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(openFiles() < openBefore + 20, "refused starts left their log open");
    const log = await fsp.readFile(path.join(server.serverDir, ".rippermoon", "runtime.log"), "utf8");
    assert.match(log, /Start failed: This server's (min|max) memory setting is not a memory size/);
  }
});

test("a record whose argfile path is a command is not turned into a script either", async (t) => {
  const marker = path.join(os.tmpdir(), `rippercraft-pwned-${process.pid}-argfile`);
  await fsp.rm(marker, { force: true });
  t.after(() => fsp.rm(marker, { force: true }));
  // The last one leads out of the server folder - two levels up, which is
  // still inside the folder this test made for itself.
  for (const argFile of [`x"; touch ${marker}; echo "`, `libraries/$(touch ${marker})/unix_args.txt`, "../../outside/unix_args.txt"]) {
    const server = await managedServer(t, { managedRuntime: { kind: "forge", launch: { argFile, kind: "argfile" } } });
    // The file "exists" as far as the dashboard can tell, so it goes on to write the script.
    const target = path.resolve(server.serverDir, argFile);
    assert.ok(target.startsWith(`${server.root}${path.sep}`), `${target} is outside the folder this test owns`);
    await fsp.mkdir(path.dirname(target), { recursive: true }).catch(() => {});
    await fsp.writeFile(target, "").catch(() => {});

    await assert.rejects(server.serverManager.startServer("Managed", server.owner), { statusCode: 409 }, argFile);
    assert.equal(fs.existsSync(marker), false, argFile);
    assert.equal(server.scriptExists(), false, argFile);
  }
});
