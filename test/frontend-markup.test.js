const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setHashCostForTests } = require("../src/lib/auth");
const { PUBLIC_ROOT, installBrowserStubs, loadPublicModule } = require("../test-support/browser");
const { hostileCopies, realResponses, renderEverything } = require("../test-support/pages");

setHashCostForTests({ ln: 10, r: 8, p: 1 });
installBrowserStubs();

// Markup that would be unmistakable if it ever reached the page unescaped.
const MARKER = '<b data-marker="x" onclick=\'alert(1)\'>unescaped</b>';

function listFiles(directory) {
  const found = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFiles(full));
    } else {
      found.push(full);
    }
  }
  return found;
}

// A copy of a response with every piece of text in it replaced.
function replaceEveryString(value, replacement) {
  if (typeof value === "string") {
    return replacement(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceEveryString(item, replacement));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceEveryString(item, replacement)]));
  }
  return value;
}

test("a value that only looks like trusted markup is shown as nothing", async () => {
  const { renderMetaRows } = await loadPublicModule("js/components.js");
  const { rawHtml, renderValue } = await loadPublicModule("js/html.js");

  // What an admin could save as a loader, exactly as a response carries it.
  const forged = JSON.parse(JSON.stringify({ __html: MARKER }));
  assert.equal(renderValue(forged), "");
  assert.doesNotMatch(renderMetaRows([["loader", forged]]), /data-marker/);

  // The real thing still works, and only for markup made by calling rawHtml().
  assert.equal(renderValue(rawHtml("<code>/srv</code>")), "<code>/srv</code>");
  assert.ok(renderMetaRows([["directory", rawHtml("<code>/srv</code>")]]).includes("<strong><code>/srv</code></strong>"));
  assert.equal(renderValue(MARKER).includes("<b"), false);
});

test("trusted markup does not survive being sent anywhere", async () => {
  const { rawHtml, renderValue } = await loadPublicModule("js/html.js");
  const trusted = rawHtml(MARKER);

  // JSON has no way to write the marker down, so a round trip through a
  // request or a response leaves an empty object.
  assert.equal(JSON.stringify(trusted), "{}");
  assert.equal(renderValue(JSON.parse(JSON.stringify(trusted))), "");
  assert.equal(renderValue(structuredClone({ ...trusted })), "");
  // Nothing about it can be read or changed by its name.
  assert.deepEqual(Object.keys(trusted), []);
  assert.equal(trusted.__html, undefined);
  assert.equal(Object.isFrozen(trusted), true);
});

test("nothing under public/ spells the old marker any more", () => {
  const offenders = listFiles(PUBLIC_ROOT)
    .filter((file) => /\.(js|html)$/.test(file))
    .filter((file) => fs.readFileSync(file, "utf8").includes("__html"))
    .map((file) => path.relative(PUBLIC_ROOT, file));
  // html.js explains what the marker used to be, in a comment; nothing else
  // mentions it, and no code does.
  assert.deepEqual(offenders, ["js/html.js"]);
  const mentions = fs
    .readFileSync(path.join(PUBLIC_ROOT, "js", "html.js"), "utf8")
    .split("\n")
    .filter((line) => line.includes("__html"));
  assert.ok(mentions.length > 0);
  for (const line of mentions) {
    assert.match(line, /^\s*\/\//, line);
  }
});

test("escaping never throws, whatever it is handed", async () => {
  const { escapeHtml, renderSelectOptions, renderValue, safeUrl } = await loadPublicModule("js/html.js");

  assert.equal(escapeHtml(0), "0");
  assert.equal(escapeHtml(false), "false");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(MARKER).includes("<"), false);

  // A response is JSON, so these are all shapes a field can take.
  const awkward = [{}, [], [MARKER], { __html: MARKER }, { toString: 1, valueOf: 2 }, { toString: null }, { length: 3 }];
  for (const value of awkward) {
    assert.equal(escapeHtml(value), "", JSON.stringify(value));
    assert.equal(renderValue(value), "", JSON.stringify(value));
    assert.equal(safeUrl(value), "", JSON.stringify(value));
    assert.equal(renderSelectOptions(["a"], value), '<option value="a" >a</option>');
  }
});

test("add-on artwork is loaded from a web address or not at all", async () => {
  const { renderAddonIcon } = await loadPublicModule("js/components.js");

  assert.match(renderAddonIcon("https://cdn.modrinth.com/data/abc/icon.png", "A Mod"), /<img\s+src="https:\/\/cdn\.modrinth\.com\/data\/abc\/icon\.png"/);
  // A path here would be fetched from the dashboard itself, as whoever is looking.
  for (const address of ["/api/servers/DemoServer/worlds/export", "api/logout", "//files.example/icon.png", "javascript:alert(1)", "data:image/svg+xml,<svg>", "", null, {}, ["https://files.example/a.png"]]) {
    const markup = renderAddonIcon(address, "A Mod");
    assert.doesNotMatch(markup, /<img/, JSON.stringify(address));
    assert.match(markup, /addon-icon__fallback/, JSON.stringify(address));
  }
  // An address that is one is still text inside an attribute.
  assert.doesNotMatch(renderAddonIcon(`https://files.example/"><b data-marker="x">`, "A Mod"), /<b data-marker/);
});

test("a time is shown as a time or as unknown, and never breaks the page", async () => {
  const { formatDate } = await loadPublicModule("js/format.js");

  assert.equal(formatDate("2026-11-15T12:00:00.000Z"), new Date("2026-11-15T12:00:00.000Z").toLocaleString());
  assert.equal(formatDate(1_700_000_000_000), new Date(1_700_000_000_000).toLocaleString());
  // Asking Date to read an object can throw; none of these is asked.
  for (const value of [null, undefined, "", "not a date", MARKER, {}, [], { toString: 1, valueOf: 2 }, { toString: null }, ["2026-11-15"], true, Number.NaN]) {
    assert.equal(formatDate(value), "unknown", JSON.stringify(value));
  }
});

test("no text in a response is drawn as markup on any page", async (t) => {
  const responses = await realResponses(t);
  // The marker, numbered when each piece of text is to be different. Where a
  // link belongs it is one: a real address with the marker in it, which is
  // let through as an address and has to be escaped as text all the same, or
  // one that would run as script if it were ever put in a link.
  const marker = (count, key) => {
    const text = count ? MARKER.replace("unescaped", `unescaped ${count}`) : MARKER;
    if (count && /url$/i.test(key)) {
      return count % 2 ? `https://files.example/"> ${text}` : `javascript:alert(1)//${text}`;
    }
    return text;
  };

  for (const role of ["owner", "admin"]) {
    // Every string the server sent, swapped for markup - and then again with
    // the strings a page branches on left as they were, so that the branches
    // real responses take are drawn with markup in them too.
    for (const [label, hostile] of hostileCopies(responses, marker)) {
      hostile.bootstrap.user.role = role;
      const page = await renderEverything(hostile, role);

      assert.doesNotMatch(page, /<b data-marker/, `${role}, ${label}`);
      assert.doesNotMatch(page, /onclick='alert/, `${role}, ${label}`);
      assert.doesNotMatch(page, /(href|src)\s*=\s*["']?\s*javascript:/i, `${role}, ${label}`);
      // It was drawn, as text.
      assert.match(page, /&lt;b data-marker=&quot;x&quot;/, `${role}, ${label}`);
    }
  }
});

test("no object in a response is drawn as markup, and none of them breaks a page", async (t) => {
  const responses = await realResponses(t);

  for (const role of ["owner", "admin"]) {
    // The same, with an object of the old trusted shape where each string was.
    for (const [label, hostile] of hostileCopies(responses, () => ({ __html: MARKER }))) {
      hostile.bootstrap.user.role = role;
      const page = await renderEverything(hostile, role);

      assert.doesNotMatch(page, /data-marker/, `${role}, ${label}`);
      // And the page was drawn: an object where text belonged did not throw.
      assert.match(page, /<h2>/, `${role}, ${label}`);
    }
  }
});

test("the pages still draw what the server really sends", async (t) => {
  const responses = await realResponses(t);
  const page = await renderEverything(responses, "owner");

  assert.match(page, /<strong>fabric<\/strong>/);
  assert.match(page, /<strong>1\.21\.1<\/strong>/);
  assert.match(page, /<strong><code>servers\/DemoServer<\/code><\/strong>/);
  assert.match(page, /example-mod\.jar/);
  assert.match(page, /first\.zip/);
  // An add-on installed through a provider, with its title and its update.
  assert.match(page, /<strong>Tracked Mod<\/strong><code class="addon-file">tracked-mod\.jar<\/code>/);
  assert.match(page, /<strong>update: tracked-mod-2\.jar<\/strong>/);
  assert.match(page, /check failed: Could not check: Request failed with status 500\./);
  // The same server as one the dashboard manages, and as one it offers to.
  assert.match(page, /<strong>loader mismatch<\/strong>/);
  assert.match(page, /labelled <code>fabric<\/code> but the runtime installed on disk is <code>paper<\/code> \(0\.16\.14\)/);
  assert.match(page, /<option value="0\.15\.0" disabled>0\.15\.0 [^<]*blocked by 1 mod<\/option>/);
  assert.match(page, /current loader build: 0\.16\.14\. load the published builds/);
  assert.match(page, /placeholder="0\.16\.10"/);
  assert.match(page, /cannot provision a quilt runtime/);
  assert.match(page, /only compatibility-matching add-ons are listed here for fabric on 1\.21\.1\./);
  // A server that is stopping: said in all three places, with both buttons held.
  assert.match(page, /<span class="status-inline status-inline--warn"><span class="icon">.*?<\/span>stopping…<\/span>/);
  assert.ok(page.includes(`<strong>stopping… since ${new Date("2026-11-16T12:00:00.000Z").toLocaleString()}</strong>`));
  assert.match(page, /<span class="tree-meta">stopping<\/span>/);
  assert.match(page, /<button class="button button--primary" data-action="start-server" disabled title="this server is stopping">/);
  assert.match(page, /<button class="button button--quiet" data-action="stop-server" disabled title="this server is stopping">/);
  // One that had to be killed: its page says so, and when.
  assert.ok(page.includes('<p class="notice notice--error">this server did not stop when it was asked to, and was killed. the world may not have been saved: see its log before starting it again.</p>'));
  assert.ok(page.includes(`<strong>${new Date("2026-11-16T12:04:10.000Z").toLocaleString()} — killed. it did not stop when asked</strong>`));
  // One whose first process has gone, with two it started still there.
  assert.match(page, /<span class="status-inline status-inline--warn"><span class="icon">.*?<\/span>exited, with processes left<\/span>/);
  assert.ok(page.includes("the process this server was started as has exited, and 2 processes that it started are still running:"));
  assert.match(page, /<button class="button button--primary" data-action="start-server" disabled title="stop this server first: processes from its last run are still there">/);
  assert.match(page, /<span class="tree-meta">left over<\/span>/);
  // And one whose state is not known: the reason, and none of its sections.
  assert.match(page, /<span class="status-inline status-inline--warn"><span class="icon">.*?<\/span>not known<\/span>/);
  assert.ok(page.includes("<strong>servers/example/.rippermoon is a link. The dashboard keeps this server&#39;s record and log there"));
  assert.match(page, /<span class="tree-meta">unknown<\/span>/);
  // And one that is not, which is every other drawing of it here.
  assert.match(page, /<button class="button button--primary" data-action="start-server">/);
  assert.match(page, /<span class="tree-meta">down<\/span>/);
  // The frame around the section, with the notice above it.
  assert.match(page, /<main class="shell">/);
  assert.match(page, /<section class="content">\s*<div class="notice notice--error" aria-hidden="true">something happened<\/div>/);
});
