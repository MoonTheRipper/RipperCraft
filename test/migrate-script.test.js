const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const {
  NEW_UNIT,
  OLD_UNIT,
  SCRIPT,
  TEMPLATE,
  assertBefore,
  assertNothingChanged,
  createMachine,
  originalData,
  unsupportedReason
} = require("../test-support/migration");

// infra/systemd/migrate-to-rippercraft.sh, run for real against a stand-in
// machine: see test-support/migration.js for what is real and what is not.
// What happens when a step fails is in migrate-undo.test.js.
const skip = unsupportedReason();

test("--check looks, says what would be done and changes nothing", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);

  const result = machine.run(["--check"]);

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /serving now:\s+rippermoonstash\.service/);
  assert.match(result.output, /game server running: Demo \(pid \d+/);
  assert.match(result.output, /add a KillMode=process drop-in to rippermoonstash\.service/);
  assert.match(result.output, /fast-forward the checkout from [0-9a-f]{7} to [0-9a-f]{7}/);
  assert.match(result.output, /stop rippermoonstash\.service and start rippercraft\.service/);
  assert.match(result.output, /Nothing has been changed/);

  assertNothingChanged(machine, before);
  assert.deepEqual(machine.systemctlCalls(), [], "systemctl was only asked questions");
  assert.equal(machine.backupCount(), 0, "no backup folder was made");
  assert.equal(fs.existsSync(path.join(machine.unitDir, `${OLD_UNIT}.d`)), false, "no drop-in was written");
  assert.equal(fs.existsSync(path.join(machine.state, "groupadd.log")), false, "no group was created");

  // The sandbox was tried out all the same, with the account's own group
  // because the service's does not exist yet.
  const runs = machine.sandboxRuns();
  assert.equal(runs.length, 1);
  assert.match(runs[0], /\tProtectHome=tmpfs\t/);
  assert.match(runs[0], /\tProtectSystem=strict\t/);
  assert.doesNotMatch(runs[0], /\tGroup=rippercraft\t/);
  assert.doesNotMatch(runs[0], /ExecStart=|KillMode=|Restart=/);
});

test("a migration hands over from the old unit and leaves the game server running", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);

  const result = machine.run();
  assert.equal(result.status, 0, result.output);

  // Where things ended up.
  assert.equal(machine.head(), machine.newCommit);
  assert.equal(machine.isActive(NEW_UNIT), true);
  assert.equal(machine.isEnabled(NEW_UNIT), true);
  assert.equal(machine.isActive(OLD_UNIT), false);
  assert.equal(machine.isEnabled(OLD_UNIT), false);
  assert.equal(machine.gameServerAlive(), true);

  // In what order. The drop-in has to be in force before the old unit is
  // stopped; the stand-in systemctl ends the game server otherwise, as the real
  // one would.
  const calls = machine.systemctlCalls();
  assertBefore(calls, "daemon-reload", `stop ${OLD_UNIT}`);
  assertBefore(calls, `stop ${OLD_UNIT}`, `start ${NEW_UNIT}`);
  assertBefore(calls, `start ${NEW_UNIT}`, `enable ${NEW_UNIT}`);
  assertBefore(calls, `enable ${NEW_UNIT}`, `disable ${OLD_UNIT}`);
  assert.match(
    fs.readFileSync(path.join(machine.unitDir, `${OLD_UNIT}.d`, "10-keep-game-servers.conf"), "utf8"),
    /^KillMode=process$/m
  );

  // The unit, filled in for this machine and nothing left to fill in.
  const unit = machine.unitFile(NEW_UNIT);
  assert.doesNotMatch(unit, /@[A-Z_]+@/);
  assert.doesNotMatch(unit, /^#@/m);
  assert.match(unit, /^Group=rippercraft$/m);
  assert.match(unit, /^Environment=HOST=0\.0\.0\.0$/m, "the address is carried over from the old unit");
  assert.match(unit, /^Environment=PORT=4300$/m);
  assert.match(unit, new RegExp(`^ExecStart=${machine.node} --max-old-space-size=1024 ${machine.checkout}/src/server\\.js$`, "m"));
  assert.match(unit, new RegExp(`^BindReadOnlyPaths=${machine.checkout}$`, "m"));
  assert.match(unit, new RegExp(`^BindPaths=${machine.checkout}/data ${machine.checkout}/servers$`, "m"));
  assert.match(unit, /^PrivateTmp=disconnected$/m);
  // An empty home directory of the service's own, over the account's.
  assert.match(unit, new RegExp(`^TemporaryFileSystem=${fs.realpathSync(os.userInfo().homedir)}:mode=0700,uid=${process.getuid()},size=256m$`, "m"));
  // Nothing in it changes from one commit to the next.
  assert.equal(unit.includes(machine.newCommit.slice(0, 7)), false);

  // The environment file is copied, and stays private.
  const envFile = path.join(machine.root, "etc", "rippercraft.env");
  assert.equal(fs.readFileSync(envFile, "utf8"), "CURSEFORGE_API_KEY=secret-key\n");
  assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);

  // The backup: made, private, and holding the files as they were.
  const backup = machine.backup();
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  for (const [name, contents] of Object.entries(before)) {
    assert.equal(fs.readFileSync(path.join(backup, "data", name), "utf8"), contents);
    assert.equal(fs.statSync(path.join(backup, "data", name)).mode & 0o777, 0o600);
  }
  assert.match(fs.readFileSync(path.join(backup, "state"), "utf8"), /^STATE_PHASE=done$/m);
  assert.match(fs.readFileSync(path.join(backup, "migrate.log"), "utf8"), /Starting rippercraft\.service/);

  // Tried out twice: before anything changed, and again once the group existed.
  const runs = machine.sandboxRuns();
  assert.equal(runs.length, 2);
  assert.match(runs[1], /\tGroup=rippercraft\t/);

  // What the operator is told.
  assert.match(result.output, /Done\. The dashboard runs sandboxed as rippercraft\.service\./);
  assert.match(result.output, new RegExp(`Backup\\n\\s+- ${backup}`));
  assert.match(result.output, /--rollback/);
  assert.match(result.output, /Restart each game server from the dashboard, one at a time/);
  assert.match(result.output, /a new one needs 12 characters/);
});

test("a second run after a migration only checks", { skip }, async (t) => {
  const machine = await createMachine(t);
  assert.equal(machine.run().status, 0);
  const calls = machine.systemctlCalls().length;
  const unit = machine.unitFile(NEW_UNIT);

  // From the checkout this time, as it will be run from then on.
  const again = machine.run([], {
    noCheckout: true,
    script: path.join(machine.checkout, "infra", "systemd", "migrate-to-rippercraft.sh")
  });

  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /Nothing to do: the dashboard runs sandboxed as rippercraft\.service/);
  assert.equal(machine.systemctlCalls().length, calls, "nothing was started, stopped, enabled or reloaded");
  assert.equal(machine.backupCount(), 1, "no second backup");
  assert.equal(machine.unitFile(NEW_UNIT), unit);
  assert.equal(machine.isActive(NEW_UNIT), true);
  assert.equal(machine.sandboxRuns().length, 3, "the sandbox was tried out once more");
  assert.equal(machine.gameServerAlive(), true);
});

test("a run that finds an older rippercraft.service running replaces it the same careful way", { skip }, async (t) => {
  // As after the script this one replaces: the unit already has the new name,
  // but none of the sandbox, and the checkout is still on the old commit.
  const machine = await createMachine(t);
  const before = originalData(machine);
  const olderUnit = fs.readFileSync(path.join(machine.unitDir, OLD_UNIT), "utf8").replace("[Service]\n", "[Service]\nKillMode=process\n");
  fs.writeFileSync(path.join(machine.unitDir, NEW_UNIT), olderUnit);
  fs.rmSync(path.join(machine.unitDir, OLD_UNIT));
  fs.renameSync(path.join(machine.state, OLD_UNIT), path.join(machine.state, NEW_UNIT));
  fs.writeFileSync(path.join(machine.root, "proc", String(machine.gameServerPid), "cgroup"), `0::/system.slice/${NEW_UNIT}\n`);

  const result = machine.run();

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /serving now:\s+rippercraft\.service/);
  assert.match(machine.unitFile(NEW_UNIT), /^ProtectHome=tmpfs$/m);
  assert.equal(machine.head(), machine.newCommit);
  assert.equal(machine.isActive(NEW_UNIT), true);
  assert.equal(machine.gameServerAlive(), true);
  // The unit is its own way back: it was stopped and started, never disabled,
  // and what it was before is kept beside the backup.
  const calls = machine.systemctlCalls();
  assertBefore(calls, `stop ${NEW_UNIT}`, `start ${NEW_UNIT}`);
  assert.equal(calls.some((call) => call.startsWith("disable ")), false);
  assert.equal(fs.readFileSync(path.join(machine.backup(), `previous-${NEW_UNIT}`), "utf8"), olderUnit);

  // And going back puts that unit, that commit and that data back.
  const rollback = machine.run(["--rollback"]);
  assert.equal(rollback.status, 0, rollback.output);
  assert.equal(machine.unitFile(NEW_UNIT), olderUnit);
  assert.equal(machine.head(), machine.oldCommit);
  assert.equal(machine.isActive(NEW_UNIT), true);
  assert.equal(machine.isEnabled(NEW_UNIT), true);
  for (const [name, contents] of Object.entries(before)) {
    assert.equal(machine.readData(name), contents);
  }
  assert.equal(machine.gameServerAlive(), true);
});

test("a run after `git pull` finds the unit in place and leaves the dashboard alone", { skip }, async (t) => {
  const machine = await createMachine(t);
  assert.equal(machine.run().status, 0);
  const calls = machine.systemctlCalls().length;
  // A newer commit that touches the code and not the unit, pulled as the
  // README says to.
  fs.appendFileSync(path.join(machine.checkout, "src", "server.js"), "// a later change\n");
  const git = (...args) => spawnSync("git", ["-C", machine.checkout, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { encoding: "utf8" });
  assert.equal(git("commit", "--quiet", "-am", "later").status, 0);
  assert.equal(git("update-ref", "refs/remotes/origin/main", "HEAD").status, 0);

  const again = machine.run([], {
    noCheckout: true,
    script: path.join(machine.checkout, "infra", "systemd", "migrate-to-rippercraft.sh")
  });

  assert.equal(again.status, 0, again.output);
  assert.match(again.output, /Nothing to do: the dashboard runs sandboxed as rippercraft\.service/);
  assert.equal(machine.systemctlCalls().length, calls, "nothing was stopped, started or reloaded");
  assert.equal(machine.backupCount(), 1);
});

test("a second run says so when the dashboard no longer answers", { skip }, async (t) => {
  const machine = await createMachine(t);
  assert.equal(machine.run().status, 0);
  machine.flag("new-status", "500");

  const again = machine.run();

  assert.equal(again.status, 1, again.output);
  assert.match(again.output, /rippercraft\.service is running, but the dashboard does not answer GET \/api\/bootstrap on port 4300 with 200/);
  assert.equal(machine.isActive(NEW_UNIT), true, "it is reported, not acted on");
});

test("a second run says so when it is the old code that answers", { skip }, async (t) => {
  const machine = await createMachine(t);
  assert.equal(machine.run().status, 0);
  machine.flag("new-csp", "");

  const again = machine.run();

  assert.equal(again.status, 1, again.output);
  assert.match(again.output, /does not answer as it should/);
  assert.equal(machine.isActive(NEW_UNIT), true, "it is reported, not acted on");
});

test("a dashboard that does not answer before the migration is not migrated", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  // The check that will judge the new dashboard cannot be passed by the one
  // that is running: a migration that worked could not be told from one that
  // did not, and neither could going back.
  machine.flag("old-status", "500");

  const result = machine.run();

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /rippermoonstash\.service is running, but the dashboard does not answer/);
  assert.match(result.output, /Nothing has been changed/);
  assertNothingChanged(machine, before);
  assert.deepEqual(machine.systemctlCalls(), []);
  assert.equal(machine.backupCount(), 0);
});

test("an option that is given without its value is refused", { skip }, async (t) => {
  const machine = await createMachine(t);
  for (const option of ["--checkout", "--target", "--node", "--host", "--port"]) {
    const result = machine.run([option], { noCheckout: option === "--checkout" });
    assert.equal(result.status, 1, `${option}: ${result.output}`);
    assert.match(result.output, new RegExp(`${option} needs a value`));
  }
  assert.equal(machine.run(["--frobnicate"]).status, 1);
  assert.deepEqual(machine.systemctlCalls(), []);
});

test("--check and --rollback together do neither", { skip }, async (t) => {
  const machine = await createMachine(t);
  assert.equal(machine.run().status, 0);
  const calls = machine.systemctlCalls().length;

  for (const pair of [["--check", "--rollback"], ["--rollback", "--check"]]) {
    const result = machine.run(pair);
    assert.equal(result.status, 1, `${pair.join(" ")}: ${result.output}`);
    assert.match(result.output, /--check and --rollback do not go together/);
  }
  assert.equal(machine.systemctlCalls().length, calls, "nothing was undone");
  assert.equal(machine.head(), machine.newCommit);
  assert.equal(machine.isActive(NEW_UNIT), true);
});

test("a port or a path that a unit cannot carry is refused", { skip }, async (t) => {
  const machine = await createMachine(t, { oldUnit: false });
  for (const port of ["80", "70000", "43oo", "4300 "]) {
    const result = machine.run(["--node", machine.node, "--port", port]);
    assert.equal(result.status, 1, `port ${JSON.stringify(port)}: ${result.output}`);
    assert.match(result.output, /the port/);
  }
  assert.equal(machine.run(["--node", machine.node, "--host", "0.0.0.0; rm -rf /"]).status, 1);
  assert.deepEqual(machine.systemctlCalls(), []);
  assert.equal(machine.unitFile(NEW_UNIT), null);

  const spaced = await createMachine(t, { checkoutName: "check out", oldUnit: false });
  const result = spaced.run(["--node", spaced.node]);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /holds a character a unit file cannot carry/);
  assert.equal(spaced.unitFile(NEW_UNIT), null);
});

test("it refuses before changing anything when something is not ready", { skip }, async (t) => {
  await t.test("changes that are not committed", async (t) => {
    const machine = await createMachine(t);
    const before = originalData(machine);
    fs.appendFileSync(path.join(machine.checkout, "src", "server.js"), "// edited\n");
    const result = machine.run();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /changes that are not committed/);
    fs.writeFileSync(path.join(machine.checkout, "src", "server.js"), "// the old code\n");
    assertNothingChanged(machine, before);
    assert.deepEqual(machine.systemctlCalls(), []);
  });

  await t.test("a commit that has not been fetched", async (t) => {
    const machine = await createMachine(t);
    const result = machine.run(["--target", "origin/missing"]);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /is not in this checkout\. Run `git fetch`/);
    assert.deepEqual(machine.systemctlCalls(), []);
  });

  await t.test("a copy of the script that is not the one being installed", async (t) => {
    const machine = await createMachine(t);
    const stale = path.join(machine.base, "stale-script.sh");
    fs.writeFileSync(stale, `${fs.readFileSync(path.join(__dirname, "..", "infra", "systemd", "migrate-to-rippercraft.sh"), "utf8")}\n# changed\n`);
    const result = machine.run([], { script: stale });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /This copy of the script is not the one in commit/);
    assert.match(result.output, /git show [0-9a-f]{7}:infra\/systemd\/migrate-to-rippercraft\.sh/);
    assert.deepEqual(machine.systemctlCalls(), []);
  });

  await t.test("a unit systemd does not accept", async (t) => {
    const machine = await createMachine(t);
    machine.flag("fail-verify");
    const result = machine.run();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /systemd does not accept the unit/);
    assert.deepEqual(machine.systemctlCalls(), []);
    assert.equal(machine.backupCount(), 0);
  });

  await t.test("a sandbox that does not hold when tried out", async (t) => {
    const machine = await createMachine(t);
    const before = originalData(machine);
    machine.flag("fail-rehearsal");
    const result = machine.run();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /FAIL {2}the home directory still shows: \.ssh/);
    assert.match(result.output, /the sandbox does not behave as it should on this machine/);
    assertNothingChanged(machine, before);
    assert.deepEqual(machine.systemctlCalls(), []);
    assert.equal(machine.backupCount(), 0);
  });

  await t.test("java where the service cannot see it", async (t) => {
    const machine = await createMachine(t);
    const hidden = path.join(machine.root, "home", "tester", ".sdkman", "java");
    fs.mkdirSync(path.dirname(hidden), { recursive: true });
    fs.renameSync(path.join(machine.root, "usr", "bin", "java"), hidden);
    fs.symlinkSync(hidden, path.join(machine.root, "usr", "bin", "java"));
    const result = machine.run();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /PROBLEM: java is at .*\.sdkman\/java, which the service will not be able to see/);
    assert.deepEqual(machine.systemctlCalls(), []);
  });

  await t.test("a server folder linked to somewhere the service cannot see", async (t) => {
    const machine = await createMachine(t);
    const elsewhere = path.join(machine.root, "home", "tester", "worlds");
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.symlinkSync(elsewhere, path.join(machine.checkout, "servers", "Demo", "world"));
    // A link that stays inside the server's folder is fine.
    fs.writeFileSync(path.join(machine.checkout, "servers", "Demo", "real.jar"), "jar");
    fs.symlinkSync("real.jar", path.join(machine.checkout, "servers", "Demo", "server.jar"));
    const result = machine.run();
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /PROBLEM: .*servers\/Demo\/world points to .*home\/tester\/worlds/);
    assert.doesNotMatch(result.output, /server\.jar points to/);
    assert.deepEqual(machine.systemctlCalls(), []);
  });
});

test("on a machine with nothing running yet, --check describes a first install", { skip }, async (t) => {
  const machine = await createMachine(t, { oldUnit: false });

  const check = machine.run(["--check", "--node", machine.node]);

  assert.equal(check.status, 0, check.output);
  assert.match(check.output, /serving now:\s+nothing/);
  assert.match(check.output, /listens on:\s+127\.0\.0\.1 port 4300/);
  assert.match(check.output, /\d\. start rippercraft\.service/);
  assert.doesNotMatch(check.output, /rippermoonstash/);
  assert.deepEqual(machine.systemctlCalls(), []);
});

test("a checkout that has never been run is given its data/ and servers/ folders first", { skip }, async (t) => {
  const machine = await createMachine(t, { neverRun: true, oldUnit: false });
  const folders = ["data", "servers"].map((name) => path.join(machine.checkout, name));

  // Looking only: they are not made, and the sandbox cannot be tried without them.
  const check = machine.run(["--check", "--node", machine.node]);
  assert.equal(check.status, 0, check.output);
  assert.match(check.output, /data\/ and servers\/ do not exist yet/);
  assert.match(check.output, /1\. make data\/ and servers\/ in the checkout, and try the sandbox out/);
  assert.deepEqual(folders.map((folder) => fs.existsSync(folder)), [false, false]);
  assert.equal(machine.sandboxRuns().length, 0);

  const result = machine.run(["--node", machine.node]);
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(folders.map((folder) => fs.existsSync(folder)), [true, true]);
  assert.equal(machine.sandboxRuns().length, 2);
  assert.equal(machine.isActive(NEW_UNIT), true);
});

test("a first install listens where it is told, on this machine only by default", { skip }, async (t) => {
  const machine = await createMachine(t, { oldUnit: false });
  fs.mkdirSync(path.join(machine.state, NEW_UNIT), { recursive: true });
  fs.writeFileSync(path.join(machine.state, NEW_UNIT, "port"), "4400\n");

  const result = machine.run(["--node", machine.node, "--port", "4400"]);

  assert.equal(result.status, 0, result.output);
  const unit = machine.unitFile(NEW_UNIT);
  assert.match(unit, /^Environment=HOST=127\.0\.0\.1$/m);
  assert.match(unit, /^Environment=PORT=4400$/m);
  assert.equal(machine.isActive(NEW_UNIT), true);
  assert.equal(machine.isEnabled(NEW_UNIT), true);
  const calls = machine.systemctlCalls();
  assert.equal(calls.some((call) => call.startsWith("stop ")), false);
  assert.equal(calls.some((call) => call.startsWith("disable ")), false);
  assert.equal(fs.existsSync(path.join(machine.root, "etc", "rippercraft.env")), false);
});

test("the unit shows node, and only node, when node is installed in a home directory", { skip }, async (t) => {
  const machine = await createMachine(t, { nodeInHome: true });

  const result = machine.run();

  assert.equal(result.status, 0, result.output);
  const unit = machine.unitFile(NEW_UNIT);
  assert.match(unit, new RegExp(`^BindReadOnlyPaths=${machine.node}$`, "m"));
});

test("the unit names node nowhere else when node is already in view", { skip }, async (t) => {
  const machine = await createMachine(t);
  assert.equal(machine.run().status, 0);
  const binds = machine.unitFile(NEW_UNIT).split("\n").filter((line) => line.startsWith("BindReadOnlyPaths="));
  assert.equal(binds.some((line) => line.includes(machine.node)), false);
  assert.doesNotMatch(machine.unitFile(NEW_UNIT), /Node is installed where the lines above have hidden it/);
});

test("on systemd older than 257 the private /tmp is the kind that systemd has", { skip }, async (t) => {
  const machine = await createMachine(t);

  const result = machine.run([], { env: { FAKE_SYSTEMD_VERSION: "255" } });

  assert.equal(result.status, 0, result.output);
  assert.match(machine.unitFile(NEW_UNIT), /^PrivateTmp=yes$/m);
});

test("the port in the environment file is the one that is checked", { skip }, async (t) => {
  const machine = await createMachine(t);
  // The file wins over the unit's own Environment= lines, for systemd and so
  // for the dashboard.
  fs.appendFileSync(path.join(machine.root, "etc", "rippermoonstash.env"), "PORT=4444\n");
  for (const unit of [OLD_UNIT, NEW_UNIT]) {
    fs.mkdirSync(path.join(machine.state, unit), { recursive: true });
    fs.writeFileSync(path.join(machine.state, unit, "port"), "4444\n");
  }

  const result = machine.run();

  assert.equal(result.status, 0, result.output);
  assert.match(fs.readFileSync(path.join(machine.state, "curl.log"), "utf8"), /^http:\/\/127\.0\.0\.1:4444\/api\/bootstrap$/m);
});

test("blanks after a value in the environment file do not count, as they do not for systemd", { skip }, async (t) => {
  const machine = await createMachine(t);
  fs.appendFileSync(path.join(machine.root, "etc", "rippermoonstash.env"), 'PORT="4445"  \n');
  for (const unit of [OLD_UNIT, NEW_UNIT]) {
    fs.mkdirSync(path.join(machine.state, unit), { recursive: true });
    fs.writeFileSync(path.join(machine.state, unit, "port"), "4445\n");
  }

  const result = machine.run();

  assert.equal(result.status, 0, result.output);
  assert.equal(machine.isActive(NEW_UNIT), true);
});

test("the script knows every name the unit template leaves to it", () => {
  const template = fs.readFileSync(TEMPLATE, "utf8");
  const script = fs.readFileSync(SCRIPT, "utf8");
  for (const name of new Set(template.match(/@[A-Z_]+@/g))) {
    assert.ok(script.includes(name), `the script fills in ${name}`);
  }
  for (const [, name] of template.matchAll(/^#@if ([A-Z_]+)$/gm)) {
    assert.ok(script.includes(`#@if ${name}`), `the script decides about the ${name} lines`);
  }
  // The group the unit is told to run in is the script's to create.
  assert.match(script, /^SERVICE_GROUP="rippercraft"$/m);
});

// `systemd-analyze verify` can be told to judge one unit alone from systemd 250.
const systemdVersion = Number((/^systemd (\d+)/.exec(spawnSync("systemd-analyze", ["--version"], { encoding: "utf8" }).stdout || "") || [])[1]);
const noSystemd = systemdVersion >= 250 ? false : "systemd-analyze 250 or later is not installed";

test("systemd accepts the unit as the migration script fills it in", { skip: skip || noSystemd }, async (t) => {
  const machine = await createMachine(t);
  assert.equal(machine.run().status, 0);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "rippercraft-unit-"));
  t.after(() => fs.rmSync(folder, { force: true, recursive: true }));
  const unit = path.join(folder, NEW_UNIT);
  fs.writeFileSync(unit, machine.unitFile(NEW_UNIT));

  // Only this unit: what else is installed on the machine running the tests
  // is not this test's business.
  const verify = spawnSync("systemd-analyze", ["verify", "--recursive-errors=no", unit], { encoding: "utf8" });
  const about = `${verify.stdout}${verify.stderr}`.split("\n").filter((line) => line.includes(NEW_UNIT));

  assert.deepEqual(about, []);
  assert.equal(verify.status, 0, verify.stderr);
});
