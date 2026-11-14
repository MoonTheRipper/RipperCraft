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

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function parseJsonBody(req) {
  const body = await readBody(req);
  if (!body.length) {
    return {};
  }
  return JSON.parse(body.toString("utf8"));
}

async function parseFormData(req) {
  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: "half"
  });
  return await request.formData();
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
  json,
  noContent,
  parseFormData,
  parseJsonBody,
  readBody,
  redirect,
  sendFile,
  sendStream,
  text
};
