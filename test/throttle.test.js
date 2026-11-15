const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOGIN_LIMITS,
  UNLOCK_LIMITS,
  createAttemptThrottle,
  createLoginThrottle,
  describeWait
} = require("../src/lib/throttle");

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function clock(start = 1_800_000_000_000) {
  let current = start;
  const now = () => current;
  now.advance = (milliseconds) => {
    current += milliseconds;
  };
  return now;
}

// A public address per index, as a visitor arriving through the tunnel.
const stranger = (index) => `198.51.100.${index}`;

function fail(throttle, attempt) {
  const result = throttle.begin(attempt);
  assert.equal(result.allowed, true, `expected ${JSON.stringify(attempt)} to be let through`);
  result.failed();
}

test("the documented login limits are the ones enforced", () => {
  assert.deepEqual(LOGIN_LIMITS, {
    crowdAddresses: 4,
    ladderBaseMs: 15 * MINUTE,
    ladderMaxMs: 24 * HOUR,
    ladderMemoryMs: 24 * HOUR,
    maxFailuresPerAddress: 20,
    maxFailuresPerAddressAndUsername: 5,
    windowMs: 15 * MINUTE
  });
  assert.deepEqual(UNLOCK_LIMITS, {
    ladderBaseMs: 15 * MINUTE,
    ladderMaxMs: 24 * HOUR,
    ladderMemoryMs: 24 * HOUR,
    maxFailures: 5,
    windowMs: 15 * MINUTE
  });
});

test("five failures from one address against one username start a ladder of doubling waits", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  const attempt = { address: stranger(1), username: "owner" };

  for (let index = 0; index < 5; index += 1) {
    fail(throttle, attempt);
    now.advance(MINUTE);
  }

  // A minute after the fifth failure: fourteen of its fifteen minutes to go.
  assert.deepEqual(throttle.begin(attempt), { allowed: false, retryAfterSeconds: 840, scope: "address+username" });

  // Being refused is not a failure: asking again does not push the time out.
  now.advance(13 * MINUTE);
  for (let index = 0; index < 50; index += 1) {
    assert.equal(throttle.begin(attempt).retryAfterSeconds, 60);
  }
  now.advance(59 * SECOND);
  assert.equal(throttle.begin(attempt).retryAfterSeconds, 1);

  // After the wait there is one try, not five, and each one that fails doubles
  // the next wait, up to a day.
  const waits = [];
  for (let round = 0; round < 8; round += 1) {
    now.advance(round === 0 ? SECOND : waits.at(-1) * SECOND);
    fail(throttle, attempt);
    const refused = throttle.begin(attempt);
    assert.equal(refused.allowed, false);
    assert.equal(refused.scope, "address+username");
    waits.push(refused.retryAfterSeconds);
  }
  assert.deepEqual(waits, [1800, 3600, 7200, 14400, 28800, 57600, 86400, 86400]);

  // Failures spread thinly never reach it: four a quarter of an hour, for a day.
  const patient = createLoginThrottle({ now });
  for (let quarter = 0; quarter < 96; quarter += 1) {
    for (let index = 0; index < 4; index += 1) {
      fail(patient, attempt);
    }
    now.advance(15 * MINUTE);
  }
  assert.equal(patient.begin(attempt).allowed, true);
});

test("username case and padding do not buy extra attempts, and other usernames are separate", () => {
  const throttle = createLoginThrottle({ now: clock() });
  for (const username of ["owner", "OWNER", " Owner ", "oWnEr", "owner\t"]) {
    fail(throttle, { address: stranger(1), username });
  }
  assert.equal(throttle.begin({ address: stranger(1), username: "Owner" }).allowed, false);

  // The same address may still try a different account, and a different
  // address the same account.
  assert.equal(throttle.begin({ address: stranger(1), username: "lane" }).allowed, true);
  assert.equal(throttle.begin({ address: stranger(2), username: "owner" }).allowed, true);
});

test("a username that does not exist is limited exactly like one that does", () => {
  const throttle = createLoginThrottle({ now: clock() });
  const results = [];
  for (let index = 0; index < 6; index += 1) {
    const result = throttle.begin({ address: stranger(1), username: "nobody-by-this-name" });
    results.push(result.allowed);
    if (result.allowed) {
      result.failed();
    }
  }
  assert.deepEqual(results, [true, true, true, true, true, false]);
});

test("a success clears that address's failures for that username and nothing wider", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  const mine = { address: stranger(1), username: "lane" };
  const theirs = { address: stranger(1), username: "owner" };

  for (let index = 0; index < 4; index += 1) {
    fail(throttle, mine);
    fail(throttle, theirs);
  }
  throttle.begin(mine).succeeded();

  // Lane's own slate is clean again: five fresh attempts.
  for (let index = 0; index < 5; index += 1) {
    fail(throttle, mine);
  }
  assert.equal(throttle.begin(mine).scope, "address+username");

  // Logging in as lane did nothing for the guesses at the owner's password.
  fail(throttle, theirs);
  assert.equal(throttle.begin(theirs).scope, "address+username");

  // And the address as a whole still carries every failure it made:
  // 4 + 4 before the success, then 5 + 1.
  for (let index = 0; index < 6; index += 1) {
    fail(throttle, { address: stranger(1), username: `spray-${index}` });
  }
  assert.deepEqual(throttle.begin({ address: stranger(1), username: "one-more" }), {
    allowed: false,
    retryAfterSeconds: 900,
    scope: "address"
  });
});

test("twenty failures from one address stop it trying any username", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  for (let index = 0; index < 20; index += 1) {
    fail(throttle, { address: stranger(1), username: `account-${index}` });
  }

  for (const username of ["owner", "account-3", "never-tried"]) {
    assert.deepEqual(throttle.begin({ address: stranger(1), username }), {
      allowed: false,
      retryAfterSeconds: 900,
      scope: "address"
    });
  }
  // Everyone else is unaffected.
  assert.equal(throttle.begin({ address: stranger(2), username: "owner" }).allowed, true);

  now.advance(15 * MINUTE);
  assert.equal(throttle.begin({ address: stranger(1), username: "owner" }).allowed, true);
});

test("guesses sent at the same moment cannot all be checked before the first is counted", () => {
  const throttle = createLoginThrottle({ now: clock() });
  const attempt = { address: stranger(1), username: "owner" };

  // Nothing has been settled yet: these are all still being verified.
  const inFlight = Array.from({ length: 12 }, () => throttle.begin(attempt));
  assert.deepEqual(
    inFlight.map((result) => result.allowed),
    [true, true, true, true, true, false, false, false, false, false, false, false]
  );

  // One that could not be checked at all gives its place back.
  inFlight[0].cancelled();
  const retried = throttle.begin(attempt);
  assert.equal(retried.allowed, true);
  assert.equal(throttle.begin(attempt).allowed, false);

  // Settling twice changes nothing.
  inFlight[1].failed();
  inFlight[1].succeeded();
  assert.equal(throttle.begin(attempt).allowed, false);
});

test("a username failed on from four addresses puts each failing address on a doubling wait", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  const on = (index) => ({ address: stranger(index), username: "owner" });

  // Three addresses are not a crowd: each keeps its ordinary five tries.
  for (let index = 1; index <= 3; index += 1) {
    fail(throttle, on(index));
    fail(throttle, on(index));
  }
  assert.equal(throttle.begin(on(1)).allowed, true);

  // The fourth makes one. Its failure costs it fifteen minutes...
  fail(throttle, on(4));
  assert.deepEqual(throttle.begin(on(4)), { allowed: false, retryAfterSeconds: 900, scope: "address+username" });
  // ...and so does the next failure of an address that was failing before the
  // crowd formed, although it has used only three of its five tries.
  assert.equal(throttle.begin(on(2)).allowed, true);
  assert.deepEqual(throttle.begin(on(2)), { allowed: false, retryAfterSeconds: 900, scope: "address+username" });

  // Other usernames are not affected, even from the same addresses.
  fail(throttle, { address: stranger(4), username: "lane" });
  assert.equal(throttle.begin({ address: stranger(4), username: "lane" }).allowed, true);

  // Each time the same address fails again its wait doubles, up to a day.
  const waits = [];
  for (let round = 0; round < 9; round += 1) {
    const refused = throttle.begin(on(4));
    assert.equal(refused.allowed, false);
    assert.equal(refused.scope, "address+username");
    waits.push(refused.retryAfterSeconds);
    now.advance(refused.retryAfterSeconds * SECOND);
    fail(throttle, on(4));
  }
  assert.deepEqual(waits, [900, 1800, 3600, 7200, 14400, 28800, 57600, 86400, 86400]);
});

test("what other addresses do never stops an address that has not been failing", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });

  // A crowd works on the owner's username until every one of its addresses is waiting.
  for (let index = 1; index <= 40; index += 1) {
    const result = throttle.begin({ address: stranger(index), username: "owner" });
    if (result.allowed) {
      result.failed();
    }
  }
  assert.equal(throttle.begin({ address: stranger(40), username: "owner" }).scope, "address+username");

  // The owner, from an address that has never been seen, is checked at once.
  for (let index = 0; index < 5; index += 1) {
    const fresh = throttle.begin({ address: `203.0.113.${index + 1}`, username: "owner" });
    assert.equal(fresh.allowed, true);
    fresh.succeeded();
  }
  // A slip of their own is theirs alone to wait out: nobody else's address is held.
  fail(throttle, { address: "203.0.113.50", username: "owner" });
  assert.deepEqual(throttle.begin({ address: "203.0.113.50", username: "owner" }), {
    allowed: false,
    retryAfterSeconds: 900,
    scope: "address+username"
  });
  assert.equal(throttle.begin({ address: "203.0.113.51", username: "owner" }).allowed, true);
});

test("one address failing for hours cannot keep anyone else out", () => {
  // The rule this replaced counted failures per username, and one address that
  // never exceeded its own limit could hold a username at the longest wait for
  // every address that had not logged in before.
  const now = clock();
  const throttle = createLoginThrottle({ now });
  let checkedGuesses = 0;
  let refusedOthers = 0;

  for (let minute = 0; minute < 6 * 60; minute += 1) {
    const guess = throttle.begin({ address: stranger(66), username: "owner" });
    if (guess.allowed) {
      guess.failed();
      checkedGuesses += 1;
    }
    // Meanwhile somebody tries the right password from an address not seen before.
    const other = throttle.begin({ address: `203.0.${minute % 250}.${Math.floor(minute / 250) + 1}`, username: "owner" });
    if (other.allowed) {
      other.succeeded();
    } else {
      refusedOthers += 1;
    }
    now.advance(MINUTE);
  }

  assert.equal(refusedOthers, 0);
  // Its own five tries, then one guess per rung of the ladder: at 19, 49, 109
  // and 229 minutes. Nine guesses in six hours.
  assert.equal(checkedGuesses, 9);
});

test("a correct login takes an address off the ladder and out of the crowd", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  const on = (index) => ({ address: stranger(index), username: "owner" });
  for (let index = 1; index <= 4; index += 1) {
    fail(throttle, on(index));
  }
  assert.equal(throttle.begin(on(4)).scope, "address+username");

  // Address 4 waits its fifteen minutes and then gets it right.
  now.advance(15 * MINUTE);
  throttle.begin(on(4)).succeeded();
  // Its slate is clean: the ordinary five tries, and no doubling from where it left off.
  for (let index = 0; index < 5; index += 1) {
    fail(throttle, on(4));
  }
  assert.deepEqual(throttle.begin(on(4)), { allowed: false, retryAfterSeconds: 900, scope: "address+username" });

  // Successful logins never make a crowd, however many addresses they come from.
  const calm = createLoginThrottle({ now });
  for (let index = 1; index <= 30; index += 1) {
    calm.begin({ address: stranger(index), username: "lane" }).succeeded();
  }
  fail(calm, { address: stranger(100), username: "lane" });
  assert.equal(calm.begin({ address: stranger(100), username: "lane" }).allowed, true);
});

test("an address keeps its place on the ladder until it has gone a day without failing, crowd or no crowd", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  const on = (index) => ({ address: stranger(index), username: "owner" });
  for (let index = 1; index <= 4; index += 1) {
    fail(throttle, on(index));
  }
  assert.equal(throttle.begin(on(4)).retryAfterSeconds, 900);

  // Two hours later the crowd is long gone, but this address was part of it:
  // its next failure is its second rung, not a fresh start.
  now.advance(2 * HOUR);
  fail(throttle, on(4));
  assert.deepEqual(throttle.begin(on(4)), { allowed: false, retryAfterSeconds: 1800, scope: "address+username" });
  // An address that was not part of it has its ordinary five tries.
  fail(throttle, on(9));
  assert.equal(throttle.begin(on(9)).allowed, true);

  // The half hour passes, and then a day in which it could have tried and did
  // not: only then is it forgotten.
  now.advance(30 * MINUTE + 23 * HOUR);
  fail(throttle, on(4));
  assert.deepEqual(throttle.begin(on(4)), { allowed: false, retryAfterSeconds: 3600, scope: "address+username" });
  now.advance(HOUR + 24 * HOUR);
  fail(throttle, on(4));
  assert.equal(throttle.begin(on(4)).allowed, true);
});

test("an attempt that could not be checked leaves no trace in the crowd or on the ladder", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  const on = (index) => ({ address: stranger(index), username: "owner" });
  for (let index = 1; index <= 3; index += 1) {
    fail(throttle, on(index));
  }

  // The fourth address's attempt is let through and then cannot be checked.
  for (let index = 0; index < 10; index += 1) {
    throttle.begin(on(4)).cancelled();
  }
  // No crowd was formed by it: the next failure from address 1 costs nothing extra...
  fail(throttle, on(1));
  assert.equal(throttle.begin(on(1)).allowed, true);
  // ...and address 4 itself is not on the ladder.
  fail(throttle, on(4));
  assert.equal(throttle.begin(on(4)).scope, "address+username");
  assert.equal(throttle.begin(on(4)).retryAfterSeconds, 900);

  // While an attempt on a crowded username is being checked, a second one from
  // the same address is not let through alongside it.
  const first = throttle.begin(on(5));
  assert.equal(first.allowed, true);
  assert.equal(throttle.begin(on(5)).allowed, false);
  first.cancelled();
  assert.equal(throttle.begin(on(5)).allowed, true);
});

test("addresses in one IPv6 /64 share a limit", () => {
  const throttle = createLoginThrottle({ now: clock() });
  for (let index = 1; index <= 5; index += 1) {
    fail(throttle, { address: `2001:db8:1:2:0:0:0:${index}`, username: "owner" });
  }
  assert.equal(throttle.begin({ address: "2001:db8:1:2:aaaa:bbbb:cccc:dddd", username: "owner" }).allowed, false);
  assert.equal(throttle.begin({ address: "2001:db8:1:3:0:0:0:1", username: "owner" }).allowed, true);
});

test("every loopback address shares one limit", () => {
  const throttle = createLoginThrottle({ now: clock() });
  // A program on this machine, connecting from a different 127.x.y.z each time.
  for (let index = 1; index <= 5; index += 1) {
    fail(throttle, { address: `127.0.0.${index}`, username: "owner" });
  }
  assert.equal(throttle.begin({ address: "127.44.55.66", username: "owner" }).scope, "address+username");
  assert.equal(throttle.begin({ address: "0:0:0:0:0:0:0:1", username: "owner" }).scope, "address+username");
});

test("the tables stay bounded however many usernames and addresses are thrown at them", () => {
  const now = clock();
  const throttle = createLoginThrottle({ maxKeys: 50, now });
  for (let index = 0; index < 2000; index += 1) {
    const result = throttle.begin({
      address: `198.51.${index % 250}.${Math.floor(index / 250) + 1}`,
      username: `${"x".repeat(5000)}-${index}`
    });
    if (result.allowed) {
      result.failed();
    }
  }
  // Four tables, 50 keys each.
  assert.ok(throttle.size() <= 200, `tracking ${throttle.size()} keys`);

  // An entry that has expired is dropped rather than kept until it is evicted.
  const quiet = createLoginThrottle({ now });
  fail(quiet, { address: stranger(1), username: "owner" });
  assert.equal(quiet.size(), 3);
  now.advance(16 * MINUTE);
  for (let index = 0; index < 512; index += 1) {
    quiet.begin({ address: stranger(2), username: "lane" }).cancelled();
  }
  assert.equal(quiet.size(), 0);
});

test("when a table is full, entries that are refusing someone are the last to go", () => {
  const now = clock();
  const throttle = createLoginThrottle({ maxKeys: 8, now });
  const blocked = { address: stranger(1), username: "owner" };
  for (let index = 0; index < 5; index += 1) {
    fail(throttle, blocked);
  }
  assert.equal(throttle.begin(blocked).allowed, false);

  // Far more single failures than the tables hold, from other addresses on
  // other usernames. Dropping the oldest entry first would drop the block.
  for (let index = 0; index < 60; index += 1) {
    fail(throttle, { address: `203.0.113.${index + 1}`, username: `filler-${index}` });
  }
  assert.deepEqual(throttle.begin(blocked), { allowed: false, retryAfterSeconds: 900, scope: "address+username" });

  // The same on the ladder. Address 4 climbs to an hour's wait...
  const laddered = createLoginThrottle({ maxKeys: 8, now });
  const crowd = (username, first) => {
    for (let index = first; index < first + 4; index += 1) {
      const result = laddered.begin({ address: stranger(index), username });
      if (result.allowed) {
        result.failed();
      }
    }
  };
  crowd("owner", 1);
  now.advance(15 * MINUTE);
  fail(laddered, { address: stranger(4), username: "owner" });
  now.advance(30 * MINUTE);
  fail(laddered, { address: stranger(4), username: "owner" });
  assert.equal(laddered.begin({ address: stranger(4), username: "owner" }).retryAfterSeconds, 3600);

  // ...then other crowds put seven more addresses on fifteen-minute waits, which
  // run out while address 4 is still waiting. Its entry is now the oldest in a
  // full table, and the only one still refusing anybody.
  for (let name = 0; name < 7; name += 1) {
    crowd(`crowded-${name}`, 10 + name * 4);
  }
  now.advance(20 * MINUTE);
  for (let name = 7; name < 12; name += 1) {
    crowd(`crowded-${name}`, 10 + name * 4);
  }
  assert.deepEqual(laddered.begin({ address: stranger(4), username: "owner" }), {
    allowed: false,
    retryAfterSeconds: 2400,
    scope: "address+username"
  });
});

test("the single-key limiter used for server passphrases allows five tries, then the same ladder", () => {
  const now = clock();
  const throttle = createAttemptThrottle({ now });
  const key = "usr_lane|DemoServer";

  for (let index = 0; index < 4; index += 1) {
    throttle.begin(key).failed();
  }
  // Getting it right wipes the slate.
  throttle.begin(key).succeeded();
  for (let index = 0; index < 5; index += 1) {
    throttle.begin(key).failed();
  }
  assert.deepEqual(throttle.begin(key), { allowed: false, retryAfterSeconds: 900, scope: "key" });

  // Another account, or the same account on another server, is separate.
  assert.equal(throttle.begin("usr_other|DemoServer").allowed, true);
  assert.equal(throttle.begin("usr_lane|OtherServer").allowed, true);

  // A request that could not be checked does not use up an attempt.
  const other = "usr_lane|ThirdServer";
  for (let index = 0; index < 20; index += 1) {
    throttle.begin(other).cancelled();
  }
  assert.equal(throttle.begin(other).allowed, true);

  // After the wait there is one try at a time, and every one that fails doubles the next wait.
  const waits = [];
  for (let round = 0; round < 8; round += 1) {
    now.advance(round === 0 ? 15 * MINUTE : waits.at(-1) * SECOND);
    throttle.begin(key).failed();
    waits.push(throttle.begin(key).retryAfterSeconds);
  }
  assert.deepEqual(waits, [1800, 3600, 7200, 14400, 28800, 57600, 86400, 86400]);

  // Getting it right ends that too: five tries again.
  now.advance(24 * HOUR);
  throttle.begin(key).succeeded();
  for (let index = 0; index < 4; index += 1) {
    throttle.begin(key).failed();
  }
  assert.equal(throttle.begin(key).allowed, true);
  assert.ok(throttle.size() <= 6);
});

test("waits are described in words a person can act on", () => {
  assert.equal(describeWait(1), "1 second");
  assert.equal(describeWait(45), "45 seconds");
  assert.equal(describeWait(89), "89 seconds");
  assert.equal(describeWait(90), "2 minutes");
  assert.equal(describeWait(300), "5 minutes");
  assert.equal(describeWait(841), "15 minutes");
  assert.equal(describeWait(900), "15 minutes");
  assert.equal(describeWait(3600), "60 minutes");
  assert.equal(describeWait(5399), "90 minutes");
  assert.equal(describeWait(5400), "2 hours");
  assert.equal(describeWait(14400), "4 hours");
  assert.equal(describeWait(86400), "24 hours");
});
