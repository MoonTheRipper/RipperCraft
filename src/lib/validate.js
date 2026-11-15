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
  MINECRAFT_VERSION_MAX_LENGTH,
  hasControlCharacters,
  integerInRange,
  invalid,
  isMinecraftVersion,
  normalizeLoader,
  normalizeMinecraftVersion,
  plainText,
  singleLine
};
