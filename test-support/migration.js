// A machine for infra/systemd/migrate-to-rippercraft.sh to migrate, small
// enough to build in a temporary folder and take down again.
//
// The script is the real one. What it would run as root is replaced: systemctl,
// systemd-run, systemd-analyze, runuser, curl and a few others are stand-ins on
// PATH that keep what they are told in files, and /etc, /var/backups and /proc
// are folders under RIPPERCRAFT_MIGRATE_TESTROOT. git is the real git, on a
// real repository with a commit to migrate from and one to migrate to, and the
// "game server" is a real process, so that staying alive means staying alive.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawn, spawnSync } = require("node:child_process");

const REPO_ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(REPO_ROOT, "infra", "systemd", "migrate-to-rippercraft.sh");
const TEMPLATE = path.join(REPO_ROOT, "infra", "systemd", "rippercraft.service");

const OLD_UNIT = "rippermoonstash.service";
const NEW_UNIT = "rippercraft.service";
const NEW_CSP = "default-src 'self'; script-src 'self'; frame-ancestors 'none'";

// Why the migration cannot be tried on this machine, or false when it can. The
// value goes straight into a test's `skip` option.
function unsupportedReason() {
  if (process.platform !== "linux") {
    return "the migration script is for Linux with systemd";
  }
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return "the script refuses a checkout that belongs to root";
  }
  for (const program of ["bash", "git"]) {
    if (spawnSync(program, ["--version"], { stdio: "ignore" }).status !== 0) {
      return `${program} is not installed`;
    }
  }
  return false;
}

const SYSTEMCTL = `#!/usr/bin/env bash
# Stand-in for systemctl. Units are the files under $UNITS; what each is doing
# is kept in $FAKE_STATE/<unit>/. As with the real one, a drop-in counts only
# once daemon-reload has been run.
set -u
STATE="$FAKE_STATE"
UNITS="$RIPPERCRAFT_MIGRATE_TESTROOT/etc/systemd/system"

record() { printf '%s\\n' "$*" >>"$STATE/systemctl.log"; }

reload_unit() {
  local unit="$1" file="$UNITS/$1" kill_mode="control-group" dropin
  mkdir -p "$STATE/$unit"
  [ -f "$file" ] || return 0
  if grep -q '^KillMode=process' "$file"; then kill_mode="process"; fi
  if [ ! -e "$STATE/ignore-dropins" ]; then
    for dropin in "$UNITS/$unit.d"/*.conf; do
      [ -f "$dropin" ] || continue
      if grep -q '^KillMode=process' "$dropin"; then kill_mode="process"; fi
    done
  fi
  printf '%s\\n' "$kill_mode" >"$STATE/$unit/killmode"
  sed -n 's/^ExecStart=//p' "$file" | tail -n 1 >"$STATE/$unit/execstart"
  sed -n 's/^Environment=//p' "$file" | tr '\\n' ' ' | sed 's/ $//' >"$STATE/$unit/environment"
}

case "\${1:-}" in
  --version)
    printf 'systemd %s (fake)\\n' "\${FAKE_SYSTEMD_VERSION:-259}"
    ;;
  daemon-reload)
    record "daemon-reload"
    [ ! -e "$STATE/fail-daemon-reload" ] || exit 1
    for file in "$UNITS"/*.service; do
      [ -f "$file" ] && reload_unit "$(basename "$file")"
    done
    ;;
  show)
    unit="$2"; property="$4"
    [ -f "$STATE/$unit/killmode" ] || reload_unit "$unit"
    case "$property" in
      LoadState) if [ -f "$UNITS/$unit" ]; then echo loaded; else echo not-found; fi ;;
      ActiveState) cat "$STATE/$unit/active" 2>/dev/null || echo inactive ;;
      UnitFileState)
        if [ ! -f "$UNITS/$unit" ]; then echo
        elif [ -e "$STATE/$unit/enabled" ]; then echo enabled
        else echo disabled; fi ;;
      KillMode) cat "$STATE/$unit/killmode" 2>/dev/null || echo control-group ;;
      ExecStart)
        line="$(cat "$STATE/$unit/execstart" 2>/dev/null || true)"
        [ -z "$line" ] || printf '{ path=%s ; argv[]=%s ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }\\n' "\${line%% *}" "$line" ;;
      Environment) cat "$STATE/$unit/environment" 2>/dev/null || true ;;
      *) echo ;;
    esac
    ;;
  start)
    unit="$2"; record "start $unit"
    mkdir -p "$STATE/$unit"
    if [ -e "$STATE/fail-start-$unit" ] || [ -e "$STATE/fail-start-once-$unit" ]; then
      rm -f "$STATE/fail-start-once-$unit"
      echo failed >"$STATE/$unit/active"
      echo "Job for $unit failed because the control process exited with error code." >&2
      exit 1
    fi
    echo active >"$STATE/$unit/active"
    if [ -x "$STATE/on-start-$unit" ]; then "$STATE/on-start-$unit"; fi
    ;;
  stop)
    unit="$2"; record "stop $unit"
    mkdir -p "$STATE/$unit"
    [ ! -e "$STATE/fail-stop-$unit" ] || exit 1
    was="$(cat "$STATE/$unit/active" 2>/dev/null || echo inactive)"
    echo inactive >"$STATE/$unit/active"
    # What systemd does to everything else the unit started.
    if [ "$was" = active ] && { [ "$(cat "$STATE/$unit/killmode" 2>/dev/null)" != process ] || [ -e "$STATE/lose-game-servers-on-stop" ]; }; then
      for pid in $(cat "$STATE/$unit/children" 2>/dev/null); do kill -KILL "$pid" 2>/dev/null; done
    fi
    # And what a test wants lost whatever the unit says.
    for pid in $(cat "$STATE/kill-on-stop" 2>/dev/null); do kill -KILL "$pid" 2>/dev/null; done
    sleep_real=/bin/sleep; [ -x "$sleep_real" ] || sleep_real=/usr/bin/sleep
    "$sleep_real" 0.2
    ;;
  enable | disable)
    unit="$2"; record "$1 $unit"
    mkdir -p "$STATE/$unit"
    [ ! -e "$STATE/fail-$1-$unit" ] || exit 1
    if [ "$1" = enable ]; then touch "$STATE/$unit/enabled"; else rm -f "$STATE/$unit/enabled"; fi
    ;;
  *)
    record "unexpected: $*"
    exit 64
    ;;
esac
`;

const CURL = `#!/usr/bin/env bash
# Stand-in for curl: answers as whichever unit is "running" would.
set -u
headers=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -D) headers="$2"; shift ;;
    -o | -w | --max-time | --noproxy) shift ;;
    http*) url="$1" ;;
  esac
  shift
done
printf '%s\\n' "$url" >>"$FAKE_STATE/curl.log"
port="\${url#http://}"; port="\${port#*:}"; port="\${port%%/*}"
running=""
for unit in ${NEW_UNIT} ${OLD_UNIT}; do
  if [ "$(cat "$FAKE_STATE/$unit/active" 2>/dev/null)" = active ]; then running="$unit"; break; fi
done
[ -n "$running" ] || exit 7
[ "$port" = "$(cat "$FAKE_STATE/$running/port" 2>/dev/null || echo 4300)" ] || exit 7
status=200; csp=""
if [ "$running" = ${NEW_UNIT} ]; then
  status="$(cat "$FAKE_STATE/new-status" 2>/dev/null || echo 200)"
  csp="$(cat "$FAKE_STATE/new-csp" 2>/dev/null || true)"
  # Not there yet, for as many askings as new-slow-start says.
  slow="$(cat "$FAKE_STATE/new-slow-start" 2>/dev/null || echo 0)"
  if [ "$slow" -gt 0 ]; then
    echo "$((slow - 1))" >"$FAKE_STATE/new-slow-start"
    exit 7
  fi
else
  status="$(cat "$FAKE_STATE/old-status" 2>/dev/null || echo 200)"
fi
{
  printf 'HTTP/1.1 %s OK\\r\\n' "$status"
  [ -z "$csp" ] || printf 'Content-Security-Policy: %s\\r\\n' "$csp"
  printf '\\r\\n'
} >"$headers"
printf '%s' "$status"
`;

const STAND_INS = {
  systemctl: SYSTEMCTL,
  curl: CURL,
  // Runs the command as whoever is running the tests. What it starts can tell
  // that it came through here: descriptor 9 stays open across \`env -i\` and
  // every exec after it, which no variable would.
  runuser: `#!/usr/bin/env bash
[ "$1" = "-u" ] || exit 64
printf '%s\\n' "$2" >>"$FAKE_STATE/runuser.log"
shift 2
[ "$1" = "--" ] && shift
exec 9>>"$FAKE_STATE/through-runuser"
exec "$@"
`,
  "systemd-analyze": `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_STATE/systemd-analyze.log"
for unit in "$@"; do :; done
if [ -e "$FAKE_STATE/fail-verify" ]; then
  echo "$unit: fake verification failure" >&2
  exit 1
fi
if grep -q '@[A-Z_]*@' "$unit"; then
  echo "$unit: placeholders left in the unit" >&2
  exit 1
fi
cp "$unit" "$FAKE_STATE/last-verified.service"
`,
  // Records the sandbox it was asked for. It builds none.
  "systemd-run": `#!/usr/bin/env bash
{
  printf 'run'
  for argument in "$@"; do
    [ "$argument" = "--" ] && break
    printf '\\t%s' "$argument"
  done
  printf '\\n'
} >>"$FAKE_STATE/systemd-run.log"
if [ -e "$FAKE_STATE/fail-rehearsal" ]; then
  echo "      FAIL  the home directory still shows: .ssh"
  exit 1
fi
echo "      ok    (stand-in sandbox)"
`,
  journalctl: `#!/usr/bin/env bash
echo "fake journal line for $*"
`,
  groupadd: `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE_STATE/groupadd.log"
[ ! -e "$FAKE_STATE/fail-groupadd" ] || exit 1
touch "$FAKE_STATE/group-exists"
if [ -x "$FAKE_STATE/on-groupadd" ]; then "$FAKE_STATE/on-groupadd"; fi
`,
  getent: `#!/usr/bin/env bash
if [ "$1" = "group" ] && { [ "$2" = "rippercraft" ] || [ "$2" = "rippercraft-service" ]; }; then
  [ -e "$FAKE_STATE/group-exists" ] || exit 2
  echo "$2:x:987:"
  exit 0
fi
for real in /usr/bin/getent /bin/getent; do
  [ -x "$real" ] && exec "$real" "$@"
done
exit 1
`,
  // Waiting is skipped. With interrupt-on-sleep, the wait for the dashboard to
  // answer is where the script is told to stop, as Ctrl-C would.
  sleep: `#!/usr/bin/env bash
if [ "$1" = 1 ] && [ -e "$FAKE_STATE/interrupt-on-sleep" ]; then
  signal="$(cat "$FAKE_STATE/interrupt-on-sleep")"
  rm -f "$FAKE_STATE/interrupt-on-sleep"
  kill "-\${signal:-TERM}" "$PPID"
fi
exit 0
`
};

function git(cwd, ...args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
      GIT_AUTHOR_EMAIL: "tester@example.invalid",
      GIT_AUTHOR_NAME: "Tester",
      GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
      GIT_COMMITTER_EMAIL: "tester@example.invalid",
      GIT_COMMITTER_NAME: "Tester",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1"
    }
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function writeFile(file, contents, mode) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, contents, mode ? { mode } : undefined);
}

// Builds the machine. Options:
//   oldUnit      whether rippermoonstash.service is installed and running (default true)
//   gameServer   whether a game server is running under it (default true)
//   nodeInHome   put node where the sandbox hides it (default false)
//   neverRun     a checkout as `git clone` leaves it: no data/, no servers/
//   checkoutName the name of the checkout's folder (default "checkout")
async function createMachine(t, options = {}) {
  const withOldUnit = options.oldUnit !== false;
  const withGameServer = withOldUnit && options.gameServer !== false;
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-migrate-"));
  const root = path.join(base, "root");
  const state = path.join(base, "state");
  const bin = path.join(base, "bin");
  const checkout = path.join(base, options.checkoutName || "checkout");
  const unitDir = path.join(root, "etc", "systemd", "system");
  const backups = path.join(root, "var", "backups", "rippercraft");
  const children = [];

  t.after(async () => {
    for (const child of children) {
      child.kill("SIGKILL");
    }
    await fsp.rm(base, { recursive: true, force: true });
  });

  await fsp.mkdir(state, { recursive: true });
  await fsp.mkdir(unitDir, { recursive: true });
  for (const [name, contents] of Object.entries(STAND_INS)) {
    await writeFile(path.join(bin, name), contents, 0o755);
  }
  // Real programs with a little added. The paths are written into them: what
  // the script runs as the checkout's owner is given no variables to find
  // them by.
  const real = (program) => spawnSync("sh", ["-c", `command -v ${program}`], { encoding: "utf8" }).stdout.trim();
  const outsideOwner = path.join(state, "outside-owner.log");
  // Notes each use that did not come through runuser: see the stand-in above.
  const noteUnlessOwner = (program) =>
    `if ! { true >&9; } 2>/dev/null; then printf '${program} %s\\n' "$*" >>'${outsideOwner}'; fi`;
  await writeFile(path.join(bin, "git"), `#!/usr/bin/env bash\n${noteUnlessOwner("git")}\nexec '${real("git")}' "$@"\n`, 0o755);
  // Fails the comparison of a backed-up file with its original, when told to.
  await writeFile(
    path.join(bin, "cmp"),
    `#!/usr/bin/env bash
if [ -e "$FAKE_STATE/fail-backup-compare" ]; then
  for argument in "$@"; do
    case "$argument" in */var/backups/*) exit 1 ;; esac
  done
fi
exec '${real("cmp")}' "$@"
`,
    0o755
  );
  // Puts the account in more groups, or another group of its own, when told to.
  await writeFile(
    path.join(bin, "id"),
    `#!/usr/bin/env bash
if [ "$1" = "-Gn" ] && [ -e "$FAKE_STATE/extra-groups" ]; then
  printf '%s %s\\n' "$('${real("id")}' "$@")" "$(cat "$FAKE_STATE/extra-groups")"
  exit 0
fi
if [ "$1" = "-gn" ] && [ -e "$FAKE_STATE/primary-group" ]; then
  cat "$FAKE_STATE/primary-group"
  exit 0
fi
exec '${real("id")}' "$@"
`,
    0o755
  );

  // node, java and zip as the service's PATH finds them.
  const programs = options.nodeInHome ? path.join(root, "home", "tester", ".nvm", "bin") : path.join(base, "programs");
  const node = path.join(programs, "node");
  await writeFile(node, `#!/bin/bash\n${noteUnlessOwner("node")}\nexec "${process.execPath}" "$@"\n`, 0o755);
  await writeFile(path.join(root, "usr", "bin", "java"), "#!/bin/sh\necho 'openjdk version \"25\"' >&2\n", 0o755);
  await writeFile(path.join(root, "usr", "bin", "zip"), "#!/bin/sh\nexit 0\n", 0o755);

  // The checkout: one commit as the old code was, one as the new code is.
  await fsp.mkdir(checkout, { recursive: true });
  git(checkout, "init", "--quiet", "--initial-branch=main");
  await writeFile(path.join(checkout, ".gitignore"), "data/\n!data/.gitkeep\nservers/*\n!servers/README.md\n");
  await writeFile(path.join(checkout, "src", "server.js"), "// the old code\n");
  await writeFile(path.join(checkout, "src", "lib", "http.js"), "module.exports = {};\n");
  await writeFile(path.join(checkout, "infra", "systemd", "rippercraft.service"), "[Service]\nUser=someone\n");
  await writeFile(path.join(checkout, "infra", "systemd", "migrate-to-rippercraft.sh"), "#!/bin/sh\necho old script\n");
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "old");
  const oldCommit = git(checkout, "rev-parse", "HEAD");

  await writeFile(path.join(checkout, "src", "server.js"), "// the new code\n");
  await writeFile(
    path.join(checkout, "src", "lib", "http.js"),
    `module.exports = { CONTENT_SECURITY_POLICY: ${JSON.stringify(NEW_CSP)} };\n`
  );
  await fsp.copyFile(TEMPLATE, path.join(checkout, "infra", "systemd", "rippercraft.service"));
  await fsp.copyFile(SCRIPT, path.join(checkout, "infra", "systemd", "migrate-to-rippercraft.sh"));
  await fsp.chmod(path.join(checkout, "infra", "systemd", "migrate-to-rippercraft.sh"), 0o755);
  git(checkout, "add", "-A");
  git(checkout, "commit", "--quiet", "-m", "new");
  const newCommit = git(checkout, "rev-parse", "HEAD");
  // As after `git fetch`: the new commit is known, the checkout is not on it.
  git(checkout, "update-ref", "refs/remotes/origin/main", newCommit);
  git(checkout, "reset", "--quiet", "--hard", oldCommit);

  const data = {
    "app.json": '{"cookieSecret":"old-secret"}\n',
    "servers.json": '{"servers":{}}\n',
    "users.json": '{"users":[{"username":"owner","passwordHash":"old-format"}]}\n'
  };
  if (!options.neverRun) {
    for (const [name, contents] of Object.entries(data)) {
      await writeFile(path.join(checkout, "data", name), contents, 0o600);
    }
    await fsp.mkdir(path.join(checkout, "servers"), { recursive: true });
    // What a dashboard with a running server leaves in data/ besides its
    // files: the server's console, a named pipe. The script looks through
    // data/ and backs up part of it, and must not stop at a pipe.
    await fsp.mkdir(path.join(checkout, "data", "consoles"), { mode: 0o700, recursive: true });
    execFileSync("mkfifo", ["-m", "600", path.join(checkout, "data", "consoles", "Demo")]);
  }

  let gameServerPid = 0;
  if (withOldUnit) {
    await writeFile(
      path.join(unitDir, OLD_UNIT),
      [
        "[Service]",
        "User=someone",
        "Environment=NODE_ENV=production",
        "Environment=HOST=0.0.0.0",
        "Environment=PORT=4300",
        `ExecStart=${node} ${checkout}/src/server.js`,
        ""
      ].join("\n")
    );
    await writeFile(path.join(root, "etc", "rippermoonstash.env"), "CURSEFORGE_API_KEY=secret-key\n", 0o600);
    await writeFile(path.join(state, OLD_UNIT, "active"), "active\n");
    await writeFile(path.join(state, OLD_UNIT, "enabled"), "");
  }
  if (withGameServer) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    gameServerPid = child.pid;
    await writeFile(
      path.join(checkout, "servers", "Demo", ".rippermoon", "pid.json"),
      `${JSON.stringify({ pid: gameServerPid, startedBy: "owner" }, null, 2)}\n`
    );
    await writeFile(path.join(root, "proc", String(gameServerPid), "cgroup"), `0::/system.slice/${OLD_UNIT}\n`);
    await writeFile(path.join(state, OLD_UNIT, "children"), `${gameServerPid}\n`);
  }
  await writeFile(path.join(state, "new-csp"), NEW_CSP);

  const environment = {
    ...process.env,
    FAKE_STATE: state,
    PATH: `${bin}:${process.env.PATH}`,
    // The stand-in sleep returns at once, but each look at the dashboard is
    // still a handful of processes: three looks are as good as forty-five.
    RIPPERCRAFT_MIGRATE_HEALTH_SECONDS: "3",
    RIPPERCRAFT_MIGRATE_TESTROOT: root
  };

  function run(args = [], extra = {}) {
    const script = extra.script || SCRIPT;
    const result = spawnSync("bash", [script, ...(extra.noCheckout ? [] : ["--checkout", checkout]), ...args], {
      cwd: extra.cwd || base,
      encoding: "utf8",
      env: { ...environment, ...(extra.env || {}) },
      timeout: 60_000
    });
    return { output: `${result.stdout}${result.stderr}`, status: result.status };
  }

  const read = (file) => fs.readFileSync(file, "utf8");
  const readOr = (file, fallback) => (fs.existsSync(file) ? read(file) : fallback);

  return {
    backups,
    base,
    checkout,
    gameServerPid,
    newCommit,
    node,
    oldCommit,
    root,
    run,
    state,
    unitDir,
    // The newest backup folder, or null.
    backup() {
      if (!fs.existsSync(backups)) {
        return null;
      }
      const names = fs.readdirSync(backups).filter((name) => name !== "latest").sort();
      return names.length ? path.join(backups, names[names.length - 1]) : null;
    },
    backupCount() {
      return fs.existsSync(backups) ? fs.readdirSync(backups).filter((name) => name !== "latest").length : 0;
    },
    // Tells a stand-in how to behave: flag("fail-start-rippercraft.service").
    flag(name, contents = "") {
      fs.writeFileSync(path.join(state, name), contents);
    },
    hook(name, script) {
      fs.writeFileSync(path.join(state, name), `#!/usr/bin/env bash\n${script}\n`, { mode: 0o755 });
    },
    gameServerAlive() {
      try {
        process.kill(gameServerPid, 0);
        return true;
      } catch {
        return false;
      }
    },
    head() {
      return git(checkout, "rev-parse", "HEAD");
    },
    isActive(unit) {
      return readOr(path.join(state, unit, "active"), "inactive").trim() === "active";
    },
    isEnabled(unit) {
      return fs.existsSync(path.join(state, unit, "enabled"));
    },
    readData(name) {
      return read(path.join(checkout, "data", name));
    },
    sandboxRuns() {
      return readOr(path.join(state, "systemd-run.log"), "").split("\n").filter(Boolean);
    },
    // Every systemctl call that changed something, in order.
    systemctlCalls() {
      return readOr(path.join(state, "systemctl.log"), "").split("\n").filter(Boolean);
    },
    // Each time git or node was run on the checkout other than as its owner.
    usesOutsideOwner() {
      return readOr(outsideOwner, "").split("\n").filter(Boolean);
    },
    // The accounts runuser was asked for, each once.
    accountsUsed() {
      return [...new Set(readOr(path.join(state, "runuser.log"), "").split("\n").filter(Boolean))];
    },
    unitFile(unit) {
      return readOr(path.join(unitDir, unit), null);
    }
  };
}

// One systemctl call came before another.
function assertBefore(calls, first, second) {
  const a = calls.indexOf(first);
  const b = calls.indexOf(second);
  assert.ok(a !== -1, `expected a call "${first}" in:\n${calls.join("\n")}`);
  assert.ok(b !== -1, `expected a call "${second}" in:\n${calls.join("\n")}`);
  assert.ok(a < b, `expected "${first}" before "${second}" in:\n${calls.join("\n")}`);
}

// The machine exactly as it was before the script ran.
function assertNothingChanged(machine, original) {
  assert.equal(machine.head(), machine.oldCommit, "the checkout is on the old commit");
  assert.equal(machine.isActive(OLD_UNIT), true, "the old unit is running");
  assert.equal(machine.isEnabled(OLD_UNIT), true, "the old unit is enabled");
  assert.equal(machine.isActive(NEW_UNIT), false, "the new unit is not running");
  assert.equal(machine.isEnabled(NEW_UNIT), false, "the new unit is not enabled");
  assert.equal(machine.unitFile(NEW_UNIT), null, "the new unit is not installed");
  assert.equal(fs.existsSync(path.join(machine.root, "etc", "rippercraft.env")), false, "no environment file was left");
  for (const [name, contents] of Object.entries(original)) {
    assert.equal(machine.readData(name), contents, `data/${name} is as it was`);
  }
}

function originalData(machine) {
  return Object.fromEntries(["app.json", "servers.json", "users.json"].map((name) => [name, machine.readData(name)]));
}

module.exports = {
  NEW_CSP,
  NEW_UNIT,
  OLD_UNIT,
  SCRIPT,
  TEMPLATE,
  assertBefore,
  assertNothingChanged,
  createMachine,
  originalData,
  unsupportedReason
};
