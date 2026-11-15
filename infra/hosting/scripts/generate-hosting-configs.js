#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const hostingRoot = path.join(repoRoot, "infra", "hosting");
const outputRoot = path.join(hostingRoot, "generated");

function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function readServerPort(serverDir) {
  const propertiesPath = path.join(serverDir, "server.properties");
  try {
    const contents = await fs.readFile(propertiesPath, "utf8");
    const match = contents.match(/^server-port=(\d+)$/m);
    return match ? Number(match[1]) : 25565;
  } catch (error) {
    if (error.code === "ENOENT") {
      return 25565;
    }
    throw error;
  }
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function renderFrps() {
  return `bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"

auth.method = "token"
auth.token = "{{ .Envs.FRP_TOKEN }}"

allowPorts = [
  { single = 4300 },
  { start = 26000, end = 26999 }
]
`;
}

function renderFrpc(config, routes) {
  const lines = [
    `serverAddr = ${tomlString(config.frpServerAddr)}`,
    `serverPort = ${Number(config.frpServerPort || 7000)}`,
    "",
    'auth.method = "token"',
    'auth.token = "{{ .Envs.FRP_TOKEN }}"',
    "",
    "[[proxies]]",
    'name = "rippermoonstash-dashboard"',
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    `localPort = ${Number(config.dashboardLocalPort || 4300)}`,
    `remotePort = ${Number(config.dashboardRemotePort || 4300)}`,
    ""
  ];

  for (const route of routes) {
    lines.push(
      "[[proxies]]",
      `name = ${tomlString(`minecraft-${route.slug}`)}`,
      'type = "tcp"',
      'localIP = "127.0.0.1"',
      `localPort = ${route.localPort}`,
      `remotePort = ${route.remotePort}`,
      ""
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderVelocity(config, routes) {
  const defaultRoute =
    routes.find((route) => route.id === config.defaultServer) ||
    routes[0];
  const lines = [
    'config-version = "2.7"',
    'bind = "0.0.0.0:25565"',
    'motd = "<dark_purple>RipperMoonStash</dark_purple>"',
    "show-max-players = 100",
    "online-mode = true",
    "force-key-authentication = true",
    'player-info-forwarding-mode = "none"',
    'forwarding-secret-file = "forwarding.secret"',
    'ping-passthrough = "ALL"',
    "",
    "[servers]"
  ];

  for (const route of routes) {
    lines.push(`${route.slug} = ${tomlString(`127.0.0.1:${route.remotePort}`)}`);
  }
  lines.push(`try = [${tomlString(defaultRoute.slug)}]`, "", "[forced-hosts]");
  for (const route of routes) {
    lines.push(`${tomlString(route.host)} = [${tomlString(route.slug)}]`);
  }

  return `${lines.join("\n")}\n`;
}

function renderCaddyfile(config) {
  const adminHost = config.adminHost || config.domain;
  const dashboardRemotePort = Number(config.dashboardRemotePort || 4300);
  // The dashboard counts failed logins against the visitor's address, and when
  // its peer is on loopback - as frpc is - it takes that address from request
  // headers. Caddy rewrites X-Forwarded-For itself, but it passes any other
  // header through, including a CF-Connecting-IP the visitor made up. Nothing
  // in this layout is Cloudflare, so nobody here may send one.
  return `${adminHost}, www.${adminHost} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:${dashboardRemotePort} {
    header_up -CF-Connecting-IP
  }
}
`;
}

function renderDnsGuide(config, routes) {
  return `# Porkbun DNS records for ${config.domain}

Create these records in Porkbun DNS:

| Type | Host | Answer |
| --- | --- | --- |
| A | @ | YOUR_VPS_PUBLIC_IPV4 |
| A | * | YOUR_VPS_PUBLIC_IPV4 |

Optional if your VPS has IPv6:

| Type | Host | Answer |
| --- | --- | --- |
| AAAA | @ | YOUR_VPS_PUBLIC_IPV6 |
| AAAA | * | YOUR_VPS_PUBLIC_IPV6 |

The wildcard record makes every current and future server hostname resolve to the VPS:

${routes.map((route) => `- ${route.host}`).join("\n")}

Minecraft Java clients will connect to ${routes[0] ? routes[0].host : `servername.${config.domain}`} on the default port 25565. Velocity on the VPS reads the requested hostname and routes the player to the matching backend tunnel.
`;
}

async function main() {
  const configPath = process.argv[2] || path.join(hostingRoot, "hosting.config.json");
  const config = await readJson(configPath).catch(async (error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return await readJson(path.join(hostingRoot, "hosting.config.example.json"));
  });
  const serverData = await readJson(path.join(repoRoot, "data", "servers.json"));
  const servers = Object.values(serverData.servers || {});
  if (!servers.length) {
    throw new Error("No servers found in data/servers.json.");
  }

  const usedSlugs = new Set();
  const routes = [];
  for (const [index, server] of servers.entries()) {
    const baseSlug = slugify(server.name || server.id);
    let slug = baseSlug || `server-${index + 1}`;
    let counter = 2;
    while (usedSlugs.has(slug)) {
      slug = `${baseSlug}-${counter}`;
      counter += 1;
    }
    usedSlugs.add(slug);

    const serverDir = path.resolve(repoRoot, server.directory);
    routes.push({
      host: `${slug}.${config.domain}`,
      id: server.id,
      localPort: await readServerPort(serverDir),
      name: server.name || server.id,
      remotePort: Number(config.minecraftRemotePortBase || 26000) + index + 1,
      slug
    });
  }

  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(outputRoot, "frps.toml"), renderFrps(config), "utf8");
  await fs.writeFile(path.join(outputRoot, "frpc.toml"), renderFrpc(config, routes), "utf8");
  await fs.writeFile(path.join(outputRoot, "velocity.toml"), renderVelocity(config, routes), "utf8");
  await fs.writeFile(path.join(outputRoot, "Caddyfile"), renderCaddyfile(config), "utf8");
  await fs.writeFile(path.join(outputRoot, "DNS.md"), renderDnsGuide(config, routes), "utf8");
  await fs.writeFile(path.join(outputRoot, "routes.json"), `${JSON.stringify(routes, null, 2)}\n`, "utf8");

  console.log(`Generated hosting configs for ${routes.length} server(s) in ${path.relative(repoRoot, outputRoot)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
