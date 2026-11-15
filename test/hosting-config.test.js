const test = require("node:test");
const assert = require("node:assert/strict");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const SCRIPT = path.join(__dirname, "..", "infra", "hosting", "scripts", "generate-hosting-configs.js");

test("the generated Caddyfile does not let a visitor say who they are", async (t) => {
  // The script works on the tree it sits in, so it is run from a copy of its own.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rippercraft-hosting-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const scriptCopy = path.join(root, "infra", "hosting", "scripts", "generate-hosting-configs.js");
  await fsp.mkdir(path.dirname(scriptCopy), { recursive: true });
  await fsp.copyFile(SCRIPT, scriptCopy);
  await fsp.writeFile(
    path.join(root, "infra", "hosting", "hosting.config.json"),
    JSON.stringify({ adminHost: "dash.example.com", dashboardRemotePort: 4300, domain: "example.com", frpServerAddr: "203.0.113.1" })
  );
  await fsp.mkdir(path.join(root, "data"));
  await fsp.writeFile(
    path.join(root, "data", "servers.json"),
    JSON.stringify({ servers: { Survival: { directory: "servers/Survival", id: "Survival", name: "Survival" } } })
  );

  await promisify(execFile)(process.execPath, [scriptCopy]);
  const caddyfile = await fsp.readFile(path.join(root, "infra", "hosting", "generated", "Caddyfile"), "utf8");

  // The dashboard believes CF-Connecting-IP from a loopback peer, which is what
  // frpc is. Caddy passes that header through from anyone unless told not to.
  assert.equal(
    caddyfile,
    [
      "dash.example.com, www.dash.example.com {",
      "  encode zstd gzip",
      "  reverse_proxy 127.0.0.1:4300 {",
      "    header_up -CF-Connecting-IP",
      "  }",
      "}",
      ""
    ].join("\n")
  );
});
