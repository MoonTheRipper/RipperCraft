const crypto = require("node:crypto");
const { addressBucket } = require("./peer");

// Limits on guessing, kept in memory. A restart clears them, which is fine: it
// also ends every session, and the limits rebuild within a handful of attempts.
//
// Login
//   1. One address has 5 tries at one username in 15 minutes. The failure that
//      uses up the last of them puts the address on a ladder of waits for that
//      username: 15 minutes, and then double for every failure after it
//      (30 minutes, an hour, ...) up to 24 hours. It comes off the ladder by
//      logging in, or by going 24 hours after a wait without failing again.
//   2. One address may fail 20 times in 15 minutes across all usernames.
//   3. A username that 4 or more addresses have failed on within 15 minutes is
//      being worked on by a crowd, and five tries per address is too generous
//      for a crowd: on such a username an address has no free tries, and its
//      very next failure goes on the ladder.
//
// Every one of these is counted against the address that failed, and only
// ever refuses that address. That is deliberate. A limit shared by a whole
// username - "this account has failed too often, everyone wait" - is the only
// kind a crowd of addresses cannot dodge, but anyone can fail on purpose under
// someone else's name, so it is also a way for one stranger to keep an account
// out of reach of its owner for as long as they care to. Here, what other
// addresses do never stops yours being checked: the right password from an
// address that has not been failing always gets in.
//
// A refused attempt is not checked at all, so the right password is refused
// too, and it does not extend the wait. A successful login clears what that
// address had against that username, and nothing wider.
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const LOGIN_LIMITS = Object.freeze({
  crowdAddresses: 4,
  ladderBaseMs: 15 * MINUTE,
  ladderMaxMs: 24 * HOUR,
  ladderMemoryMs: 24 * HOUR,
  maxFailuresPerAddress: 20,
  maxFailuresPerAddressAndUsername: 5,
  windowMs: 15 * MINUTE
});

// Server passphrase
//   - One account has 5 tries at one server's passphrase in 15 minutes, and
//     then the same ladder of waits as rule 1.
const UNLOCK_LIMITS = Object.freeze({
  ladderBaseMs: 15 * MINUTE,
  ladderMaxMs: 24 * HOUR,
  ladderMemoryMs: 24 * HOUR,
  maxFailures: 5,
  windowMs: 15 * MINUTE
});

// Usernames are whatever the request says, so the keys are attacker-chosen and
// every table has a ceiling. Beyond it the table drops an entry that is not
// holding anyone back, the least recently touched first; an entry that is
// currently refusing someone goes only when nothing else is left to drop.
const MAX_TRACKED_KEYS = 20_000;
const EVICTION_SCAN = 64;
const SWEEP_EVERY = 512;
// How many recently failing addresses are remembered per username. Only
// "at least crowdAddresses" ever matters, so this need not be large.
const CROWD_ADDRESSES_KEPT = 16;

function touch(map, key, value, maxKeys, isHolding) {
  map.delete(key);
  map.set(key, value);
  if (map.size <= maxKeys) {
    return;
  }
  let scanned = 0;
  for (const [candidate, entry] of map) {
    if (candidate !== key && !(isHolding && isHolding(entry))) {
      map.delete(candidate);
      return;
    }
    scanned += 1;
    if (scanned >= EVICTION_SCAN) {
      break;
    }
  }
  map.delete(map.keys().next().value);
}

// Failure times per key, newest last, forgetting anything older than the
// window. A key with `limit` of them is refused until the oldest ages out.
function createFailureLog({ limit, maxKeys, now, windowMs }) {
  const entries = new Map();
  const isHolding = (times) => times.length >= limit && times[times.length - 1] + windowMs > now();

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
      touch(entries, key, times, maxKeys, isHolding);
    },
    clear(key) {
      entries.delete(key);
    },
    isFull(key, at) {
      const times = recent(key, at);
      return Boolean(times) && times.length >= limit;
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
    waitMs(key, at) {
      const times = recent(key, at);
      if (!times || times.length < limit) {
        return 0;
      }
      return times[times.length - limit] + windowMs - at;
    }
  };
}

// Which addresses have failed on each username lately, to tell when a username
// is being worked on by a crowd.
function createCrowds({ maxKeys, windowMs }) {
  const entries = new Map();

  function recent(key, at) {
    const addresses = entries.get(key);
    if (!addresses) {
      return null;
    }
    for (const [address, failedAt] of addresses) {
      if (failedAt + windowMs <= at) {
        addresses.delete(address);
      }
    }
    if (!addresses.size) {
      entries.delete(key);
      return null;
    }
    return addresses;
  }

  return {
    count(key, at) {
      const addresses = recent(key, at);
      return addresses ? addresses.size : 0;
    },
    // Records that `address` failed on `key`, and returns what is needed to
    // take that back.
    note(key, address, at) {
      const addresses = recent(key, at) || new Map();
      const receipt = { at, before: addresses.get(address) };
      addresses.delete(address);
      addresses.set(address, at);
      if (addresses.size > CROWD_ADDRESSES_KEPT) {
        addresses.delete(addresses.keys().next().value);
      }
      touch(entries, key, addresses, maxKeys);
      return receipt;
    },
    // The address turned out not to have failed after all (it logged in, or
    // the attempt could not be checked): put back what was there before.
    restore(key, address, receipt) {
      const addresses = entries.get(key);
      if (!addresses || addresses.get(address) !== receipt.at) {
        return;
      }
      if (receipt.before === undefined) {
        addresses.delete(address);
      } else {
        addresses.set(address, receipt.before);
      }
      if (!addresses.size) {
        entries.delete(key);
      }
    },
    // The address is the account's real user: its earlier slips do not make a crowd.
    forget(key, address) {
      const addresses = entries.get(key);
      if (addresses && addresses.delete(address) && !addresses.size) {
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
    }
  };
}

// The ladder: per address and username, each failure doubles the wait before
// the next attempt.
function createLadder({ baseMs, maxKeys, maxMs, memoryMs, now }) {
  const entries = new Map();
  const isHolding = (entry) => entry.blockedUntil > now();

  function live(key, at) {
    const entry = entries.get(key);
    if (!entry) {
      return null;
    }
    // Remembered until it has been free to try again for `memoryMs` without
    // failing. Counting from the last failure instead would forget an address
    // at the very moment its longest wait ended.
    if (entry.blockedUntil + memoryMs <= at) {
      entries.delete(key);
      return null;
    }
    return entry;
  }

  return {
    clear(key) {
      entries.delete(key);
    },
    has(key, at) {
      return live(key, at) !== null;
    },
    size() {
      return entries.size;
    },
    // One rung up. Returns what is needed to step back down.
    step(key, at) {
      const entry = live(key, at) || { blockedUntil: 0, failures: 0 };
      const receipt = { ...entry, existed: entries.has(key) };
      entry.failures += 1;
      const wait = Math.min(maxMs, baseMs * 2 ** Math.min(entry.failures - 1, 30));
      entry.blockedUntil = Math.max(entry.blockedUntil, at + wait);
      touch(entries, key, entry, maxKeys, isHolding);
      return receipt;
    },
    sweep(at) {
      for (const key of [...entries.keys()]) {
        live(key, at);
      }
    },
    undo(key, receipt) {
      if (!receipt.existed) {
        entries.delete(key);
        return;
      }
      const entry = entries.get(key);
      if (entry) {
        entry.blockedUntil = receipt.blockedUntil;
        entry.failures = receipt.failures;
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
function ticket({ onCancel, onFailure, onSuccess }) {
  let settled = false;
  const settle = (action) => () => {
    if (!settled) {
      settled = true;
      if (action) {
        action();
      }
    }
  };
  return {
    allowed: true,
    // The attempt could not be checked (the request failed for another reason).
    cancelled: settle(onCancel),
    failed: settle(onFailure),
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

  const byPair = createFailureLog({
    limit: limits.maxFailuresPerAddressAndUsername,
    maxKeys,
    now,
    windowMs: limits.windowMs
  });
  const byAddress = createFailureLog({ limit: limits.maxFailuresPerAddress, maxKeys, now, windowMs: limits.windowMs });
  const crowds = createCrowds({ maxKeys, windowMs: limits.windowMs });
  const ladder = createLadder({
    baseMs: limits.ladderBaseMs,
    maxKeys,
    maxMs: limits.ladderMaxMs,
    memoryMs: limits.ladderMemoryMs,
    now
  });
  let calls = 0;

  function begin({ address, username }) {
    const at = now();
    calls += 1;
    if (calls % SWEEP_EVERY === 0) {
      byPair.sweep(at);
      byAddress.sweep(at);
      crowds.sweep(at);
      ladder.sweep(at);
    }

    const addressKey = addressBucket(address);
    const userKey = usernameKey(username);
    const pairKey = `${addressKey}|${userKey}`;

    // Both are this address's own doing. Nothing here asks whether any other
    // address is being made to wait.
    const pairWait = Math.max(byPair.waitMs(pairKey, at), ladder.waitMs(pairKey, at));
    const addressWait = byAddress.waitMs(addressKey, at);
    if (pairWait > 0 || addressWait > 0) {
      return pairWait >= addressWait ? refusal(pairWait, "address+username") : refusal(addressWait, "address");
    }

    byPair.add(pairKey, at);
    byAddress.add(addressKey, at);
    const noted = crowds.note(userKey, addressKey, at);
    // An address already on the ladder, or one failing on a username that a
    // crowd is working on, has no free tries: it takes its next rung now,
    // before the check, so that a second guess sent alongside this one waits
    // like any other. (The rung is given back if the password turns out right.)
    const stepped =
      ladder.has(pairKey, at) || crowds.count(userKey, at) >= limits.crowdAddresses ? ladder.step(pairKey, at) : null;

    return ticket({
      onCancel() {
        byPair.remove(pairKey, at);
        byAddress.remove(addressKey, at);
        crowds.restore(userKey, addressKey, noted);
        if (stepped) {
          ladder.undo(pairKey, stepped);
        }
      },
      // The failure that used up the address's five tries is its first rung.
      onFailure() {
        if (!stepped && !ladder.has(pairKey, at) && byPair.isFull(pairKey, at)) {
          ladder.step(pairKey, at);
        }
      },
      // Clears what this address had against this username, and nothing wider:
      // a valid account of one's own must not buy fresh guesses at someone
      // else's, so the address's other failures stay on the books.
      onSuccess() {
        byPair.clear(pairKey);
        byAddress.remove(addressKey, at);
        crowds.forget(userKey, addressKey);
        ladder.clear(pairKey);
      }
    });
  }

  return {
    begin,
    limits,
    size: () => byPair.size() + byAddress.size() + crowds.size() + ladder.size()
  };
}

// One key, rule 1 only: N tries in the window, then the ladder.
function createAttemptThrottle(options = {}) {
  const limits = { ...UNLOCK_LIMITS, ...(options.limits || {}) };
  const now = options.now || Date.now;
  const maxKeys = options.maxKeys || MAX_TRACKED_KEYS;
  const log = createFailureLog({ limit: limits.maxFailures, maxKeys, now, windowMs: limits.windowMs });
  const ladder = createLadder({
    baseMs: limits.ladderBaseMs,
    maxKeys,
    maxMs: limits.ladderMaxMs,
    memoryMs: limits.ladderMemoryMs,
    now
  });
  let calls = 0;

  function begin(key) {
    const at = now();
    calls += 1;
    if (calls % SWEEP_EVERY === 0) {
      log.sweep(at);
      ladder.sweep(at);
    }

    const waitMs = Math.max(log.waitMs(key, at), ladder.waitMs(key, at));
    if (waitMs > 0) {
      return refusal(waitMs, "key");
    }
    log.add(key, at);
    const stepped = ladder.has(key, at) ? ladder.step(key, at) : null;
    return ticket({
      onCancel() {
        log.remove(key, at);
        if (stepped) {
          ladder.undo(key, stepped);
        }
      },
      onFailure() {
        if (!stepped && !ladder.has(key, at) && log.isFull(key, at)) {
          ladder.step(key, at);
        }
      },
      onSuccess() {
        log.clear(key);
        ladder.clear(key);
      }
    });
  }

  return { begin, limits, size: () => log.size() + ladder.size() };
}

// "45 seconds", "15 minutes", "3 hours": how long a refused client is told to wait.
function describeWait(seconds) {
  if (seconds < 90) {
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  if (seconds < 90 * 60) {
    return `${Math.ceil(seconds / 60)} minutes`;
  }
  return `${Math.ceil(seconds / 3600)} hours`;
}

module.exports = {
  LOGIN_LIMITS,
  UNLOCK_LIMITS,
  createAttemptThrottle,
  createLoginThrottle,
  describeWait
};
