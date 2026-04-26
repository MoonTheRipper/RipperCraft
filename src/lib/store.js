const path = require("node:path");
const crypto = require("node:crypto");
const { ensureDir, nowIso, randomId, readJson, writeJson } = require("./utils");

function createStore(rootDir) {
  const DATA_DIR = path.join(rootDir, "data");
  const USERS_FILE = path.join(DATA_DIR, "users.json");
  const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
  const APP_FILE = path.join(DATA_DIR, "app.json");

  async function ensureInitialized() {
    await ensureDir(DATA_DIR);

    const app = await readJson(APP_FILE, null);
    if (!app) {
      const timestamp = nowIso();
      await writeJson(APP_FILE, {
        appName: "RipperMoonStash",
        cookieSecret: crypto.randomBytes(32).toString("hex"),
        sessionTtlHours: 24,
        unlockTtlMinutes: 20,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    }

    const users = await readJson(USERS_FILE, null);
    if (!users) {
      await writeJson(USERS_FILE, { users: [] });
    }

    const servers = await readJson(SERVERS_FILE, null);
    if (!servers) {
      await writeJson(SERVERS_FILE, { servers: {} });
    }
  }

  async function getAppConfig() {
    await ensureInitialized();
    return await readJson(APP_FILE, {});
  }

  async function saveAppConfig(nextConfig) {
    await ensureInitialized();
    const current = await getAppConfig();
    const merged = { ...current, ...nextConfig, updatedAt: nowIso() };
    await writeJson(APP_FILE, merged);
    return merged;
  }

  async function getUsers() {
    await ensureInitialized();
    const data = await readJson(USERS_FILE, { users: [] });
    return data.users || [];
  }

  async function saveUsers(users) {
    await ensureInitialized();
    await writeJson(USERS_FILE, { users });
  }

  async function hasUsers() {
    const users = await getUsers();
    return users.length > 0;
  }

  async function createUser(user) {
    const users = await getUsers();
    const timestamp = nowIso();
    const nextUser = {
      id: randomId("usr"),
      displayName: user.displayName || user.username,
      role: user.role || "admin",
      servers: Array.isArray(user.servers) ? user.servers : [],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...user
    };
    users.push(nextUser);
    await saveUsers(users);
    return nextUser;
  }

  async function updateUser(userId, patch) {
    const users = await getUsers();
    const index = users.findIndex((user) => user.id === userId);
    if (index === -1) {
      return null;
    }
    users[index] = {
      ...users[index],
      ...patch,
      updatedAt: nowIso()
    };
    await saveUsers(users);
    return users[index];
  }

  async function getServerRecords() {
    await ensureInitialized();
    const data = await readJson(SERVERS_FILE, { servers: {} });
    return data.servers || {};
  }

  async function saveServerRecords(records) {
    await ensureInitialized();
    await writeJson(SERVERS_FILE, { servers: records });
  }

  async function updateServerRecord(serverId, patch) {
    const records = await getServerRecords();
    records[serverId] = {
      ...(records[serverId] || {}),
      ...patch,
      id: serverId,
      updatedAt: nowIso()
    };
    if (!records[serverId].createdAt) {
      records[serverId].createdAt = nowIso();
    }
    await saveServerRecords(records);
    return records[serverId];
  }

  async function deleteServerRecord(serverId) {
    const records = await getServerRecords();
    if (!records[serverId]) {
      return null;
    }
    const removed = records[serverId];
    delete records[serverId];
    await saveServerRecords(records);
    return removed;
  }

  return {
    APP_FILE,
    DATA_DIR,
    SERVERS_FILE,
    USERS_FILE,
    createUser,
    deleteServerRecord,
    ensureInitialized,
    getAppConfig,
    getServerRecords,
    getUsers,
    hasUsers,
    rootDir,
    saveAppConfig,
    saveServerRecords,
    saveUsers,
    updateServerRecord,
    updateUser
  };
}

module.exports = {
  createStore
};
