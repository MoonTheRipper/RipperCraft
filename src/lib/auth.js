const crypto = require("node:crypto");
const { HttpError } = require("./http");
const { nowIso, randomId } = require("./utils");

// Password and passphrase hashes come in two shapes:
//
//   current  $scrypt$ln=15,r=8,p=3$<salt>$<hash>   a PHC string; every parameter
//                                                   travels with the hash
//   legacy   <salt hex>:<hash hex>                 PBKDF2-HMAC-SHA256 at 210 000
//                                                   rounds, the parameters implied
//
// Legacy hashes keep verifying, so nobody is locked out by an upgrade. They are
// never written again: a login rewrites the account's hash in the current shape.
//
// scrypt at N = 2^15, r = 8, p = 3 is one of the equivalent settings OWASP lists.
// It needs 32 MiB per hash, which stays small next to the game servers sharing
// this machine, and takes about a third of a second on an old desktop CPU.
const DEFAULT_SCRYPT_COST = Object.freeze({ ln: 15, r: 8, p: 3 });
const SCRYPT_KEY_BYTES = 32;
const SALT_BYTES = 16;
const LEGACY_PBKDF2_ITERATIONS = 210_000;
const LEGACY_KEY_BYTES = 32;
const LEGACY_COST = `pbkdf2-sha256:${LEGACY_PBKDF2_ITERATIONS}`;

let scryptCost = DEFAULT_SCRYPT_COST;

// The derivations run on libuv's thread pool, which every file read and write
// shares. Half of it is left free so a burst of logins cannot stall the rest of
// the dashboard, and the queue is bounded so the burst cannot grow without end.
const KDF_SLOTS = Math.max(1, Math.floor((Number(process.env.UV_THREADPOOL_SIZE) || 4) / 2));
const KDF_QUEUE_LIMIT = 64;
let kdfRunning = 0;
const kdfWaiting = [];

function withKdfSlot(compute) {
  return new Promise((resolve, reject) => {
    function start() {
      kdfRunning += 1;
      let finished = false;
      const finish = (error, value) => {
        if (finished) {
          return;
        }
        finished = true;
        kdfRunning -= 1;
        const next = kdfWaiting.shift();
        if (next) {
          next();
        }
        if (error) {
          reject(error);
        } else {
          resolve(value);
        }
      };
      try {
        compute(finish);
      } catch (error) {
        finish(error);
      }
    }

    if (kdfRunning < KDF_SLOTS) {
      start();
    } else if (kdfWaiting.length >= KDF_QUEUE_LIMIT) {
      reject(
        new HttpError(503, "The server is busy checking other sign-ins. Try again in a moment.", {
          headers: { "Retry-After": "2" }
        })
      );
    } else {
      kdfWaiting.push(start);
    }
  });
}

function deriveScrypt(secret, salt, cost, keyBytes) {
  const N = 2 ** cost.ln;
  return withKdfSlot((done) => {
    // Node's default memory ceiling is exactly what N = 2^15, r = 8 needs, so
    // it has to be raised or the call fails.
    crypto.scrypt(secret, salt, keyBytes, { N, r: cost.r, p: cost.p, maxmem: 256 * N * cost.r }, done);
  });
}

function deriveLegacy(secret, salt) {
  return withKdfSlot((done) => {
    // The legacy salt is the hex text itself, not the bytes it spells.
    crypto.pbkdf2(secret, salt, LEGACY_PBKDF2_ITERATIONS, LEGACY_KEY_BYTES, "sha256", done);
  });
}

function encodeB64(buffer) {
  return buffer.toString("base64").replace(/=+$/, "");
}

function formatScryptHash(cost, salt, hash) {
  return `$scrypt$ln=${cost.ln},r=${cost.r},p=${cost.p}$${encodeB64(salt)}$${encodeB64(hash)}`;
}

function scryptCostLabel(cost, keyBytes) {
  return `scrypt:${cost.ln}:${cost.r}:${cost.p}:${keyBytes}`;
}

// Returns null for anything that cannot be verified, including scrypt
// parameters outside a sane range: a damaged users.json must not be able to ask
// for gigabytes of memory.
function parseHash(storedHash) {
  if (typeof storedHash !== "string" || !storedHash) {
    return null;
  }

  if (storedHash.startsWith("$scrypt$")) {
    const parts = storedHash.split("$");
    if (parts.length !== 5) {
      return null;
    }
    const parameters = {};
    for (const pair of parts[2].split(",")) {
      const [name, value] = pair.split("=");
      parameters[name] = Number(value);
    }
    const { ln, r, p } = parameters;
    if (
      ![ln, r, p].every(Number.isInteger) ||
      ln < 10 || ln > 20 ||
      r < 1 || r > 32 ||
      p < 1 || p > 16
    ) {
      return null;
    }
    const salt = Buffer.from(parts[3], "base64");
    const hash = Buffer.from(parts[4], "base64");
    if (salt.length < 8 || hash.length < 16 || hash.length > 64) {
      return null;
    }
    return { cost: scryptCostLabel({ ln, r, p }, hash.length), hash, kind: "scrypt", ln, p, r, salt };
  }

  if (storedHash.includes(":")) {
    const [salt, expectedHash] = storedHash.split(":");
    return { cost: LEGACY_COST, hash: Buffer.from(expectedHash, "hex"), kind: "pbkdf2-legacy", salt };
  }

  return null;
}

async function hashSecret(secret) {
  if (typeof secret !== "string" || !secret) {
    throw new TypeError("A secret to hash is required.");
  }
  const cost = scryptCost;
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await deriveScrypt(secret, salt, cost, SCRYPT_KEY_BYTES);
  return formatScryptHash(cost, salt, hash);
}

async function verifySecret(secret, storedHash) {
  const parsed = parseHash(storedHash);
  if (!parsed || typeof secret !== "string") {
    return false;
  }

  const derived =
    parsed.kind === "scrypt"
      ? await deriveScrypt(secret, parsed.salt, parsed, parsed.hash.length)
      : await deriveLegacy(secret, parsed.salt);

  // An empty secret is never valid, but it is only turned away after the
  // derivation, so it answers no faster than any other wrong guess.
  return (
    derived.length === parsed.hash.length &&
    crypto.timingSafeEqual(derived, parsed.hash) &&
    secret.length > 0
  );
}

// True when a hash that verifies should be replaced: it is in the legacy shape,
// or was made with other scrypt parameters than new hashes get.
function needsRehash(storedHash) {
  const parsed = parseHash(storedHash);
  return Boolean(parsed) && parsed.cost !== scryptCostLabel(scryptCost, SCRYPT_KEY_BYTES);
}

// One hash per cost that no secret matches. Verifying against it costs exactly
// what verifying a real hash of that cost does.
const decoyHashes = new Map();

function decoyHashFor(costLabel, sample) {
  let decoy = decoyHashes.get(costLabel);
  if (!decoy) {
    decoy =
      sample.kind === "scrypt"
        ? formatScryptHash(sample, crypto.randomBytes(SALT_BYTES), crypto.randomBytes(sample.hash.length))
        : `${crypto.randomBytes(SALT_BYTES).toString("hex")}:${crypto.randomBytes(LEGACY_KEY_BYTES).toString("hex")}`;
    decoyHashes.set(costLabel, decoy);
  }
  return decoy;
}

// Checks a login password so that the work done says nothing about the account.
//
// The old check ran the derivation only for usernames that existed, so an
// unknown one answered in 3 ms and a real one in 112 ms. Running one decoy
// derivation for unknown names is not enough either while legacy and current
// hashes sit side by side: a legacy account would still answer faster than a
// name that does not exist. So every attempt performs one derivation for each
// cost in use across all accounts (always including the current one), against
// the account's own hash where it has that cost and against a decoy otherwise.
// Known, unknown, legacy and current accounts all do identical work.
async function verifyAccountSecret(secret, accountHash, everyAccountHash = []) {
  const account = parseHash(accountHash);
  const currentLabel = scryptCostLabel(scryptCost, SCRYPT_KEY_BYTES);
  const samples = new Map([
    [currentLabel, { ...scryptCost, hash: Buffer.alloc(SCRYPT_KEY_BYTES), kind: "scrypt" }]
  ]);
  for (const storedHash of everyAccountHash) {
    const parsed = parseHash(storedHash);
    if (parsed && !samples.has(parsed.cost)) {
      samples.set(parsed.cost, parsed);
    }
  }

  let matched = false;
  for (const costLabel of [...samples.keys()].sort()) {
    const usesAccountHash = Boolean(account) && account.cost === costLabel;
    const candidate = usesAccountHash ? accountHash : decoyHashFor(costLabel, samples.get(costLabel));
    const verified = await verifySecret(secret, candidate);
    matched = matched || (usesAccountHash && verified);
  }
  return matched;
}

// Test seam: the suite makes hundreds of hashes and would otherwise spend
// minutes in scrypt. Nothing outside the tests calls this.
function setHashCostForTests(cost) {
  scryptCost = cost ? Object.freeze({ ...cost }) : DEFAULT_SCRYPT_COST;
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
  needsRehash,
  parseCookieHeader,
  setHashCostForTests,
  verifyAccountSecret,
  verifySecret
};
