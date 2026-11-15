const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { Writable } = require("node:stream");
const { HttpError, describeBytes } = require("./http");
const { ensureDir, readEnv } = require("./utils");

// File uploads used to be read into memory twice over - once as form data, once
// more as a Buffer - so a multi-gigabyte world archive needed that much RAM, and
// nothing set an upper bound.
//
// receiveUpload streams the one expected file part straight to a temporary file
// in the directory it is destined for, so the final step is a rename on the
// same filesystem and nothing large ever lands in /tmp, which is often RAM. It
// stops at a size limit, and whatever happens - too large, malformed, the
// client gone, or a later step failing - the temporary file is removed.

// World archives run to gigabytes; mod jars are small. One limit covers both.
const DEFAULT_UPLOAD_LIMIT_MB = 4096;

// Everything in a multipart body that is not the file: part headers and the
// few short text fields the forms send.
const HEADER_LIMIT_BYTES = 16 * 1024;
const FIELD_LIMIT_BYTES = 64 * 1024;
const PART_LIMIT = 32;
const ENVELOPE_ALLOWANCE_BYTES = 1024 * 1024;

const TEMP_NAME = /^\.upload-[0-9a-f]{16}\.part$/;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;

const CRLF = Buffer.from("\r\n");
const DOUBLE_CRLF = Buffer.from("\r\n\r\n");

// The limit in bytes, from RIPPERCRAFT_MAX_UPLOAD_MB.
function resolveUploadLimitBytes(logger) {
  const raw = readEnv("MAX_UPLOAD_MB");
  if (!raw) {
    return DEFAULT_UPLOAD_LIMIT_MB * 1024 * 1024;
  }
  const megabytes = Number(raw);
  if (!Number.isFinite(megabytes) || megabytes <= 0) {
    if (logger) {
      logger.warn("Ignoring MAX_UPLOAD_MB: it must be a positive number of megabytes", { value: raw });
    }
    return DEFAULT_UPLOAD_LIMIT_MB * 1024 * 1024;
  }
  return Math.floor(megabytes * 1024 * 1024);
}

function isUploadTempName(name) {
  return TEMP_NAME.test(name);
}

// A fresh name for a file that is still arriving in `directory`. A download
// from another server uses the same names as an upload from a browser, so the
// two are hidden from listings and cleared up after a crash in the same way.
function newUploadTempPath(directory) {
  return path.join(directory, `.upload-${crypto.randomBytes(8).toString("hex")}.part`);
}

function multipartBoundary(contentType) {
  const header = String(contentType || "");
  if (!/^multipart\/form-data\s*(;|$)/i.test(header)) {
    return null;
  }
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(header);
  const boundary = match ? match[1] || match[2] : "";
  // RFC 2046 allows at most 70 characters.
  return boundary && boundary.length <= 70 ? boundary : null;
}

// Reads `; name="value"` pairs one at a time, so a quote or a semicolon inside
// one value cannot pass for the start of another parameter.
function parseContentDisposition(value) {
  const text = String(value || "");
  const type = text.split(";")[0].trim().toLowerCase();
  const parameters = {};
  let index = text.indexOf(";");

  while (index !== -1 && index < text.length) {
    index += 1;
    while (text[index] === " " || text[index] === "\t") {
      index += 1;
    }
    const equals = text.indexOf("=", index);
    if (equals === -1) {
      break;
    }
    const name = text.slice(index, equals).trim().toLowerCase();
    index = equals + 1;

    let parameter = "";
    if (text[index] === '"') {
      index += 1;
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\" && index + 1 < text.length) {
          index += 1;
        }
        parameter += text[index];
        index += 1;
      }
      index += 1;
    } else {
      const end = text.indexOf(";", index);
      parameter = text.slice(index, end === -1 ? text.length : end).trim();
      index = end === -1 ? text.length : end;
    }

    if (name && !(name in parameters)) {
      parameters[name] = parameter;
    }
    index = text.indexOf(";", index);
  }

  return { parameters, type };
}

// The file name of a part, or undefined when the part is not a file.
//
// Browsers and curl send filename="...", with the name as raw UTF-8 and the
// three characters that would break the header written as %22, %0D and %0A.
// Some other clients (python-requests, for a name that is not ASCII) send only
// the RFC 5987 form, filename*=utf-8''%E4%B8%96.zip, which wins when both are
// present. The parser this replaced understood both, so this one does too.
function partFileName(parameters) {
  const extended = parameters["filename*"];
  if (extended !== undefined) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(extended);
    if (match) {
      try {
        const charset = match[1].toLowerCase();
        if (charset === "utf-8" || charset === "utf8" || charset === "") {
          return decodeURIComponent(match[2]);
        }
        // Anything else is taken as single-byte, which is what ISO-8859-1 is.
        return match[2].replace(/%([0-9a-f]{2})/gi, (_all, hex) => String.fromCharCode(parseInt(hex, 16)));
      } catch {
        // Not decodable: fall through to the plain form, or to the raw text.
      }
    }
    if (parameters.filename === undefined) {
      return extended;
    }
  }
  if (parameters.filename === undefined) {
    return undefined;
  }
  return parameters.filename.replace(/%22/g, '"').replace(/%0d/gi, "\r").replace(/%0a/gi, "\n");
}

function parsePartHeaders(block) {
  const headers = {};
  for (const line of block.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
  }
  const disposition = parseContentDisposition(headers["content-disposition"]);
  if (disposition.type !== "form-data" || !disposition.parameters.name) {
    throw new HttpError(400, "The upload is not valid form data.");
  }
  const fileName = partFileName(disposition.parameters);
  return { fileName, isFile: fileName !== undefined, name: disposition.parameters.name };
}

// A multipart/form-data parser that never holds more than a few kilobytes: the
// bytes of the file part go to `openFile()`'s handle as they arrive, and the
// write is awaited before more is read, so a slow disk slows the upload rather
// than filling memory.
class MultipartReceiver extends Writable {
  constructor(options) {
    super();
    this.fileField = options.fileField;
    this.maxFileBytes = options.maxFileBytes;
    this.openFile = options.openFile;
    this.dashBoundary = Buffer.from(`--${options.boundary}`);
    this.delimiter = Buffer.from(`\r\n--${options.boundary}`);

    this.buffered = Buffer.alloc(0);
    this.received = 0;
    this.state = "preamble";
    this.part = null;
    this.partCount = 0;
    this.fields = {};
    this.fieldBytes = 0;
    this.file = null;
    this.handle = null;
  }

  _write(chunk, _encoding, callback) {
    this.consume(chunk).then(() => callback(), callback);
  }

  _final(callback) {
    this.closeHandle().then(
      () => callback(this.state === "done" ? null : new HttpError(400, "The upload ended before it was complete.")),
      callback
    );
  }

  _destroy(error, callback) {
    this.closeHandle().then(
      () => callback(error),
      () => callback(error)
    );
  }

  async closeHandle() {
    if (this.handle) {
      const handle = this.handle;
      this.handle = null;
      await handle.close();
    }
  }

  async consume(chunk) {
    // Bounds the whole body, not just the file inside it: without a declared
    // length, text after the closing boundary could otherwise go on for as long
    // as the connection was allowed to.
    this.received += chunk.length;
    if (this.received > this.maxFileBytes + ENVELOPE_ALLOWANCE_BYTES) {
      throw new HttpError(413, `That upload is larger than the ${describeBytes(this.maxFileBytes)} limit.`);
    }
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;

    for (;;) {
      if (this.destroyed) {
        // Torn down while a write or an open was in progress: nothing further
        // may touch the file.
        return;
      }
      if (this.state === "done") {
        // Anything after the closing boundary is an epilogue to ignore.
        this.buffered = Buffer.alloc(0);
        return;
      }

      if (this.state === "preamble") {
        const index = this.buffered.indexOf(this.dashBoundary);
        if (index === -1) {
          if (this.buffered.length > HEADER_LIMIT_BYTES) {
            throw new HttpError(400, "The upload is not valid form data.");
          }
          return;
        }
        this.buffered = this.buffered.subarray(index + this.dashBoundary.length);
        this.state = "after-boundary";
        continue;
      }

      if (this.state === "after-boundary") {
        if (this.buffered.length < 2) {
          return;
        }
        if (this.buffered[0] === 0x2d && this.buffered[1] === 0x2d) {
          this.state = "done";
          continue;
        }
        const lineEnd = this.buffered.indexOf(CRLF);
        if (lineEnd === -1) {
          if (this.buffered.length > 256) {
            throw new HttpError(400, "The upload is not valid form data.");
          }
          return;
        }
        // Only padding may follow a boundary on its line.
        if (this.buffered.subarray(0, lineEnd).some((byte) => byte !== 0x20 && byte !== 0x09)) {
          throw new HttpError(400, "The upload is not valid form data.");
        }
        this.buffered = this.buffered.subarray(lineEnd + 2);
        this.state = "headers";
        continue;
      }

      if (this.state === "headers") {
        let headerBlock;
        if (this.buffered.length >= 2 && this.buffered[0] === 0x0d && this.buffered[1] === 0x0a) {
          // A part with no headers at all.
          headerBlock = "";
          this.buffered = this.buffered.subarray(2);
        } else {
          const end = this.buffered.indexOf(DOUBLE_CRLF);
          if (end === -1) {
            if (this.buffered.length > HEADER_LIMIT_BYTES) {
              throw new HttpError(400, "The upload has a part header that is too large.");
            }
            return;
          }
          if (end > HEADER_LIMIT_BYTES) {
            throw new HttpError(400, "The upload has a part header that is too large.");
          }
          headerBlock = this.buffered.subarray(0, end).toString("utf8");
          this.buffered = this.buffered.subarray(end + 4);
        }
        await this.beginPart(parsePartHeaders(headerBlock));
        this.state = "body";
        continue;
      }

      // state === "body"
      const index = this.buffered.indexOf(this.delimiter);
      if (index !== -1) {
        await this.writePart(this.buffered.subarray(0, index));
        await this.endPart();
        this.buffered = this.buffered.subarray(index + this.delimiter.length);
        this.state = "after-boundary";
        continue;
      }
      // The tail might be the start of a delimiter that the next chunk
      // completes, so that much is held back.
      const safe = this.buffered.length - (this.delimiter.length - 1);
      if (safe > 0) {
        await this.writePart(this.buffered.subarray(0, safe));
        this.buffered = this.buffered.subarray(safe);
      }
      return;
    }
  }

  async beginPart(headers) {
    this.partCount += 1;
    if (this.partCount > PART_LIMIT) {
      throw new HttpError(400, "The upload has too many parts.");
    }

    if (!headers.isFile) {
      this.part = { chunks: [], kind: "field", name: headers.name };
      return;
    }
    if (headers.name !== this.fileField || this.file) {
      throw new HttpError(400, `Only one file may be uploaded here, in the "${this.fileField}" field.`);
    }
    if (!headers.fileName) {
      // What a browser sends for a file input that was left empty.
      this.part = { bytes: 0, kind: "empty-file" };
      return;
    }
    const opened = await this.openFile();
    if (this.destroyed) {
      // Nobody else knows about this handle yet, so nobody else will close it.
      await opened.handle.close().catch(() => {});
      return;
    }
    this.handle = opened.handle;
    this.file = { fileName: headers.fileName, path: opened.path, size: 0 };
    this.part = { kind: "file" };
  }

  async writePart(data) {
    if (!data.length || this.destroyed) {
      return;
    }
    const part = this.part;
    if (part.kind === "file") {
      this.file.size += data.length;
      if (this.file.size > this.maxFileBytes) {
        throw new HttpError(413, `That file is larger than the ${describeBytes(this.maxFileBytes)} upload limit.`);
      }
      await this.handle.writeFile(data);
      return;
    }
    if (part.kind === "empty-file") {
      part.bytes += data.length;
      if (part.bytes > FIELD_LIMIT_BYTES) {
        throw new HttpError(400, "An uploaded file needs a file name.");
      }
      return;
    }
    this.fieldBytes += data.length;
    if (this.fieldBytes > FIELD_LIMIT_BYTES) {
      throw new HttpError(413, "The form fields sent with the upload are too large.");
    }
    part.chunks.push(Buffer.from(data));
  }

  async endPart() {
    const part = this.part;
    this.part = null;
    if (!part) {
      return;
    }
    if (part.kind === "file") {
      await this.closeHandle();
    } else if (part.kind === "field" && !(part.name in this.fields)) {
      this.fields[part.name] = Buffer.concat(part.chunks).toString("utf8");
    }
  }
}

// Removes temporary files a crash or a kill left behind in this directory.
async function removeStaleTempFiles(directory, now = Date.now()) {
  let names;
  try {
    names = await fsp.readdir(directory);
  } catch {
    return;
  }
  for (const name of names.filter(isUploadTempName)) {
    const filePath = path.join(directory, name);
    try {
      if (now - (await fsp.stat(filePath)).mtimeMs > STALE_TEMP_AGE_MS) {
        await fsp.rm(filePath, { force: true });
      }
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

// Receives a multipart/form-data request holding at most one file, in the
// field named `fileField`, and writes that file to a temporary file inside
// `directory`.
//
// Resolves to { fields, file, cleanup }. `file` is null when no file was sent,
// otherwise { fileName, path, size } with `path` the temporary file. The caller
// moves that file to where it belongs, and calls cleanup() in a finally block:
// it removes the temporary file if it is still there.
//
// Rejects - with the temporary file already removed - when the request is not
// multipart form data (415), is too large (413), is malformed (400), or the
// client disconnects part-way.
async function receiveUpload(req, options) {
  const { directory, fileField, maxFileBytes } = options;

  const boundary = multipartBoundary(req.headers["content-type"]);
  if (!boundary) {
    throw new HttpError(415, "Send the file as multipart/form-data.");
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxFileBytes + ENVELOPE_ALLOWANCE_BYTES) {
    throw new HttpError(413, `That file is larger than the ${describeBytes(maxFileBytes)} upload limit.`);
  }
  if (req.destroyed) {
    throw new HttpError(400, "The connection closed before the upload arrived.");
  }

  let tempPath = null;
  async function removeTemp() {
    if (tempPath) {
      const target = tempPath;
      tempPath = null;
      await fsp.rm(target, { force: true });
    }
  }

  // Opening the file takes a moment, and the upload can be given up in that
  // moment: the client hangs up, and everything is torn down while the open is
  // still on its way. The file then appears after the cleanup has run. So the
  // cleanup waits for an open that is in flight, and an open that completes
  // after the upload was abandoned closes its handle itself.
  let abandoned = false;
  let opening = Promise.resolve();
  async function openTemp() {
    await ensureDir(directory);
    await removeStaleTempFiles(directory);
    const candidate = newUploadTempPath(directory);
    // The default mode, so the finished file ends up with the permissions a
    // plain write gave it before.
    const handle = await fsp.open(candidate, "wx");
    tempPath = candidate;
    if (abandoned) {
      await handle.close().catch(() => {});
      throw new HttpError(400, "The connection closed before the upload finished.");
    }
    return { handle, path: candidate };
  }

  const receiver = new MultipartReceiver({
    boundary,
    fileField,
    maxFileBytes,
    openFile() {
      const opened = openTemp();
      opening = opened.then(
        () => {},
        () => {}
      );
      return opened;
    }
  });

  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const settle = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        req.off("close", onClose);
        req.off("error", onError);
        if (error) {
          // Stop feeding the parser; what is still arriving is discarded.
          req.unpipe(receiver);
          req.resume();
          receiver.destroy();
          reject(error);
        } else {
          resolve();
        }
      };
      // A request stream only errors when its connection does: Node reports a
      // client that hung up as an "aborted" error, then as a close.
      const onError = () => settle(new HttpError(400, "The connection closed before the upload finished."));
      const onClose = () => {
        if (!req.complete) {
          settle(new HttpError(400, "The connection closed before the upload finished."));
        }
      };
      receiver.once("error", (error) => settle(error));
      receiver.once("finish", () => settle(null));
      req.once("error", onError);
      req.once("close", onClose);
      req.pipe(receiver);
    });
  } catch (error) {
    abandoned = true;
    // The parser closes its file handle as it is destroyed; wait for that, and
    // for any open still in flight, so the file is removed after the last
    // handle on it has gone and not before it exists.
    if (!receiver.closed) {
      await new Promise((resolve) => receiver.once("close", resolve));
    }
    await opening;
    await removeTemp();
    throw error;
  }

  return { cleanup: removeTemp, fields: receiver.fields, file: receiver.file };
}

module.exports = {
  DEFAULT_UPLOAD_LIMIT_MB,
  MultipartReceiver,
  isUploadTempName,
  multipartBoundary,
  newUploadTempPath,
  parseContentDisposition,
  receiveUpload,
  resolveUploadLimitBytes
};
