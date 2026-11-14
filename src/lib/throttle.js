const crypto = require("node:crypto");
const { addressBucket } = require("./peer");

// Limits on guessing, kept in memory. A restart clears them, which is fine: it
// also ends every session, and the limits rebuild within a handful of attempts.
//
// Login
//   - One address may fail 5 times against one username in 15 minutes. It is
//     then refused (429) until the oldest of those failures is 15 minutes old.
//   - One address may fail 20 times in 15 minutes across all usernames.
//   - One username may fail 10 times, from any mix of addresses, before it is
//     slowed down: each further failure makes every address wait before the
//     next attempt on that username is looked at, 1 s doubling up to 5 minutes.
//     The count starts over once the username has gone 15 minutes without a
//     failure.
//
// The last rule is the only one a crowd of addresses cannot dodge, and the only
// one that could be turned against the owner: anyone can fail on purpose under
// someone else's username. So it never applies to
//   - an address that has logged in to that username before (remembered for
//     30 days, or until a restart), or
//   - a direct connection from loopback or a private network.
// Those are still held to their own 5-in-15-minutes. The effect is that guesses
// from strangers slow to one every five minutes, while the account's real user
// is not kept out by them.
//
// A refused attempt is not checked at all, so the right password is refused
// too, and it does not extend the wait.
const LOGIN_LIMITS = Object.freeze({
  knownAddressTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxFailuresPerAddress: 20,
  maxFailuresPerAddressAndUsername: 5,
  usernameBackoffBaseMs: 1000,
  usernameBackoffMaxMs: 5 * 60 * 1000,
  usernameFailuresBeforeBackoff: 10,
  windowMs: 15 * 60 * 1000
});

// Server passphrase
//   - One account may get one server's passphrase wrong 5 times in 15 minutes.
const UNLOCK_LIMITS = Object.freeze({
  maxFailures: 5,
  windowMs: 15 * 60 * 1000
});

// Usernames are whatever the request says, so the keys are attacker-chosen.
// Each table drops its least recently touched entry beyond this size.
const MAX_TRACKED_KEYS = 20_000;
const SWEEP_EVERY = 512;

function touch(map, key, value, maxKeys) {
  map.delete(key);
  map.set(key, value);
  if (map.size > maxKeys) {
    map.delete(map.keys().next().value);
  }
}

// Failure times per key, newest last, forgetting anything older than the window.
function createFailureLog(windowMs, maxKeys) {
  const entries = new Map();

  function recent(key, at) {
    const times = entries.get(key);
    if (!times) {
      return null;
    }
    let expired = 0;
    while (expired < times.length && times[expired] + windowMs <= at) {
      expired += 1;
    }
    if (expired) {
      times.splice(0, expired);
    }
    if (!times.length) {
      entries.delete(key);
      return null;
    }
    return times;
  }

  return {
    add(key, at) {
      const times = recent(key, at) || [];
      times.push(at);
      touch(entries, key, times, maxKeys);
    },
    clear(key) {
      entries.delete(key);
    },
    remove(key, at) {
      const times = entries.get(key);
      if (!times) {
        return;
      }
      const index = times.lastIndexOf(at);
      if (index !== -1) {
        times.splice(index, 1);
      }
      if (!times.length) {
        entries.delete(key);
      }
    },
    size() {
      return entries.size;
    },
    sweep(at) {
      for (const key of [...entries.keys()]) {
        recent(key, at);
      }
    },
    // Milliseconds until the key may try again; 0 while it is under the limit.
    waitMs(key, limit, at) {
      const times = recent(key, at);
      if (!times || times.length < limit) {
        return 0;
      }
      return times[times.length - limit] + windowMs - at;
    }
  };
}

// A failure count per key that turns into a growing wait once it passes a
// threshold, and resets after a full window with no failures.
function createBackoff({ baseMs, maxKeys, maxMs, threshold, windowMs }) {
  const entries = new Map();

  function live(key, at) {
    const entry = entries.get(key);
    if (!entry) {
      return null;
    }
    if (entry.lastFailureAt + windowMs <= at && entry.blockedUntil <= at) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  return {
    // Records a failure and returns what is needed to take it back.
    add(key, at) {
      const entry = live(key, at) || { blockedUntil: 0, failures: 0, lastFailureAt: 0 };
      const receipt = {
        at,
        blockedAfter: entry.blockedUntil,
        blockedBefore: entry.blockedUntil,
        lastFailureBefore: entry.lastFailureAt
      };
      entry.failures += 1;
      entry.lastFailureAt = at;
      if (entry.failures >= threshold) {
        const doublings = Math.min(entry.failures - threshold, 30);
        entry.blockedUntil = Math.max(entry.blockedUntil, at + Math.min(maxMs, baseMs * 2 ** doublings));
        receipt.blockedAfter = entry.blockedUntil;
      }
      touch(entries, key, entry, maxKeys);
      return receipt;
    },
    size() {
      return entries.size;
    },
    sweep(at) {
      for (const key of [...entries.keys()]) {
        live(key, at);
      }
    },
    undo(key, receipt) {
      const entry = entries.get(key);
      if (!entry) {
        return;
      }
      entry.failures = Math.max(0, entry.failures - 1);
      if (entry.blockedUntil === receipt.blockedAfter) {
        entry.blockedUntil = receipt.blockedBefore;
      }
      // A success is not a failure: it must not restart the quiet period.
      if (entry.lastFailureAt === receipt.at) {
        entry.lastFailureAt = receipt.lastFailureBefore;
      }
      if (entry.failures === 0 && entry.blockedUntil === 0) {
        entries.delete(key);
      }
    },
    waitMs(key, at) {
      const entry = live(key, at);
      return entry ? Math.max(0, entry.blockedUntil - at) : 0;
    }
  };
}

function refusal(waitMs, scope) {
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)), scope };
}

// An attempt is counted as a failure the moment it is let through, and the
// count is taken back if it turns out to be right. Counting only afterwards
// would let a hundred guesses sent at once all be checked before the first one
// had been recorded.
function ticket({ onCancel, onSuccess }) {
  let settled = false;
  const settle = (action) => () => {
    if (!settled) {
      settled = true;
      action();
    }
  };
  return {
    allowed: true,
    // The attempt could not be checked (the request failed for another reason).
    cancelled: settle(onCancel),
    failed: settle(() => {}),
    succeeded: settle(onSuccess)
  };
}

function usernameKey(username) {
  const normalized = String(username === undefined || username === null ? "" : username)
    .trim()
    .toLowerCase();
  // Bounded, whatever was typed into the username field.
  return normalized.length <= 64 ? normalized : `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

function createLoginThrottle(options = {}) {
  const limits = { ...LOGIN_LIMITS, ...(options.limits || {}) };
  const now = options.now || Date.now;
  const maxKeys = options.maxKeys || MAX_TRACKED_KEYS;

  const byPair = createFailureLog(limits.windowMs, maxKeys);
  const byAddress = createFailureLog(limits.windowMs, maxKeys);
  const byUsername = createBackoff({
    baseMs: limits.usernameBackoffBaseMs,
    maxKeys,
    maxMs: limits.usernameBackoffMaxMs,
    threshold: limits.usernameFailuresBeforeBackoff,
    windowMs: limits.windowMs
  });
  const knownAddresses = new Map();
  let calls = 0;

  function isKnown(pairKey, at) {
    const expiresAt = knownAddresses.get(pairKey);
    if (expiresAt === undefined) {
      return false;
    }
    if (expiresAt <= at) {
      knownAddresses.delete(pairKey);
      return false;
    }
    return true;
  }

  function sweep(at) {
    byPair.sweep(at);
    byAddress.sweep(at);
    byUsername.sweep(at);
    for (const [key, expiresAt] of knownAddresses) {
      if (expiresAt <= at) {
        knownAddresses.delete(key);
      }
    }
  }

  // `local` is true for a direct connection from loopback or a private network.
  function begin({ address, local = false, username }) {
    const at = now();
    calls += 1;
    if (calls % SWEEP_EVERY === 0) {
      sweep(at);
    }

    const addressKey = addressBucket(address);
    const userKey = usernameKey(username);
    const pairKey = `${addressKey}|${userKey}`;
    const exemptFromUsernameBackoff = local || isKnown(pairKey, at);

    const waits = [
      ["address+username", byPair.waitMs(pairKey, limits.maxFailuresPerAddressAndUsername, at)],
      ["address", byAddress.waitMs(addressKey, limits.maxFailuresPerAddress, at)],
      ["username", exemptFromUsernameBackoff ? 0 : byUsername.waitMs(userKey, at)]
    ].sort((left, right) => right[1] - left[1]);
    if (waits[0][1] > 0) {
      return refusal(waits[0][1], waits[0][0]);
    }

    byPair.add(pairKey, at);
    byAddress.add(addressKey, at);
    const receipt = byUsername.add(userKey, at);

    return ticket({
      onCancel() {
        byPair.remove(pairKey, at);
        byAddress.remove(addressKey, at);
        byUsername.undo(userKey, receipt);
      },
      // Clears what this address had against this username, and nothing wider:
      // a valid account of one's own must not buy fresh guesses at someone
      // else's, so the address's other failures stay on the books.
      onSuccess() {
        byPair.clear(pairKey);
        byAddress.remove(addressKey, at);
        byUsername.undo(userKey, receipt);
        touch(knownAddresses, pairKey, at + limits.knownAddressTtlMs, maxKeys);
      }
    });
  }

  // For a sign-in that did not come through begin(): the owner created at
  // first run is logged in from this address without ever "logging in".
  function remember({ address, username }) {
    const pairKey = `${addressBucket(address)}|${usernameKey(username)}`;
    touch(knownAddresses, pairKey, now() + limits.knownAddressTtlMs, maxKeys);
  }

  return {
    begin,
    limits,
    remember,
    size: () => byPair.size() + byAddress.size() + byUsername.size() + knownAddresses.size
  };
}

// One rule, one key: N failures in the window, then a wait.
function createAttemptThrottle(options = {}) {
  const limits = { ...UNLOCK_LIMITS, ...(options.limits || {}) };
  const now = options.now || Date.now;
  const log = createFailureLog(limits.windowMs, options.maxKeys || MAX_TRACKED_KEYS);
  let calls = 0;

  function begin(key) {
    const at = now();
    calls += 1;
    if (calls % SWEEP_EVERY === 0) {
      log.sweep(at);
    }

    const waitMs = log.waitMs(key, limits.maxFailures, at);
    if (waitMs > 0) {
      return refusal(waitMs, "key");
    }
    log.add(key, at);
    return ticket({
      onCancel: () => log.remove(key, at),
      onSuccess: () => log.clear(key)
    });
  }

  return { begin, limits, size: () => log.size() };
}

// "3 minutes", "45 seconds": how long a refused client is told to wait.
function describeWait(seconds) {
  if (seconds < 90) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}

module.exports = {
  LOGIN_LIMITS,
  UNLOCK_LIMITS,
  createAttemptThrottle,
  createLoginThrottle,
  describeWait
};
