const crypto = require("node:crypto");
const { nowIso, randomId } = require("./utils");

function hashSecret(secret, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(secret, salt, 210_000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifySecret(secret, storedHash) {
  if (!storedHash || !secret || !storedHash.includes(":")) {
    return false;
  }

  const [salt, expectedHash] = storedHash.split(":");
  const actualHash = crypto.pbkdf2Sync(secret, salt, 210_000, 32, "sha256").toString("hex");
  const actualBuffer = Buffer.from(actualHash, "hex");
  const expectedBuffer = Buffer.from(expectedHash, "hex");
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function parseCookieHeader(cookieHeader = "") {
  const cookies = {};
  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (!rawName) {
      continue;
    }
    cookies[rawName] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

function createSignedCookie(value, secret) {
  const signature = crypto.createHmac("sha256", secret).update(value).digest("hex");
  return `${value}.${signature}`;
}

function verifySignedCookie(signedValue, secret) {
  if (!signedValue || !signedValue.includes(".")) {
    return null;
  }
  const lastDotIndex = signedValue.lastIndexOf(".");
  const value = signedValue.slice(0, lastDotIndex);
  const signature = signedValue.slice(lastDotIndex + 1);
  const expected = crypto.createHmac("sha256", secret).update(value).digest("hex");

  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (signatureBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return null;
  }

  return value;
}

function createSessionManager(appConfigPromise) {
  const sessions = new Map();

  async function getConfig() {
    return await appConfigPromise();
  }

  async function createSession(userId) {
    const config = await getConfig();
    const sessionId = randomId("sess");
    const expiresAt = Date.now() + config.sessionTtlHours * 60 * 60 * 1000;
    const session = {
      id: sessionId,
      userId,
      unlockedServers: {},
      createdAt: nowIso(),
      expiresAt
    };
    sessions.set(sessionId, session);
    return session;
  }

  async function getSessionFromRequest(req) {
    const config = await getConfig();
    const cookieValue = parseCookieHeader(req.headers.cookie || "").rippermoon_session;
    const sessionId = verifySignedCookie(cookieValue, config.cookieSecret);
    if (!sessionId) {
      return null;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      return null;
    }

    if (session.expiresAt < Date.now()) {
      sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  async function serializeSessionCookie(session) {
    const config = await getConfig();
    return [
      `rippermoon_session=${encodeURIComponent(createSignedCookie(session.id, config.cookieSecret))}`,
      "HttpOnly",
      "SameSite=Lax",
      "Path=/",
      `Max-Age=${config.sessionTtlHours * 60 * 60}`
    ].join("; ");
  }

  function clearSessionCookie() {
    return "rippermoon_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0";
  }

  function destroySession(sessionId) {
    sessions.delete(sessionId);
  }

  async function unlockServer(session, serverId) {
    const config = await getConfig();
    session.unlockedServers[serverId] = Date.now() + config.unlockTtlMinutes * 60 * 1000;
    return session.unlockedServers[serverId];
  }

  function isServerUnlocked(session, serverId) {
    if (!session) {
      return false;
    }
    const expiresAt = session.unlockedServers[serverId];
    if (!expiresAt) {
      return false;
    }
    if (expiresAt < Date.now()) {
      delete session.unlockedServers[serverId];
      return false;
    }
    return true;
  }

  return {
    clearSessionCookie,
    createSession,
    destroySession,
    getSessionFromRequest,
    isServerUnlocked,
    serializeSessionCookie,
    unlockServer
  };
}

module.exports = {
  createSessionManager,
  hashSecret,
  parseCookieHeader,
  verifySecret
};
