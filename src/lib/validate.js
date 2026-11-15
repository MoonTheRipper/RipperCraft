const { HttpError } = require("./http");

// Checks for the values a person can put into a server's record.
//
// A request body is JSON, so any field can arrive as an object, a list or a
// number where text was expected. Nothing looked: an admin could save
// {"__html": "<script>..."} as a server's loader, the record kept it, and the
// owner's browser was handed it back as markup. Everything that is stored and
// shown again is therefore checked here, on the way in, and refused with a 400
// that says what was wrong.

// Every loader a server can be labelled with. The first eight are the ones the
// settings page offers; folia, spigot and bukkit are plugin servers the add-on
// code already knows how to treat.
const KNOWN_LOADERS = Object.freeze([
  "vanilla",
  "fabric",
  "forge",
  "neoforge",
  "quilt",
  "paper",
  "purpur",
  "folia",
  "spigot",
  "bukkit",
  "custom"
]);
const KNOWN_LOADER_SET = new Set(KNOWN_LOADERS);

// Minecraft version ids as Mojang publishes them: "1.20.1", "26.1.2",
// "26.4-snapshot-8", "24w14a", "1.21-rc1", and a dozen old ones with single
// spaces in them ("1.14.2 Pre-Release 4"). Letters, digits, dot, underscore,
// plus and hyphen, in words separated by one space - nothing that means
// anything to HTML, a shell, a URL or a file path. Every id in Mojang's
// version manifest matches it.
const MINECRAFT_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?: [A-Za-z0-9][A-Za-z0-9._+-]*)*$/;
const MINECRAFT_VERSION_MAX_LENGTH = 64;

// What the JVM takes after -Xms and -Xmx: a whole number and a unit.
const MEMORY_PATTERN = /^[0-9]{1,6}[KMG]$/i;

// The path of a Forge or NeoForge argfile inside a server folder, such as
// libraries/net/minecraftforge/forge/1.20.1-47.4.10/unix_args.txt: plain names
// separated by slashes, none of them starting with a dot.
const ARG_FILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)*$/;

// C0 and C1 control characters, DEL, and the two Unicode line separators. None
// of them belongs in a name, a description or a one-line setting, and several
// of them start a new line in whatever file or log the value ends up in.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function invalid(message) {
  return new HttpError(400, message);
}

// A JSON field read as text: a string as it is, a finite number in its usual
// spelling. Anything else - an object, a list, true, null - is not text, and
// the caller decides whether that is an error or simply "not supplied".
function plainText(value) {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

function hasControlCharacters(text) {
  return CONTROL_CHARACTERS.test(text);
}

const EVERY_CONTROL_CHARACTER = new RegExp(CONTROL_CHARACTERS.source, "g");

// Text read back from a file that is not the dashboard's alone to write - one
// in a server's folder, where the server and anything it runs can write too -
// on its way to a page. Text comes back on one line, trimmed, and no longer
// than maxLength. Anything that is not text comes back as "".
function displayText(value, maxLength = 200) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(EVERY_CONTROL_CHARACTER, " ").trim().slice(0, maxLength);
}

// One line of text for a named field, trimmed. Refuses anything that is not
// text, that holds a control character, or that is too long.
function singleLine(value, label, options = {}) {
  const text = plainText(value);
  if (text === null) {
    throw invalid(`${label} must be text.`);
  }
  const trimmed = text.trim();
  if (hasControlCharacters(trimmed)) {
    throw invalid(`${label} cannot contain line breaks or other control characters.`);
  }
  const maxLength = options.maxLength || 200;
  if ([...trimmed].length > maxLength) {
    throw invalid(`${label} cannot be longer than ${maxLength} characters.`);
  }
  if (!trimmed && options.required) {
    throw invalid(`${label} cannot be empty.`);
  }
  return trimmed;
}

function normalizeLoader(value) {
  const text = plainText(value);
  const loader = text === null ? "" : text.trim().toLowerCase();
  if (!KNOWN_LOADER_SET.has(loader)) {
    throw invalid(`The loader must be one of: ${KNOWN_LOADERS.join(", ")}.`);
  }
  return loader;
}

function isMinecraftVersion(value) {
  return (
    typeof value === "string" &&
    value.length <= MINECRAFT_VERSION_MAX_LENGTH &&
    MINECRAFT_VERSION_PATTERN.test(value)
  );
}

// A stored Minecraft version. Blank is allowed - it is how a server whose
// version nobody knows is recorded, and reads as "unknown" everywhere.
function normalizeMinecraftVersion(value, label = "The Minecraft version") {
  const text = plainText(value);
  if (text === null) {
    throw invalid(`${label} must be text, such as 1.21.1.`);
  }
  const version = text.trim();
  if (version && !isMinecraftVersion(version)) {
    throw invalid(
      `${label} can only contain letters, digits, dots, hyphens, underscores and plus signs, such as 1.21.1 or 26.1-snapshot-3.`
    );
  }
  return version;
}

function isMemorySetting(value) {
  return typeof value === "string" && MEMORY_PATTERN.test(value);
}

// A JVM memory size, such as 4G or 512M. Blank is allowed and means "use the
// default". Both end up inside a shell script, so nothing else is.
function normalizeMemory(value, label) {
  const text = plainText(value);
  const memory = text === null ? null : text.trim();
  if (memory === null || (memory && !MEMORY_PATTERN.test(memory))) {
    throw invalid(`${label} must be a whole number followed by K, M or G, such as 4G or 512M.`);
  }
  return memory;
}

function isArgFilePath(value) {
  return typeof value === "string" && value.length <= 300 && ARG_FILE_PATTERN.test(value);
}

// A value for server.properties.
//
// The file is one "key=value" per line, so a value with a line break in it is
// two lines: an admin allowed to change the message of the day sent
// "hello\nonline-mode=false" and had written a setting of their choosing. A
// value must therefore be one line of text with no control characters in it.
//
// It must also not end in an unpaired backslash. Minecraft reads the file as
// Java properties, where a backslash at the end of a line joins the next line
// onto it - which would swallow whichever setting came next in the file.
// Backslashes anywhere else are left alone: "\u00a7" colour codes and a "\n"
// between the two lines of a message of the day are written exactly that way.
function propertyValue(value, label, options = {}) {
  const text = singleLine(value, label, { maxLength: options.maxLength || 256 });
  const trailing = /\\+$/.exec(text);
  if (trailing && trailing[0].length % 2 === 1) {
    throw invalid(`${label} cannot end with a backslash.`);
  }
  return text;
}

// What level-type may be set to: the world presets Minecraft ships (1.19 and
// later spell them with the minecraft: prefix) and the names older versions
// used. A world preset added by a mod is the owner's to set, in the full
// server.properties editor.
const LEVEL_TYPES = Object.freeze([
  "minecraft:normal",
  "minecraft:flat",
  "minecraft:large_biomes",
  "minecraft:amplified",
  "minecraft:single_biome_surface",
  "minecraft:debug_all_block_states",
  "normal",
  "default",
  "flat",
  "largebiomes",
  "large_biomes",
  "amplified",
  "single_biome_surface",
  "buffet",
  "customized",
  "default_1_1",
  "debug_all_block_states"
]);
const LEVEL_TYPE_SET = new Set(LEVEL_TYPES);

function normalizeLevelType(value) {
  const text = plainText(value);
  // Minecraft writes the colon escaped ("minecraft\:normal") when it saves the
  // file; a value read from there and sent back means the same thing.
  const levelType = text === null ? "" : text.trim().toLowerCase().replace("\\:", ":");
  if (!LEVEL_TYPE_SET.has(levelType)) {
    throw invalid(
      "The world type must be one of Minecraft's own: minecraft:normal, minecraft:flat, minecraft:large_biomes, minecraft:amplified or minecraft:single_biome_surface, or one of the older names (default, flat, largebiomes, amplified, buffet)."
    );
  }
  return levelType;
}

// A whole number within a range, from a JSON number or its spelling as text.
function integerInRange(value, label, minimum, maximum) {
  const text = plainText(value);
  if (text === null || !/^[0-9]{1,10}$/.test(text.trim())) {
    throw invalid(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  }
  const number = Number(text.trim());
  if (number < minimum || number > maximum) {
    throw invalid(`${label} must be a whole number between ${minimum} and ${maximum}.`);
  }
  return number;
}

module.exports = {
  KNOWN_LOADERS,
  LEVEL_TYPES,
  MINECRAFT_VERSION_MAX_LENGTH,
  displayText,
  hasControlCharacters,
  integerInRange,
  invalid,
  isArgFilePath,
  isMemorySetting,
  isMinecraftVersion,
  normalizeLevelType,
  normalizeLoader,
  normalizeMemory,
  normalizeMinecraftVersion,
  plainText,
  propertyValue,
  singleLine
};
