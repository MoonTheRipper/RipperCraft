const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { pipeline } = require("node:stream");

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

// What the page may load and run. The dashboard draws itself by assigning
// markup built from server responses, so this is the second line behind the
// escaping: markup that does get through still cannot run a script, load one,
// or send anything anywhere.
//
// Nothing here is looser than the page needs. It has no inline script and no
// inline style - the three that existed (a style attribute on the live region,
// one on the progress bar, an onerror attribute on add-on artwork) were moved
// into the stylesheet and into modules so that neither 'unsafe-inline' nor a
// hash list is required.
const CONTENT_SECURITY_POLICY = [
  // Anything not named below, such as the web app manifest: this origin only.
  "default-src 'self'",
  // The page's own modules. No inline script, no eval, no other host.
  "script-src 'self'",
  // The one stylesheet. Widths worked out at run time are set from script,
  // which this does not restrict; style attributes in markup it does.
  "style-src 'self'",
  // The logo and icons from here, and add-on artwork, which Modrinth and
  // CurseForge serve from their own CDNs: any https host, never plain http.
  // data: is for an image written out inline, which is as inert as a file.
  "img-src 'self' data: https:",
  // The API, and nothing else: no page script can send data to another host.
  "connect-src 'self'",
  // System fonts only, so nothing is ever fetched; this keeps it that way.
  "font-src 'self'",
  // No plugins, no <base> to re-point relative URLs, no form posted elsewhere.
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  // Never inside a frame (X-Frame-Options says the same to older browsers).
  "frame-ancestors 'none'"
].join("; ");

// Sent with every response, whatever it is.
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
});

function applySecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(name, value);
  }
}

function staticFileHeaders(filePath) {
  return {
    "Cache-Control": "no-store, max-age=0",
    "Content-Type": CONTENT_TYPES[path.extname(filePath)] || "application/octet-stream"
  };
}

// Streams a regular file as a 200 response and resolves to true once it has
// been sent, or once there is nobody left to send it to. Resolves to false,
// with nothing written, when the path is not a file that can be read: missing,
// or a directory. The caller then answers. Rejects, also with nothing written,
// if the headers it was given cannot be sent.
//
// The headers used to go out before the file had even been opened. Asking for
// a directory (GET /js) or an archive that was not there therefore failed with
// the status line already sent: the error handler threw trying to send a
// second one, and the request hung until the client gave up.
//
// With options.followLinks set to false, a path whose last part is a symbolic
// link counts as not a file: it is neither reported as one nor opened, even if
// it became a link in the moment between the two.
async function sendFile(res, filePath, headers = {}, options = {}) {
  const followLinks = options.followLinks !== false;
  let stats;
  try {
    stats = followLinks ? await fsp.stat(filePath) : await fsp.lstat(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) {
    return false;
  }

  return await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(
      filePath,
      followLinks ? {} : { flags: fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW }
    );
    stream.once("error", () => resolve(false));
    stream.once("open", () => {
      stream.removeAllListeners("error");
      // Nothing in here may throw: this is an event handler, so an exception
      // would be an uncaught one, the caller would wait for ever, and the file
      // would stay open.
      if (res.destroyed) {
        // The client hung up while the file was being opened.
        stream.destroy();
        resolve(true);
        return;
      }
      try {
        res.writeHead(200, headers);
      } catch (error) {
        // A header the caller built cannot be sent. Nothing has gone out yet,
        // so the caller can still answer with an error of its own.
        stream.destroy();
        reject(error);
        return;
      }
      try {
        // Ends the response when the file does, and closes the file if the
        // client goes away or reading fails part-way. It also throws, at once,
        // if the response was destroyed in the last few microseconds.
        pipeline(stream, res, () => resolve(true));
      } catch {
        stream.destroy();
        res.destroy();
        resolve(true);
      }
    });
  });
}

module.exports = {
  CONTENT_SECURITY_POLICY,
  HttpError,
  JSON_BODY_LIMIT_BYTES,
  SECURITY_HEADERS,
  applySecurityHeaders,
  closeAfterUnreadBody,
  describeBytes,
  json,
  noContent,
  parseJsonBody,
  readBody,
  redirect,
  sendFile,
  staticFileHeaders,
  text
};
