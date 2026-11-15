const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { hashSecret, setHashCostForTests } = require("../src/lib/auth");
const { createServerManager } = require("../src/lib/servers");
// Loaded for what it does on the way in: the server manager below is given a
// fetcher that connects to nothing.
require("../test-support/outbound");
const { createStore } = require("../src/lib/store");
const { childEnvironment, runCommand } = require("../src/lib/utils");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

// What the dashboard's own environment holds that is nobody else's business,
// and what a server legitimately needs from it.
const SECRETS = {
  AWS_SECRET_ACCESS_KEY: "canary-aws",
  CURSEFORGE_API_KEY: "canary-curseforge-key",
  GH_TOKEN: "canary-gh",
  HOST: "0.0.0.0",
  INVOCATION_ID: "canary-invocation",
  NODE_ENV: "production",
  NOTIFY_SOCKET: "/run/canary-notify",
  PORT: "4300",
  RIPPERCRAFT_MAX_UPLOAD_MB: "4096",
  RIPPERCRAFT_TRUSTED_ORIGINS: "https://canary.example",
  RIPPERMOONSTASH_ENV_FILE: "/etc/canary.env",
  SOMETHING_ELSE_ENTIRELY: "canary-other"
};
const WANTED = {
  JAVA_TOOL_OPTIONS: "-Dwanted.option=1",
  LANG: "en_GB.UTF-8",
  LC_ALL: "C.UTF-8",
  LC_TIME: "en_GB.UTF-8",
  TZ: "Europe/Berlin"
};

// Sets variables on this process for one test and puts them back after it.
function withEnvironment(t, values) {
  const saved = {};
  for (const [name, value] of Object.entries(values)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });
}

function parseEnvironment(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );
}

async function serverThatReportsItsEnvironment(t, startCommand = "./launch-server.sh") {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-env-"));
  const serverDir = path.join(root, "servers", "DemoServer");
  await fsp.mkdir(path.join(serverDir, "logs"), { recursive: true });
  await fsp.writeFile(path.join(serverDir, "eula.txt"), "eula=true\n");
  const report = path.join(root, "environment.txt");
  await fsp.writeFile(
    path.join(serverDir, "launch-server.sh"),
    // Writes down what it was given, then waits to be told to stop.
    `#!/usr/bin/env bash\nenv > ${report}.part\nmv ${report}.part ${report}\nread -r -t 20 _line\n`,
    { mode: 0o755 }
  );

  const store = createStore(root);
  await store.ensureInitialized();
  const owner = await store.createUser({ passwordHash: await hashSecret("owner-password-1"), role: "owner", servers: [], username: "owner" });
  const serverManager = createServerManager(store);
  await serverManager.syncDiscoveredServers();
  await serverManager.setServerMetadata("DemoServer", { passphrase: "lane-secret", startCommand });

  async function start() {
    await fsp.rm(report, { force: true });
    await serverManager.startServer("DemoServer", owner);
    for (let attempt = 0; attempt < 100 && !fs.existsSync(report); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const environment = parseEnvironment(await fsp.readFile(report, "utf8"));
    await serverManager.stopServer("DemoServer");
    return environment;
  }
  // In this order: stopping a server writes to its record, and a folder that
  // was removed first is made again to hold it.
  t.after(async () => {
    await serverManager.stopServer("DemoServer").catch(() => {});
    await fsp.rm(root, { force: true, maxRetries: 10, recursive: true, retryDelay: 50 });
  });
  return { root, serverManager, start };
}

// --- the list --------------------------------------------------------------------------

test("a child's environment is a short list taken from the dashboard's, plus what is set for it", () => {
  const source = {
    ...SECRETS,
    ...WANTED,
    HOME: "/home/someone",
    JAVA_HOME: "/usr/lib/jvm/java-21",
    JDK_JAVA_OPTIONS: "-Xss2m",
    LANGUAGE: "en_GB:en",
    LOGNAME: "someone",
    PATH: "/usr/bin:/bin",
    RIPPERCRAFT_JAVA_BIN: "/opt/java/bin/java",
    RIPPERMOONSTASH_JAVA_BIN: "/opt/old-java/bin/java",
    SHELL: "/bin/bash",
    TMPDIR: "/var/tmp",
    USER: "someone",
    _JAVA_OPTIONS: "-Dawt.headless=true",
    undefinedValue: undefined
  };

  assert.deepEqual(childEnvironment({}, source), {
    HOME: "/home/someone",
    JAVA_HOME: "/usr/lib/jvm/java-21",
    JAVA_TOOL_OPTIONS: "-Dwanted.option=1",
    JDK_JAVA_OPTIONS: "-Xss2m",
    LANG: "en_GB.UTF-8",
    LANGUAGE: "en_GB:en",
    LC_ALL: "C.UTF-8",
    LC_TIME: "en_GB.UTF-8",
    LOGNAME: "someone",
    PATH: "/usr/bin:/bin",
    RIPPERCRAFT_JAVA_BIN: "/opt/java/bin/java",
    RIPPERMOONSTASH_JAVA_BIN: "/opt/old-java/bin/java",
    SHELL: "/bin/bash",
    TMPDIR: "/var/tmp",
    TZ: "Europe/Berlin",
    USER: "someone",
    _JAVA_OPTIONS: "-Dawt.headless=true"
  });

  // What the dashboard sets for the child on purpose is added, and wins.
  const withOverride = childEnvironment({ JAVA_HOME: "/usr/lib/jvm/java-17", RIPPERCRAFT_JAVA_BIN: "/usr/lib/jvm/java-17/bin/java" }, source);
  assert.equal(withOverride.JAVA_HOME, "/usr/lib/jvm/java-17");
  assert.equal(withOverride.RIPPERCRAFT_JAVA_BIN, "/usr/lib/jvm/java-17/bin/java");
  assert.equal(withOverride.PATH, "/usr/bin:/bin");

  // Names that only look like listed ones are not.
  assert.deepEqual(childEnvironment({}, { JAVA_HOME_SECRET: "x", LCX: "x", MY_PATH: "x", PATH_SECRET: "x", RIPPERCRAFT_JAVA_BIN_TOKEN: "x", lc_all: "x", path: "x" }), {});
  assert.deepEqual(childEnvironment({}, {}), {});
});

// --- a game server -------------------------------------------------------------------------

test("a game server is started with the short list, not with the dashboard's environment", async (t) => {
  withEnvironment(t, { ...SECRETS, ...WANTED, RIPPERCRAFT_JAVA_BIN: "/opt/service-wide/bin/java" });
  const { start } = await serverThatReportsItsEnvironment(t);

  const environment = await start();

  for (const [name, value] of Object.entries(SECRETS)) {
    assert.equal(environment[name], undefined, `${name} reached the game server`);
    assert.equal(JSON.stringify(environment).includes(value) && value.startsWith("canary"), false, `${name}'s value reached the game server`);
  }
  for (const [name, value] of Object.entries(WANTED)) {
    assert.equal(environment[name], value, name);
  }
  assert.equal(environment.RIPPERCRAFT_JAVA_BIN, "/opt/service-wide/bin/java");
  assert.equal(environment.PATH, process.env.PATH);
  assert.equal(environment.HOME, process.env.HOME);

  // Nothing is there that is not on the list, apart from what bash adds itself.
  const allowed = new Set(Object.keys(childEnvironment()));
  const extra = Object.keys(environment).filter((name) => !allowed.has(name) && !["PWD", "OLDPWD", "SHLVL", "_"].includes(name));
  assert.deepEqual(extra, []);
});

test("a server's own Java still reaches it, under all three names the launch scripts read", async (t) => {
  withEnvironment(t, { ...SECRETS, JAVA_HOME: "/opt/service-wide", RIPPERCRAFT_JAVA_BIN: "/opt/service-wide/bin/java" });
  const { root, serverManager, start } = await serverThatReportsItsEnvironment(t);
  const fakeJava = path.join(root, "jdk-17", "bin", "java");
  await fsp.mkdir(path.dirname(fakeJava), { recursive: true });
  await fsp.writeFile(fakeJava, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  await serverManager.setServerMetadata("DemoServer", { javaBin: fakeJava });

  const environment = await start();
  assert.equal(environment.RIPPERCRAFT_JAVA_BIN, fakeJava);
  assert.equal(environment.RIPPERMOONSTASH_JAVA_BIN, fakeJava);
  assert.equal(environment.JAVA_HOME, path.join(root, "jdk-17"));
  assert.equal(environment.CURSEFORGE_API_KEY, undefined);
});

test("a start command run through a shell gets the short list too", async (t) => {
  withEnvironment(t, { ...SECRETS, ...WANTED });
  // A space in the command sends it through the login shell rather than exec.
  const { start } = await serverThatReportsItsEnvironment(t, "./launch-server.sh --with-an-argument");

  const environment = await start();
  // A login shell reads the user's profile, which may add variables of its
  // own, so this looks for what must not be there rather than at the whole list.
  for (const [name, value] of Object.entries(SECRETS)) {
    if (value.startsWith("canary")) {
      assert.equal(environment[name], undefined, `${name} reached the game server`);
    }
  }
  assert.equal(JSON.stringify(environment).includes("canary"), false);
  assert.equal(environment.TZ, WANTED.TZ);
});

// --- every other program the dashboard runs -----------------------------------------------------

test("programs the dashboard runs get the short list unless they are given one of their own", async (t) => {
  withEnvironment(t, { ...SECRETS, ...WANTED, UNZIP: "-o", ZIPOPT: "-9" });

  const inherited = parseEnvironment((await runCommand("/usr/bin/env", [])).stdout);
  for (const name of [...Object.keys(SECRETS), "UNZIP", "ZIPOPT"]) {
    assert.equal(inherited[name], undefined, name);
  }
  assert.equal(inherited.TZ, WANTED.TZ);
  assert.equal(inherited.PATH, process.env.PATH);
  assert.deepEqual(Object.keys(inherited).sort(), Object.keys(childEnvironment()).sort());

  const given = parseEnvironment((await runCommand("/usr/bin/env", [], { env: { ONLY: "this" } })).stdout);
  assert.deepEqual(given, { ONLY: "this" });
});

test("nothing in src/ starts a process with the dashboard's whole environment", () => {
  const offenders = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".js")) {
        const code = fs
          .readFileSync(full, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
          .join("\n");
        if (/env:\s*process\.env|\.\.\.process\.env|Object\.assign\(\s*\{\s*\}\s*,\s*process\.env/.test(code)) {
          offenders.push(path.relative(path.join(__dirname, ".."), full));
        }
        // A spawn or exec with no env at all inherits everything.
        for (const call of code.matchAll(/(?<![.\w])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)\s*\(([\s\S]*?)\n\s*\}\s*\)/g)) {
          if (!/\benv\s*[:,]/.test(call[2])) {
            offenders.push(`${path.relative(path.join(__dirname, ".."), full)}: ${call[1]} without env`);
          }
        }
      }
    }
  };
  walk(path.join(__dirname, "..", "src"));
  assert.deepEqual(offenders, []);
});
