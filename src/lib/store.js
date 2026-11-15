const path = require("node:path");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { createMutex, ensureDir, nowIso, randomId, readJson, writeJson } = require("./utils");

function createStore(rootDir) {
  const DATA_DIR = path.join(rootDir, "data");
  const USERS_FILE = path.join(DATA_DIR, "users.json");
  const SERVERS_FILE = path.join(DATA_DIR, "servers.json");
  const APP_FILE = path.join(DATA_DIR, "app.json");
  // app.json holds the cookie secret and integration keys, users.json holds
  // password hashes, servers.json holds per-server passphrase hashes. None of
  // them should be world-readable.
  const SECRET_FILE_MODE = 0o600;
  let hardenedExistingFiles = false;
  // Two requests arriving together used to each find a file missing and each
  // write its default, the later one landing on top of a user the earlier one
  // had just saved. Initialisation runs one caller at a time, and so does every
  // read-modify-write of users.json.
  const initializeExclusively = createMutex();
  const mutateUsersExclusively = createMutex();

  async function hardenSecretFiles() {
    if (hardenedExistingFiles) {
      return;
    }
    hardenedExistingFiles = true;
    for (const file of [APP_FILE, USERS_FILE, SERVERS_FILE]) {
      try {
        await fsp.chmod(file, SECRET_FILE_MODE);
      } catch {
        // Missing file or a filesystem without permissions; nothing to harden.
      }
    }
  }

  function ensureInitialized() {
    return initializeExclusively(initialize);
  }

  async function initialize() {
    await ensureDir(DATA_DIR);

    const app = await readJson(APP_FILE, null);
    if (!app) {
      const timestamp = nowIso();
      await writeJson(
        APP_FILE,
        {
          appName: "RipperCraft",
          cookieSecret: crypto.randomBytes(32).toString("hex"),
          integrations: {},
          sessionTtlHours: 24,
          unlockTtlMinutes: 20,
          createdAt: timestamp,
          updatedAt: timestamp
        },
        { mode: SECRET_FILE_MODE }
      );
    }

    const users = await readJson(USERS_FILE, null);
    if (!users) {
      await writeJson(USERS_FILE, { users: [] }, { mode: SECRET_FILE_MODE });
    }

    const servers = await readJson(SERVERS_FILE, null);
    if (!servers) {
      await writeJson(SERVERS_FILE, { servers: {} }, { mode: SECRET_FILE_MODE });
    }

    await hardenSecretFiles();
  }

  async function getAppConfig() {
    await ensureInitialized();
    return await readJson(APP_FILE, {});
  }

  async function saveAppConfig(nextConfig) {
    await ensureInitialized();
    const current = await getAppConfig();
    const merged = { ...current, ...nextConfig, updatedAt: nowIso() };
    await writeJson(APP_FILE, merged, { mode: SECRET_FILE_MODE });
    return merged;
  }

  async function getIntegrations() {
    const config = await getAppConfig();
    return config.integrations && typeof config.integrations === "object" ? config.integrations : {};
  }

  // Patch keys with a blank value are removed rather than stored empty, so
  // "configured" always means "has a usable value".
  async function saveIntegrations(patch) {
    const next = { ...(await getIntegrations()) };
    for (const [key, value] of Object.entries(patch || {})) {
      const trimmed = typeof value === "string" ? value.trim() : value;
      if (!trimmed) {
        delete next[key];
      } else {
        next[key] = trimmed;
      }
    }
    await saveAppConfig({ integrations: next });
    return next;
  }

  async function getUsers() {
    await ensureInitialized();
    const data = await readJson(USERS_FILE, { users: [] });
    return data.users || [];
  }

  async function saveUsers(users) {
    await ensureInitialized();
    await writeJson(USERS_FILE, { users }, { mode: SECRET_FILE_MODE });
  }

  async function hasUsers() {
    const users = await getUsers();
    return users.length > 0;
  }

  async function hasOwner() {
    const users = await getUsers();
    return users.some((user) => user.role === "owner");
  }

  function createUser(user) {
    return mutateUsersExclusively(async () => {
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
    });
  }

  function updateUser(userId, patch) {
    return mutateUsersExclusively(async () => {
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
    });
  }

  // Swaps a stored password hash for a stronger encoding of the same password.
  // It only happens while the hash is still the one that was just verified: a
  // password reset that lands in between must not be undone by the upgrade.
  // updatedAt is left alone, because nothing about the account changed.
  function upgradePasswordHash(userId, verifiedHash, nextHash) {
    return mutateUsersExclusively(async () => {
      const users = await getUsers();
      const index = users.findIndex((user) => user.id === userId);
      if (index === -1 || users[index].passwordHash !== verifiedHash) {
        return false;
      }
      users[index] = { ...users[index], passwordHash: nextHash };
      await saveUsers(users);
      return true;
    });
  }

  async function getServerRecords() {
    await ensureInitialized();
    const data = await readJson(SERVERS_FILE, { servers: {} });
    return data.servers || {};
  }

  async function saveServerRecords(records) {
    await ensureInitialized();
    await writeJson(SERVERS_FILE, { servers: records }, { mode: SECRET_FILE_MODE });
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
    getIntegrations,
    getServerRecords,
    getUsers,
    hasOwner,
    hasUsers,
    rootDir,
    saveAppConfig,
    saveIntegrations,
    saveServerRecords,
    saveUsers,
    updateServerRecord,
    updateUser,
    upgradePasswordHash
  };
}

module.exports = {
  createStore
};
