const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { promisify } = require("node:util");
const { HttpError, describeBytes } = require("./http");

// Unpacks a world archive that somebody uploaded.
//
// This used to be `unzip`, followed by a copy of whatever it had produced. An
// archive can hold symbolic links, and unzip creates them: an admin uploaded a
// world with a link to somewhere else on the machine, restored it, backed the
// world up again - which followed the link - and downloaded the result. unzip
// also believes nothing an archive says about its own size: a few hundred
// kilobytes unpacked to as much as the disk would hold, including when the
// headers claimed ten bytes.
//
// So the archive is read here instead, and only ever turned into two things:
// directories and regular files.
//
//   * An entry that is a symbolic link or a device is refused, by name. Nothing
//     is ever created from one.
//   * Every name is checked before anything is written: no absolute paths, no
//     "..", no control characters.
//   * The sizes in the archive's directory are added up first and held against
//     the limit, and then enforced: an entry that turns out to hold more than it
//     declared stops the whole thing. What is written can therefore never
//     exceed what was checked.
//   * Folders count too. An empty folder holds no bytes but takes a block of
//     the disk, and a path may name hundreds of them: a hundred kilobytes of
//     archive made fifty thousand folders under a limit of nothing. Each folder
//     is charged to the limit and counted with the files, and a path may only
//     be so many names long.
//   * Each file's checksum is verified, so a damaged archive is refused rather
//     than restored.
//
// Stored and deflated entries are supported, with or without ZIP64 - which is
// everything `zip`, 7-Zip, macOS and Windows produce by default.

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;

const EOCD_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const ZIP64_LOCATOR_LENGTH = 20;
const ZIP64_EOCD_LENGTH = 56;

// A world is a few thousand files; a very large one, tens of thousands. The
// limit is on files and folders together, including every folder a path
// implies without listing it.
const DEFAULT_MAX_ENTRIES = 200_000;
// 46 bytes and a name per entry. More than the entry limit can need, and
// little enough to hold in memory.
const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_NAME_BYTES = 1024;
// How many names long a path may be, the file's own included. Minecraft's own
// are a handful, a data pack's a dozen.
const MAX_DEPTH = 64;
// What a folder is charged against the size limit: the block it takes on disk.
const FOLDER_COST_BYTES = 4096;
// Reading a long list of contents is done in pieces, with a pause between them
// so the dashboard keeps answering other requests. A piece is this much work:
// one for an entry and one for each folder on its path.
const WORK_PER_SLICE = 2000;
const READ_CHUNK_BYTES = 256 * 1024;
// Most of a world is small files - player data, statistics, one per player -
// and setting up streams for each costs more than unpacking it. Anything this
// size or smaller is unpacked in one piece instead.
const SMALL_FILE_BYTES = 1024 * 1024;

const inflateRaw = promisify(zlib.inflateRaw);

const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const METHOD_NAMES = { 9: "Deflate64", 12: "bzip2", 14: "LZMA", 93: "Zstandard", 95: "XZ", 98: "PPMd", 99: "AES encryption" };

// "Version made by" hosts whose external attributes carry a Unix file mode.
const UNIX_HOSTS = new Set([3, 19]);
const TYPE_MASK = 0o170000;
const TYPE_FILE = 0o100000;
const TYPE_DIRECTORY = 0o040000;
const TYPE_SYMLINK = 0o120000;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function archiveError(message, statusCode = 400) {
  return new HttpError(statusCode, message);
}

function damaged(detail) {
  return archiveError(`This is not a zip archive the dashboard can read (${detail}).`);
}

async function readExactly(handle, position, length, what) {
  if (length === 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) {
    throw damaged(`${what} is cut short`);
  }
  return buffer;
}

// A 64-bit field as a number. Anything past 2^53 is not a real file size.
function readUInt64(buffer, offset) {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw damaged("a size in it is impossibly large");
  }
  return Number(value);
}

// Where the central directory is and how many entries it lists.
async function locateDirectory(handle, fileSize) {
  if (fileSize < EOCD_LENGTH) {
    throw damaged("it is too short");
  }
  const tailLength = Math.min(fileSize, EOCD_LENGTH + MAX_COMMENT_LENGTH);
  const tailStart = fileSize - tailLength;
  const tail = await readExactly(handle, tailStart, tailLength, "the end of the file");

  let eocd = -1;
  for (let index = tail.length - EOCD_LENGTH; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE && index + EOCD_LENGTH + tail.readUInt16LE(index + 20) <= tail.length) {
      eocd = index;
      break;
    }
  }
  if (eocd === -1) {
    throw damaged("it has no end-of-archive record");
  }

  let disk = tail.readUInt16LE(eocd + 4);
  let directoryDisk = tail.readUInt16LE(eocd + 6);
  let entriesHere = tail.readUInt16LE(eocd + 8);
  let entries = tail.readUInt16LE(eocd + 10);
  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);

  // ZIP64: more than 65,535 entries or 4 GB. The real numbers are in a second
  // record, found through a locator that sits just before this one.
  const locatorPosition = tailStart + eocd - ZIP64_LOCATOR_LENGTH;
  if (locatorPosition >= 0) {
    const locator = await readExactly(handle, locatorPosition, ZIP64_LOCATOR_LENGTH, "the ZIP64 locator");
    if (locator.readUInt32LE(0) === ZIP64_LOCATOR_SIGNATURE) {
      if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) > 1) {
        throw archiveError("Archives split across several files are not supported. Upload the world as one zip.");
      }
      const recordPosition = readUInt64(locator, 8);
      if (recordPosition + ZIP64_EOCD_LENGTH > fileSize) {
        throw damaged("its ZIP64 record points outside the file");
      }
      const record = await readExactly(handle, recordPosition, ZIP64_EOCD_LENGTH, "the ZIP64 record");
      if (record.readUInt32LE(0) !== ZIP64_EOCD_SIGNATURE) {
        throw damaged("its ZIP64 record is missing");
      }
      disk = record.readUInt32LE(16);
      directoryDisk = record.readUInt32LE(20);
      entriesHere = readUInt64(record, 24);
      entries = readUInt64(record, 32);
      size = readUInt64(record, 40);
      offset = readUInt64(record, 48);
    }
  }

  if (disk !== 0 || directoryDisk !== 0 || entriesHere !== entries) {
    throw archiveError("Archives split across several files are not supported. Upload the world as one zip.");
  }
  if (offset + size > fileSize) {
    throw damaged("its directory points outside the file");
  }
  return { entries, offset, size };
}

// The name of an entry as text. The archive says when a name is UTF-8; when it
// does not, it usually still is (zip on Linux and macOS writes it that way),
// and otherwise each byte is taken as one character.
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeName(bytes, declaredUtf8) {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    if (declaredUtf8) {
      throw damaged("a file name in it is not valid UTF-8");
    }
    return bytes.toString("latin1");
  }
}

// A name as it is quoted in a refusal.
function quoted(name) {
  return JSON.stringify(name.slice(0, 80));
}

// The path an entry will be written to, relative to the folder being unpacked
// into, as a list of names. Refuses anything that is not a plain path downward.
// An empty list is the folder itself ("./"), which some tools list first.
function safeSegments(name) {
  // Windows tools write backslashes; treated as separators they are held to
  // the same rules instead of becoming part of a file name.
  const normalized = name.includes("\\") ? name.replaceAll("\\", "/") : name;
  if (!normalized || normalized.startsWith("/")) {
    throw archiveError(`The archive holds an entry with an absolute path (${quoted(name)}), which is not allowed.`);
  }
  if (CONTROL_CHARACTERS.test(normalized)) {
    throw archiveError("The archive holds a file name with control characters in it, which is not allowed.");
  }
  // "." means "here" and changes nothing, so "./world/level.dat" - how bsdtar
  // and tar-like tools write a path - is "world/level.dat".
  const segments = normalized.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length > MAX_DEPTH) {
    throw archiveError(`The archive holds a path more than ${MAX_DEPTH} names long (${quoted(name)}), which is not allowed.`);
  }
  for (const segment of segments) {
    if (segment === ".." || (segment.length === 2 && /^[A-Za-z]:$/.test(segment))) {
      throw archiveError(`The archive holds a path that leads outside the world folder (${quoted(name)}), which is not allowed.`);
    }
    if (segment.length > 85 && Buffer.byteLength(segment) > 255) {
      throw archiveError("The archive holds a file name longer than 255 bytes, which cannot be created.");
    }
  }
  return segments;
}

// Reads the whole central directory and checks every entry in it. Nothing is
// written by this; it is what decides whether anything will be.
async function readEntries(handle, fileSize, limits) {
  const directory = await locateDirectory(handle, fileSize);
  if (directory.entries > limits.maxEntries) {
    throw archiveError(
      `The archive holds ${directory.entries.toLocaleString("en")} entries; at most ${limits.maxEntries.toLocaleString("en")} can be unpacked.`,
      413
    );
  }
  if (directory.size > MAX_DIRECTORY_BYTES) {
    throw archiveError("The archive's list of contents is too large to read.", 413);
  }
  const central = await readExactly(handle, directory.offset, directory.size, "the list of contents");

  const entries = [];
  // Every folder that unpacking will create: the ones the archive lists and
  // the ones its paths pass through. Each is known by the folder it is in and
  // its own name, not by its whole path, so that remembering them takes about
  // as much memory as the list of contents itself and no more.
  const folders = new Map();
  const tooMany = () =>
    archiveError(
      `The archive holds more than ${limits.maxEntries.toLocaleString("en")} files and folders, which is more than can be unpacked.`,
      413
    );
  const addFolders = (segments, count) => {
    let parent = 0;
    for (let depth = 0; depth < count; depth += 1) {
      const key = `${parent}/${segments[depth]}`;
      let folder = folders.get(key);
      if (folder === undefined) {
        folder = folders.size + 1;
        folders.set(key, folder);
      }
      parent = folder;
    }
  };
  let cursor = 0;
  let files = 0;
  let totalBytes = 0;
  let workDone = 0;
  for (let index = 0; index < directory.entries; index += 1) {
    if (workDone >= WORK_PER_SLICE) {
      workDone = 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
    if (cursor + 46 > central.length || central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw damaged("its list of contents is cut short");
    }
    const madeBy = central.readUInt16LE(cursor + 4);
    const flags = central.readUInt16LE(cursor + 8);
    const method = central.readUInt16LE(cursor + 10);
    const crc = central.readUInt32LE(cursor + 16);
    let compressedSize = central.readUInt32LE(cursor + 20);
    let size = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    let localOffset = central.readUInt32LE(cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > central.length) {
      throw damaged("its list of contents is cut short");
    }
    if (nameLength > MAX_NAME_BYTES) {
      throw archiveError(`The archive holds a path longer than ${MAX_NAME_BYTES} bytes, which is not allowed.`);
    }
    const nameBytes = central.subarray(cursor + 46, cursor + 46 + nameLength);
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
    cursor = end;

    // ZIP64 extended information: only the fields that overflowed are present,
    // in this fixed order.
    for (let at = 0; at + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(at);
      const length = extra.readUInt16LE(at + 2);
      if (id === 0x0001) {
        let field = at + 4;
        const limit = Math.min(extra.length, field + length);
        const next = () => {
          if (field + 8 > limit) {
            throw damaged("a ZIP64 size in it is missing");
          }
          const value = readUInt64(extra, field);
          field += 8;
          return value;
        };
        if (size === 0xffffffff) {
          size = next();
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = next();
        }
        if (localOffset === 0xffffffff) {
          localOffset = next();
        }
        break;
      }
      at += 4 + length;
    }

    const name = decodeName(nameBytes, Boolean(flags & 0x0800));
    if (flags & 0x2041) {
      throw archiveError("The archive is encrypted. Upload the world as a plain zip, without a password.");
    }

    const mode = UNIX_HOSTS.has(madeBy >> 8) ? externalAttributes >>> 16 : 0;
    const type = mode & TYPE_MASK;
    if (type === TYPE_SYMLINK) {
      throw archiveError(
        `The archive holds a symbolic link (${quoted(name)}). Links are not restored: they can point anywhere on this machine. Replace the link with the files it stands for and zip the world again.`
      );
    }
    if (type !== 0 && type !== TYPE_FILE && type !== TYPE_DIRECTORY) {
      throw archiveError(`The archive holds something that is neither a file nor a folder (${quoted(name)}), which is not restored.`);
    }

    const segments = safeSegments(name);
    workDone += 1 + segments.length;
    const last = name.charCodeAt(name.length - 1);
    const isDirectory =
      last === 0x2f || last === 0x5c || type === TYPE_DIRECTORY || (type === 0 && Boolean(externalAttributes & 0x10) && size === 0);
    if (isDirectory) {
      // "./" on its own is the folder being unpacked into: nothing to make.
      if (segments.length) {
        addFolders(segments, segments.length);
        if (folders.size + files > limits.maxEntries) {
          throw tooMany();
        }
        entries.push({ isDirectory: true, name, segments });
      }
      continue;
    }
    if (!segments.length) {
      throw damaged("an entry in it has no name");
    }

    if (method !== METHOD_STORED && method !== METHOD_DEFLATED) {
      throw archiveError(
        `The archive is compressed with ${METHOD_NAMES[method] || `method ${method}`}, which the dashboard cannot unpack (${quoted(name)}). Zip the world again with the standard "deflate" compression.`
      );
    }
    if (method === METHOD_STORED && compressedSize !== size) {
      throw damaged("a stored file in it has two different sizes");
    }
    if (localOffset + 30 > fileSize || compressedSize > fileSize) {
      throw damaged("an entry in it points outside the file");
    }

    files += 1;
    totalBytes += size;
    addFolders(segments, segments.length - 1);
    if (folders.size + files > limits.maxEntries) {
      throw tooMany();
    }
    entries.push({
      compressedSize,
      crc,
      isDirectory: false,
      localOffset,
      method,
      name,
      segments,
      size
    });
  }

  return {
    entries,
    summary: {
      directories: folders.size,
      files,
      totalBytes,
      // What is held against the size limit: the files, and a block per folder.
      weight: totalBytes + folders.size * FOLDER_COST_BYTES
    }
  };
}

function resolveLimits(options = {}) {
  return {
    maxBytes: options.maxBytes === undefined ? Number.MAX_SAFE_INTEGER : options.maxBytes,
    maxEntries: options.maxEntries === undefined ? DEFAULT_MAX_ENTRIES : options.maxEntries
  };
}

function assertWithinLimit(summary, limits) {
  if (summary.weight > limits.maxBytes) {
    throw archiveError(
      `This archive unpacks to ${describeBytes(summary.weight)}, and the limit is ${describeBytes(limits.maxBytes)}. ` +
        "If the world really is that large, raise RIPPERCRAFT_MAX_WORLD_MB.",
      413
    );
  }
}

// Checks an archive without unpacking it: that it can be read, that everything
// in it is a file or a folder with a safe name, and that it fits the limit.
//
// Resolves to { directories, files, totalBytes, weight }: how many folders and
// files unpacking would create, what the files add up to, and what is held
// against the limit - the files plus a block for each folder.
async function inspectZip(archivePath, options = {}) {
  const limits = resolveLimits(options);
  const handle = await fsp.open(archivePath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const { summary } = await readEntries(handle, fileSize, limits);
    assertWithinLimit(summary, limits);
    return summary;
  } finally {
    await handle.close();
  }
}

// Passes data through while counting it and keeping its CRC-32, and fails the
// moment there is more of it than the archive said there would be.
function createMeter(entry, tooMuch) {
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      meter.bytes += chunk.length;
      if (meter.bytes > entry.size) {
        callback(tooMuch());
        return;
      }
      meter.crc = zlib.crc32(chunk, meter.crc);
      callback(null, chunk);
    }
  });
  meter.bytes = 0;
  meter.crc = 0;
  return meter;
}

// One entry's bytes as they sit in the archive, read in pieces. A generator
// rather than a stream made from the handle: such a stream keeps a claim on
// the handle that only goes when the stream is destroyed, and the handle is
// shared by every entry.
async function* readRange(handle, start, length) {
  let position = start;
  let remaining = length;
  while (remaining > 0) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      throw damaged("a file in it is cut short");
    }
    position += bytesRead;
    remaining -= bytesRead;
    yield bytesRead === buffer.length ? buffer : buffer.subarray(0, bytesRead);
  }
}

async function extractFile(handle, fileSize, entry, targetPath) {
  const header = await readExactly(handle, entry.localOffset, 30, "a file header");
  if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
    throw damaged("a file header in it is missing");
  }
  const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (dataStart + entry.compressedSize > fileSize) {
    throw damaged("a file in it runs past the end of the archive");
  }

  let output;
  try {
    // "wx": the file must not exist yet. Two entries with one name, or a name
    // that is already a folder, stop here rather than overwrite anything.
    output = await fsp.open(targetPath, "wx", 0o644);
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "EISDIR" || error.code === "ENOTDIR") {
      throw archiveError(`The archive lists ${JSON.stringify(entry.name.slice(0, 80))} more than once, or as both a file and a folder.`);
    }
    throw error;
  }

  const shown = JSON.stringify(entry.name.slice(0, 80));
  const hidesItsSize = () =>
    archiveError(
      `The archive holds more data for ${shown} than it declares, which is how an archive hides its real size. It was not restored.`
    );
  let bytes = 0;
  let crc = 0;
  try {
    if (entry.size <= SMALL_FILE_BYTES && entry.compressedSize <= SMALL_FILE_BYTES) {
      const packed = await readExactly(handle, dataStart, entry.compressedSize, "a file in it");
      let contents = packed;
      if (entry.method === METHOD_DEFLATED) {
        try {
          // Never more than the entry declared, plus one byte to notice with.
          contents = await inflateRaw(packed, { maxOutputLength: entry.size + 1 });
        } catch (error) {
          throw error.code === "ERR_BUFFER_TOO_LARGE" ? hidesItsSize() : error;
        }
      }
      if (contents.length > entry.size) {
        throw hidesItsSize();
      }
      await output.writeFile(contents);
      bytes = contents.length;
      crc = zlib.crc32(contents);
    } else {
      const meter = createMeter(entry, hidesItsSize);
      const source = readRange(handle, dataStart, entry.compressedSize);
      const stages = entry.method === METHOD_DEFLATED ? [source, zlib.createInflateRaw(), meter] : [source, meter];
      try {
        // The write stream closes the output file when it is done or destroyed.
        await pipeline(...stages, output.createWriteStream());
      } finally {
        bytes = meter.bytes;
        crc = meter.crc;
      }
    }
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (typeof error.code === "string" && error.code.startsWith("Z_")) {
      throw damaged(`${shown} is corrupt`);
    }
    throw error;
  } finally {
    await output.close();
  }

  if (bytes !== entry.size || crc !== entry.crc) {
    throw damaged(`${shown} does not match its checksum`);
  }
}

// Unpacks an archive into targetDir, which must exist and be empty.
//
// Rejects - with whatever was unpacked so far still in targetDir, for the
// caller to remove - if the archive cannot be read, holds anything but files
// and folders, or would unpack to more than options.maxBytes.
//
// options.beforeWriting, if given, is called with the same summary inspectZip
// returns once the archive has passed every check and before anything is
// written; if it rejects, nothing is.
// Resolves to { directories, files, totalBytes, weight }.
async function extractZip(archivePath, targetDir, options = {}) {
  const limits = resolveLimits(options);
  const root = path.resolve(targetDir);
  const handle = await fsp.open(archivePath, "r");
  try {
    const { size: fileSize } = await handle.stat();
    const { entries, summary } = await readEntries(handle, fileSize, limits);
    assertWithinLimit(summary, limits);
    if (options.beforeWriting) {
      await options.beforeWriting(summary);
    }

    const made = new Set();
    const makeDirectory = async (segments) => {
      const key = segments.join("/");
      if (!segments.length || made.has(key)) {
        return;
      }
      try {
        await fsp.mkdir(path.join(root, ...segments), { recursive: true });
      } catch (error) {
        if (error.code === "EEXIST" || error.code === "ENOTDIR") {
          throw archiveError(`The archive lists ${JSON.stringify(key.slice(0, 80))} as both a file and a folder.`);
        }
        throw error;
      }
      made.add(key);
    };

    for (const entry of entries) {
      const targetPath = path.join(root, ...entry.segments);
      // The names were checked one by one; this is the same check on the result.
      if (!targetPath.startsWith(`${root}${path.sep}`)) {
        throw archiveError("The archive holds a path that leads outside the world folder, which is not allowed.");
      }
      if (entry.isDirectory) {
        await makeDirectory(entry.segments);
        continue;
      }
      await makeDirectory(entry.segments.slice(0, -1));
      await extractFile(handle, fileSize, entry, targetPath);
    }
    return summary;
  } finally {
    await handle.close();
  }
}

// Walks a folder and makes sure it holds nothing but folders and regular
// files - no symbolic link, socket, pipe or device anywhere in it - and adds up
// what the files weigh. `root` itself must be a real folder too.
//
// Resolves to { directories, files, totalBytes, weight }, where weight is the
// files plus a block for each folder, as for an archive. Rejects, naming the
// first offender, otherwise; and if options.maxBytes is given, when the weight
// comes to more than that.
async function assertPlainTree(root, options = {}) {
  const maxBytes = options.maxBytes === undefined ? Number.MAX_SAFE_INTEGER : options.maxBytes;
  const describe = (target) => JSON.stringify(path.relative(root, target) || path.basename(root));

  const rootStats = await fsp.lstat(root);
  if (!rootStats.isDirectory()) {
    throw archiveError(`${describe(root)} is not a folder: it is a link or a special file, which the dashboard does not follow.`, 409);
  }

  let directories = 0;
  let files = 0;
  let totalBytes = 0;
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    for (const name of await fsp.readdir(directory)) {
      const target = path.join(directory, name);
      const stats = await fsp.lstat(target);
      if (stats.isDirectory()) {
        directories += 1;
        pending.push(target);
      } else if (stats.isFile()) {
        files += 1;
        totalBytes += stats.size;
      } else {
        const kind = stats.isSymbolicLink() ? "a symbolic link" : "neither a file nor a folder";
        throw archiveError(`${describe(target)} is ${kind}, which is not allowed in a world the dashboard restores.`, 409);
      }
      if (totalBytes + directories * FOLDER_COST_BYTES > maxBytes) {
        throw archiveError(`This holds more than the ${describeBytes(maxBytes)} limit allows.`, 413);
      }
    }
  }
  return { directories, files, totalBytes, weight: totalBytes + directories * FOLDER_COST_BYTES };
}

module.exports = {
  DEFAULT_MAX_ENTRIES,
  FOLDER_COST_BYTES,
  MAX_DEPTH,
  assertPlainTree,
  extractZip,
  inspectZip
};
