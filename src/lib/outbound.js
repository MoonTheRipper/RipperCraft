const dns = require("node:dns");
const https = require("node:https");
const net = require("node:net");
const zlib = require("node:zlib");
const { Transform, Writable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { HttpError, describeBytes } = require("./http");
const { readEnv } = require("./utils");

// Every request the dashboard makes to another machine goes through here.
//
// "Install from a URL" used to hand whatever an admin typed straight to
// fetch(). The dashboard sits inside the home network, so the address could be
// one only it can reach - a router's admin page, a service bound to loopback,
// another machine on the tailnet - and the answer was saved where the admin
// could read it back. Redirects were followed wherever they led.
//
// The rules here are the same for every caller, whether the address was typed
// by an admin or came out of Modrinth's API:
//
//   * https only.
//   * The host name is resolved first, and every address it resolves to has to
//     be a public one. Loopback, private, link-local, carrier-grade NAT
//     (which is where Tailscale lives), multicast, reserved and documentation
//     ranges are refused, for IPv4 and IPv6, including IPv4 written inside an
//     IPv6 address.
//   * The connection is then made to that address, not to the name. A name
//     looked up a second time could answer differently (DNS rebinding); it is
//     never looked up a second time.
//   * Redirects are followed by hand, at most five, and each new address goes
//     through all of the above again.
//   * There is a limit on how much is read and on how long it may take.
//   * What the other end said is never passed on. An error names the status
//     code and nothing else.

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_USER_AGENT = "RipperCraft/0.1 (https://github.com/MoonTheRipper/RipperCraft)";

// How long a connection may sit with nothing arriving, and how long a whole
// request - every redirect and the body - may take.
const IDLE_TIMEOUT_MS = 30_000;
const METADATA_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const LOOKUP_TIMEOUT_MS = 10_000;

// API answers and version lists are kilobytes; Forge's is the largest, at
// under a megabyte.
const METADATA_LIMIT_BYTES = 32 * 1024 * 1024;
// A server runtime held in memory before it is written: about 60 MB for
// vanilla, less for the others.
const RUNTIME_LIMIT_BYTES = 256 * 1024 * 1024;
// An add-on jar, streamed to disk. Most are a few megabytes; the largest in
// common use is under half a gigabyte.
const DEFAULT_DOWNLOAD_LIMIT_MB = 1024;

// Other addresses to try when the first one a name resolves to cannot be
// reached - a host with an IPv6 address on a machine with no IPv6 route.
const MAX_ADDRESSES_TRIED = 4;
const UNREACHABLE = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EADDRNOTAVAIL"]);

function refused(message) {
  return new HttpError(400, message);
}

function upstreamFailure(message, statusCode = 502) {
  return new HttpError(statusCode, message);
}

// --- which addresses are public ---------------------------------------------------

function parseIpv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const bytes = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part) || Number(part) > 255) {
      return null;
    }
    bytes.push(Number(part));
  }
  return bytes;
}

// The 16 bytes of an IPv6 address that net.isIPv6() has already accepted.
function parseIpv6(text) {
  const groupsOf = (part) => {
    if (part === "") {
      return [];
    }
    const groups = [];
    for (const piece of part.split(":")) {
      if (piece.includes(".")) {
        const quad = parseIpv4(piece);
        if (!quad) {
          return null;
        }
        groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3]);
      } else if (/^[0-9a-fA-F]{1,4}$/.test(piece)) {
        groups.push(parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return groups;
  };

  const gap = text.indexOf("::");
  const head = groupsOf(gap === -1 ? text : text.slice(0, gap));
  const tail = gap === -1 ? [] : groupsOf(text.slice(gap + 2));
  if (!head || !tail) {
    return null;
  }
  const missing = 8 - head.length - tail.length;
  if (gap === -1 ? missing !== 0 : missing < 1) {
    return null;
  }
  const groups = [...head, ...new Array(missing).fill(0), ...tail];
  return groups.flatMap((group) => [group >> 8, group & 0xff]);
}

function isPublicIpv4(bytes) {
  const [a, b, c] = bytes;
  return !(
    a === 0 || // "this network", and the unspecified address 0.0.0.0
    a === 10 || // private (RFC 1918)
    (a === 100 && (b & 0xc0) === 64) || // 100.64.0.0/10: carrier-grade NAT, and Tailscale
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local, where cloud metadata services sit
    (a === 172 && (b & 0xf0) === 16) || // private (RFC 1918)
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 relays
    (a === 192 && b === 168) || // private (RFC 1918)
    (a === 198 && (b & 0xfe) === 18) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224 // multicast, reserved, and broadcast
  );
}

function isPublicIpv6(bytes) {
  const zero = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  // An IPv4 address written as IPv6 (::ffff:a.b.c.d), or reached through NAT64
  // (64:ff9b::a.b.c.d), is as public as the IPv4 address inside it.
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPublicIpv4(bytes.slice(12));
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) {
    return isPublicIpv4(bytes.slice(12));
  }
  // Every address routed on the public internet is in 2000::/3. That leaves
  // out, without naming them, the unspecified address and loopback (::, ::1),
  // unique local addresses (fc00::/7), link-local (fe80::/10), multicast
  // (ff00::/8) and everything not yet assigned.
  if ((bytes[0] & 0xe0) !== 0x20) {
    return false;
  }
  return !(
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] < 0x02) || // 2001::/23: Teredo, benchmarking, ORCHID
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) || // 2001:db8::/32: documentation
    (bytes[0] === 0x20 && bytes[1] === 0x02) || // 2002::/16: 6to4, which wraps any IPv4 address
    (bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0) // 3fff::/20: documentation
  );
}

// Whether an address, as text, is one on the public internet. Anything that is
// not an address at all - a name, an address with a zone - is not.
function isPublicAddress(address) {
  const text = String(address);
  const family = net.isIP(text);
  if (family === 4) {
    const bytes = parseIpv4(text);
    return Boolean(bytes) && isPublicIpv4(bytes);
  }
  if (family === 6 && !text.includes("%")) {
    const bytes = parseIpv6(text);
    return Boolean(bytes) && isPublicIpv6(bytes);
  }
  return false;
}

// --- one request, to one address ------------------------------------------------------

// Makes a single GET to `address`, speaking TLS for the host name in `url`.
// The name is used for the certificate and the Host header only; nothing is
// resolved here. Resolves to { status, headers, body } as soon as the response
// headers arrive, with `body` a stream the caller must read or destroy.
function httpsTransport({ address, family, headers, idleTimeoutMs, signal, tls, url }) {
  return new Promise((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const request = https.request(
      {
        ...(tls || {}),
        // A connection of its own, so nothing is reused from an earlier host.
        agent: false,
        family,
        headers: { ...headers, Host: url.host },
        host: address,
        method: "GET",
        path: `${url.pathname}${url.search}`,
        port: url.port ? Number(url.port) : 443,
        // The certificate has to be for the name that was asked for. An address
        // typed in place of a name has no name to check.
        servername: net.isIP(hostname) ? undefined : hostname,
        signal
      },
      (response) => {
        resolve({ body: response, headers: response.headers, status: response.statusCode });
      }
    );
    request.setTimeout(idleTimeoutMs, () => {
      request.destroy(Object.assign(new Error("The connection went quiet."), { code: "ETIMEDOUT" }));
    });
    request.once("error", reject);
    request.end();
  });
}

function systemLookup(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

// The limit on an add-on download in bytes, from RIPPERCRAFT_MAX_DOWNLOAD_MB.
function resolveDownloadLimitBytes(logger) {
  const raw = readEnv("MAX_DOWNLOAD_MB");
  if (!raw) {
    return DEFAULT_DOWNLOAD_LIMIT_MB * 1024 * 1024;
  }
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    if (logger) {
      logger.warn("Ignoring MAX_DOWNLOAD_MB: it must be a positive number of megabytes", { value: raw });
    }
    return DEFAULT_DOWNLOAD_LIMIT_MB * 1024 * 1024;
  }
  return Math.floor(megabytes * 1024 * 1024);
}

// --- the fetcher -------------------------------------------------------------------------

function createOutbound(overrides = {}) {
  const lookup = overrides.lookup || systemLookup;
  const transport = overrides.transport || httpsTransport;
  const userAgent = overrides.userAgent || DEFAULT_USER_AGENT;
  const downloadLimitBytes = overrides.downloadLimitBytes || DEFAULT_DOWNLOAD_LIMIT_MB * 1024 * 1024;
  const idleTimeoutMs = overrides.idleTimeoutMs || IDLE_TIMEOUT_MS;

  // An address typed by somebody, or handed back by an API, as a URL this
  // module is willing to contact.
  function parseAddress(value) {
    let url = null;
    try {
      // Text, or a URL this code built. Nothing else is turned into an address.
      url = typeof value === "string" ? new URL(value.trim()) : value instanceof URL ? new URL(value.href) : null;
    } catch {
      url = null;
    }
    if (!url) {
      throw refused("That is not a web address the dashboard can download from.");
    }
    if (url.protocol !== "https:") {
      throw refused("Only https:// addresses can be downloaded from.");
    }
    if (url.username || url.password) {
      throw refused("An address with a user name or password in it cannot be downloaded from.");
    }
    return url;
  }

  // The addresses a host name stands for, all of them public, or a refusal.
  async function resolvePublic(url) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    let found;
    if (net.isIP(hostname)) {
      found = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
      let timer;
      try {
        found = await Promise.race([
          lookup(hostname),
          new Promise((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("lookup timed out")), LOOKUP_TIMEOUT_MS);
          })
        ]);
      } catch {
        throw upstreamFailure(`The address ${hostname} could not be found.`);
      } finally {
        clearTimeout(timer);
      }
    }
    const addresses = (Array.isArray(found) ? found : [found]).filter((entry) => entry && entry.address);
    if (!addresses.length) {
      throw upstreamFailure(`The address ${hostname} could not be found.`);
    }
    // All of them, not just the one that will be used: a name that answers
    // with a private address beside a public one is not a download host.
    if (!addresses.every((entry) => isPublicAddress(entry.address))) {
      throw refused(
        `${hostname} is this machine or an address on a private network. The dashboard only downloads from the public internet.`
      );
    }
    return addresses.map((entry) => ({ address: entry.address, family: net.isIP(entry.address) }));
  }

  // Connects to the first of the checked addresses that answers.
  async function connect(url, addresses, headers, signal) {
    let lastError = null;
    for (const { address, family } of addresses.slice(0, MAX_ADDRESSES_TRIED)) {
      try {
        return await transport({ address, family, headers, idleTimeoutMs, signal, url });
      } catch (error) {
        lastError = error;
        if (signal.aborted || !UNREACHABLE.has(error.code)) {
          break;
        }
      }
    }
    if (signal.aborted) {
      throw upstreamFailure(`${url.hostname} did not answer in time.`, 504);
    }
    const certificate = lastError && /CERT|certificate|altnames/i.test(`${lastError.code} ${lastError.message}`);
    throw upstreamFailure(
      certificate
        ? `${url.hostname} did not present a certificate the dashboard trusts.`
        : `Could not connect to ${url.hostname}.`
    );
  }

  // Follows an address to the response that is not a redirect, and hands that
  // response back unread: { status, headers, body, url }.
  async function open(address, options, signal) {
    let url = parseAddress(address);
    const startedAt = url.origin;
    for (let redirects = 0; ; redirects += 1) {
      const addresses = await resolvePublic(url);
      const headers = {
        "Accept-Encoding": "identity",
        "User-Agent": userAgent,
        // Whatever the caller added - an API key - goes to the host it was
        // meant for and is not carried along by a redirect to another.
        ...(url.origin === startedAt ? options.headers || {} : {})
      };
      const response = await connect(url, addresses, headers, signal);
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { ...response, url };
      }

      response.body.destroy();
      const location = response.headers.location;
      if (!location) {
        throw upstreamFailure(`${url.hostname} sent a redirect that leads nowhere.`);
      }
      if (redirects >= MAX_REDIRECTS) {
        throw upstreamFailure(`The download was redirected more than ${MAX_REDIRECTS} times.`);
      }
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw upstreamFailure(`${url.hostname} sent a redirect that leads nowhere.`);
      }
      // Held to the same rules as the address that was asked for.
      url = parseAddress(next.href);
    }
  }

  // Reads a response body into `sink`, stopping at `maxBytes`. A body that says
  // it is compressed is unpacked, and it is the unpacked size that counts.
  async function drain(response, sink, maxBytes, signal) {
    const declared = Number(response.headers["content-length"]);
    const tooLarge = () => upstreamFailure(`The file is larger than the ${describeBytes(maxBytes)} limit for downloads.`, 413);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.body.destroy();
      throw tooLarge();
    }

    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(received > maxBytes ? tooLarge() : null, chunk);
      }
    });
    const encoding = String(response.headers["content-encoding"] || "identity").trim().toLowerCase();
    const decoder =
      encoding === "gzip" || encoding === "x-gzip"
        ? zlib.createGunzip()
        : encoding === "deflate"
          ? zlib.createInflate()
          : encoding === "br"
            ? zlib.createBrotliDecompress()
            : null;
    if (!decoder && encoding !== "identity" && encoding !== "") {
      response.body.destroy();
      throw upstreamFailure("The download arrived in a form the dashboard cannot read.");
    }

    try {
      await pipeline(...[response.body, decoder, meter, sink].filter(Boolean), { signal });
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      if (signal.aborted) {
        throw upstreamFailure("The download did not finish in time.", 504);
      }
      throw upstreamFailure("The download was cut off before it finished.");
    }
    return received;
  }

  function deadline(options, fallbackMs) {
    return AbortSignal.timeout(options.timeoutMs || fallbackMs);
  }

  // GETs an address and resolves to { status, headers, buffer, url } whatever
  // the status is. For callers that read the status themselves.
  async function get(address, options = {}) {
    const signal = deadline(options, METADATA_TIMEOUT_MS);
    const response = await open(address, options, signal);
    const chunks = [];
    const collector = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      }
    });
    await drain(response, collector, options.maxBytes || METADATA_LIMIT_BYTES, signal);
    return { buffer: Buffer.concat(chunks), headers: response.headers, status: response.status, url: response.url };
  }

  // An error for a response that was not a success. It carries the status, as
  // `status`, for callers that treat some statuses specially - and never
  // anything the response said.
  function failedStatus(response, what) {
    const error = upstreamFailure(`${what} failed: ${response.url.hostname} answered with HTTP ${response.status}.`);
    error.status = response.status;
    return error;
  }

  async function fetchBuffer(address, options = {}) {
    const response = await get(address, {
      maxBytes: RUNTIME_LIMIT_BYTES,
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
      ...options
    });
    if (response.status < 200 || response.status > 299) {
      throw failedStatus(response, "The download");
    }
    return response.buffer;
  }

  async function fetchText(address, options = {}) {
    const response = await get(address, options);
    if (response.status < 200 || response.status > 299) {
      throw failedStatus(response, "The request");
    }
    return response.buffer.toString("utf8");
  }

  async function fetchJson(address, options = {}) {
    const text = await fetchText(address, options);
    try {
      return JSON.parse(text);
    } catch {
      throw upstreamFailure("The answer was not the JSON that was expected.");
    }
  }

  // Downloads an address into a writable stream and resolves to the number of
  // bytes written. Nothing is held in memory.
  //
  // `openSink` is called for the stream only once there is a successful
  // response to write, so a refused or failed request creates nothing. If the
  // body then fails part-way the stream is destroyed, and whatever it had
  // written is the caller's to remove.
  async function download(address, openSink, options = {}) {
    const signal = deadline(options, DOWNLOAD_TIMEOUT_MS);
    const response = await open(address, options, signal);
    if (response.status < 200 || response.status > 299) {
      response.body.destroy();
      throw failedStatus(response, "The download");
    }
    return await drain(response, openSink(), options.maxBytes || downloadLimitBytes, signal);
  }

  return {
    download,
    downloadLimitBytes,
    fetchBuffer,
    fetchJson,
    fetchText,
    get,
    parseAddress
  };
}

// The fetcher used when a caller is not handed one of its own.
let defaultOutbound = null;

function getDefaultOutbound() {
  if (!defaultOutbound) {
    defaultOutbound = createOutbound({
      downloadLimitBytes: resolveDownloadLimitBytes(),
      userAgent: readEnv("USER_AGENT", DEFAULT_USER_AGENT)
    });
  }
  return defaultOutbound;
}

// Tests replace the network; nothing else should. Pass null to put it back.
function setDefaultOutboundForTests(outbound) {
  defaultOutbound = outbound;
}

module.exports = {
  DEFAULT_DOWNLOAD_LIMIT_MB,
  MAX_REDIRECTS,
  createOutbound,
  getDefaultOutbound,
  httpsTransport,
  isPublicAddress,
  resolveDownloadLimitBytes,
  setDefaultOutboundForTests
};
