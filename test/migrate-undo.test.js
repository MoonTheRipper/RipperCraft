const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  NEW_UNIT,
  OLD_UNIT,
  assertBefore,
  assertNothingChanged,
  createMachine,
  originalData,
  unsupportedReason
} = require("../test-support/migration");

// infra/systemd/migrate-to-rippercraft.sh when something goes wrong: every way
// it has of going back, tried against the stand-in machine of
// test-support/migration.js. The rule being tested is the one the script
// states: once the running unit has been stopped, the dashboard is not left
// stopped.
const skip = unsupportedReason();

test("a dashboard that fails its check is undone, and the old one answers again", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  // The new code answers, but without its Content-Security-Policy: the wrong
  // code is running. While it ran, somebody signed in and their password was
  // stored again in the form the old code cannot read.
  machine.flag("new-csp", "");
  machine.hook(
    `on-start-${NEW_UNIT}`,
    `printf '%s' '{"users":[{"username":"owner","passwordHash":"scrypt$new-format"}]}' > "${machine.checkout}/data/users.json"`
  );

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /without the Content-Security-Policy header the new code sends/);
  assert.match(result.output, /The migration did not go through, and everything is back as it was/);
  assert.match(result.output, /rippermoonstash\.service is serving the dashboard at commit/);
  assertNothingChanged(machine, before);
  assert.equal(machine.gameServerAlive(), true);

  const calls = machine.systemctlCalls();
  assertBefore(calls, `start ${NEW_UNIT}`, `stop ${NEW_UNIT}`);
  assertBefore(calls, `stop ${NEW_UNIT}`, `start ${OLD_UNIT}`);
  assert.equal(calls.includes(`enable ${NEW_UNIT}`), false);
  assert.equal(calls.includes(`disable ${OLD_UNIT}`), false);
  // The backup is kept, with the record of what happened.
  assert.match(fs.readFileSync(path.join(machine.backup(), "migrate.log"), "utf8"), /Going back/);
});

test("a dashboard that answers with an error is undone", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  machine.flag("new-status", "500");

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /GET \/api\/bootstrap answered 500, not 200/);
  assertNothingChanged(machine, before);
});

test("a unit that does not start is undone", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  machine.flag(`fail-start-${NEW_UNIT}`);

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /Going back: rippercraft\.service could not be started/);
  // What systemctl said is not lost.
  assert.match(result.output, /Job for rippercraft\.service failed/);
  assert.match(result.output, /rippermoonstash\.service is running again and answers/);
  assertNothingChanged(machine, before);
  assert.equal(machine.gameServerAlive(), true);
});

test("a game server lost in the handover undoes the migration and is reported", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  machine.flag("lose-game-servers-on-stop");

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /game server Demo \(pid \d+\) is no longer running/);
  assert.match(result.output, /Why: a game server that was running is not running any more/);
  assertNothingChanged(machine, before);
});

test("the old unit is not stopped unless stopping it is safe for game servers", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  // systemd does not pick the drop-in up.
  machine.flag("ignore-dropins");

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /would still stop its game servers when stopped \(KillMode=control-group\)/);
  assert.match(result.output, /The running dashboard was never stopped/);
  assertNothingChanged(machine, before);
  assert.equal(machine.systemctlCalls().some((call) => call.startsWith("stop ")), false);
  assert.equal(machine.gameServerAlive(), true);
  assert.equal(fs.existsSync(path.join(machine.unitDir, `${OLD_UNIT}.d`)), false, "the drop-in that did not take is removed");
});

test("the old unit is looked at once more just before it is stopped", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  // Between the drop-in being written and the unit being stopped, something
  // else on the machine takes the drop-in away and reloads systemd.
  machine.hook(
    "on-groupadd",
    `rm -rf "${machine.unitDir}/${OLD_UNIT}.d" && systemctl daemon-reload`
  );

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /rippermoonstash\.service no longer has KillMode=process/);
  assert.match(result.output, /The running dashboard was never stopped/);
  assertNothingChanged(machine, before);
  assert.equal(machine.systemctlCalls().some((call) => call.startsWith("stop ")), false);
  assert.equal(machine.gameServerAlive(), true);
});

test("a failure at the very last step still leaves what was running enabled", { skip }, async (t) => {
  // Each unit is the one that was running in turn, and the step after the new
  // unit has been enabled is made to fail.
  for (const running of [OLD_UNIT, NEW_UNIT]) {
    const machine = await createMachine(t);
    if (running === NEW_UNIT) {
      // rippercraft.service is what is running; the old unit is installed,
      // stopped, and still enabled, so there is one more thing to do after
      // enabling the new one.
      fs.copyFileSync(path.join(machine.unitDir, OLD_UNIT), path.join(machine.unitDir, NEW_UNIT));
      fs.cpSync(path.join(machine.state, OLD_UNIT), path.join(machine.state, NEW_UNIT), { recursive: true });
      fs.writeFileSync(path.join(machine.state, OLD_UNIT, "active"), "inactive\n");
      fs.writeFileSync(path.join(machine.root, "proc", String(machine.gameServerPid), "cgroup"), `0::/system.slice/${NEW_UNIT}\n`);
      fs.mkdirSync(path.join(machine.unitDir, `${NEW_UNIT}.d`));
      fs.writeFileSync(path.join(machine.unitDir, `${NEW_UNIT}.d`, "keep.conf"), "[Service]\nKillMode=process\n");
    }
    machine.flag(`fail-disable-${OLD_UNIT}`);

    const result = machine.run();

    assert.equal(result.status, 2, `${running}: ${result.output}`);
    assert.match(result.output, /rippermoonstash\.service could not be disabled/, running);
    assert.equal(machine.isActive(running), true, `${running} is running again`);
    assert.equal(machine.isEnabled(running), true, `${running} still starts with the machine`);
    assert.equal(machine.head(), machine.oldCommit, running);
    assert.equal(machine.gameServerAlive(), true, running);
  }
});

test("being interrupted while waiting for the new dashboard undoes the migration", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  machine.flag("new-status", "503");
  machine.flag("interrupt-on-sleep");

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /Going back: interrupted/);
  assertNothingChanged(machine, before);
  assert.equal(machine.gameServerAlive(), true);
});

test("a hang-up of the terminal in the middle does not stop the migration", { skip }, async (t) => {
  const machine = await createMachine(t);
  // The new dashboard takes a moment to answer, and the terminal the script
  // was started from goes away while it waits.
  machine.flag("new-slow-start", "1");
  machine.flag("interrupt-on-sleep", "HUP");

  const result = machine.run();

  assert.equal(result.status, 0, result.output);
  assert.equal(machine.isActive(NEW_UNIT), true);
  assert.equal(machine.isEnabled(NEW_UNIT), true);
  assert.equal(fs.existsSync(path.join(machine.state, "interrupt-on-sleep")), false, "the hang-up was sent");
  // What it said is in the log beside the backup, terminal or no terminal.
  assert.match(fs.readFileSync(path.join(machine.backup(), "migrate.log"), "utf8"), /Done\. The dashboard runs sandboxed/);
});

test("a script that ends where nobody expected it to still puts everything back", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  // The record beside the backup can no longer be written, which nothing in
  // the script looks out for: it simply ends there, with the checkout about
  // to move.
  machine.hook("on-groupadd", `chmod a-w "${machine.root}"/var/backups/rippercraft/*/state`);

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /Going back: the script ended unexpectedly/);
  assertNothingChanged(machine, before);
  assert.equal(machine.gameServerAlive(), true);
});

test("an old dashboard that comes back but does not answer is reported as down", { skip }, async (t) => {
  const machine = await createMachine(t);
  machine.flag("new-status", "500");
  machine.hook(`on-start-${NEW_UNIT}`, `printf 500 > "${machine.state}/old-status"`);

  const result = machine.run();

  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /COULD NOT bring rippermoonstash\.service back/);
  assert.match(result.output, /THE DASHBOARD IS DOWN/);
});

test("a data file that cannot be put back is said to be that, with the dashboard running", { skip }, async (t) => {
  const machine = await createMachine(t);
  machine.flag("new-status", "500");
  // Code in the new dashboard leaves a folder where a data file belongs. A
  // file cannot be moved over a folder that has something in it.
  machine.hook(
    `on-start-${NEW_UNIT}`,
    `rm -f "${machine.checkout}/data/users.json" && mkdir -p "${machine.checkout}/data/users.json/in-the-way"`
  );

  const result = machine.run();

  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /COULD NOT put back data\/users\.json/);
  assert.match(result.output, /GOING BACK DID NOT WORK ALL THE WAY\. rippermoonstash\.service is serving the dashboard/);
  assert.doesNotMatch(result.output, /THE DASHBOARD IS DOWN/);
  assert.equal(machine.isActive(OLD_UNIT), true);
  assert.equal(machine.readData("app.json"), '{"cookieSecret":"old-secret"}\n', "what could be put back was");
});

test("when going back fails too, it says the dashboard is down and how to look", { skip }, async (t) => {
  const machine = await createMachine(t);
  machine.flag(`fail-start-${NEW_UNIT}`);
  machine.flag(`fail-start-${OLD_UNIT}`);

  const result = machine.run();

  assert.equal(result.status, 3, result.output);
  assert.match(result.output, /THE DASHBOARD IS DOWN/);
  assert.match(result.output, /sudo systemctl start rippermoonstash\.service/);
  assert.match(result.output, new RegExp(`${machine.backup()}/data`));
  // Everything that could be put back was.
  assert.equal(machine.head(), machine.oldCommit);
  assert.equal(machine.unitFile(NEW_UNIT), null);
});

test("--rollback undoes a migration that went through", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  assert.equal(machine.run().status, 0);
  // Since then the new code has stored a password its own way, and the key in
  // the new unit's environment file has been changed.
  const changed = '{"users":[{"username":"owner","passwordHash":"scrypt$new-format"}]}';
  fs.writeFileSync(path.join(machine.checkout, "data", "users.json"), changed);
  fs.writeFileSync(path.join(machine.root, "etc", "rippercraft.env"), "CURSEFORGE_API_KEY=a-newer-key\n");

  const result = machine.run(["--rollback"], {
    noCheckout: true,
    script: path.join(machine.checkout, "infra", "systemd", "migrate-to-rippercraft.sh")
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Done\. rippermoonstash\.service serves the dashboard again/);
  assertNothingChanged(machine, before);
  assert.equal(machine.gameServerAlive(), true);
  // What was there just before going back is kept as well.
  assert.equal(fs.readFileSync(path.join(machine.backup(), "data-before-rollback", "users.json"), "utf8"), changed);
  assert.match(fs.readFileSync(path.join(machine.backup(), "state"), "utf8"), /^STATE_PHASE=rolled-back$/m);

  // The environment file the migration copied is moved aside, not deleted: it
  // may have been edited since.
  assert.equal(fs.existsSync(path.join(machine.root, "etc", "rippercraft.env")), false);
  assert.equal(fs.readFileSync(path.join(machine.backup(), "rippercraft.env.removed"), "utf8"), "CURSEFORGE_API_KEY=a-newer-key\n");

  // There is nothing left to go back from.
  const twice = machine.run(["--rollback"]);
  assert.equal(twice.status, 1, twice.output);
  assert.match(twice.output, /has been undone already/);

  // And the migration can be done again from here.
  assert.equal(machine.run().status, 0);
  assert.equal(machine.isActive(NEW_UNIT), true);
  assert.equal(machine.head(), machine.newCommit);
});

test("a later run that fails leaves the unit that was installed, and --rollback still undoes the migration", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  assert.equal(machine.run().status, 0);
  const firstBackup = machine.backup();
  // Somebody has edited the installed unit since, so a second run has something
  // to do: put the unit back as the script writes it. This time it does not start.
  const edited = `${machine.unitFile(NEW_UNIT)}\n# edited by hand\n`;
  fs.writeFileSync(path.join(machine.unitDir, NEW_UNIT), edited);
  machine.flag(`fail-start-once-${NEW_UNIT}`);

  const second = machine.run();

  assert.equal(second.status, 2, second.output);
  assert.match(second.output, /put back the earlier .*rippercraft\.service/);
  assert.match(second.output, /rippercraft\.service is serving the dashboard/);
  // It never ran the new unit successfully, so what was there is what is there.
  assert.equal(machine.unitFile(NEW_UNIT), edited);
  assert.equal(machine.head(), machine.newCommit);
  assert.equal(machine.gameServerAlive(), true);
  assert.equal(machine.backupCount(), 2);

  assert.equal(machine.isActive(NEW_UNIT), true);

  // Going back still means going back from the migration that went through.
  const rollback = machine.run(["--rollback"]);
  assert.equal(rollback.status, 0, rollback.output);
  assert.match(rollback.output, new RegExp(`the migration of ${path.basename(firstBackup)}:`));
  assertNothingChanged(machine, before);
});

test("a failure after the checkout has moved, before anything is stopped, moves it back", { skip }, async (t) => {
  const machine = await createMachine(t);
  const before = originalData(machine);
  machine.flag("fail-daemon-reload");
  // The drop-in still has to take, so reloading only starts failing once the
  // unit has been installed: the first reload is let through by hand.
  fs.mkdirSync(path.join(machine.unitDir, `${OLD_UNIT}.d`), { recursive: true });
  fs.writeFileSync(path.join(machine.unitDir, `${OLD_UNIT}.d`, "10-keep-game-servers.conf"), "[Service]\nKillMode=process\n");

  const result = machine.run();

  assert.equal(result.status, 2, result.output);
  assert.match(result.output, /systemd could not reload its units/);
  assert.match(result.output, /The running dashboard was never stopped/);
  assertNothingChanged(machine, before);
  assert.equal(machine.systemctlCalls().some((call) => call.startsWith("stop ")), false);
});

test("a first install that fails its check is taken out again", { skip }, async (t) => {
  const machine = await createMachine(t, { oldUnit: false });
  machine.flag("new-status", "500");

  const result = machine.run(["--node", machine.node]);

  assert.equal(result.status, 2, result.output);
  assert.equal(machine.unitFile(NEW_UNIT), null);
  assert.equal(machine.isActive(NEW_UNIT), false);
  assert.equal(machine.isEnabled(NEW_UNIT), false);
  assert.equal(machine.head(), machine.oldCommit);
});

