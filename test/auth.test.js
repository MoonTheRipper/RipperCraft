const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  hashSecret,
  needsRehash,
  setHashCostForTests,
  verifyAccountSecret,
  verifySecret
} = require("../src/lib/auth");

// Made by the previous version's hashSecret (PBKDF2-HMAC-SHA256, 210 000 rounds)
// for the password "correct horse battery staple". Kept as a literal so this
// test fails if hashes already sitting in a deployed users.json stop verifying.
const LEGACY_PASSWORD = "correct horse battery staple";
const LEGACY_HASH =
  "00112233445566778899aabbccddeeff:56b72380dc8efdd13cf6d33e683401766d75f4577128d6d15ca9156639f00cb1";

const CHEAP_COST = { ln: 10, r: 8, p: 1 };

// Wraps a callback-style crypto function so calls can be counted while the real
// derivation still runs.
function countCalls(t, name) {
  const original = crypto[name];
  const calls = [];
  t.mock.method(crypto, name, (...args) => {
    calls.push(args);
    return original(...args);
  });
  return calls;
}

test("new hashes are scrypt, record their parameters and verify at the real cost", async () => {
  const hash = await hashSecret("moon-pass-for-the-owner");

  // $scrypt$ln=<log2 N>,r=<r>,p=<p>$<16 byte salt>$<32 byte hash>
  assert.match(hash, /^\$scrypt\$ln=15,r=8,p=3\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/);
  assert.equal(await verifySecret("moon-pass-for-the-owner", hash), true);
  assert.equal(await verifySecret("moon-pass-for-the-owneR", hash), false);
  assert.equal(needsRehash(hash), false);

  // A fresh salt every time, so equal passwords do not share a hash.
  assert.notEqual(await hashSecret("moon-pass-for-the-owner"), hash);
});

test("a hash made by the previous version still verifies and is flagged for upgrade", async () => {
  assert.equal(await verifySecret(LEGACY_PASSWORD, LEGACY_HASH), true);
  assert.equal(await verifySecret("correct horse battery stapler", LEGACY_HASH), false);
  assert.equal(needsRehash(LEGACY_HASH), true);
});

test("a scrypt hash made with other parameters verifies and is flagged for upgrade", async (t) => {
  setHashCostForTests(CHEAP_COST);
  t.after(() => setHashCostForTests(null));
  const cheap = await hashSecret("made-with-older-settings");
  assert.match(cheap, /^\$scrypt\$ln=10,r=8,p=1\$/);

  setHashCostForTests(null);
  // The parameters are read from the hash, not from the current defaults.
  assert.equal(await verifySecret("made-with-older-settings", cheap), true);
  assert.equal(needsRehash(cheap), true);
});

test("malformed stored hashes and odd inputs are rejected without throwing", async () => {
  const good = await hashSecret("a-perfectly-good-one");
  const [, , parameters, salt, digest] = good.split("$");

  for (const stored of [
    "",
    null,
    undefined,
    42,
    {},
    "no-separator-at-all",
    "$scrypt$",
    `$scrypt$${parameters}$${salt}`,
    `$scrypt$ln=15,r=8$${salt}$${digest}`,
    // Parameters a damaged file could ask for: 2^40 blocks, or none at all.
    `$scrypt$ln=40,r=8,p=3$${salt}$${digest}`,
    `$scrypt$ln=0,r=8,p=3$${salt}$${digest}`,
    `$scrypt$ln=15,r=4096,p=3$${salt}$${digest}`,
    `$scrypt$ln=15.5,r=8,p=3$${salt}$${digest}`,
    `$scrypt$ln=15,r=8,p=3$$${digest}`,
    `$scrypt$ln=15,r=8,p=3$${salt}$`,
    "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"
  ]) {
    assert.equal(await verifySecret("a-perfectly-good-one", stored), false, String(stored));
    assert.equal(needsRehash(stored), false, String(stored));
  }

  // The wrong kind of secret never matches, and an empty one is never valid.
  for (const secret of [null, undefined, 42, {}, ["a-perfectly-good-one"], ""]) {
    assert.equal(await verifySecret(secret, good), false);
    assert.equal(await verifySecret(secret, LEGACY_HASH), false);
  }
  await assert.rejects(hashSecret(""), TypeError);
  await assert.rejects(hashSecret(12345678901234), TypeError);
});

test("hashing happens off the event loop", async () => {
  // The synchronous derivation froze every other request for its whole length.
  // Timers must keep firing while several hashes are being made.
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 2);
  const startedAt = Date.now();
  await Promise.all([
    hashSecret("first-concurrent-hash"),
    hashSecret("second-concurrent-hash"),
    verifySecret(LEGACY_PASSWORD, LEGACY_HASH)
  ]);
  const elapsed = Date.now() - startedAt;
  clearInterval(timer);

  assert.ok(elapsed >= 20, `the derivations finished implausibly fast (${elapsed} ms)`);
  assert.ok(ticks >= 5, `only ${ticks} timer ticks in ${elapsed} ms: the event loop was blocked`);
});

test("at most half the thread pool derives at once, and the rest wait their turn", async (t) => {
  setHashCostForTests(CHEAP_COST);
  t.after(() => setHashCostForTests(null));

  const original = crypto.scrypt;
  let running = 0;
  let mostAtOnce = 0;
  t.mock.method(crypto, "scrypt", (...args) => {
    const callback = args.pop();
    running += 1;
    mostAtOnce = Math.max(mostAtOnce, running);
    return original(...args, (error, value) => {
      // Finish on a later turn so overlapping work would be visible.
      setTimeout(() => {
        running -= 1;
        callback(error, value);
      }, 3);
    });
  });

  const hashes = await Promise.all(Array.from({ length: 12 }, (_, index) => hashSecret(`queued-secret-${index}`)));

  assert.equal(hashes.length, 12);
  // libuv's pool is 4 threads unless UV_THREADPOOL_SIZE says otherwise.
  const expectedSlots = Math.max(1, Math.floor((Number(process.env.UV_THREADPOOL_SIZE) || 4) / 2));
  assert.equal(mostAtOnce, expectedSlots);
});

test("a flood of derivations is turned away with 503 instead of queueing without limit", async (t) => {
  setHashCostForTests(CHEAP_COST);
  t.after(() => setHashCostForTests(null));

  // Hold every derivation open so the queue fills deterministically.
  const original = crypto.scrypt;
  const held = [];
  t.mock.method(crypto, "scrypt", (...args) => {
    held.push(() => original(...args));
  });

  const slots = Math.max(1, Math.floor((Number(process.env.UV_THREADPOOL_SIZE) || 4) / 2));
  const accepted = Array.from({ length: slots + 64 }, (_, index) => hashSecret(`accepted-${index}`));
  const refused = await hashSecret("one-too-many").then(
    () => null,
    (error) => error
  );

  assert.ok(refused, "the request beyond the queue limit was accepted");
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.headers["Retry-After"], "2");
  assert.match(refused.message, /busy/);

  // Let everything through; nothing that was accepted is lost.
  const drain = setInterval(() => {
    while (held.length) {
      held.shift()();
    }
  }, 1);
  const results = await Promise.all(accepted);
  clearInterval(drain);
  assert.equal(results.length, slots + 64);
  assert.ok(results.every((hash) => hash.startsWith("$scrypt$ln=10,")));
});

test("a login check does the same derivations whether or not the account exists", async (t) => {
  setHashCostForTests(CHEAP_COST);
  t.after(() => setHashCostForTests(null));
  const currentHash = await hashSecret("the-current-password");
  const otherCurrentHash = await hashSecret("somebody-elses-password");

  const scryptCalls = countCalls(t, "scrypt");
  const pbkdf2Calls = countCalls(t, "pbkdf2");
  const work = () => {
    const summary = {
      pbkdf2: pbkdf2Calls.map((args) => `${args[2]} rounds, ${args[3]} bytes, ${args[4]}`),
      scrypt: scryptCalls.map((args) => `N=${args[3].N} r=${args[3].r} p=${args[3].p}, ${args[2]} bytes`)
    };
    scryptCalls.length = 0;
    pbkdf2Calls.length = 0;
    return summary;
  };

  // Every account has a current hash: one scrypt derivation per attempt.
  const allCurrent = [currentHash, otherCurrentHash];
  assert.equal(await verifyAccountSecret("a-wrong-password", null, allCurrent), false);
  const unknownAccount = work();
  assert.deepEqual(unknownAccount, { pbkdf2: [], scrypt: ["N=1024 r=8 p=1, 32 bytes"] });

  assert.equal(await verifyAccountSecret("a-wrong-password", currentHash, allCurrent), false);
  assert.deepEqual(work(), unknownAccount);

  assert.equal(await verifyAccountSecret("the-current-password", currentHash, allCurrent), true);
  assert.deepEqual(work(), unknownAccount);

  // No accounts at all (before setup) still costs one derivation.
  assert.equal(await verifyAccountSecret("a-wrong-password", null, []), false);
  assert.deepEqual(work(), unknownAccount);

  // A legacy hash sits next to current ones, as it does right after upgrading:
  // every attempt now pays for both, so a legacy account cannot be told apart
  // from a name that does not exist.
  const mixed = [LEGACY_HASH, currentHash];
  assert.equal(await verifyAccountSecret("a-wrong-password", null, mixed), false);
  const unknownAmongMixed = work();
  assert.deepEqual(unknownAmongMixed, {
    pbkdf2: ["210000 rounds, 32 bytes, sha256"],
    scrypt: ["N=1024 r=8 p=1, 32 bytes"]
  });

  assert.equal(await verifyAccountSecret("a-wrong-password", LEGACY_HASH, mixed), false);
  assert.deepEqual(work(), unknownAmongMixed);

  assert.equal(await verifyAccountSecret("a-wrong-password", currentHash, mixed), false);
  assert.deepEqual(work(), unknownAmongMixed);

  assert.equal(await verifyAccountSecret(LEGACY_PASSWORD, LEGACY_HASH, mixed), true);
  assert.deepEqual(work(), unknownAmongMixed);

  assert.equal(await verifyAccountSecret("the-current-password", currentHash, mixed), true);
  assert.deepEqual(work(), unknownAmongMixed);

  // An account whose stored hash is unusable can never log in, and looks like
  // an unknown one while failing.
  assert.equal(await verifyAccountSecret("anything-at-all", "garbage", mixed), false);
  assert.deepEqual(work(), unknownAmongMixed);

  // The right password for one account does not open another.
  assert.equal(await verifyAccountSecret("somebody-elses-password", currentHash, allCurrent), false);
  assert.equal(await verifyAccountSecret("", currentHash, allCurrent), false);
});
