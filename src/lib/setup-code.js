const crypto = require("node:crypto");

// The first-run screen creates an owner, and an owner can run commands on the
// host. It used to be open to whoever reached the page first - and it opened
// again any time data/users.json went missing. Creating the owner now needs a
// code that only someone who can read this process's output has.

// Crockford's base32: no I, L, O or U, so nothing in a code read off a terminal
// can be mistaken for a digit.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const GROUPS = 4;
const GROUP_LENGTH = 4;

// 16 characters of 5 bits each: 80 bits, far beyond guessing over HTTP.
function generateSetupCode() {
  const groups = [];
  for (let group = 0; group < GROUPS; group += 1) {
    let text = "";
    for (let index = 0; index < GROUP_LENGTH; index += 1) {
      text += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
    groups.push(text);
  }
  return groups.join("-");
}

// Forgives what does not matter when copying a code by hand: case, the dashes,
// stray spaces, and the letters that look like digits.
function normalizeSetupCode(value) {
  // Only text can be a code. Anything else a JSON body might hold is no code
  // at all, rather than whatever String() would make of it.
  return (typeof value === "string" ? value : "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^0-9A-Z]/g, "");
}

// Compares in constant time. Both sides are hashed first so the comparison
// always runs over 32 bytes, whatever length was submitted.
function setupCodeMatches(expected, provided) {
  if (!expected) {
    return false;
  }
  const digest = (value) => crypto.createHash("sha256").update(normalizeSetupCode(value)).digest();
  return crypto.timingSafeEqual(digest(expected), digest(provided));
}

function setupCodeBanner(code) {
  const rule = "=".repeat(66);
  return [
    "",
    rule,
    "  RipperCraft has no owner account yet.",
    "",
    `      Owner setup code:   ${code}`,
    "",
    "  Open the dashboard and enter this code to create the owner account.",
    "  A new code is made each time RipperCraft starts, and it stops",
    "  working as soon as the owner exists.",
    rule,
    ""
  ].join("\n");
}

module.exports = {
  generateSetupCode,
  normalizeSetupCode,
  setupCodeBanner,
  setupCodeMatches
};
