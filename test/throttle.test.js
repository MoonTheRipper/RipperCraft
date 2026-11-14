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
    knownAddressTtlMs: 30 * 24 * 60 * MINUTE,
    maxFailuresPerAddress: 20,
    maxFailuresPerAddressAndUsername: 5,
    usernameBackoffBaseMs: SECOND,
    usernameBackoffMaxMs: 5 * MINUTE,
    usernameFailuresBeforeBackoff: 10,
    windowMs: 15 * MINUTE
  });
  assert.deepEqual(UNLOCK_LIMITS, { maxFailures: 5, windowMs: 15 * MINUTE });
});

test("five failures from one address against one username are refused until the oldest ages out", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  const attempt = { address: stranger(1), username: "owner" };

  for (let index = 0; index < 5; index += 1) {
    fail(throttle, attempt);
    now.advance(MINUTE);
  }

  // Five minutes after the first failure: ten more to wait.
  assert.deepEqual(throttle.begin(attempt), { allowed: false, retryAfterSeconds: 600, scope: "address+username" });

  // Being refused is not a failure: asking again does not push the time out.
  now.advance(9 * MINUTE);
  for (let index = 0; index < 50; index += 1) {
    assert.equal(throttle.begin(attempt).retryAfterSeconds, 60);
  }
  now.advance(59 * SECOND);
  assert.equal(throttle.begin(attempt).retryAfterSeconds, 1);

  // The first failure is now 15 minutes old: one attempt is available again,
  // and using it up closes the door until the second failure ages out.
  now.advance(SECOND);
  fail(throttle, attempt);
  assert.deepEqual(throttle.begin(attempt), { allowed: false, retryAfterSeconds: 60, scope: "address+username" });
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

test("failures for one username from many addresses slow it down, doubling to five minutes", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });

  // Ten addresses, one wrong guess each: no single address is near its limit.
  for (let index = 1; index <= 9; index += 1) {
    fail(throttle, { address: stranger(index), username: "owner" });
  }
  assert.equal(throttle.begin({ address: stranger(100), username: "owner" }).allowed, true);

  // The tenth failure (just made, still unsettled) starts the waits.
  const waits = [];
  for (let index = 101; index <= 112; index += 1) {
    const refused = throttle.begin({ address: stranger(index), username: "owner" });
    assert.equal(refused.allowed, false);
    assert.equal(refused.scope, "username");
    waits.push(refused.retryAfterSeconds);
    // Wait it out, then fail once more from yet another address.
    now.advance(refused.retryAfterSeconds * SECOND);
    fail(throttle, { address: stranger(index), username: "owner" });
  }
  assert.deepEqual(waits, [1, 2, 4, 8, 16, 32, 64, 128, 256, 300, 300, 300]);

  // Other usernames are not slowed, even from the same addresses.
  assert.equal(throttle.begin({ address: stranger(112), username: "lane" }).allowed, true);

  // It is a wait, not a lock: it ends on its own, and after fifteen quiet
  // minutes the count starts from nothing.
  assert.equal(throttle.begin({ address: stranger(200), username: "owner" }).retryAfterSeconds, 300);
  now.advance(5 * MINUTE);
  assert.equal(throttle.begin({ address: stranger(200), username: "owner" }).allowed, true);
  now.advance(15 * MINUTE);
  for (let index = 1; index <= 9; index += 1) {
    fail(throttle, { address: stranger(210 + index), username: "owner" });
  }
  assert.equal(throttle.begin({ address: stranger(220), username: "owner" }).allowed, true);
});

test("the real user is not kept out by other people's failures", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });

  // The owner has logged in from home before.
  throttle.begin({ address: "203.0.113.50", username: "owner" }).succeeded();

  // Then a crowd hammers the owner's username until it is at the longest wait.
  for (let index = 1; index <= 30; index += 1) {
    const result = throttle.begin({ address: stranger(index), username: "owner" });
    if (result.allowed) {
      result.failed();
    } else {
      now.advance(result.retryAfterSeconds * SECOND);
      fail(throttle, { address: stranger(index), username: "owner" });
    }
  }
  const outsider = throttle.begin({ address: stranger(250), username: "owner" });
  assert.deepEqual(outsider, { allowed: false, retryAfterSeconds: 300, scope: "username" });

  // The address that has logged in before is let straight through...
  const fromHome = throttle.begin({ address: "203.0.113.50", username: "owner" });
  assert.equal(fromHome.allowed, true);
  fromHome.succeeded();

  // ...and so is a direct connection from the LAN, which no crowd on the
  // internet can pretend to be.
  const fromLan = throttle.begin({ address: "192.168.1.20", local: true, username: "owner" });
  assert.equal(fromLan.allowed, true);
  fromLan.succeeded();

  // A legitimate login does not shorten the wait for everyone else either.
  assert.equal(throttle.begin({ address: stranger(250), username: "owner" }).retryAfterSeconds, 300);

  // Neither exemption is a way round the per-address limit.
  for (let index = 0; index < 5; index += 1) {
    fail(throttle, { address: "192.168.1.20", local: true, username: "owner" });
    fail(throttle, { address: "203.0.113.50", username: "owner" });
  }
  assert.equal(throttle.begin({ address: "192.168.1.20", local: true, username: "owner" }).scope, "address+username");
  assert.equal(throttle.begin({ address: "203.0.113.50", username: "owner" }).scope, "address+username");

  // Having logged in as one account says nothing about another.
  throttle.begin({ address: "203.0.113.60", username: "lane" }).succeeded();
  assert.equal(throttle.begin({ address: "203.0.113.60", username: "owner" }).scope, "username");
});

test("a remembered address is forgotten after thirty days", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  throttle.begin({ address: "203.0.113.50", username: "owner" }).succeeded();

  const hammer = () => {
    for (let index = 1; index <= 12; index += 1) {
      const result = throttle.begin({ address: stranger(index), username: "owner" });
      if (result.allowed) {
        result.failed();
      }
    }
  };

  now.advance(29 * 24 * 60 * MINUTE);
  hammer();
  assert.equal(throttle.begin({ address: "203.0.113.50", username: "owner" }).allowed, true);

  now.advance(2 * 24 * 60 * MINUTE);
  hammer();
  assert.equal(throttle.begin({ address: "203.0.113.50", username: "owner" }).scope, "username");
});

test("a successful login does not count towards slowing the username down", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  for (let index = 1; index <= 9; index += 1) {
    fail(throttle, { address: stranger(index), username: "owner" });
  }

  // Many successes from many addresses: still nine failures on the books.
  for (let index = 20; index < 40; index += 1) {
    throttle.begin({ address: stranger(index), username: "owner" }).succeeded();
  }
  assert.equal(throttle.begin({ address: stranger(50), username: "owner" }).allowed, true);

  // Nor do they keep old failures alive: 15 minutes after the last *failure*
  // the count is gone, however recently somebody logged in.
  now.advance(14 * MINUTE);
  throttle.begin({ address: stranger(60), username: "owner" }).succeeded();
  now.advance(2 * MINUTE);
  for (let index = 70; index < 79; index += 1) {
    fail(throttle, { address: stranger(index), username: "owner" });
  }
  assert.equal(throttle.begin({ address: stranger(90), username: "owner" }).allowed, true);
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
    fail(throttle, { address: `127.0.0.${index}`, local: true, username: "owner" });
  }
  assert.equal(throttle.begin({ address: "127.44.55.66", local: true, username: "owner" }).scope, "address+username");
  assert.equal(throttle.begin({ address: "0:0:0:0:0:0:0:1", local: true, username: "owner" }).scope, "address+username");
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
  // Three tables of failures and one of remembered addresses, 50 keys each.
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

test("the single-key limiter used for server passphrases allows five failures per window", () => {
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

  now.advance(15 * MINUTE);
  assert.equal(throttle.begin(key).allowed, true);
});

test("waits are described in words a person can act on", () => {
  assert.equal(describeWait(1), "1 second");
  assert.equal(describeWait(45), "45 seconds");
  assert.equal(describeWait(89), "89 seconds");
  assert.equal(describeWait(90), "2 minutes");
  assert.equal(describeWait(300), "5 minutes");
  assert.equal(describeWait(841), "15 minutes");
  assert.equal(describeWait(900), "15 minutes");
});

test("an address can be remembered without a login, as the owner's is at first run", () => {
  const now = clock();
  const throttle = createLoginThrottle({ now });
  throttle.remember({ address: "203.0.113.50", username: " Owner " });

  for (let index = 1; index <= 12; index += 1) {
    const result = throttle.begin({ address: stranger(index), username: "owner" });
    if (result.allowed) {
      result.failed();
    }
  }
  assert.equal(throttle.begin({ address: stranger(99), username: "owner" }).scope, "username");
  assert.equal(throttle.begin({ address: "203.0.113.50", username: "owner" }).allowed, true);
  // Remembered for that account only.
  assert.equal(throttle.begin({ address: "203.0.113.50", username: "lane" }).allowed, true);
  now.advance(31 * 24 * 60 * MINUTE);
  for (let index = 1; index <= 12; index += 1) {
    const result = throttle.begin({ address: stranger(index), username: "owner" });
    if (result.allowed) {
      result.failed();
    }
  }
  assert.equal(throttle.begin({ address: "203.0.113.50", username: "owner" }).scope, "username");
});
