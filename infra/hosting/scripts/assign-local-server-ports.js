#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..", "..", "..");
const hostingRoot = path.join(repoRoot, "infra", "hosting");

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function upsertProperty(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=.*$`, "m");
  if (pattern.test(contents)) {
    return contents.replace(pattern, line);
  }
  return `${contents.replace(/\s*$/, "")}\n${line}\n`;
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
  const localMinecraftPortBase = Number(config.localMinecraftPortBase || 31000);
  const localRconPortBase = Number(config.localRconPortBase || 32000);

  for (const [index, server] of servers.entries()) {
    const serverPort = localMinecraftPortBase + index + 1;
    const rconPort = localRconPortBase + index + 1;
    const propertiesPath = path.resolve(repoRoot, server.directory, "server.properties");
    let contents = await fs.readFile(propertiesPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return "";
      }
      throw error;
    });

    contents = upsertProperty(contents, "server-port", serverPort);
    contents = upsertProperty(contents, "query.port", serverPort);
    contents = upsertProperty(contents, "rcon.port", rconPort);
    await fs.writeFile(propertiesPath, contents, "utf8");
    console.log(`${server.id}: server-port=${serverPort}, query.port=${serverPort}, rcon.port=${rconPort}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
