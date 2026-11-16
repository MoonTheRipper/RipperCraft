const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { NEW_UNIT, OLD_UNIT, assertNothingChanged, createMachine, originalData, unsupportedReason } = require("../test-support/migration");

// infra/systemd/migrate-to-rippercraft.sh against what a mod can leave for it.
//
// data/ and servers/ are the two folders the service can write to. The script
// is run by root, and reaches into the checkout as the checkout's owner: both
// have the whole machine, or the whole account, where the service has a
// sandbox. Whatever is in those two folders is therefore somebody else's, and
// nothing in them may decide what the script reads, writes or runs.
const skip = unsupportedReason();

// A file outside the checkout, standing for something of the account's that
// the service cannot reach: a key, a shell profile.
function outsideFile(machine, contents) {
  const file = path.join(machine.base, "outside-the-sandbox.txt");
  fs.writeFileSync(file, contents);
  return file;
}

test("a link left where a data file is put back is replaced, not written through", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  const outside = outsideFile(machine, "the account's own\n");
  // The new dashboard starts, and code running in it swaps a data file for a
  // link and leaves another under the name an earlier version of this script
  // wrote through. Then the migration fails and everything is put back.
  machine.flag("new-status", "500");
  machine.hook(
    `on-start-${NEW_UNIT}`,
    [
      `rm -f "${machine.checkout}/data/users.json"`,
      `ln -s "${outside}" "${machine.checkout}/data/users.json"`,
      `ln -s "${outside}" "${machine.checkout}/data/users.json.rippercraft-restore"`,
      `ln -s "${outside}" "${machine.checkout}/data/app.json.rippercraft-restore"`
    ].join("\n")
  );

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.equal(fs.readFileSync(outside, "utf8"), "the account's own\n");
  assert.equal(fs.lstatSync(path.join(machine.checkout, "data", "users.json")).isFile(), true);
  assertNothingChanged(machine, before);
  for (const name of Object.keys(before)) {
    assert.equal(fs.statSync(path.join(machine.checkout, "data", name)).mode & 0o777, 0o600, name);
  }
  // Nothing of the putting back is left lying in the checkout.
  assert.deepEqual(fs.readdirSync(machine.checkout).filter((name) => name.startsWith(".rippercraft-")), []);
});

test("--rollback does not write through a link left in data/ either", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  assert.equal(machine.run().status, 0);
  const outside = outsideFile(machine, "the account's own\n");
  fs.rmSync(path.join(machine.checkout, "data", "app.json"));
  fs.symlinkSync(outside, path.join(machine.checkout, "data", "app.json"));
  fs.symlinkSync(outside, path.join(machine.checkout, "data", "servers.json.rippercraft-restore"));

  const result = machine.run(["--rollback"]);

  assert.equal(result.status, 0, result.output);
  assert.equal(fs.readFileSync(outside, "utf8"), "the account's own\n");
  assertNothingChanged(machine, before);
  // What was in data/ just before going back is kept, but a link is not read.
  const kept = path.join(machine.backup(), "data-before-rollback");
  assert.equal(fs.existsSync(path.join(kept, "users.json")), true);
  assert.notEqual(fs.existsSync(path.join(kept, "app.json")) && fs.readFileSync(path.join(kept, "app.json"), "utf8"), "the account's own\n");
});

test("a data file that is a link is refused before anything is read through it", { skip }, async (t) => {
  const machine = await createMachine(t);
  const outside = outsideFile(machine, '{"a secret":"of the account"}\n');
  fs.rmSync(path.join(machine.checkout, "data", "app.json"));
  fs.symlinkSync(outside, path.join(machine.checkout, "data", "app.json"));

  const result = machine.run();

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /PROBLEM: data\/app\.json is not an ordinary file/);
  assert.deepEqual(machine.systemctlCalls(), []);
  assert.equal(machine.backupCount(), 0);
});

test("a data file swapped for a link after the look is not copied into the backup", { skip }, async (t) => {
  const machine = await createMachine(t, { oldUnit: false });
  const outside = outsideFile(machine, '{"a secret":"of the account"}\n');
  // Between the look and the backup: the trial run of the sandbox is the
  // moment a test can step in.
  fs.writeFileSync(
    path.join(machine.base, "bin", "systemd-run"),
    `#!/usr/bin/env bash\nrm -f "${machine.checkout}/data/app.json"\nln -s "${outside}" "${machine.checkout}/data/app.json"\necho "      ok    (stand-in sandbox)"\n`,
    { mode: 0o755 }
  );

  const result = machine.run(["--node", machine.node]);

  assert.equal(result.status, 1, result.output);
  const backup = machine.backup();
  const copied = backup && fs.existsSync(path.join(backup, "data", "app.json")) ? fs.readFileSync(path.join(backup, "data", "app.json"), "utf8") : "";
  assert.doesNotMatch(copied, /a secret/);
  assert.equal(machine.unitFile(NEW_UNIT), null);
  assert.deepEqual(machine.systemctlCalls(), []);
});

test("a copy of a data file that does not match the original stops the migration", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  machine.flag("fail-backup-compare");

  const result = machine.run();

  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /the copy of data\/app\.json does not match the original/);
  assertNothingChanged(machine, before);
  assert.deepEqual(machine.systemctlCalls(), []);
});

test("everything in the checkout is done as its owner, with the checkout's hooks off", { skip }, async (t) => {
  const machine = await createMachine(t);
  const marker = path.join(machine.base, "a-hook-ran");
  for (const hook of ["post-merge", "post-checkout", "pre-merge-commit", "reference-transaction"]) {
    fs.writeFileSync(path.join(machine.checkout, ".git", "hooks", hook), `#!/bin/sh\necho ${hook} >> "${marker}"\n`, { mode: 0o755 });
  }

  assert.equal(machine.run().status, 0);
  assert.equal(machine.run(["--rollback"]).status, 0);

  assert.equal(fs.existsSync(marker), false, "no hook of the checkout was run");
  assert.deepEqual(machine.usesOutsideOwner(), []);
  assert.deepEqual(machine.accountsUsed(), [require("node:os").userInfo().username]);
});

test("a pid file that cannot be read, or names something else, is not a game server", { skip }, async (t) => {
  const machine = await createMachine(t);
  const servers = path.join(machine.checkout, "servers");
  const pidFile = (name) => path.join(servers, name, ".rippermoon", "pid.json");
  for (const name of ["Unreadable", "Elsewhere", "Rubbish", "Linked"]) {
    fs.mkdirSync(path.dirname(pidFile(name)), { recursive: true });
  }
  // One a mod has made unreadable; one that names a process which is not part
  // of the service; one that is not what a pid file looks like; one that is a
  // link to a file of the account's.
  fs.writeFileSync(pidFile("Unreadable"), '{"pid": 1}');
  fs.chmodSync(pidFile("Unreadable"), 0o000);
  fs.writeFileSync(pidFile("Elsewhere"), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(pidFile("Rubbish"), "$(touch /tmp/never) `id` ; pid");
  fs.symlinkSync(outsideFile(machine, '{"pid": 1}'), pidFile("Linked"));

  const check = machine.run(["--check"]);

  assert.equal(check.status, 0, check.output);
  assert.match(check.output, /game server running: Demo \(pid \d+/);
  assert.match(check.output, new RegExp(`note: Elsewhere records pid ${process.pid}, which is not part of`));
  assert.doesNotMatch(check.output, /game server running: (Unreadable|Elsewhere|Rubbish|Linked)/);

  // And none of them holds the migration up, or its summary.
  const result = machine.run();
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Done\. The dashboard runs sandboxed/);
  assert.match(result.output, /Next\n/);
  assert.equal(machine.head(), machine.newCommit);
});

test("a game server started after the first look is watched all the same", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  // Somebody starts a server while the script is at work: after it has looked,
  // before it stops the old unit. This one does not survive the stop.
  const late = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => late.kill("SIGKILL"));
  machine.hook(
    "on-groupadd",
    [
      `mkdir -p "${machine.checkout}/servers/Late/.rippermoon" "${machine.root}/proc/${late.pid}"`,
      `printf '{"pid": ${late.pid}}' > "${machine.checkout}/servers/Late/.rippermoon/pid.json"`,
      `printf '0::/system.slice/${OLD_UNIT}\\n' > "${machine.root}/proc/${late.pid}/cgroup"`,
      `printf '${late.pid}\\n' > "${machine.state}/kill-on-stop"`
    ].join("\n")
  );

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /game server Late \(pid \d+\) is no longer running/);
  fs.rmSync(path.join(machine.checkout, "servers", "Late"), { recursive: true });
  assertNothingChanged(machine, before);
  assert.equal(machine.gameServerAlive(), true);
});

test("an account in a group that hands out root is refused where that group's socket is", { skip }, async (t) => {
  const machine = await createMachine(t);
  machine.flag("extra-groups", "docker lxd");

  // Neither service is installed: said, and no more.
  const without = machine.run(["--check"]);
  assert.equal(without.status, 0, without.output);
  assert.match(without.output, /note: \S+ is in the group docker, which is as good as root where its service is installed/);
  assert.match(without.output, /note: \S+ is in the group lxd/);

  // Docker's socket is there: the service would be root's equal.
  fs.mkdirSync(path.join(machine.root, "run"), { recursive: true });
  fs.writeFileSync(path.join(machine.root, "run", "docker.sock"), "");
  const result = machine.run();
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /PROBLEM: \S+ is in the group docker, and \/run\/docker\.sock is there/);
  assert.deepEqual(machine.systemctlCalls(), []);
  assert.equal(machine.backupCount(), 0);
});

test("an account whose own group is called rippercraft gets a service group by another name", { skip }, async (t) => {
  const machine = await createMachine(t);
  machine.flag("primary-group", "rippercraft\n");

  const result = machine.run();

  assert.equal(result.status, 0, result.output);
  assert.match(machine.unitFile(NEW_UNIT), /^Group=rippercraft-service$/m);
  assert.match(fs.readFileSync(path.join(machine.state, "groupadd.log"), "utf8"), /^--system rippercraft-service$/m);
  assert.match(machine.sandboxRuns().at(-1), /\tGroup=rippercraft-service\t/);
});
