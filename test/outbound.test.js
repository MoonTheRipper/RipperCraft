const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");
const { Readable, Writable } = require("node:stream");
const {
  MAX_REDIRECTS,
  createOutbound,
  httpsTransport,
  isPublicAddress,
  resolveDownloadLimitBytes
} = require("../src/lib/outbound");
const { PUBLIC_ADDRESS, scriptedOutbound } = require("../test-support/outbound");

const OTHER_PUBLIC_ADDRESS = "151.101.1.69";

function collector() {
  const chunks = [];
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });
  sink.contents = () => Buffer.concat(chunks);
  return sink;
}

// --- which addresses are public ---------------------------------------------------------

const NOT_PUBLIC = {
  "carrier-grade NAT, where Tailscale lives": ["100.64.0.1", "100.100.100.100", "100.127.255.254"],
  "documentation and benchmarking": ["192.0.2.1", "198.51.100.7", "203.0.113.9", "198.18.0.1", "198.19.255.254", "2001:db8::1", "3fff::1"],
  "link-local": ["169.254.0.1", "169.254.169.254", "fe80::1", "fe80::1%eth0", "febf::1"],
  "loopback": ["127.0.0.1", "127.0.0.53", "127.255.255.254", "::1", "0:0:0:0:0:0:0:1"],
  "multicast and reserved": ["224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255", "ff02::1", "ff05::2"],
  "private (RFC 1918)": ["10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.178.1"],
  "protocol assignments and relays": ["192.0.0.1", "192.88.99.1", "2001::1", "2001:0:4136:e378::1", "2002:7f00:1::1", "2002:c0a8:101::1", "100::1"],
  "unique local (fc00::/7)": ["fc00::1", "fd00::1", "fd7a:115c:a1e0::1", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
  "unspecified": ["0.0.0.0", "0.1.2.3", "::", "0:0:0:0:0:0:0:0"]
};

test("addresses on this machine or a private network are not public", () => {
  for (const [kind, addresses] of Object.entries(NOT_PUBLIC)) {
    for (const address of addresses) {
      assert.equal(isPublicAddress(address), false, `${kind}: ${address}`);
    }
  }
});

test("an IPv4 address written inside an IPv6 one is judged as the IPv4 address", () => {
  const ipv4 = Object.values(NOT_PUBLIC)
    .flat()
    .filter((address) => net.isIPv4(address));
  assert.ok(ipv4.length > 20);
  for (const address of ipv4) {
    const [a, b, c, d] = address.split(".").map(Number);
    const hex = `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    // Mapped, in both spellings; through NAT64; and the old "compatible" form.
    for (const wrapped of [`::ffff:${address}`, `::ffff:${hex}`, `0:0:0:0:0:ffff:${hex}`, `64:ff9b::${address}`, `64:ff9b::${hex}`, `::${address}`]) {
      assert.equal(isPublicAddress(wrapped), false, wrapped);
    }
  }
  // The same wrappers around a public address are as public as it is - except
  // the "compatible" form, which nothing has used in twenty years.
  assert.equal(isPublicAddress("::ffff:8.8.8.8"), true);
  assert.equal(isPublicAddress("::ffff:808:808"), true);
  assert.equal(isPublicAddress("64:ff9b::8.8.8.8"), true);
  assert.equal(isPublicAddress("::8.8.8.8"), false);
});

test("ordinary internet addresses are public, including ones next to a private range", () => {
  const publicAddresses = [
    "1.1.1.1",
    "8.8.8.8",
    "93.184.215.14",
    "9.255.255.255",
    "11.0.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "126.255.255.255",
    "128.0.0.1",
    "169.253.255.255",
    "169.255.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "192.167.255.255",
    "192.169.0.1",
    "198.17.255.255",
    "198.20.0.1",
    "223.255.255.254",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "2a00:1450:4001:81b::200e",
    "2001:200::1",
    "2003::1",
    "3ffe::1"
  ];
  for (const address of publicAddresses) {
    assert.equal(isPublicAddress(address), true, address);
  }
});

test("anything that is not an address is not public", () => {
  for (const value of ["", "example.com", "localhost", "1.2.3", "1.2.3.4.5", "01.2.3.4", "0x7f.0.0.1", "127.0.0.1.", " 8.8.8.8", "8.8.8.8 ", "[::1]", "::1/128", null, undefined, {}, 2130706433]) {
    assert.equal(isPublicAddress(value), false, JSON.stringify(value));
  }
});

test("the address check agrees with Node's own block list over every range it names", () => {
  // The same ranges, written a second time in a different form and checked by
  // a different piece of code, over addresses spread across all of IPv4.
  const blocked = new net.BlockList();
  for (const [range, prefix] of [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
    ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]
  ]) {
    blocked.addSubnet(range, prefix, "ipv4");
  }
  let checked = 0;
  for (let a = 0; a < 256; a += 1) {
    for (const b of [0, 1, 15, 16, 31, 32, 51, 63, 64, 88, 100, 127, 128, 167, 168, 169, 253, 254, 255]) {
      for (const c of [0, 2, 99, 100, 113, 255]) {
        const address = `${a}.${b}.${c}.7`;
        assert.equal(isPublicAddress(address), !blocked.check(address, "ipv4"), address);
        checked += 1;
      }
    }
  }
  assert.equal(checked, 256 * 19 * 6);
});

// --- which addresses may be asked for at all ------------------------------------------------

test("only https addresses are accepted, and none with a user name in it", () => {
  const { outbound } = scriptedOutbound();
  assert.equal(outbound.parseAddress(" https://cdn.example/mods/a.jar ").href, "https://cdn.example/mods/a.jar");
  assert.equal(outbound.parseAddress("HTTPS://CDN.Example:8443/a.jar?x=1").href, "https://cdn.example:8443/a.jar?x=1");

  for (const address of [
    "http://cdn.example/a.jar",
    "ftp://cdn.example/a.jar",
    "file:///etc/passwd",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "gopher://cdn.example/",
    "ws://cdn.example/",
    "//cdn.example/a.jar",
    "cdn.example/a.jar",
    "/etc/passwd",
    "",
    "   ",
    "https://",
    "https://user:secret@cdn.example/a.jar",
    "https://user@cdn.example/a.jar",
    {},
    null,
    undefined,
    ["https://cdn.example/a.jar", "x"]
  ]) {
    assert.throws(() => outbound.parseAddress(address), { statusCode: 400 }, JSON.stringify(address));
  }
});

// --- where a request is allowed to go ------------------------------------------------------------

test("an address that is not public is refused before anything is connected to", async () => {
  const literals = [
    "https://127.0.0.1/a.jar",
    "https://127.0.0.1:8443/a.jar",
    "https://2130706433/a.jar",
    "https://0x7f.1/a.jar",
    "https://017700000001/a.jar",
    "https://127.1/a.jar",
    "https://0.0.0.0/a.jar",
    "https://10.0.0.5/a.jar",
    "https://172.20.1.1/a.jar",
    "https://192.168.178.1/a.jar",
    "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/a.jar",
    "https://100.100.100.100/a.jar",
    "https://[::1]/a.jar",
    "https://[::]/a.jar",
    "https://[::ffff:127.0.0.1]/a.jar",
    "https://[::ffff:7f00:1]/a.jar",
    "https://[::ffff:10.0.0.5]/a.jar",
    "https://[fd7a:115c:a1e0::1]/a.jar",
    "https://[fe80::1]/a.jar",
    "https://[ff02::1]/a.jar",
    "https://224.0.0.1/a.jar"
  ];
  for (const address of literals) {
    const { calls, lookups, outbound } = scriptedOutbound({ respond: () => ({ body: "reached" }) });
    await assert.rejects(outbound.fetchBuffer(address), { message: /private network/, statusCode: 400 }, address);
    let opened = 0;
    await assert.rejects(outbound.download(address, () => ((opened += 1), collector())), { statusCode: 400 }, address);
    // Nothing was created to hold a download that was never going to start.
    assert.equal(opened, 0, address);
    assert.deepEqual(calls, [], address);
    // An address needs no looking up.
    assert.deepEqual(lookups, [], address);
  }
});

test("a name that resolves to an address that is not public is refused", async () => {
  const names = {
    "intranet.example": ["192.168.1.20"],
    "localhost.example": ["127.0.0.1"],
    "metadata.example": ["169.254.169.254"],
    "tailnet.example": ["100.101.102.103"],
    "v6-local.example": ["fd00::5"],
    "v6-loopback.example": ["::1"],
    "v6-mapped.example": ["::ffff:10.1.1.1"],
    // One public address does not make up for a private one beside it.
    "mixed.example": [PUBLIC_ADDRESS, "10.0.0.9"],
    "mixed-v6.example": ["2606:4700:4700::1111", "::1"]
  };
  for (const hostname of Object.keys(names)) {
    const { calls, lookups, outbound } = scriptedOutbound({ addresses: names, respond: () => ({ body: "reached" }) });
    await assert.rejects(outbound.fetchBuffer(`https://${hostname}/a.jar`), { message: /private network/, statusCode: 400 }, hostname);
    assert.deepEqual(lookups, [hostname]);
    assert.deepEqual(calls, [], hostname);
  }
});

test("a name that does not resolve is an error, not a connection", async () => {
  const { calls, outbound } = scriptedOutbound({ respond: () => ({ body: "reached" }) });
  await assert.rejects(outbound.fetchBuffer("https://no-such-host.example/a.jar"), { message: /could not be found/, statusCode: 502 });
  assert.deepEqual(calls, []);
});

test("the connection is made to the address that was checked, and the name is not looked up again", async () => {
  // A resolver that changes its answer: public when asked the first time, this
  // machine every time after. Checking one answer and connecting with another
  // is how a rebinding attack gets through.
  const answers = [];
  const { calls, lookups, outbound } = scriptedOutbound({
    addresses: (hostname, count) => {
      const answer = count === 1 ? [PUBLIC_ADDRESS] : ["127.0.0.1"];
      answers.push(answer[0]);
      return answer;
    },
    respond: () => ({ body: "the file" })
  });

  const buffer = await outbound.fetchBuffer("https://rebind.example/a.jar");
  assert.equal(buffer.toString(), "the file");
  assert.deepEqual(lookups, ["rebind.example"]);
  assert.deepEqual(calls.map((call) => call.address), [PUBLIC_ADDRESS]);
  // The request still names the host: for the certificate and the Host header.
  assert.equal(calls[0].url, "https://rebind.example/a.jar");

  // And when it is looked up again, for a second request, the new answer is
  // checked like the first was.
  await assert.rejects(outbound.fetchBuffer("https://rebind.example/a.jar"), { statusCode: 400 });
  assert.deepEqual(answers, [PUBLIC_ADDRESS, "127.0.0.1"]);
  assert.equal(calls.length, 1);
});

test("when the first address cannot be reached the next one is tried, and only checked ones", async () => {
  const { calls, outbound } = scriptedOutbound({
    addresses: { "two.example": ["2606:4700:4700::1111", PUBLIC_ADDRESS] },
    respond: ({ address }) => {
      if (address.includes(":")) {
        throw Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
      }
      return { body: "over IPv4" };
    }
  });
  assert.equal((await outbound.fetchBuffer("https://two.example/a.jar")).toString(), "over IPv4");
  assert.deepEqual(calls.map((call) => call.address), ["2606:4700:4700::1111", PUBLIC_ADDRESS]);

  // A certificate that does not match is not a reason to try elsewhere.
  const strict = scriptedOutbound({
    addresses: { "two.example": [PUBLIC_ADDRESS, OTHER_PUBLIC_ADDRESS] },
    respond: () => {
      throw Object.assign(new Error("Hostname/IP does not match certificate's altnames"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    }
  });
  await assert.rejects(strict.outbound.fetchBuffer("https://two.example/a.jar"), { message: /certificate/, statusCode: 502 });
  assert.equal(strict.calls.length, 1);
});

// --- redirects ---------------------------------------------------------------------------------------

test("redirects are followed by hand, and each new address is checked like the first", async () => {
  const addresses = {
    "cdn.example": [OTHER_PUBLIC_ADDRESS],
    "internal.example": ["10.0.0.5"],
    "start.example": [PUBLIC_ADDRESS]
  };
  const redirectTo = (location) => ({ addresses, respond: ({ url }) => (url.hostname === "start.example" ? { headers: { location }, status: 302 } : { body: "the file" }) });

  // Somewhere public: followed, and connected to at its own checked address.
  const followed = scriptedOutbound(redirectTo("https://cdn.example/files/a.jar"));
  assert.equal((await followed.outbound.fetchBuffer("https://start.example/a.jar")).toString(), "the file");
  assert.deepEqual(followed.calls.map((call) => [call.url, call.address]), [
    ["https://start.example/a.jar", PUBLIC_ADDRESS],
    ["https://cdn.example/files/a.jar", OTHER_PUBLIC_ADDRESS]
  ]);
  assert.deepEqual(followed.lookups, ["start.example", "cdn.example"]);

  // A relative one is resolved against where it came from.
  const relative = scriptedOutbound({
    addresses,
    respond: ({ url }) => (url.pathname === "/a.jar" ? { headers: { location: "../mirror/b.jar?x=1" }, status: 307 } : { body: url.href })
  });
  assert.equal((await relative.outbound.fetchBuffer("https://start.example/a.jar")).toString(), "https://start.example/mirror/b.jar?x=1");

  // Anywhere that is not public, or not https: refused, and never connected to.
  const refusedTargets = [
    "https://internal.example/secret",
    "https://127.0.0.1/secret",
    "https://[::1]/secret",
    "https://169.254.169.254/latest/meta-data/",
    "https://100.64.0.1/secret",
    "http://cdn.example/a.jar",
    "http://127.0.0.1/secret",
    "file:///etc/passwd",
    "ftp://cdn.example/a.jar",
    "//127.0.0.1/secret",
    "https://user:pass@cdn.example/a.jar"
  ];
  for (const location of refusedTargets) {
    const refused = scriptedOutbound(redirectTo(location));
    await assert.rejects(refused.outbound.fetchBuffer("https://start.example/a.jar"), { statusCode: 400 }, location);
    assert.deepEqual(refused.calls.map((call) => call.url), ["https://start.example/a.jar"], location);
  }
});

test("at most five redirects are followed", async () => {
  const hops = (count) =>
    scriptedOutbound({
      addresses: () => [PUBLIC_ADDRESS],
      respond: ({ url }) => {
        const step = Number(url.pathname.slice(1));
        return step < count ? { headers: { location: `https://hop${step + 1}.example/${step + 1}` }, status: 301 } : { body: `arrived after ${step}` };
      }
    });

  assert.equal(MAX_REDIRECTS, 5);
  const five = hops(5);
  assert.equal((await five.outbound.fetchBuffer("https://hop0.example/0")).toString(), "arrived after 5");
  assert.equal(five.calls.length, 6);

  const six = hops(6);
  await assert.rejects(six.outbound.fetchBuffer("https://hop0.example/0"), { message: /redirected more than 5 times/, statusCode: 502 });
  assert.equal(six.calls.length, 6);

  const loop = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: ({ url }) => ({ headers: { location: url.href }, status: 302 }) });
  await assert.rejects(loop.outbound.fetchBuffer("https://loop.example/"), { message: /redirected more than 5 times/ });
  assert.equal(loop.calls.length, 6);

  const nowhere = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: () => ({ status: 302 }) });
  await assert.rejects(nowhere.outbound.fetchBuffer("https://nowhere.example/"), { message: /leads nowhere/ });
});

test("a caller's headers go to the host they were meant for, not along with a redirect", async () => {
  const { calls, outbound } = scriptedOutbound({
    addresses: () => [PUBLIC_ADDRESS],
    respond: ({ url }) => {
      if (url.pathname === "/start") return { headers: { location: "/same-host" }, status: 302 };
      if (url.pathname === "/same-host") return { headers: { location: "https://elsewhere.example/end" }, status: 302 };
      return { body: "{}" };
    }
  });
  await outbound.fetchJson("https://api.example/start", { headers: { Accept: "application/json", "x-api-key": "the-owner's-key" } });

  assert.deepEqual(calls.map((call) => [new URL(call.url).host, call.headers["x-api-key"]]), [
    ["api.example", "the-owner's-key"],
    ["api.example", "the-owner's-key"],
    ["elsewhere.example", undefined]
  ]);
  for (const call of calls) {
    assert.match(call.headers["User-Agent"], /^RipperCraft/);
    assert.equal(call.headers["Accept-Encoding"], "identity");
  }
});

// --- how much, and for how long ------------------------------------------------------------------------

test("a response that declares more than the limit is refused without being read", async () => {
  let read = 0;
  const body = new Readable({
    read() {
      read += 1;
      this.push(Buffer.alloc(64 * 1024));
    }
  });
  const { outbound } = scriptedOutbound({
    addresses: () => [PUBLIC_ADDRESS],
    respond: () => ({ body, headers: { "content-length": String(50 * 1024 * 1024) } })
  });
  await assert.rejects(outbound.fetchBuffer("https://big.example/a.jar", { maxBytes: 1024 * 1024 }), {
    message: /larger than the 1 MB limit/,
    statusCode: 413
  });
  assert.ok(read <= 2, `${read} reads`);
  assert.equal(body.destroyed, true);
});

test("a response that goes past the limit without saying so is cut off there", async () => {
  let produced = 0;
  const endless = () =>
    new Readable({
      read() {
        produced += 64 * 1024;
        this.push(Buffer.alloc(64 * 1024, 1));
      }
    });
  const { outbound } = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: () => ({ body: endless() }) });

  await assert.rejects(outbound.fetchBuffer("https://endless.example/a.jar", { maxBytes: 1024 * 1024 }), { statusCode: 413 });
  // It stopped reading shortly after the limit rather than draining the source.
  assert.ok(produced < 4 * 1024 * 1024, `${produced} bytes were produced`);

  produced = 0;
  const sink = collector();
  await assert.rejects(outbound.download("https://endless.example/a.jar", () => sink, { maxBytes: 512 * 1024 }), { statusCode: 413 });
  assert.ok(sink.contents().length <= 512 * 1024);
  assert.equal(sink.destroyed, true);
});

test("a compressed response is measured by what it unpacks to", async () => {
  // 20 MB of zeros in about 20 KB.
  const packed = zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024));
  assert.ok(packed.length < 100_000);
  const { outbound } = scriptedOutbound({
    addresses: () => [PUBLIC_ADDRESS],
    respond: () => ({ body: packed, headers: { "content-encoding": "gzip", "content-length": String(packed.length) } })
  });
  await assert.rejects(outbound.fetchBuffer("https://gzip.example/a.json", { maxBytes: 1024 * 1024 }), { statusCode: 413 });

  // One that fits is unpacked and handed over.
  const small = scriptedOutbound({
    addresses: () => [PUBLIC_ADDRESS],
    respond: () => ({ body: zlib.gzipSync('{"ok":true}'), headers: { "content-encoding": "gzip" } })
  });
  assert.deepEqual(await small.outbound.fetchJson("https://gzip.example/a.json"), { ok: true });
  const brotli = scriptedOutbound({
    addresses: () => [PUBLIC_ADDRESS],
    respond: () => ({ body: zlib.brotliCompressSync('{"ok":"br"}'), headers: { "content-encoding": "br" } })
  });
  assert.deepEqual(await brotli.outbound.fetchJson("https://br.example/a.json"), { ok: "br" });
  const unknown = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: () => ({ body: "x", headers: { "content-encoding": "zstd" } }) });
  await assert.rejects(unknown.outbound.fetchBuffer("https://zstd.example/"), { statusCode: 502 });
});

test("a server that never answers, or stops part-way, is given up on", async () => {
  // Never sends headers: the transport is waiting until it is told to stop.
  const silent = scriptedOutbound({
    addresses: () => [PUBLIC_ADDRESS],
    respond: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      })
  });
  const startedAt = Date.now();
  await assert.rejects(silent.outbound.fetchBuffer("https://silent.example/a.jar", { timeoutMs: 150 }), {
    message: /did not answer in time/,
    statusCode: 504
  });
  assert.ok(Date.now() - startedAt < 3000);

  // Sends the headers and a first piece, then nothing.
  const stalled = scriptedOutbound({
    addresses: () => [PUBLIC_ADDRESS],
    respond: () => {
      let sent = false;
      return {
        body: new Readable({
          read() {
            if (!sent) {
              sent = true;
              this.push("the first part");
            }
          }
        })
      };
    }
  });
  const sink = collector();
  await assert.rejects(stalled.outbound.download("https://stalled.example/a.jar", () => sink, { timeoutMs: 150 }), {
    message: /did not finish in time/,
    statusCode: 504
  });
  assert.equal(sink.destroyed, true);
});

// --- what comes back ---------------------------------------------------------------------------------------

test("nothing the other end said is passed on when a request fails", async () => {
  const SECRET = "INTERNAL-ONLY-RESPONSE-BODY";
  for (const status of [400, 401, 403, 404, 418, 500, 503]) {
    const { outbound } = scriptedOutbound({
      addresses: () => [PUBLIC_ADDRESS],
      respond: () => ({ body: `<html>${SECRET}</html>`, headers: { "x-secret": SECRET }, status })
    });
    for (const call of [
      () => outbound.fetchBuffer("https://files.example/a.jar"),
      () => outbound.fetchText("https://files.example/a.txt"),
      () => outbound.fetchJson("https://files.example/a.json"),
      () => outbound.download("https://files.example/a.jar", () => collector())
    ]) {
      const error = await call().then(
        () => null,
        (caught) => caught
      );
      assert.ok(error, `HTTP ${status} was treated as a success`);
      assert.equal(error.statusCode, 502);
      // The status is kept, for callers that need to tell one from another.
      assert.equal(error.status, status);
      assert.match(error.message, new RegExp(`files\\.example answered with HTTP ${status}\\.$`));
      assert.equal(JSON.stringify({ ...error, message: error.message }).includes(SECRET), false);
    }
  }

  // An answer that was supposed to be JSON and is not.
  const { outbound } = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: () => ({ body: `not json ${SECRET}` }) });
  const error = await outbound.fetchJson("https://files.example/a.json").catch((caught) => caught);
  assert.equal(error.statusCode, 502);
  assert.equal(error.message.includes(SECRET), false);
});

test("get() hands back any status, for callers that read it themselves", async () => {
  const { outbound } = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: () => ({ body: '{"error":"no such player"}', status: 404 }) });
  const response = await outbound.get("https://api.example/users/nobody");
  assert.equal(response.status, 404);
  assert.equal(response.buffer.toString(), '{"error":"no such player"}');
});

test("a download is written to the sink as it arrives", async () => {
  const pieces = Array.from({ length: 40 }, (_unused, index) => Buffer.alloc(32 * 1024, index));
  const { outbound } = scriptedOutbound({ addresses: () => [PUBLIC_ADDRESS], respond: () => ({ body: Readable.from(pieces) }) });
  const sink = collector();
  assert.equal(await outbound.download("https://files.example/big.jar", () => sink), 40 * 32 * 1024);
  assert.ok(sink.contents().equals(Buffer.concat(pieces)));
});

// --- the real connection ---------------------------------------------------------------------------------------

// A certificate for pinned.test, made on the spot. The name does not exist in
// DNS, so the only way to reach the server below is to be told its address.
function makeCertificate(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "rippercraft-tls-"));
  t.after(() => fsp.rm(directory, { force: true, recursive: true }));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", path.join(directory, "key.pem"), "-out", path.join(directory, "cert.pem"),
        "-days", "2", "-subj", "/CN=pinned.test", "-addext", "subjectAltName=DNS:pinned.test"
      ],
      { stdio: "ignore" }
    );
  } catch {
    return null;
  }
  return { cert: fs.readFileSync(path.join(directory, "cert.pem")), key: fs.readFileSync(path.join(directory, "key.pem")) };
}

test("the real transport connects to the address it is given and checks the certificate against the name", async (t) => {
  const certificate = makeCertificate(t);
  if (!certificate) {
    t.skip("openssl is not available to make a certificate");
    return;
  }
  const seen = [];
  const server = https.createServer(certificate, (request, response) => {
    seen.push({ host: request.headers.host, servername: request.socket.servername, url: request.url, userAgent: request.headers["user-agent"] });
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("served by the pinned address");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const read = async (response) => {
    const chunks = [];
    for await (const chunk of response.body) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString();
  };
  const request = (url, extra = {}) =>
    httpsTransport({
      address: "127.0.0.1",
      family: 4,
      headers: { "User-Agent": "test" },
      idleTimeoutMs: 5000,
      signal: AbortSignal.timeout(5000),
      tls: { ca: certificate.cert },
      url: new URL(url),
      ...extra
    });

  // pinned.test resolves nowhere; the connection goes where it was told to.
  const response = await request(`https://pinned.test:${port}/files/a.jar?x=1`);
  assert.equal(response.status, 200);
  assert.equal(await read(response), "served by the pinned address");
  assert.deepEqual(seen, [{ host: `pinned.test:${port}`, servername: "pinned.test", url: "/files/a.jar?x=1", userAgent: "test" }]);

  // The same server under another name: its certificate is not for that name.
  await assert.rejects(request(`https://other.test:${port}/`), /altnames|certificate/i);
  // And a certificate nobody vouches for is not trusted just because it matches.
  await assert.rejects(request(`https://pinned.test:${port}/`, { tls: {} }), /self.signed|certificate/i);
  assert.equal(seen.length, 1);

  // Through the whole fetcher, with only the name lookup replaced.
  const outbound = createOutbound({
    lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    transport: (options) => httpsTransport({ ...options, tls: { ca: certificate.cert } })
  });
  // ...which refuses, because the address it resolved to is this machine.
  await assert.rejects(outbound.fetchBuffer(`https://pinned.test:${port}/`), { statusCode: 400 });
  assert.equal(seen.length, 1);
});

test("a connection that goes quiet is dropped", async (t) => {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) {
      socket.destroy();
    }
    return new Promise((resolve) => server.close(resolve));
  });

  // Accepts the connection and never completes the TLS handshake.
  const startedAt = Date.now();
  await assert.rejects(
    httpsTransport({
      address: "127.0.0.1",
      family: 4,
      headers: {},
      idleTimeoutMs: 200,
      signal: AbortSignal.timeout(5000),
      url: new URL(`https://quiet.test:${server.address().port}/`)
    }),
    { code: "ETIMEDOUT" }
  );
  assert.ok(Date.now() - startedAt < 3000);
});

// --- settings ------------------------------------------------------------------------------------------------------

test("the download limit comes from RIPPERCRAFT_MAX_DOWNLOAD_MB, and defaults to 1 GB", (t) => {
  const saved = process.env.RIPPERCRAFT_MAX_DOWNLOAD_MB;
  t.after(() => {
    if (saved === undefined) {
      delete process.env.RIPPERCRAFT_MAX_DOWNLOAD_MB;
    } else {
      process.env.RIPPERCRAFT_MAX_DOWNLOAD_MB = saved;
    }
  });
  const megabyte = 1024 * 1024;
  delete process.env.RIPPERCRAFT_MAX_DOWNLOAD_MB;
  assert.equal(resolveDownloadLimitBytes(), 1024 * megabyte);
  process.env.RIPPERCRAFT_MAX_DOWNLOAD_MB = "64";
  assert.equal(resolveDownloadLimitBytes(), 64 * megabyte);
  const warnings = [];
  for (const value of ["0", "-1", "plenty"]) {
    process.env.RIPPERCRAFT_MAX_DOWNLOAD_MB = value;
    assert.equal(resolveDownloadLimitBytes({ warn: (message) => warnings.push(message) }), 1024 * megabyte);
  }
  assert.equal(warnings.length, 3);
});
