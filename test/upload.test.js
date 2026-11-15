const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { once } = require("node:events");
const { setHashCostForTests } = require("../src/lib/auth");
const {
  DEFAULT_UPLOAD_LIMIT_MB,
  MultipartReceiver,
  multipartBoundary,
  parseContentDisposition,
  resolveUploadLimitBytes
} = require("../src/lib/upload");
const { ADMIN_PASSWORD, startApp } = require("../test-support/app");

setHashCostForTests({ ln: 10, r: 8, p: 1 });

const BOUNDARY = "----RipperCraftTestBoundary7MA4YWxk";

function filePart(name, fileName, content, type = "application/octet-stream") {
  return { content: Buffer.from(content), headers: [`Content-Disposition: form-data; name="${name}"; filename="${fileName}"`, `Content-Type: ${type}`] };
}

function fieldPart(name, value) {
  return { content: Buffer.from(value), headers: [`Content-Disposition: form-data; name="${name}"`] };
}

function multipartBody(parts, { boundary = BOUNDARY, close = true, epilogue = "", preamble = "" } = {}) {
  const pieces = [Buffer.from(preamble)];
  for (const part of parts) {
    pieces.push(Buffer.from(`--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n`), part.content, Buffer.from("\r\n"));
  }
  if (close) {
    pieces.push(Buffer.from(`--${boundary}--\r\n${epilogue}`));
  }
  return Buffer.concat(pieces);
}

// Runs the parser over `chunks` with a file handle that just remembers what it
// was given, so the parsing can be checked without touching the disk.
async function parse(chunks, options = {}) {
  const written = [];
  let opened = 0;
  let closed = 0;
  const receiver = new MultipartReceiver({
    boundary: options.boundary || BOUNDARY,
    fileField: options.fileField || "file",
    maxFileBytes: options.maxFileBytes || 1024 * 1024,
    async openFile() {
      opened += 1;
      return {
        handle: {
          async close() {
            closed += 1;
          },
          async writeFile(data) {
            // Yield, as a real write would, and copy: the parser hands out views.
            await new Promise((resolve) => setImmediate(resolve));
            written.push(Buffer.from(data));
          }
        },
        path: "/nowhere/.upload-test.part"
      };
    }
  });

  const finished = new Promise((resolve, reject) => {
    receiver.once("error", reject);
    receiver.once("finish", resolve);
  });
  // One chunk at a time, each fully processed before the next, as pipe() does.
  // A failure surfaces through `finished`; the loop just stops feeding.
  for (const chunk of chunks) {
    if (receiver.destroyed) {
      break;
    }
    await new Promise((resolve) => receiver.write(chunk, () => resolve()));
  }
  if (!receiver.destroyed) {
    receiver.end();
  }
  await finished;
  return { closed, fields: receiver.fields, file: receiver.file, opened, written: Buffer.concat(written) };
}

async function parseError(chunks, options) {
  return await parse(chunks, options).then(
    () => null,
    (error) => error
  );
}

test("the boundary is taken from a multipart content type and nothing else", () => {
  assert.equal(multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`), BOUNDARY);
  assert.equal(multipartBoundary('Multipart/Form-Data; charset=utf-8; boundary="quoted boundary"'), "quoted boundary");
  assert.equal(multipartBoundary("multipart/form-data"), null);
  assert.equal(multipartBoundary("multipart/form-data; boundary="), null);
  assert.equal(multipartBoundary(`multipart/form-data; boundary=${"x".repeat(71)}`), null);
  assert.equal(multipartBoundary(`multipart/mixed; boundary=${BOUNDARY}`), null);
  assert.equal(multipartBoundary(`application/json; boundary=${BOUNDARY}`), null);
  assert.equal(multipartBoundary(undefined), null);
});

test("content-disposition parameters are read one at a time, quotes and all", () => {
  assert.deepEqual(parseContentDisposition('form-data; name="file"; filename="world.zip"'), {
    parameters: { filename: "world.zip", name: "file" },
    type: "form-data"
  });
  // curl escapes quotes and backslashes; semicolons are ordinary inside quotes.
  assert.deepEqual(parseContentDisposition('form-data; name="file"; filename="a;b\\"c\\\\d.jar"').parameters, {
    filename: 'a;b"c\\d.jar',
    name: "file"
  });
  // A field name that merely contains the text of another parameter stays one value.
  assert.deepEqual(parseContentDisposition('form-data; name="note; filename=\\"evil.jar\\""').parameters, {
    name: 'note; filename="evil.jar"'
  });
  assert.deepEqual(parseContentDisposition("form-data; name=plain; filename=mod.jar").parameters, {
    filename: "mod.jar",
    name: "plain"
  });
  // The first of a repeated parameter wins.
  assert.equal(parseContentDisposition('form-data; name="first"; name="second"').parameters.name, "first");
  assert.equal(parseContentDisposition('FORM-DATA; NAME="x"').type, "form-data");
  assert.deepEqual(parseContentDisposition(undefined), { parameters: {}, type: "" });
  assert.equal(parseContentDisposition('form-data; name="file"; filename=""').parameters.filename, "");
});

test("a file name is read in each form a client may send it", async () => {
  const named = async (disposition) => {
    const body = multipartBody([{ content: Buffer.from("x"), headers: [`Content-Disposition: ${disposition}`] }]);
    const result = await parse([body]);
    return result.file ? result.file.fileName : { field: result.fields };
  };

  // Browsers: raw UTF-8, with only the quote and the line breaks escaped.
  assert.equal(await named('form-data; name="file"; filename="mod.jar"'), "mod.jar");
  assert.equal(await named('form-data; name="file"; filename="\u4e16\u754c.jar"'), "\u4e16\u754c.jar");
  assert.equal(await named('form-data; name="file"; filename="a%22b%0D%0Ac.jar"'), 'a"b\r\nc.jar');
  // Other percent signs are part of the name, not an encoding of anything.
  assert.equal(await named('form-data; name="file"; filename="100%20real.jar"'), "100%20real.jar");
  // curl: backslash escapes.
  assert.equal(await named('form-data; name="file"; filename="a\\"b.jar"'), 'a"b.jar');

  // RFC 5987, alone or alongside a plain fallback, in which case it wins.
  assert.equal(await named("form-data; name=\"file\"; filename*=utf-8''%E4%B8%96.jar"), "\u4e16.jar");
  assert.equal(await named("form-data; name=\"file\"; filename*=UTF-8'en'%E4%B8%96%20x.jar"), "\u4e16 x.jar");
  assert.equal(
    await named("form-data; name=\"file\"; filename=\"fallback.jar\"; filename*=utf-8''%E4%B8%96.jar"),
    "\u4e16.jar"
  );
  assert.equal(await named("form-data; name=\"file\"; filename*=iso-8859-1''caf%E9.jar"), "caf\u00e9.jar");
  // Undecodable: the plain name if there is one, otherwise the text as sent.
  assert.equal(await named("form-data; name=\"file\"; filename=\"plain.jar\"; filename*=utf-8''%E4%B8.jar"), "plain.jar");
  assert.equal(await named("form-data; name=\"file\"; filename*=utf-8''%E4%B8.jar"), "utf-8''%E4%B8.jar");

  // No file name of either kind: an ordinary text field.
  assert.deepEqual(await named('form-data; name="file"'), { field: { file: "x" } });
});

test("a file comes out byte for byte wherever the chunk boundaries fall", async () => {
  // Bytes chosen to look like structure: bare CR and LF, dashes, most of a
  // delimiter, and a complete delimiter for a different boundary.
  const tricky = Buffer.concat([
    Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x0d, 0x0d, 0x0a, 0x2d, 0x2d]),
    Buffer.from(`\r\n--${BOUNDARY.slice(0, -1)}`),
    Buffer.from("\r\n--some-other-boundary--\r\n"),
    Buffer.from([0x0d, 0x0a, 0x2d]),
    crypto.randomBytes(40)
  ]);
  const body = multipartBody([
    fieldPart("before", "one"),
    filePart("file", "tricky.jar", tricky),
    fieldPart("confirmManualCompatibility", "true")
  ]);
  const expected = { fileName: "tricky.jar", path: "/nowhere/.upload-test.part", size: tricky.length };

  for (let split = 0; split <= body.length; split += 1) {
    const result = await parse([body.subarray(0, split), body.subarray(split)]);
    assert.deepEqual(result.file, expected, `split at ${split}`);
    assert.ok(result.written.equals(tricky), `file bytes differ when split at ${split}`);
    assert.deepEqual(result.fields, { before: "one", confirmManualCompatibility: "true" }, `split at ${split}`);
    assert.equal(result.closed, 1);
  }

  // One byte at a time.
  const drip = await parse(Array.from(body, (byte) => Buffer.from([byte])));
  assert.ok(drip.written.equals(tricky));
  assert.deepEqual(drip.fields, { before: "one", confirmManualCompatibility: "true" });
});

test("a megabyte of random bytes survives random chunking", async () => {
  const content = crypto.randomBytes(1024 * 1024 + 17);
  const body = multipartBody([filePart("file", "big.jar", content)], {
    epilogue: "ignored trailing text",
    preamble: "This is a preamble and is ignored.\r\n"
  });

  const chunks = [];
  for (let offset = 0; offset < body.length; ) {
    const size = 1 + crypto.randomInt(70_000);
    chunks.push(body.subarray(offset, offset + size));
    offset += size;
  }
  const result = await parse(chunks, { maxFileBytes: 2 * 1024 * 1024 });

  assert.equal(result.file.size, content.length);
  assert.equal(
    crypto.createHash("sha256").update(result.written).digest("hex"),
    crypto.createHash("sha256").update(content).digest("hex")
  );
});

test("a file over the limit is refused with 413 and nothing past the limit is written", async () => {
  const content = crypto.randomBytes(5000);
  const body = multipartBody([filePart("file", "big.jar", content)]);
  const chunks = [];
  for (let offset = 0; offset < body.length; offset += 512) {
    chunks.push(body.subarray(offset, offset + 512));
  }

  const error = await parseError(chunks, { maxFileBytes: 2048 });
  assert.equal(error.statusCode, 413);
  assert.equal(error.message, "That file is larger than the 2 KB upload limit.");

  // Exactly at the limit is fine.
  const exact = await parse([multipartBody([filePart("file", "exact.jar", content.subarray(0, 2048))])], { maxFileBytes: 2048 });
  assert.equal(exact.file.size, 2048);
});

test("the body as a whole is bounded too, not just the file inside it", async () => {
  // A small file, then text after the closing boundary that never stops. With a
  // chunked body nothing declares how much is coming.
  const body = multipartBody([filePart("file", "small.jar", "tiny")]);
  const junk = Buffer.alloc(256 * 1024, 0x2e);
  const chunks = [body, ...new Array(8).fill(junk)];

  // A megabyte is allowed on top of the file limit for the form's own overhead.
  const error = await parseError(chunks, { maxFileBytes: 1024 });
  assert.equal(error.statusCode, 413);
  assert.equal(error.message, "That upload is larger than the 1 KB limit.");

  // Under that allowance, trailing text is ignored as before.
  const allowed = await parse([body, junk, junk], { maxFileBytes: 1024 });
  assert.equal(allowed.written.toString(), "tiny");
});

test("an empty file selection, missing parts and stray text fields are handled", async () => {
  // What a browser sends when the file input was left empty.
  const empty = await parse([multipartBody([filePart("file", "", ""), fieldPart("confirmManualCompatibility", "true")])]);
  assert.equal(empty.file, null);
  assert.equal(empty.opened, 0);
  assert.deepEqual(empty.fields, { confirmManualCompatibility: "true" });

  const nothing = await parse([Buffer.from(`--${BOUNDARY}--\r\n`)]);
  assert.equal(nothing.file, null);
  assert.deepEqual(nothing.fields, {});

  // A repeated field keeps its first value; a zero-length file is still a file.
  const repeated = await parse([
    multipartBody([fieldPart("mode", "first"), fieldPart("mode", "second"), filePart("file", "empty.jar", "")])
  ]);
  assert.deepEqual(repeated.fields, { mode: "first" });
  assert.deepEqual(repeated.file, { fileName: "empty.jar", path: "/nowhere/.upload-test.part", size: 0 });
  assert.equal(repeated.closed, 1);
});

test("malformed and oversized form data is refused with a client error", async () => {
  const cases = [
    ["cut off before the closing boundary", multipartBody([filePart("file", "a.jar", "abc")], { close: false }), 400],
    ["no boundary anywhere", Buffer.from("just some text that is not form data at all"), 400],
    ["a second file", multipartBody([filePart("file", "a.jar", "abc"), filePart("file", "b.jar", "def")]), 400],
    ["a file in an unexpected field", multipartBody([filePart("other", "a.jar", "abc")]), 400],
    ["a part with no headers", Buffer.from(`--${BOUNDARY}\r\n\r\nbody\r\n--${BOUNDARY}--\r\n`), 400],
    [
      "a part that is not form-data",
      multipartBody([{ content: Buffer.from("x"), headers: ['Content-Disposition: attachment; filename="a.jar"'] }]),
      400
    ],
    ["text after a boundary on its line", Buffer.from(`--${BOUNDARY}junk\r\nContent-Disposition: form-data; name="a"\r\n\r\nx\r\n--${BOUNDARY}--\r\n`), 400],
    [
      "an endless part header",
      Buffer.concat([Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="a"; filename="`), Buffer.alloc(20_000, 0x61)]),
      400
    ],
    ["too many parts", multipartBody(Array.from({ length: 33 }, (_, index) => fieldPart(`f${index}`, "v"))), 400],
    ["oversized text fields", multipartBody([fieldPart("notes", "x".repeat(70_000))]), 413],
    ["a megabyte of preamble", Buffer.alloc(1024 * 1024, 0x61), 400]
  ];

  for (const [label, body, status] of cases) {
    const error = await parseError([body]);
    assert.ok(error, `${label}: was accepted`);
    assert.equal(error.statusCode, status, `${label}: ${error.message}`);
    assert.equal(error.expose, true, label);
  }
});

test("the upload limit comes from RIPPERCRAFT_MAX_UPLOAD_MB, with the old prefix still read", (t) => {
  const names = ["RIPPERCRAFT_MAX_UPLOAD_MB", "RIPPERMOONSTASH_MAX_UPLOAD_MB"];
  const saved = names.map((name) => process.env[name]);
  t.after(() => {
    names.forEach((name, index) => {
      if (saved[index] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[index];
      }
    });
  });
  const megabyte = 1024 * 1024;
  const warnings = [];
  const logger = { warn: (message, meta) => warnings.push([message, meta]) };

  names.forEach((name) => delete process.env[name]);
  assert.equal(DEFAULT_UPLOAD_LIMIT_MB, 4096);
  assert.equal(resolveUploadLimitBytes(logger), 4096 * megabyte);

  process.env.RIPPERCRAFT_MAX_UPLOAD_MB = "250";
  assert.equal(resolveUploadLimitBytes(logger), 250 * megabyte);
  process.env.RIPPERCRAFT_MAX_UPLOAD_MB = "0.5";
  assert.equal(resolveUploadLimitBytes(logger), megabyte / 2);

  delete process.env.RIPPERCRAFT_MAX_UPLOAD_MB;
  process.env.RIPPERMOONSTASH_MAX_UPLOAD_MB = "100";
  assert.equal(resolveUploadLimitBytes(logger), 100 * megabyte);
  assert.deepEqual(warnings, []);

  // Nonsense falls back to the default and says so, rather than meaning "no limit".
  for (const value of ["lots", "-5", "0", "NaN"]) {
    process.env.RIPPERCRAFT_MAX_UPLOAD_MB = value;
    assert.equal(resolveUploadLimitBytes(logger), 4096 * megabyte, value);
  }
  assert.equal(warnings.length, 4);
  assert.deepEqual(warnings[0][1], { value: "lots" });
});

// --- over HTTP, onto a real disk ---------------------------------------------

async function appWithAdmin(t, appOptions = {}) {
  const app = await startApp(t, { app: appOptions });
  const owner = await app.setupOwner();
  assert.equal(
    (await owner("PUT", "/api/servers/DemoServer/settings", { json: { loader: "fabric", passphrase: "lane-secret" } })).status,
    200
  );
  const serverDir = path.join(app.root, "servers", "DemoServer");
  return {
    app,
    library: path.join(serverDir, ".rippermoon", "world-library"),
    mods: path.join(serverDir, "mods"),
    owner
  };
}

function upload(client, urlPath, parts, extra = {}) {
  return client("POST", urlPath, {
    body: extra.body || multipartBody(parts),
    headers: { "Content-Type": `multipart/form-data; boundary=${BOUNDARY}`, ...(extra.headers || {}) }
  });
}

async function listing(directory) {
  try {
    return (await fsp.readdir(directory)).sort();
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function waitFor(check, what, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("a world archive is streamed into the library and leaves no temporary file", async (t) => {
  const { library, owner } = await appWithAdmin(t);
  const archive = crypto.randomBytes(3 * 1024 * 1024 + 123);

  const response = await upload(owner, "/api/servers/DemoServer/worlds/import", [filePart("archive", "my world (1).zip", archive)]);
  assert.equal(response.status, 201);
  assert.match(response.json.archiveName, /^\d{4}-.*-my-world-1-\.zip$/);

  assert.deepEqual(await listing(library), [response.json.archiveName]);
  const stored = await fsp.readFile(path.join(library, response.json.archiveName));
  assert.ok(stored.equals(archive));

  const worlds = (await owner("GET", "/api/servers/DemoServer/worlds")).json.worlds;
  assert.equal(worlds.filter((world) => world.kind === "archive").length, 1);

  const missing = await upload(owner, "/api/servers/DemoServer/worlds/import", [fieldPart("archive", "not a file")]);
  assert.equal(missing.status, 400);
  assert.deepEqual(missing.json, { error: "A zip archive is required." });
  assert.deepEqual(await listing(library), [response.json.archiveName]);
});

test("a mod jar is streamed into the add-on directory, with fields after the file still read", async (t) => {
  const { mods, owner } = await appWithAdmin(t);
  const jar = crypto.randomBytes(200_000);

  // The form sends the confirmation after the file, as the page does.
  const response = await upload(owner, "/api/servers/DemoServer/mods/upload", [
    filePart("file", "Example Mod.jar", jar),
    fieldPart("confirmManualCompatibility", "true")
  ]);
  assert.equal(response.status, 201);
  assert.equal(response.json.installed[0].fileName, "Example-Mod.jar");

  assert.deepEqual(await listing(mods), ["Example-Mod.jar"]);
  assert.ok((await fsp.readFile(path.join(mods, "Example-Mod.jar"))).equals(jar));
  // Same permissions a plain write would have given it.
  const plain = path.join(mods, "..", "plain-write-for-comparison");
  await fsp.writeFile(plain, "x");
  assert.equal((await fsp.stat(path.join(mods, "Example-Mod.jar"))).mode & 0o777, (await fsp.stat(plain)).mode & 0o777);
  await fsp.rm(plain);

  // Uploading the same name again replaces the file in one step.
  const replacement = crypto.randomBytes(1000);
  const again = await upload(owner, "/api/servers/DemoServer/mods/upload", [
    filePart("file", "Example Mod.jar", replacement),
    fieldPart("confirmManualCompatibility", "true")
  ]);
  assert.equal(again.status, 201);
  assert.ok((await fsp.readFile(path.join(mods, "Example-Mod.jar"))).equals(replacement));
  assert.deepEqual(await listing(mods), ["Example-Mod.jar"]);
});

test("form data built by a real client's FormData is understood", async (t) => {
  // The bodies above are assembled by hand. This one is whatever fetch makes of
  // a FormData - its own boundary, header spelling and field order.
  const { app, library, mods, owner } = await appWithAdmin(t);
  const post = (urlPath, form) =>
    fetch(`${app.origin}${urlPath}`, { body: form, headers: { Cookie: owner.cookie() }, method: "POST" });

  const jar = crypto.randomBytes(150_000);
  const modForm = new FormData();
  modForm.set("confirmManualCompatibility", "true");
  modForm.set("file", new Blob([jar], { type: "application/java-archive" }), "From Fetch \u00e9\u4e16.jar");
  const modResponse = await post("/api/servers/DemoServer/mods/upload", modForm);
  assert.equal(modResponse.status, 201);
  const [installed] = (await modResponse.json()).installed;
  assert.match(installed.fileName, /^From-Fetch-.*\.jar$/);
  assert.deepEqual(await listing(mods), [installed.fileName]);
  assert.ok((await fsp.readFile(path.join(mods, installed.fileName))).equals(jar));

  const archive = crypto.randomBytes(400_000);
  const worldForm = new FormData();
  worldForm.set("archive", new Blob([archive]), "fetched.zip");
  const worldResponse = await post("/api/servers/DemoServer/worlds/import", worldForm);
  assert.equal(worldResponse.status, 201);
  const { archiveName } = await worldResponse.json();
  assert.ok((await fsp.readFile(path.join(library, archiveName))).equals(archive));

  // A file input left empty.
  const emptyForm = new FormData();
  emptyForm.set("archive", new Blob([]), "");
  assert.equal((await post("/api/servers/DemoServer/worlds/import", emptyForm)).status, 400);
  assert.deepEqual(await listing(library), [archiveName]);
});

test("an upload that is refused after it arrived still has its temporary file removed", async (t) => {
  const { mods, owner } = await appWithAdmin(t);

  // No compatibility confirmation.
  const unconfirmed = await upload(owner, "/api/servers/DemoServer/mods/upload", [filePart("file", "mod.jar", "jar bytes")]);
  assert.notEqual(unconfirmed.status, 201);
  assert.match(unconfirmed.json.error, /explicit compatibility confirmation/);
  assert.deepEqual(await listing(mods), []);

  // Not a jar.
  const notJar = await upload(owner, "/api/servers/DemoServer/mods/upload", [
    filePart("file", "script.sh", "#!/bin/sh"),
    fieldPart("confirmManualCompatibility", "true")
  ]);
  assert.notEqual(notJar.status, 201);
  assert.match(notJar.json.error, /Only \.jar/);
  assert.deepEqual(await listing(mods), []);

  // No file at all, and a malformed body.
  const empty = await upload(owner, "/api/servers/DemoServer/mods/upload", [filePart("file", "", "")]);
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.json, { error: "A file upload is required." });
  const truncated = await upload(owner, "/api/servers/DemoServer/mods/upload", [], {
    body: multipartBody([filePart("file", "mod.jar", "partial")], { close: false })
  });
  assert.equal(truncated.status, 400);
  assert.deepEqual(truncated.json, { error: "The upload ended before it was complete." });
  assert.deepEqual(await listing(mods), []);

  // JSON sent to an upload route is the wrong kind of body.
  const wrongType = await owner("POST", "/api/servers/DemoServer/mods/upload", { json: { file: "mod.jar" } });
  assert.equal(wrongType.status, 415);
  assert.deepEqual(await listing(mods), []);
});

test("an upload over the limit gets 413 whether or not it declared its size, and leaves nothing behind", async (t) => {
  const limit = 64 * 1024;
  const { app, library, mods, owner } = await appWithAdmin(t, { uploadLimitBytes: limit });
  assert.equal((await app.request({ path: "/api/bootstrap" })).json.uploadLimitBytes, limit);
  const tooBig = crypto.randomBytes(limit + 1);

  // Whether a temporary file was ever opened tells the two refusals apart.
  const realOpen = fsp.open;
  let tempFilesOpened = 0;
  t.mock.method(fsp, "open", (...args) => {
    if (/\.upload-[0-9a-f]{16}\.part$/.test(String(args[0]))) {
      tempFilesOpened += 1;
    }
    return realOpen(...args);
  });

  // Content-Length gives it away before a byte of the file is taken: nothing
  // is opened, nothing is written.
  const declared = await upload(owner, "/api/servers/DemoServer/worlds/import", [
    filePart("archive", "huge.zip", crypto.randomBytes(3 * 1024 * 1024))
  ]);
  assert.equal(declared.status, 413);
  assert.deepEqual(declared.json, { error: "That file is larger than the 64 KB upload limit." });
  assert.equal(tempFilesOpened, 0);
  assert.deepEqual(await listing(library), []);

  // Just over the limit, inside the allowance for the form's own overhead, so
  // it is the byte count while streaming that catches it - after the file was
  // opened, which is why it then has to be removed.
  const counted = await upload(owner, "/api/servers/DemoServer/worlds/import", [filePart("archive", "over.zip", tooBig)]);
  assert.equal(counted.status, 413);
  assert.deepEqual(counted.json, { error: "That file is larger than the 64 KB upload limit." });
  assert.equal(tempFilesOpened, 1);
  assert.deepEqual(await listing(library), []);

  // No Content-Length at all.
  const chunked = await upload(owner, "/api/servers/DemoServer/mods/upload", [], {
    body: multipartBody([filePart("file", "over.jar", tooBig), fieldPart("confirmManualCompatibility", "true")]),
    headers: { "Transfer-Encoding": "chunked" }
  });
  assert.equal(chunked.status, 413);
  assert.deepEqual(await listing(mods), []);

  // Exactly at the limit is accepted.
  const atLimit = await upload(owner, "/api/servers/DemoServer/worlds/import", [
    filePart("archive", "fits.zip", tooBig.subarray(0, limit))
  ]);
  assert.equal(atLimit.status, 201);
  assert.deepEqual(await listing(library), [atLimit.json.archiveName]);
  assert.equal((await fsp.stat(path.join(library, atLimit.json.archiveName))).size, limit);
});

test("a client that disconnects part-way leaves no temporary file and no archive", async (t) => {
  const { app, library, owner } = await appWithAdmin(t);
  const body = multipartBody([filePart("archive", "interrupted.zip", crypto.randomBytes(512 * 1024))]);

  const socket = net.connect(app.port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(
    [
      "POST /api/servers/DemoServer/worlds/import HTTP/1.1",
      "Host: 127.0.0.1",
      `Cookie: ${owner.cookie()}`,
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`,
      `Content-Length: ${body.length}`,
      "",
      ""
    ].join("\r\n")
  );
  // Half of the file, then nothing.
  socket.write(body.subarray(0, body.length / 2));

  const partial = await waitFor(async () => {
    const names = await listing(library);
    return names.length === 1 && /^\.upload-[0-9a-f]{16}\.part$/.test(names[0]) ? names[0] : null;
  }, "the temporary file to appear");
  assert.ok((await fsp.stat(path.join(library, partial))).size > 0);
  // While it is in flight it is not offered as a world.
  assert.deepEqual(
    (await owner("GET", "/api/servers/DemoServer/worlds")).json.worlds.filter((world) => world.kind === "archive"),
    []
  );

  socket.destroy();
  await waitFor(async () => (await listing(library)).length === 0, "the temporary file to be removed");

  // Noted as the client's doing, not logged as a fault of the server.
  const refused = await waitFor(
    () => app.logs.find((entry) => entry.message === "HTTP request refused"),
    "the aborted upload to be logged"
  );
  assert.equal(refused.meta.error, "The connection closed before the upload finished.");
  assert.equal(app.logs.some((entry) => entry.level === "error"), false);
});

test("a client that disconnects while the temporary file is still being opened leaves nothing behind", async (t) => {
  // The cleanup used to run before the file existed: the open finished a moment
  // later, and its file and its handle then belonged to nobody.
  const { app, library, owner } = await appWithAdmin(t);
  const body = multipartBody([filePart("archive", "interrupted.zip", crypto.randomBytes(200_000))]);

  // Make the open slow enough for the disconnect to land in the middle of it.
  const realOpen = fsp.open;
  const handles = [];
  let opening = 0;
  t.mock.method(fsp, "open", async (...args) => {
    if (!/\.upload-[0-9a-f]{16}\.part$/.test(String(args[0]))) {
      return await realOpen(...args);
    }
    opening += 1;
    await new Promise((resolve) => setTimeout(resolve, 150));
    const handle = await realOpen(...args);
    handles.push(handle);
    return handle;
  });

  for (let round = 0; round < 3; round += 1) {
    const socket = net.connect(app.port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(
      [
        "POST /api/servers/DemoServer/worlds/import HTTP/1.1",
        "Host: 127.0.0.1",
        `Cookie: ${owner.cookie()}`,
        `Content-Type: multipart/form-data; boundary=${BOUNDARY}`,
        `Content-Length: ${body.length}`,
        "",
        ""
      ].join("\r\n")
    );
    socket.write(body.subarray(0, 50_000));
    await waitFor(() => opening === round + 1, "the upload to start opening its file");
    socket.destroy();
  }

  // Each open still completes, after its upload has been given up...
  await waitFor(() => handles.length === 3, "the delayed opens to finish");
  // ...and each file is closed and removed all the same.
  await waitFor(async () => (await listing(library)).length === 0, "the temporary files to be removed");
  await waitFor(() => handles.every((handle) => handle.fd === -1), "the file handles to be closed");
  assert.equal(app.logs.some((entry) => entry.level === "error"), false);

  // The next upload is unaffected.
  t.mock.restoreAll();
  const response = await upload(owner, "/api/servers/DemoServer/worlds/import", [filePart("archive", "after.zip", "zip bytes")]);
  assert.equal(response.status, 201);
  assert.deepEqual(await listing(library), [response.json.archiveName]);
});

test("an upload in progress does not show up as an installed add-on", async (t) => {
  const { app, mods, owner } = await appWithAdmin(t);
  const body = multipartBody([filePart("file", "slow.jar", crypto.randomBytes(256 * 1024)), fieldPart("confirmManualCompatibility", "true")]);

  const socket = net.connect(app.port, "127.0.0.1");
  socket.on("error", () => {});
  await once(socket, "connect");
  socket.write(
    [
      "POST /api/servers/DemoServer/mods/upload HTTP/1.1",
      "Host: 127.0.0.1",
      `Cookie: ${owner.cookie()}`,
      `Content-Type: multipart/form-data; boundary=${BOUNDARY}`,
      `Content-Length: ${body.length}`,
      "",
      ""
    ].join("\r\n")
  );
  socket.write(body.subarray(0, 100_000));
  await waitFor(async () => (await listing(mods)).length === 1, "the temporary file to appear");

  assert.deepEqual((await owner("GET", "/api/servers/DemoServer/mods")).json.mods, []);
  assert.equal((await owner("GET", "/api/servers")).json.servers[0].modCount, 0);

  // The rest arrives and the upload completes normally.
  let response = "";
  socket.on("data", (chunk) => {
    response += chunk.toString("latin1");
  });
  socket.write(body.subarray(100_000));
  await waitFor(() => response.includes("\r\n\r\n") && response.includes("slow.jar"), "the upload to finish");
  socket.destroy();

  assert.match(response, /^HTTP\/1\.1 201 /);
  assert.deepEqual(await listing(mods), ["slow.jar"]);
  assert.deepEqual(
    (await owner("GET", "/api/servers/DemoServer/mods")).json.mods.map((mod) => mod.fileName),
    ["slow.jar"]
  );
});

test("temporary files left by a crash are cleared out by the next upload, recent ones are not", async (t) => {
  const { library, owner } = await appWithAdmin(t);
  await fsp.mkdir(library, { recursive: true });
  const stale = path.join(library, ".upload-00000000deadbeef.part");
  const recent = path.join(library, ".upload-1111111111111111.part");
  const unrelated = path.join(library, ".upload-notes.txt");
  for (const file of [stale, recent, unrelated]) {
    await fsp.writeFile(file, "left behind");
  }
  const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fsp.utimes(stale, twoDaysAgo, twoDaysAgo);
  await fsp.utimes(unrelated, twoDaysAgo, twoDaysAgo);

  const response = await upload(owner, "/api/servers/DemoServer/worlds/import", [filePart("archive", "fresh.zip", "zip bytes")]);
  assert.equal(response.status, 201);

  // The stale one is gone; one that may belong to an upload still running, and
  // a file that only resembles ours, are left alone.
  assert.deepEqual(await listing(library), [".upload-1111111111111111.part", ".upload-notes.txt", response.json.archiveName].sort());
});

test("uploads are refused before any of the body is read when the caller may not make them", async (t) => {
  const { app, library, mods, owner } = await appWithAdmin(t);
  await owner("POST", "/api/users", { json: { password: ADMIN_PASSWORD, servers: ["DemoServer"], username: "lane" } });
  await owner("POST", "/api/users", { json: { password: ADMIN_PASSWORD, servers: [], username: "moss" } });

  // Sends the headers of a 3 GB upload and none of the body: an answer can
  // only come back if the server decided without waiting for it.
  async function headersOnly(urlPath, cookie) {
    const socket = net.connect(app.port, "127.0.0.1");
    socket.on("error", () => {});
    await once(socket, "connect");
    socket.write(
      [
        `POST ${urlPath} HTTP/1.1`,
        "Host: 127.0.0.1",
        ...(cookie ? [`Cookie: ${cookie}`] : []),
        `Content-Type: multipart/form-data; boundary=${BOUNDARY}`,
        `Content-Length: ${3 * 1024 * 1024 * 1024}`,
        "",
        ""
      ].join("\r\n")
    );
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
    });
    await waitFor(() => /\r\n\r\n.*\n/s.test(response), `an answer for ${urlPath}`);
    socket.destroy();
    return { body: response.split("\r\n\r\n")[1], status: Number(response.split(" ")[1]) };
  }

  // Not logged in.
  assert.equal((await headersOnly("/api/servers/DemoServer/mods/upload", null)).status, 401);
  assert.equal((await headersOnly("/api/servers/DemoServer/worlds/import", null)).status, 401);

  // Logged in, but the server is locked for this admin.
  const lane = app.client();
  await lane("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "lane" } });
  const locked = await headersOnly("/api/servers/DemoServer/mods/upload", lane.cookie());
  assert.equal(locked.status, 403);
  assert.match(locked.body, /Unlock the server/);
  assert.equal((await headersOnly("/api/servers/DemoServer/worlds/import", lane.cookie())).status, 403);

  // Logged in, with no access to this server at all.
  const moss = app.client();
  await moss("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "moss" } });
  assert.equal((await headersOnly("/api/servers/DemoServer/mods/upload", moss.cookie())).status, 403);

  assert.deepEqual(await listing(mods), []);
  assert.deepEqual(await listing(library), []);
});
