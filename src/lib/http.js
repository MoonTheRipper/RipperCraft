const fs = require("node:fs");
const path = require("node:path");

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  // Without this the manifest went out as application/octet-stream, which some
  // browsers refuse to parse - taking the installable-app metadata with it.
  ".webmanifest": "application/manifest+json; charset=utf-8"
};

// An error whose status and message are meant for the client. Anything else
// that reaches the request handler is a fault and answers 500.
class HttpError extends Error {
  constructor(statusCode, message, options = {}) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.expose = true;
    this.headers = options.headers || {};
  }
}

// Everything the dashboard takes as JSON is a small form. The old reader had no
// limit at all, so 32 MB posted to /api/login by a stranger was held in memory
// whole before anything looked at it.
const JSON_BODY_LIMIT_BYTES = 1024 * 1024;

// How long a connection is left open after an answer has been sent while the
// client is still uploading. See closeAfterUnreadBody.
const UNREAD_BODY_LINGER_MS = 2000;
const graceTimers = new WeakMap();

function describeBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024 * 1024)) * 10) / 10} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
  }
  return `${Math.ceil(bytes / 1024)} KB`;
}

// Collects a request body, refusing with 413 as soon as it is known to be over
// the limit: straight away when Content-Length says so, otherwise at the first
// byte past it. Nothing beyond the limit is kept.
function readBody(req, options = {}) {
  const limit = options.limit === undefined ? JSON_BODY_LIMIT_BYTES : options.limit;
  const tooLarge = () => new HttpError(413, `The request body is larger than the ${describeBytes(limit)} allowed here.`);

  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      reject(tooLarge());
      return;
    }
    if (req.destroyed) {
      // The client has already gone; no further event would ever settle this.
      reject(new HttpError(400, "The connection closed before the request body arrived."));
      return;
    }

    let chunks = [];
    let size = 0;

    function stop() {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        stop();
        chunks = [];
        // Whatever still arrives is dropped as it comes, not stored.
        req.resume();
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      stop();
      resolve(Buffer.concat(chunks, size));
    }
    // A request stream only errors when its connection does: Node reports a
    // client that hung up as an "aborted" error, then as a close.
    function onError() {
      stop();
      reject(new HttpError(400, "The connection closed before the request body arrived."));
    }
    function onClose() {
      stop();
      reject(new HttpError(400, "The connection closed before the request body arrived."));
    }

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

async function parseJsonBody(req, options = {}) {
  const body = await readBody(req, options);
  if (!body.length) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  // Every route reads named fields, so `null`, a number or a list is a client
  // error here rather than a TypeError further in.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "The request body must be a JSON object.");
  }
  return parsed;
}

// Stops a client from using an answered request as somewhere to keep sending
// data. When a response has gone out and the request body is still arriving -
// refused before it was read, or cut off at the size limit - the connection is
// given a moment and then closed.
//
// The moment matters: closing at once, with the client's bytes still unread,
// makes the kernel reset the connection, and a client that is still sending
// then loses the response that told it why. What arrives meanwhile is thrown
// away by Node as it is parsed, never stored.
//
// This only helps on a kept-alive connection, which is what browsers, curl and
// the tunnel use. A client that asked for "Connection: close" has its
// connection closed by Node as soon as the response is written, as before.
function closeAfterUnreadBody(req, res, lingerMs = UNREAD_BODY_LINGER_MS) {
  res.once("finish", () => {
    const socket = req.socket;
    if (req.complete || !socket || socket.destroyed) {
      return;
    }
    // Normally Node discards an unread body by itself once the response is
    // done, but not after a handler has started reading it and stopped.
    req.resume();

    // One timer per connection, and nothing attached to the socket itself: a
    // tunnel reuses one connection for thousands of requests. Requests on a
    // connection arrive one after another, so an earlier timer still pending
    // here belongs to a request whose body has since arrived in full.
    clearTimeout(graceTimers.get(socket));
    const timer = setTimeout(() => {
      if (!req.complete && !socket.destroyed) {
        socket.destroy();
      }
    }, lingerMs);
    timer.unref();
    graceTimers.set(socket, timer);
  });
}

function json(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...headers
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function text(res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...headers
  });
  res.end(payload);
}

function noContent(res, headers = {}) {
  res.writeHead(204, headers);
  res.end();
}

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function sendStream(res, statusCode, stream, headers = {}) {
  res.writeHead(statusCode, headers);
  stream.pipe(res);
}

function sendFile(res, filePath) {
  const extension = path.extname(filePath);
  const contentType = CONTENT_TYPES[extension] || "application/octet-stream";
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    json(res, 404, { error: "Not found" });
  });
  sendStream(res, 200, stream, {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": contentType
  });
}

module.exports = {
  HttpError,
  JSON_BODY_LIMIT_BYTES,
  closeAfterUnreadBody,
  describeBytes,
  json,
  noContent,
  parseJsonBody,
  readBody,
  redirect,
  sendFile,
  sendStream,
  text
};
