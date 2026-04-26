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
    `# Porkbun SRV records for Minecraft Java on ${config.domain}`,
    "",
    "Create one SRV record per server in Porkbun DNS.",
    "",
    "| Server | Players type | Porkbun Type | Porkbun Host | Porkbun Answer/Value |",
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

  lines.push(
    "",
    "Notes:",
    "- The Answer/Value format is: priority, weight, port, target.",
    "- Do not add a port in Minecraft. Players type only the hostname.",
    "- This is for Minecraft Java Edition. Bedrock does not use these SRV records.",
    ""
  );

  const outputPath = path.join(freeHostingRoot, "generated", "PORKBUN_SRV_RECORDS.md");
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
