const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { startApp } = require("../test-support/app");

// infra/systemd/rippercraft.service: what the unit promises, read off the
// template itself. What systemd then makes of it can only be seen by running
// it as root, which the migration script does on the machine it is run on
// before it changes anything.

const TEMPLATE = path.join(__dirname, "..", "infra", "systemd", "rippercraft.service");
const template = fs.readFileSync(TEMPLATE, "utf8");
// The lines systemd acts on, as "Key=Value".
const settings = template.split("\n").filter((line) => /^[A-Za-z]+=/.test(line));
const valuesOf = (key) => settings.filter((line) => line.startsWith(`${key}=`)).map((line) => line.slice(key.length + 1));

test("the unit template names no machine, account or path of its own", () => {
  assert.doesNotMatch(template, /ripper-moon|minecraft-server|\/home\//);
  // Everything from the machine is a name between two @ signs.
  const names = new Set(template.match(/@[A-Z_]+@/g));
  assert.deepEqual(
    [...names].sort(),
    ["@CHECKOUT@", "@GROUP@", "@HOME@", "@HOST@", "@NODE@", "@NODE_BIN_DIR@", "@NODE_HIDDEN@", "@PORT@", "@PRIVATE_TMP@", "@UID@", "@USER@"]
  );
});

test("game servers outlive the dashboard, and the dashboard comes back by itself", () => {
  assert.deepEqual(valuesOf("KillMode"), ["process"]);
  assert.deepEqual(valuesOf("KillSignal"), ["SIGTERM"]);
  assert.deepEqual(valuesOf("TimeoutStopSec"), ["30"]);
  assert.deepEqual(valuesOf("Restart"), ["on-failure"]);
  assert.deepEqual(valuesOf("Type"), ["exec"]);
  assert.deepEqual(valuesOf("WorkingDirectory"), ["@CHECKOUT@"]);
  assert.deepEqual(valuesOf("OOMPolicy"), ["continue"]);
  assert.deepEqual(valuesOf("EnvironmentFile"), ["-/etc/rippercraft.env"]);
  // The dashboard's own heap is capped; the unit's memory as a whole is not,
  // because that would be the game servers' memory too.
  assert.deepEqual(valuesOf("ExecStart"), ["@NODE@ --max-old-space-size=1024 @CHECKOUT@/src/server.js"]);
  assert.deepEqual(valuesOf("MemoryMax"), []);
  assert.deepEqual(valuesOf("MemorySwapMax"), []);
});

test("the service can write to data/ and servers/ and to nothing else in the checkout", () => {
  assert.deepEqual(valuesOf("ProtectSystem"), ["strict"]);
  assert.deepEqual(valuesOf("ProtectHome"), ["tmpfs"]);
  assert.deepEqual(valuesOf("BindPaths"), ["@CHECKOUT@/data @CHECKOUT@/servers"]);
  assert.deepEqual(valuesOf("BindReadOnlyPaths"), ["@CHECKOUT@", "@NODE_HIDDEN@"]);
  assert.deepEqual(valuesOf("ReadWritePaths"), []);
  // The home directory it sees is an empty one of its own, and so is the
  // shared memory.
  assert.deepEqual(valuesOf("TemporaryFileSystem"), ["@HOME@:mode=0700,uid=@UID@,size=256m", "/dev/shm:mode=1777"]);
  assert.deepEqual(valuesOf("PrivateTmp"), ["@PRIVATE_TMP@"]);
});

test("what the account's groups and its other programs would open is shut, path by path", () => {
  const hidden = valuesOf("InaccessiblePaths").join(" ").split(" ");
  // Every one may be missing on a machine, and none may stop the unit then.
  assert.ok(hidden.every((entry) => entry.startsWith("-/")), hidden.join(" "));
  for (const place of [
    // Logs, which the adm group may read.
    "/var/log",
    "/run/log",
    // What a program of the account leaves when it is made to crash.
    "/var/crash",
    "/var/lib/systemd/coredump",
    "/var/lib/apport/coredump",
    // The terminals and screen sessions of whoever is logged in.
    "/dev/pts",
    "/run/screen",
    // Sockets that hand out root to a group.
    "/run/docker.sock",
    "/run/lxd-installer.socket",
    "/var/snap/lxd",
    "/var/lib/lxd",
    "/var/lib/incus",
    "/run/incus",
    "/run/libvirt"
  ]) {
    assert.ok(hidden.includes(`-${place}`), place);
  }
});

test("the service runs as the checkout's owner, in a group of its own", () => {
  assert.deepEqual(valuesOf("User"), ["@USER@"]);
  // Not the owner's group: see the comment above Group= in the unit.
  assert.deepEqual(valuesOf("Group"), ["@GROUP@"]);
  assert.match(template, /^# A group of its own, not the account's usual one\./m);
});

test("the unit carries every restriction it is meant to, and none that breaks Java or Node", () => {
  const expected = {
    CapabilityBoundingSet: "",
    LockPersonality: "yes",
    NoNewPrivileges: "yes",
    PrivateDevices: "yes",
    ProtectClock: "yes",
    ProtectControlGroups: "yes",
    ProtectHostname: "yes",
    ProtectKernelLogs: "yes",
    ProtectKernelModules: "yes",
    ProtectKernelTunables: "yes",
    ProtectProc: "invisible",
    RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6 AF_NETLINK",
    RestrictNamespaces: "yes",
    RestrictRealtime: "yes",
    RestrictSUIDSGID: "yes",
    SystemCallArchitectures: "native"
  };
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(valuesOf(key), [value], key);
  }
  assert.deepEqual(valuesOf("PrivateIPC"), ["yes"]);
  // An allow list, with two things taken back out of it, and a call that is
  // not allowed is refused rather than fatal.
  assert.deepEqual(valuesOf("SystemCallFilter"), ["@system-service @pkey mincore", "~@keyring process_vm_readv process_vm_writev"]);
  assert.deepEqual(valuesOf("SystemCallErrorNumber"), ["EPERM"]);
  // Both runtimes compile code as they run, and both read /proc/meminfo.
  for (const key of ["MemoryDenyWriteExecute", "ProcSubset", "PrivateUsers", "PrivateNetwork", "IPAddressDeny", "RemoveIPC"]) {
    assert.deepEqual(valuesOf(key), [], key);
  }
});

test("the Owner page names the unit and the file the dashboard was started from", async (t) => {
  const names = ["CURSEFORGE_API_KEY", "RIPPERCRAFT_ENV_FILE", "RIPPERCRAFT_SERVICE", "RIPPERMOONSTASH_ENV_FILE"];
  const before = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const name of names) {
      if (before[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = before[name];
      }
    }
  });
  for (const name of names) {
    delete process.env[name];
  }
  process.env.CURSEFORGE_API_KEY = "a-key-from-the-environment";

  const app = await startApp(t);
  const owner = await app.setupOwner();
  const hint = async () => (await owner("GET", "/api/settings/integrations")).json.integrations.curseforge.envOverride;

  // Told nothing, it is running under the unit's earlier name.
  assert.deepEqual(await hint(), { envFile: "/etc/rippermoonstash.env", service: "rippermoonstash", variable: "CURSEFORGE_API_KEY" });

  // rippercraft.service says what it is, in these two variables.
  for (const line of valuesOf("Environment")) {
    const [name, ...value] = line.split("=");
    if (name.startsWith("RIPPERCRAFT_")) {
      process.env[name] = value.join("=");
    }
  }
  assert.deepEqual(await hint(), { envFile: "/etc/rippercraft.env", service: "rippercraft", variable: "CURSEFORGE_API_KEY" });
});

test("npm test runs the tests in test/ and no file from anywhere else", () => {
  // `node --test` with no pattern runs every *.test.js beneath the folder it
  // is started in. In a checkout that serves a dashboard that includes
  // servers/ and data/, where a game server - and so a mod - can write.
  const { scripts } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(scripts.test, 'node --test "test/*.test.js"');
  // Nothing is left out by that: every test is directly in test/.
  const nested = fs.readdirSync(__dirname, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.deepEqual(nested, []);
});
