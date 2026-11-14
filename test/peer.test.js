const test = require("node:test");
const assert = require("node:assert/strict");
const {
  addressBucket,
  clientAddress,
  isHttpsRequest,
  isLoopbackAddress,
  isPrivateAddress,
  normalizeAddress
} = require("../src/lib/peer");

function fakeRequest(remoteAddress, headers = {}, socket = {}) {
  return { headers, socket: { remoteAddress, ...socket } };
}

test("addresses are normalised to one spelling each", () => {
  assert.equal(normalizeAddress("203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeAddress("  203.0.113.7 "), "203.0.113.7");
  // An IPv4 client seen through a dual-stack socket is the same client.
  assert.equal(normalizeAddress("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normalizeAddress("::FFFF:CB00:7107"), "203.0.113.7");
  assert.equal(normalizeAddress("2001:db8::1"), "2001:db8:0:0:0:0:0:1");
  assert.equal(normalizeAddress("2001:0DB8:0000:0000:0000:0000:0000:0001"), "2001:db8:0:0:0:0:0:1");
  assert.equal(normalizeAddress("::1"), "0:0:0:0:0:0:0:1");
  assert.equal(normalizeAddress("::"), "0:0:0:0:0:0:0:0");
  assert.equal(normalizeAddress("fe80::1%eth0"), "fe80:0:0:0:0:0:0:1");
  // Forms some proxies use for forwarded addresses.
  assert.equal(normalizeAddress("203.0.113.7:51234"), "203.0.113.7");
  assert.equal(normalizeAddress("[2001:db8::1]:51234"), "2001:db8:0:0:0:0:0:1");
  assert.equal(normalizeAddress("[2001:db8::1]"), "2001:db8:0:0:0:0:0:1");

  for (const junk of ["", null, undefined, "unknown", "localhost", "999.1.1.1", "1.2.3", "2001:db8::g", "a, b", "<script>"]) {
    assert.equal(normalizeAddress(junk), null, String(junk));
  }
});

test("loopback and private ranges are recognised", () => {
  for (const address of ["127.0.0.1", "127.8.9.10", normalizeAddress("::1"), normalizeAddress("::ffff:127.0.0.1")]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["128.0.0.1", "10.0.0.1", "203.0.113.7", normalizeAddress("::2"), normalizeAddress("2001:db8::1"), null]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }

  for (const address of [
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.254",
    "192.168.1.20",
    "169.254.10.10",
    "100.64.0.1",
    "100.127.255.254",
    normalizeAddress("fd12:3456::1"),
    normalizeAddress("fe80::1")
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of [
    "172.15.0.1",
    "172.32.0.1",
    "192.169.1.1",
    "100.63.255.255",
    "100.128.0.1",
    "8.8.8.8",
    "203.0.113.7",
    normalizeAddress("2001:db8::1"),
    normalizeAddress("fec0::1"),
    null
  ]) {
    assert.equal(isPrivateAddress(address), false, String(address));
  }
});

test("IPv6 addresses are counted per /64, IPv4 addresses one by one", () => {
  const first = addressBucket(normalizeAddress("2001:db8:aaaa:bbbb::1"));
  const sameNetwork = addressBucket(normalizeAddress("2001:db8:aaaa:bbbb:ffff:ffff:ffff:ffff"));
  const otherNetwork = addressBucket(normalizeAddress("2001:db8:aaaa:bbbc::1"));
  assert.equal(first, "2001:db8:aaaa:bbbb::/64");
  assert.equal(sameNetwork, first);
  assert.notEqual(otherNetwork, first);

  assert.equal(addressBucket("203.0.113.7"), "203.0.113.7");
  assert.notEqual(addressBucket("203.0.113.8"), addressBucket("203.0.113.7"));
  assert.equal(addressBucket(null), "unknown");

  // A local program can connect from any of sixteen million loopback addresses.
  for (const loopback of ["127.0.0.1", "127.0.0.2", "127.200.30.4", normalizeAddress("::1"), normalizeAddress("::ffff:127.9.9.9")]) {
    assert.equal(addressBucket(loopback), "loopback", loopback);
  }
});

test("forwarding headers are believed only when the socket peer is loopback", () => {
  const spoofed = { "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "198.51.100.2" };

  // A LAN machine, or anyone reaching the port directly, cannot pick its address.
  assert.deepEqual(clientAddress(fakeRequest("192.168.1.20", spoofed)), {
    address: "192.168.1.20",
    forwarded: false,
    local: true
  });
  assert.deepEqual(clientAddress(fakeRequest("203.0.113.7", spoofed)), {
    address: "203.0.113.7",
    forwarded: false,
    local: false
  });
  assert.deepEqual(clientAddress(fakeRequest("::ffff:192.168.1.20", spoofed)), {
    address: "192.168.1.20",
    forwarded: false,
    local: true
  });

  // The tunnel connects from loopback and names the visitor.
  for (const loopback of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.deepEqual(clientAddress(fakeRequest(loopback, { "cf-connecting-ip": "198.51.100.1" })), {
      address: "198.51.100.1",
      forwarded: true,
      local: false
    });
  }
});

test("CF-Connecting-IP wins over X-Forwarded-For, whose first hop is the fallback", () => {
  assert.equal(
    clientAddress(fakeRequest("127.0.0.1", { "cf-connecting-ip": "198.51.100.1", "x-forwarded-for": "203.0.113.99, 198.51.100.1" }))
      .address,
    "198.51.100.1"
  );
  assert.equal(
    clientAddress(fakeRequest("127.0.0.1", { "x-forwarded-for": "198.51.100.2, 10.0.0.1, 127.0.0.1" })).address,
    "198.51.100.2"
  );
  assert.equal(
    clientAddress(fakeRequest("127.0.0.1", { "cf-connecting-ip": "2001:db8::abcd" })).address,
    "2001:db8:0:0:0:0:0:abcd"
  );
  // A forwarded private address is not "local": only the socket can vouch for that.
  assert.deepEqual(clientAddress(fakeRequest("127.0.0.1", { "x-forwarded-for": "192.168.1.20" })), {
    address: "192.168.1.20",
    forwarded: true,
    local: false
  });
});

test("unusable forwarding headers fall back to the socket address", () => {
  assert.deepEqual(clientAddress(fakeRequest("127.0.0.1", {})), { address: "127.0.0.1", forwarded: false, local: true });
  assert.deepEqual(clientAddress(fakeRequest("127.0.0.1", { "cf-connecting-ip": "not-an-address", "x-forwarded-for": "unknown" })), {
    address: "127.0.0.1",
    forwarded: false,
    local: true
  });
  // A junk first header does not hide a usable second one.
  assert.equal(
    clientAddress(fakeRequest("127.0.0.1", { "cf-connecting-ip": "", "x-forwarded-for": "198.51.100.2" })).address,
    "198.51.100.2"
  );
  // A socket that has already gone away has no address at all.
  assert.deepEqual(clientAddress(fakeRequest(undefined, { "cf-connecting-ip": "198.51.100.1" })), {
    address: "unknown",
    forwarded: false,
    local: false
  });
  assert.deepEqual(clientAddress({ headers: {} }), { address: "unknown", forwarded: false, local: false });
});

test("HTTPS is taken from a loopback proxy's headers and from nobody else's", () => {
  assert.equal(isHttpsRequest(fakeRequest("127.0.0.1", { "x-forwarded-proto": "https" })), true);
  assert.equal(isHttpsRequest(fakeRequest("127.0.0.1", { "x-forwarded-proto": "HTTPS, http" })), true);
  assert.equal(isHttpsRequest(fakeRequest("::1", { "cf-visitor": '{"scheme":"https"}' })), true);
  assert.equal(isHttpsRequest(fakeRequest("127.0.0.1", { "cf-visitor": '{"scheme":"https"}', "x-forwarded-proto": "http" })), true);

  assert.equal(isHttpsRequest(fakeRequest("127.0.0.1", {})), false);
  assert.equal(isHttpsRequest(fakeRequest("127.0.0.1", { "x-forwarded-proto": "http" })), false);
  assert.equal(isHttpsRequest(fakeRequest("127.0.0.1", { "cf-visitor": '{"scheme":"http"}' })), false);
  assert.equal(isHttpsRequest(fakeRequest("127.0.0.1", { "cf-visitor": "{not json" })), false);
  assert.equal(isHttpsRequest(fakeRequest("127.0.0.1", { "cf-visitor": "null" })), false);

  // Plain HTTP on the LAN stays plain, whatever the request claims.
  assert.equal(isHttpsRequest(fakeRequest("192.168.1.20", { "x-forwarded-proto": "https" })), false);
  assert.equal(isHttpsRequest(fakeRequest("192.168.1.20", { "cf-visitor": '{"scheme":"https"}' })), false);
  assert.equal(isHttpsRequest(fakeRequest("203.0.113.7", { "x-forwarded-proto": "https" })), false);

  // A socket that really is TLS needs no header.
  assert.equal(isHttpsRequest(fakeRequest("192.168.1.20", {}, { encrypted: true })), true);
});
