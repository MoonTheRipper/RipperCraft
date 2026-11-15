const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("npm test runs the tests in test/ and no file from anywhere else", () => {
  // `node --test` with no pattern runs every *.test.js beneath the folder it
  // is started in. In a checkout that serves a dashboard that includes
  // servers/ and data/, where a game server - and so a mod - can write.
  const { scripts } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
  assert.equal(scripts.test, 'node --test "test/*.test.js"');
  // Nothing is left out by that: every test is directly in test/.
  const nested = fs.readdirSync(__dirname, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  assert.deepEqual(nested, []);
});
