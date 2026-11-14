const net = require("node:net");

// Who is on the other end of a request, and whether they reached us over HTTPS.
//
// The dashboard is reached two ways at once: directly, by machines on the LAN,
// and through a tunnel or reverse proxy running on this machine, which connects
// from loopback and describes the real visitor in request headers. Those
// headers are only believed when the socket peer is loopback. Anyone on the
// network can type "CF-Connecting-IP: 1.2.3.4" into a request of their own.

// The eight 16-bit groups of an address that net.isIP has already accepted.
function ipv6Groups(address) {
  let text = address.toLowerCase();

  // A dotted quad in the last 32 bits, as in ::ffff:192.0.2.1.
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const [a, b, c, d] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, rest] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  if (rest === undefined) {
    return headGroups.map((group) => parseInt(group, 16));
  }
  const restGroups = rest ? rest.split(":") : [];
  const zeros = new Array(8 - headGroups.length - restGroups.length).fill("0");
  return [...headGroups, ...zeros, ...restGroups].map((group) => parseInt(group, 16));
}

// One canonical spelling per address, or null for anything that is not an IP
// address. An IPv4 client seen through a dual-stack socket (::ffff:a.b.c.d)
// comes out as plain IPv4, so it is one client however it arrived.
function normalizeAddress(value) {
  let text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) {
    return null;
  }

  // Some proxies write forwarded addresses with a port: [::1]:4300, 192.0.2.1:55000.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(text);
  if (bracketed) {
    text = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(text)) {
    text = text.slice(0, text.lastIndexOf(":"));
  }

  const zone = text.indexOf("%");
  if (zone !== -1) {
    text = text.slice(0, zone);
  }

  const family = net.isIP(text);
  if (family === 4) {
    return text;
  }
  if (family !== 6) {
    return null;
  }

  const groups = ipv6Groups(text);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`;
  }
  return groups.map((group) => group.toString(16)).join(":");
}

// Both of these take an address already passed through normalizeAddress.
function isLoopbackAddress(address) {
  if (!address) {
    return false;
  }
  return address.includes(":") ? address === "0:0:0:0:0:0:0:1" : address.startsWith("127.");
}

// Private, link-local and carrier-grade NAT ranges: addresses that cannot be
// reached from the internet at large.
function isPrivateAddress(address) {
  if (!address) {
    return false;
  }
  if (address.includes(":")) {
    const first = parseInt(address.split(":")[0], 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
  }
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

// What failed attempts are counted against: the address, except where one
// client has many to choose from. An IPv6 customer is handed a /64 or more, so
// counting single addresses would give one visitor 2^64 fresh starts. And any
// program on this machine can connect from every address in 127.0.0.0/8, so
// loopback counts as one.
function addressBucket(address) {
  if (!address) {
    return "unknown";
  }
  if (isLoopbackAddress(address)) {
    return "loopback";
  }
  if (!address.includes(":")) {
    return address;
  }
  return `${address.split(":").slice(0, 4).join(":")}::/64`;
}

function firstHeaderValue(value) {
  return String(Array.isArray(value) ? value[0] : value || "")
    .split(",")[0]
    .trim();
}

function socketPeer(req) {
  return normalizeAddress(req.socket && req.socket.remoteAddress);
}

// The visitor's address.
//
//   address    who failed attempts are counted against
//   forwarded  true when it came from a proxy header rather than the socket
//   local      true when the visitor connected to us directly from loopback or
//              a private range, with no proxy in between
//
// Behind Cloudflare, CF-Connecting-IP is set by Cloudflare and cannot be
// supplied by the visitor, so it is preferred. X-Forwarded-For is the fallback
// for other proxies; its first entry is only as trustworthy as the proxy, which
// must replace the header rather than append to one the visitor sent.
function clientAddress(req) {
  const peer = socketPeer(req);
  if (peer && isLoopbackAddress(peer)) {
    const forwarded =
      normalizeAddress(firstHeaderValue(req.headers["cf-connecting-ip"])) ||
      normalizeAddress(firstHeaderValue(req.headers["x-forwarded-for"]));
    if (forwarded) {
      return { address: forwarded, forwarded: true, local: false };
    }
  }
  return {
    address: peer || "unknown",
    forwarded: false,
    local: Boolean(peer) && (isLoopbackAddress(peer) || isPrivateAddress(peer))
  };
}

// True when the visitor's own connection was HTTPS: either this socket is TLS,
// or a proxy on loopback says the request reached it that way.
function isHttpsRequest(req) {
  if (req.socket && req.socket.encrypted) {
    return true;
  }
  if (!isLoopbackAddress(socketPeer(req))) {
    return false;
  }
  if (firstHeaderValue(req.headers["x-forwarded-proto"]).toLowerCase() === "https") {
    return true;
  }
  const visitor = req.headers["cf-visitor"];
  if (visitor) {
    try {
      return JSON.parse(Array.isArray(visitor) ? visitor[0] : visitor).scheme === "https";
    } catch {
      return false;
    }
  }
  return false;
}

module.exports = {
  addressBucket,
  clientAddress,
  isHttpsRequest,
  isLoopbackAddress,
  isPrivateAddress,
  normalizeAddress
};
