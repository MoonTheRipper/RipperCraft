const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { SCRIPT, unsupportedReason } = require("../test-support/migration");

// The probe that infra/systemd/migrate-to-rippercraft.sh runs inside the
// sandbox before it changes anything. Its job is to say no when the sandbox is
// not what the unit asks for. There is no sandbox here - building one takes
// root - so that is exactly what these tests can see: run with none at all, it
// has to notice.
const skip = unsupportedReason();

// The probe as the script hands it to bash: what is between the two marks.
function probeText() {
  const script = fs.readFileSync(SCRIPT, "utf8");
  const start = script.indexOf("cat <<'PROBE'\n");
  const end = script.indexOf("\nPROBE\n", start);
  assert.ok(start !== -1 && end !== -1, "the probe is where it is expected in the script");
  return script.slice(start + "cat <<'PROBE'\n".length, end + 1);
}

// A checkout and a home directory for the probe to look at, and a file each in
// the machine's own /tmp, /var/tmp and /dev/shm that a real sandbox would hide.
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rippercraft-probe-"));
  const checkout = path.join(base, "home", "minecraft-server");
  const home = path.join(base, "home");
  for (const folder of ["src", "public", ".git", "infra/systemd", "data", "servers"]) {
    fs.mkdirSync(path.join(checkout, folder), { recursive: true });
  }
  fs.writeFileSync(path.join(checkout, "src", "server.js"), "// code\n");
  fs.mkdirSync(path.join(home, ".ssh"));
  const markers = ["/tmp", "/var/tmp", "/dev/shm"].map((folder) => {
    try {
      const file = path.join(folder, `rippercraft-rehearsal.test-${process.pid}-${Math.random().toString(16).slice(2)}`);
      fs.writeFileSync(file, "");
      return file;
    } catch {
      return "";
    }
  });
  t.after(() => {
    for (const file of markers.filter(Boolean)) {
      fs.rmSync(file, { force: true });
    }
    fs.rmSync(base, { force: true, recursive: true });
  });
  return { checkout, home, markers };
}

function runProbe(probe, { checkout, home, markers }, pid) {
  const result = spawnSync("bash", ["-s", "--", checkout, home, process.execPath, String(pid), "1", ...markers], {
    encoding: "utf8",
    input: probe,
    timeout: 60_000
  });
  return { lines: result.stdout.split("\n").map((line) => line.trim()), output: `${result.stdout}${result.stderr}`, status: result.status };
}

test("the probe is a shell script that bash accepts", { skip }, () => {
  const probe = probeText();
  const check = spawnSync("bash", ["-n"], { encoding: "utf8", input: probe });
  assert.equal(check.status, 0, check.stderr);
  // bash reads it from standard input, so nothing it runs may read from there:
  // whatever did would swallow the rest of the probe.
  for (const command of [
    "server.listen(0, \"127.0.0.1\", () => server.close());' </dev/null",
    '"$java" -Xmx64m -version </dev/null',
    "zip -v </dev/null",
    "/tmp/.rippercraft-probe-run </dev/null",
    '"$home/.rippercraft-probe-run" </dev/null'
  ]) {
    assert.ok(probe.includes(command), command);
  }
});

test("run where there is no sandbox, the probe says so and fails", { skip }, async (t) => {
  const places = fixture(t);
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => other.kill("SIGKILL"));

  const result = runProbe(probeText(), places, other.pid);

  assert.equal(result.status, 1, result.output);
  const failed = result.lines.filter((line) => line.startsWith("FAIL"));
  // The code can be written.
  for (const folder of ["", "/src", "/public", "/.git", "/infra/systemd"]) {
    assert.ok(failed.includes(`FAIL  ${places.checkout}${folder} can be written to`), `${folder || "the checkout"}: ${result.output}`);
  }
  // The home directory is the real one, with what is in it.
  assert.ok(failed.some((line) => /^FAIL {2}the home directory still shows:.* \.ssh/.test(line)), result.output);
  // /tmp and /var/tmp are the machine's own.
  assert.ok(failed.includes("FAIL  /tmp is the machine's own, not a private one"), result.output);
  assert.ok(failed.includes("FAIL  /var/tmp is the machine's own, not a private one"), result.output);
  if (places.markers[2]) {
    assert.ok(failed.includes("FAIL  /dev/shm is the machine's own, not a private one"), result.output);
  }
  // Another process of the account is in plain view.
  assert.ok(failed.some((line) => line.startsWith(`FAIL  a process of this account outside the service (pid ${other.pid}) can be seen`)), result.output);
  // What works without a sandbox is still reported as working.
  assert.ok(result.lines.includes("ok    data/ can be written to"), result.output);
  assert.ok(result.lines.includes("ok    servers/ can be written to"), result.output);
  assert.ok(result.lines.includes("ok    node runs and can listen"), result.output);
  // And it tidied up after itself.
  assert.deepEqual(fs.readdirSync(places.home).sort(), [".ssh", "minecraft-server"]);
  assert.deepEqual(fs.readdirSync(path.join(places.checkout, "data")), []);
});

test("the probe does not take a process that has gone for one it cannot see", { skip }, async (t) => {
  const places = fixture(t);
  const gone = spawnSync(process.execPath, ["-e", "console.log(process.pid)"], { encoding: "utf8" }).stdout.trim();

  const result = runProbe(probeText(), places, gone);

  assert.equal(result.status, 1, result.output);
  assert.ok(
    result.lines.some((line) => line.startsWith(`FAIL  the process this was to look for (pid ${gone}) has gone`)),
    result.output
  );
  assert.equal(result.lines.includes("ok    the account's other processes cannot be seen"), false);
});
