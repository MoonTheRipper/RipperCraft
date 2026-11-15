const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

// Loader dependency scanning.
//
// Mod jars declare which loader build they need *inside the jar* -
// fabric.mod.json's `depends.fabricloader`, mods.toml's `versionRange`. Neither
// Modrinth nor CurseForge exposes that constraint in its API, so a mod can be
// tagged compatible with the right Minecraft version and still refuse to load.
// That is exactly how a server ends up crashing at boot with
// "requires version X or later of mod 'Fabric Loader'".
//
// Everything here reads jars that are already on disk, so the check costs no
// network calls and answers the only question that matters before a loader
// change: which loader builds can this mod set actually run on?

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT_LENGTH = 0xffff;

// A jar is whatever somebody uploaded, and every size written in it is that
// somebody's claim. What is wanted out of it is one small text file, so that
// is all that is ever read: a list of contents no longer than this, and a
// metadata file no larger than this, packed or unpacked. A 261 KB jar whose
// fabric.mod.json unpacked to 1.1 GB used to be unpacked, in one piece, every
// time the owner opened the server's update panel.
const MAX_CENTRAL_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 1024 * 1024;

// A version as a loader or the game writes one: 0.16.10, 47.4.10, 1.20.1,
// 21.1.1-beta. A bound that is anything else - a hundred thousand digits, a
// line of markup - is not a bound, and is not compared or shown as one.
const VERSION_TEXT = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;
// No range anyone writes by hand comes near this.
const MAX_RANGE_LENGTH = 512;

function usableBound(bound) {
  if (!bound) {
    return null;
  }
  for (const key of ["min", "exclusiveMax", "inclusiveMax"]) {
    const value = bound[key];
    if (value !== undefined && value !== null && !(typeof value === "string" && VERSION_TEXT.test(value))) {
      return null;
    }
  }
  return bound;
}

// Which metadata file and dependency key each loader uses.
const LOADER_METADATA = {
  fabric: { entry: "fabric.mod.json", format: "json", loaderKey: "fabricloader" },
  quilt: { entry: "quilt.mod.json", format: "quilt-json", loaderKey: "quilt_loader" },
  neoforge: { entry: "META-INF/neoforge.mods.toml", format: "toml", loaderKey: "neoforge" },
  forge: { entry: "META-INF/mods.toml", format: "toml", loaderKey: "forge" }
};

function splitVersion(value) {
  return String(value || "")
    .trim()
    .split(/[.\-+_]/)
    .filter((part) => part !== "");
}

// Numeric-segment comparison. Loader versions (0.19.3, 47.4.10, 21.1.100) are
// all dotted numbers, so this stays simple; non-numeric tails compare as text
// so 1.0.0-beta sorts below 1.0.0-rc without pretending to implement semver.
function compareVersions(left, right) {
  const leftParts = splitVersion(left);
  const rightParts = splitVersion(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index];
    const rightPart = rightParts[index];
    if (leftPart === undefined) {
      // 1.2 < 1.2.1, but a numeric tail outranks a textual one: 1.2 > 1.2-beta.
      return /^\d+$/.test(rightPart) ? -1 : 1;
    }
    if (rightPart === undefined) {
      return /^\d+$/.test(leftPart) ? 1 : -1;
    }

    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) {
        return difference < 0 ? -1 : 1;
      }
      continue;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? 1 : -1;
    }
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }

  return 0;
}

function bumpMinor(version) {
  const parts = splitVersion(version);
  const major = Number(parts[0] || 0);
  const minor = Number(parts[1] || 0);
  return Number.isFinite(major) && Number.isFinite(minor) ? `${major}.${minor + 1}.0` : null;
}

function bumpMajor(version) {
  const parts = splitVersion(version);
  const major = Number(parts[0] || 0);
  return Number.isFinite(major) ? `${major + 1}.0.0` : null;
}

// Fabric's own predicate syntax: *, 1.2.3, >=1.2.3, ~1.2.3, ^1.2.3, 1.2.x.
// Space- or comma-separated terms are ANDed, so the strictest lower bound wins.
function parseFabricPredicate(value) {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!raw || raw === "*" || raw.length > MAX_RANGE_LENGTH) {
    return null;
  }

  let bound = null;
  const consider = (found) => {
    const candidate = usableBound(found);
    if (candidate && candidate.min && (!bound || compareVersions(candidate.min, bound.min) > 0)) {
      bound = candidate;
    }
  };

  for (const term of raw.split(/[\s,]+/).filter(Boolean)) {
    const match = term.match(/^(>=|<=|>|<|\^|~|=)?\s*([0-9][0-9A-Za-z.\-+_]*|[0-9xX*.]+)$/);
    if (!match) {
      continue;
    }

    const [, operator = "", version] = match;
    if (operator === "<" || operator === "<=") {
      continue;
    }

    if (operator === "^") {
      consider({ exclusiveMax: bumpMajor(version), min: version, minInclusive: true });
      continue;
    }
    if (operator === "~") {
      consider({ exclusiveMax: bumpMinor(version), min: version, minInclusive: true });
      continue;
    }
    if (operator === ">") {
      consider({ min: version, minInclusive: false });
      continue;
    }
    if (operator === ">=") {
      consider({ min: version, minInclusive: true });
      continue;
    }

    // A bare version. "1.2.x" is a wildcard range; a plain "1.2.3" is exact,
    // but as a floor both behave the same.
    const wildcard = version.match(/^([0-9.]*?)\.?[xX*]$/);
    if (wildcard) {
      const base = wildcard[1];
      consider({ exclusiveMax: bumpMinor(base), min: base, minInclusive: true });
      continue;
    }
    consider({ min: version, minInclusive: true });
  }

  return bound;
}

// Maven version ranges, used by Forge and NeoForge: [47,) (1.0,2.0) [1.0,2.0].
// A bare "47" is Maven's "soft" requirement, which Forge treats as a minimum.
function parseMavenRange(value) {
  const raw = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  if (!raw || raw === "*" || raw.length > MAX_RANGE_LENGTH) {
    return null;
  }

  const bracketed = raw.match(/^([[(])\s*([^,\])]*)\s*,\s*([^,\])]*)\s*([\])])$/);
  if (bracketed) {
    const [, openBracket, low, high, closeBracket] = bracketed;
    if (!low.trim()) {
      return null;
    }
    return usableBound({
      exclusiveMax: closeBracket === ")" && high.trim() ? high.trim() : null,
      inclusiveMax: closeBracket === "]" && high.trim() ? high.trim() : null,
      min: low.trim(),
      minInclusive: openBracket === "["
    });
  }

  const exact = raw.match(/^[[(]\s*([^,\])]+)\s*[\])]$/);
  if (exact) {
    return usableBound({ inclusiveMax: exact[1].trim(), min: exact[1].trim(), minInclusive: true });
  }

  if (/^[0-9]/.test(raw)) {
    return usableBound({ min: raw, minInclusive: true });
  }

  return null;
}

function satisfiesBound(bound, version) {
  if (!bound || !bound.min || !version) {
    return true;
  }
  const lower = compareVersions(version, bound.min);
  if (lower < 0 || (lower === 0 && bound.minInclusive === false)) {
    return false;
  }
  if (bound.exclusiveMax && compareVersions(version, bound.exclusiveMax) >= 0) {
    return false;
  }
  if (bound.inclusiveMax && compareVersions(version, bound.inclusiveMax) > 0) {
    return false;
  }
  return true;
}

async function readBytes(handle, position, length) {
  if (length <= 0) {
    return Buffer.alloc(0);
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
}

// A minimal zip reader: locate the central directory, then inflate just the one
// entry we want. Jars here reach 30MB, so pulling the whole archive into memory
// to read a 2KB manifest is not worth it - and shelling out to `unzip` would add
// a runtime dependency the rest of the dashboard does not need.
async function readJarEntries(jarPath, wantedEntries) {
  const handle = await fsp.open(jarPath, "r");
  try {
    const { size } = await handle.stat();
    if (size < 22) {
      return {};
    }

    const tailLength = Math.min(size, MAX_COMMENT_LENGTH + 22);
    const tail = await readBytes(handle, size - tailLength, tailLength);

    let eocdOffset = -1;
    for (let index = tail.length - 22; index >= 0; index -= 1) {
      if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
        eocdOffset = index;
        break;
      }
    }
    if (eocdOffset === -1) {
      throw new Error("not a zip archive");
    }

    const centralSize = tail.readUInt32LE(eocdOffset + 12);
    const centralOffset = tail.readUInt32LE(eocdOffset + 16);
    if (centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      // ZIP64. No mod jar in practice needs it, and guessing would be worse
      // than saying so.
      throw new Error("zip64 archives are not supported");
    }
    // Room is made for what a header says before any of it is read, so what a
    // header says is held against the file first.
    if (centralOffset + centralSize > size) {
      throw new Error("the archive is damaged: its list of contents points outside the file");
    }
    if (centralSize > MAX_CENTRAL_DIRECTORY_BYTES) {
      throw new Error("the archive's list of contents is too large to read");
    }

    const central = await readBytes(handle, centralOffset, centralSize);
    const wanted = new Set(wantedEntries);
    const located = new Map();

    let cursor = 0;
    while (cursor + 46 <= central.length) {
      if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
        break;
      }
      const compressionMethod = central.readUInt16LE(cursor + 10);
      const compressedSize = central.readUInt32LE(cursor + 20);
      const nameLength = central.readUInt16LE(cursor + 28);
      const extraLength = central.readUInt16LE(cursor + 30);
      const commentLength = central.readUInt16LE(cursor + 32);
      const localOffset = central.readUInt32LE(cursor + 42);
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

      if (wanted.has(name)) {
        located.set(name, { compressedSize, compressionMethod, localOffset });
      }

      cursor += 46 + nameLength + extraLength + commentLength;
    }

    const results = {};
    for (const [name, entry] of located) {
      const localHeader = await readBytes(handle, entry.localOffset, 30);
      if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== LOCAL_SIGNATURE) {
        continue;
      }
      const dataOffset =
        entry.localOffset + 30 + localHeader.readUInt16LE(26) + localHeader.readUInt16LE(28);
      if (dataOffset + entry.compressedSize > size) {
        throw new Error(`the archive is damaged: ${name} points outside the file`);
      }
      if (entry.compressedSize > MAX_METADATA_BYTES) {
        throw new Error(`${name} is too large to read`);
      }
      const raw = await readBytes(handle, dataOffset, entry.compressedSize);
      if (entry.compressionMethod === 0) {
        results[name] = raw.toString("utf8");
      } else if (entry.compressionMethod === 8) {
        try {
          results[name] = zlib.inflateRawSync(raw, { maxOutputLength: MAX_METADATA_BYTES }).toString("utf8");
        } catch (error) {
          // Stopped at the limit, with that much unpacked and no more.
          if (error.code === "ERR_BUFFER_TOO_LARGE") {
            throw new Error(`${name} is too large to read`);
          }
          throw new Error(`the archive is damaged: ${name} cannot be unpacked`);
        }
      }
    }

    return results;
  } finally {
    await handle.close();
  }
}

function firstDependencyValue(value) {
  // fabric.mod.json allows a string or an array of alternatives. Alternatives
  // are ORed, so the loosest one decides what the mod can actually run on.
  if (Array.isArray(value)) {
    const bounds = value.map((entry) => parseFabricPredicate(entry)).filter(Boolean);
    if (!bounds.length) {
      return null;
    }
    return bounds.reduce((lowest, bound) => (compareVersions(bound.min, lowest.min) < 0 ? bound : lowest));
  }
  return parseFabricPredicate(value);
}

// A jar describes itself - its name, its version, the ranges it accepts - and
// the owner's page shows what it says. Anyone who can upload a jar writes that
// description, and in a JSON file a "name" can as easily be an object or a
// megabyte of text. What is passed on is a short piece of text, or nothing.
const METADATA_TEXT_LIMIT = 200;

function metadataText(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value !== "string" || !value) {
    return null;
  }
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, METADATA_TEXT_LIMIT);
}

// A declared range, as written, for display.
function rangeText(value) {
  return value === undefined ? null : metadataText(typeof value === "string" ? value : JSON.stringify(value));
}

function parseFabricMetadata(text, loaderKey) {
  const manifest = JSON.parse(text) || {};
  const depends = manifest.depends && typeof manifest.depends === "object" ? manifest.depends : {};
  const rawLoader = depends[loaderKey];
  const rawMinecraft = depends.minecraft;

  return {
    loaderBound: firstDependencyValue(rawLoader),
    loaderRaw: rawLoader === undefined ? null : rangeText(JSON.stringify(rawLoader)),
    minecraftBound: firstDependencyValue(rawMinecraft),
    minecraftRaw: rawMinecraft === undefined ? null : rangeText(JSON.stringify(rawMinecraft)),
    modId: metadataText(manifest.id),
    name: metadataText(manifest.name) || metadataText(manifest.id),
    version: metadataText(manifest.version)
  };
}

function parseQuiltMetadata(text, loaderKey) {
  const manifest = JSON.parse(text) || {};
  const quiltLoader = manifest.quilt_loader && typeof manifest.quilt_loader === "object" ? manifest.quilt_loader : {};
  const depends = Array.isArray(quiltLoader.depends) ? quiltLoader.depends : [];
  const find = (id) =>
    depends.find((entry) => entry && typeof entry === "object" && entry.id === id) ||
    (depends.includes(id) ? { id, versions: "*" } : null);

  const loaderEntry = find(loaderKey);
  const minecraftEntry = find("minecraft");

  return {
    loaderBound: loaderEntry ? firstDependencyValue(loaderEntry.versions) : null,
    loaderRaw: loaderEntry ? rangeText(JSON.stringify(loaderEntry.versions)) : null,
    minecraftBound: minecraftEntry ? firstDependencyValue(minecraftEntry.versions) : null,
    minecraftRaw: minecraftEntry ? rangeText(JSON.stringify(minecraftEntry.versions)) : null,
    modId: metadataText(quiltLoader.id),
    name: metadataText(quiltLoader.metadata && quiltLoader.metadata.name) || metadataText(quiltLoader.id),
    version: metadataText(quiltLoader.version)
  };
}

// A deliberately small mods.toml reader. Only the [[mods]] identity and the
// [[dependencies.*]] blocks matter here, and a full TOML parser would be a
// dependency added for two string fields.
function parseForgeMetadata(text, loaderKey) {
  const readString = (block, key) => {
    const match = block.match(new RegExp(`${key}\\s*=\\s*["']([^"']*)["']`));
    return match ? match[1] : null;
  };

  const modsIndex = text.indexOf("[[mods]]");
  const modsBlock = modsIndex === -1 ? "" : text.slice(modsIndex).split(/\[\[dependencies/)[0];
  const modId = readString(modsBlock, "modId");

  let loaderBound = null;
  let loaderRaw = null;
  let minecraftBound = null;
  let minecraftRaw = null;

  const blocks = text.split(/\[\[dependencies[^\]]*\]\]/).slice(1);
  for (const block of blocks) {
    const dependencyId = readString(block, "modId");
    const versionRange = readString(block, "versionRange");
    if (!dependencyId || !versionRange) {
      continue;
    }
    if (dependencyId === loaderKey) {
      loaderBound = parseMavenRange(versionRange);
      loaderRaw = versionRange;
    } else if (dependencyId === "minecraft") {
      minecraftBound = parseMavenRange(versionRange);
      minecraftRaw = versionRange;
    }
  }

  return {
    loaderBound,
    loaderRaw: rangeText(loaderRaw === null ? undefined : loaderRaw),
    minecraftBound,
    minecraftRaw: rangeText(minecraftRaw === null ? undefined : minecraftRaw),
    modId: metadataText(modId),
    name: metadataText(readString(modsBlock, "displayName")) || metadataText(modId),
    version: metadataText(readString(modsBlock, "version"))
  };
}

async function readJarRequirements(jarPath, loader) {
  const definition = LOADER_METADATA[loader];
  if (!definition) {
    return null;
  }

  const entries = await readJarEntries(jarPath, [definition.entry]);
  const text = entries[definition.entry];
  if (text === undefined) {
    return null;
  }

  if (definition.format === "json") {
    return parseFabricMetadata(text, definition.loaderKey);
  }
  if (definition.format === "quilt-json") {
    return parseQuiltMetadata(text, definition.loaderKey);
  }
  return parseForgeMetadata(text, definition.loaderKey);
}

/**
 * Scan a mods directory and work out the loader build the installed set needs.
 *
 * Returns the highest declared lower bound (the "floor"), every mod that
 * contributes a constraint, and the jars whose metadata could not be read - the
 * last of these matters because an unreadable jar means the floor is a
 * best-effort answer, not a guarantee, and callers should say so.
 */
async function scanLoaderRequirements(modsDir, loader, options = {}) {
  const normalizedLoader = String(loader || "").trim().toLowerCase();
  if (!LOADER_METADATA[normalizedLoader]) {
    return { floor: null, loader: normalizedLoader, mods: [], supported: false, unreadable: [] };
  }

  let fileNames = [];
  try {
    fileNames = (await fsp.readdir(modsDir)).filter((name) => name.toLowerCase().endsWith(".jar"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    return { floor: null, loader: normalizedLoader, mods: [], supported: true, unreadable: [] };
  }

  const skip = new Set(options.ignoreFileNames || []);
  const mods = [];
  const unreadable = [];

  for (const fileName of fileNames.sort()) {
    if (skip.has(fileName)) {
      continue;
    }
    try {
      const requirements = await readJarRequirements(path.join(modsDir, fileName), normalizedLoader);
      if (!requirements) {
        // No metadata for this loader: a library jar, or a mod for a different
        // loader. Neither constrains the loader build.
        continue;
      }
      mods.push({ fileName, ...requirements });
    } catch (error) {
      unreadable.push({ fileName, reason: metadataText(error.message) || "unreadable" });
    }
  }

  let floor = null;
  for (const mod of mods) {
    if (mod.loaderBound && mod.loaderBound.min) {
      if (!floor || compareVersions(mod.loaderBound.min, floor.version) > 0) {
        floor = {
          inclusive: mod.loaderBound.minInclusive !== false,
          requiredBy: [mod],
          version: mod.loaderBound.min
        };
      } else if (compareVersions(mod.loaderBound.min, floor.version) === 0) {
        floor.requiredBy.push(mod);
      }
    }
  }

  return {
    floor: floor
      ? {
          inclusive: floor.inclusive,
          requiredBy: floor.requiredBy.map((mod) => ({
            fileName: mod.fileName,
            modId: mod.modId,
            name: mod.name,
            range: mod.loaderRaw,
            version: mod.version
          })),
          version: floor.version
        }
      : null,
    loader: normalizedLoader,
    mods,
    supported: true,
    unreadable
  };
}

/**
 * Check a candidate loader build against a scan, and report which mods reject
 * it. `conflicts` is what turns "this version is wrong" into "these three mods
 * are why".
 */
function evaluateLoaderCandidate(scan, candidateVersion) {
  if (!scan || !scan.supported || !candidateVersion) {
    return { compatible: true, conflicts: [] };
  }

  const conflicts = [];
  for (const mod of scan.mods || []) {
    if (mod.loaderBound && !satisfiesBound(mod.loaderBound, candidateVersion)) {
      conflicts.push({
        fileName: mod.fileName,
        modId: mod.modId,
        name: mod.name || mod.modId || mod.fileName,
        range: mod.loaderRaw,
        version: mod.version
      });
    }
  }

  return { compatible: conflicts.length === 0, conflicts };
}

/**
 * The same question for the game version: would this Minecraft target break a
 * mod's declared `depends.minecraft`? Used to explain why a version change is
 * risky even when a loader build exists for it.
 */
function evaluateMinecraftCandidate(scan, candidateVersion) {
  if (!scan || !scan.supported || !candidateVersion) {
    return { compatible: true, conflicts: [] };
  }

  const conflicts = [];
  for (const mod of scan.mods || []) {
    if (mod.minecraftBound && !satisfiesBound(mod.minecraftBound, candidateVersion)) {
      conflicts.push({
        fileName: mod.fileName,
        modId: mod.modId,
        name: mod.name || mod.modId || mod.fileName,
        range: mod.minecraftRaw,
        version: mod.version
      });
    }
  }

  return { compatible: conflicts.length === 0, conflicts };
}

/** Read one text entry out of a jar, or null when it is absent. */
async function readJarTextEntry(jarPath, entryName) {
  const entries = await readJarEntries(jarPath, [entryName]);
  return entries[entryName] === undefined ? null : entries[entryName];
}

module.exports = {
  compareVersions,
  readJarTextEntry,
  evaluateLoaderCandidate,
  evaluateMinecraftCandidate,
  parseFabricPredicate,
  parseMavenRange,
  readJarRequirements,
  satisfiesBound,
  scanLoaderRequirements
};
