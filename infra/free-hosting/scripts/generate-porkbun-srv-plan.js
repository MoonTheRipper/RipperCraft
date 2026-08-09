#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const freeHostingRoot = path.join(repoRoot, "infra", "free-hosting");

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

async function main() {
  const configPath = process.argv[2] || path.join(freeHostingRoot, "playit-tunnels.json");
  const config = await readJson(configPath).catch(async (error) => {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return await readJson(path.join(freeHostingRoot, "playit-tunnels.example.json"));
  });
  const serverData = await readJson(path.join(repoRoot, "data", "servers.json"));
  const servers = Object.values(serverData.servers || {});
  const lines = [
    `# Minecraft Java SRV records for ${config.domain}`,
    "",
    "Create one SRV record per server, at whichever provider is authoritative",
    `for ${config.domain}. Check with:`,
    "",
    "```bash",
    `dig +short NS ${config.domain}`,
    "```",
    "",
    "`*.ns.cloudflare.com` means the records live in Cloudflare DNS, not at the",
    "registrar - moving nameservers to Cloudflare leaves the registrar's own DNS",
    "panel inert.",
    "",
    "## Single-field providers (Porkbun and most registrars)",
    "",
    "| Server | Players type | Type | Host | Answer/Value |",
    "| --- | --- | --- | --- | --- |"
  ];

  for (const server of servers) {
    const tunnel = config.servers && config.servers[server.id];
    const slug = slugify(server.name || server.id);
    const playerHost = `${slug}.${config.domain}`;
    if (!tunnel || !tunnel.publicHost || !tunnel.publicPort) {
      lines.push(`| ${server.id} | ${playerHost} | SRV | _minecraft._tcp.${slug} | MISSING_PLAYIT_HOST_AND_PORT |`);
      continue;
    }
    lines.push(
      `| ${server.id} | ${playerHost} | SRV | _minecraft._tcp.${slug} | ${Number(tunnel.priority || 1)} ${Number(tunnel.weight || 1)} ${Number(tunnel.publicPort)} ${tunnel.publicHost} |`
    );
  }

  // Cloudflare splits an SRV record across separate form fields instead of one
  // "priority weight port target" string, so spell those out too.
  lines.push("", "## Cloudflare DNS (separate fields per record)", "");
  for (const server of servers) {
    const tunnel = config.servers && config.servers[server.id];
    const slug = slugify(server.name || server.id);
    if (!tunnel || !tunnel.publicHost || !tunnel.publicPort) {
      lines.push(`### ${server.id}`, "", "MISSING_PLAYIT_HOST_AND_PORT", "");
      continue;
    }
    lines.push(
      `### ${server.id} — players type \`${slug}.${config.domain}\``,
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Type | `SRV` |",
      "| Name | `" + slug + "` |",
      "| Service | `_minecraft` |",
      "| Protocol | `TCP` |",
      "| TTL | Auto |",
      `| Priority | \`${Number(tunnel.priority || 1)}\` |`,
      `| Weight | \`${Number(tunnel.weight || 1)}\` |`,
      `| Port | \`${Number(tunnel.publicPort)}\` |`,
      `| Target | \`${tunnel.publicHost}\` |`,
      ""
    );
  }

  lines.push(
    "Notes:",
    "- Single-field Answer/Value format is: priority, weight, port, target.",
    "- Players type only the hostname. Do not add a port in Minecraft.",
    "- SRV records are never proxied; there is no orange cloud to turn off.",
    "- No A record is needed for the play hostname. Minecraft Java resolves SRV first.",
    "- Java Edition only. Bedrock ignores these records.",
    "- Verify with: `dig +short SRV _minecraft._tcp.<slug>.<domain>`",
    ""
  );

  const outputPath = path.join(freeHostingRoot, "generated", "MINECRAFT_SRV_RECORDS.md");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
