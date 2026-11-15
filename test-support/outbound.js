// Stands in for the network in tests.
//
// The dashboard reaches other machines through lib/outbound.js, which resolves
// a host name, checks the address, and opens a TLS connection to it. Tests
// replace the last two steps and keep everything else: the https-only rule,
// the redirect handling, the size limits and the error wording all still run.
const { Readable } = require("node:stream");
const { createOutbound, setDefaultOutboundForTests } = require("../src/lib/outbound");

// An address on the public internet for names that do not need a particular one.
const PUBLIC_ADDRESS = "93.184.215.14";

// A transport that asks globalThis.fetch for the response, so a test can keep
// describing the outside world by replacing fetch. The stand-in may answer
// with a real Response or with an object that has only the parts a test
// bothered to write: { ok, status, json(), text(), arrayBuffer() }.
async function fetchTransport({ headers, url }) {
  const response = await globalThis.fetch(url.href, { headers, redirect: "manual" });
  const status = typeof response.status === "number" ? response.status : response.ok === false ? 500 : 200;
  let bytes = Buffer.alloc(0);
  if (typeof response.arrayBuffer === "function") {
    bytes = Buffer.from(await response.arrayBuffer());
  } else if (typeof response.text === "function") {
    bytes = Buffer.from(await response.text());
  } else if (typeof response.json === "function") {
    bytes = Buffer.from(JSON.stringify(await response.json()));
  }
  const responseHeaders = {};
  if (response.headers && typeof response.headers.forEach === "function") {
    response.headers.forEach((value, name) => {
      // The stand-in has already decoded the body, whatever it says.
      if (name.toLowerCase() !== "content-encoding" && name.toLowerCase() !== "content-length") {
        responseHeaders[name.toLowerCase()] = value;
      }
    });
  }
  return { body: Readable.from([bytes]), headers: responseHeaders, status };
}

// A fetcher whose requests are answered by globalThis.fetch.
function fetchBackedOutbound(overrides = {}) {
  return createOutbound({
    lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    transport: fetchTransport,
    ...overrides
  });
}

// Makes every server and add-on manager created from now on, in this test
// file, use fetch-backed requests unless it is handed a fetcher of its own.
function useFetchForOutbound() {
  setDefaultOutboundForTests(fetchBackedOutbound());
}

// A fetcher wired to hand-written answers, for tests about the fetcher itself.
//
//   scriptedOutbound({
//     addresses: { "files.example": ["93.184.215.14"] },
//     respond: ({ url, address, headers }) => ({ status: 200, body: "hello" })
//   })
//
// `respond` may return { status, headers, body } with a string, a Buffer or a
// stream for a body, or throw. Every call is recorded in `calls`, every name
// looked up in `lookups`.
function scriptedOutbound(script = {}, overrides = {}) {
  const calls = [];
  const lookups = [];
  const outbound = createOutbound({
    lookup: async (hostname) => {
      lookups.push(hostname);
      const answer = typeof script.addresses === "function" ? await script.addresses(hostname, lookups.length) : (script.addresses || {})[hostname];
      if (!answer) {
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
      }
      return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    },
    transport: async (request) => {
      calls.push({ address: request.address, headers: request.headers, url: request.url.href });
      const answer = await script.respond(request, calls.length);
      const body = answer.body === undefined ? "" : answer.body;
      return {
        body: typeof body === "string" || Buffer.isBuffer(body) ? Readable.from([Buffer.from(body)]) : body,
        headers: answer.headers || {},
        status: answer.status === undefined ? 200 : answer.status
      };
    },
    ...overrides
  });
  return { calls, lookups, outbound };
}

module.exports = {
  PUBLIC_ADDRESS,
  fetchBackedOutbound,
  scriptedOutbound,
  useFetchForOutbound
};
