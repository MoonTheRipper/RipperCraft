const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { setHashCostForTests } = require("../src/lib/auth");
const { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } = require("../src/lib/http");
const { PUBLIC_ROOT, installBrowserStubs, loadPublicModule } = require("../test-support/browser");
const { realResponses, renderEverything } = require("../test-support/pages");

setHashCostForTests({ ln: 10, r: 8, p: 1 });
const appElement = installBrowserStubs();

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
  return found.sort();
}

function parsePolicy(policy) {
  return Object.fromEntries(
    policy.split(";").map((directive) => {
      const [name, ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    })
  );
}

// An attribute the policy refuses, written in markup: style="..." or an event
// handler such as onerror="...". Setting element.style.width or element.onload
// from script is something else and is allowed, hence the look-behind.
const INLINE_ATTRIBUTE = /(?<![.\w-])(style|on[a-z]+)\s*=\s*(\\?["']|\$\{)/;
// The same thing in markup that has already been drawn.
const DRAWN_INLINE_ATTRIBUTE = /<[a-zA-Z][^<>]*\s(style|on[a-z]+)\s*=/;

// --- the policy ------------------------------------------------------------------

test("the policy allows this origin and add-on artwork, and nothing else", () => {
  assert.deepEqual(parsePolicy(CONTENT_SECURITY_POLICY), {
    "base-uri": ["'none'"],
    "connect-src": ["'self'"],
    "default-src": ["'self'"],
    "font-src": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
    "img-src": ["'self'", "data:", "https:"],
    "object-src": ["'none'"],
    "script-src": ["'self'"],
    "style-src": ["'self'"]
  });
  assert.equal(SECURITY_HEADERS["Content-Security-Policy"], CONTENT_SECURITY_POLICY);
});

test("the policy has no escape hatch in it", () => {
  for (const loose of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'", "*", "http:", "blob:", "'nonce-", "'sha"]) {
    assert.equal(CONTENT_SECURITY_POLICY.includes(loose), false, loose);
  }
  // Only images may come from anywhere but here.
  for (const [name, sources] of Object.entries(parsePolicy(CONTENT_SECURITY_POLICY))) {
    if (name !== "img-src") {
      assert.ok(sources.every((source) => source === "'self'" || source === "'none'"), name);
    }
  }
});

// --- what the page is made of ----------------------------------------------------------

test("the page has no inline script and no inline style", () => {
  const html = fs.readFileSync(path.join(PUBLIC_ROOT, "index.html"), "utf8");

  assert.doesNotMatch(html, /<style/i);
  assert.doesNotMatch(html, /\sstyle\s*=/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /javascript:/i);
  // One script, loaded from this origin as a module.
  const scripts = html.match(/<script\b[^>]*>/gi) || [];
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /\ssrc="\/app\.js[^"]*"/);
  assert.match(scripts[0], /type="module"/);
  assert.doesNotMatch(html, /<script\b[^>]*>\s*[^\s<]/i);
  // Every stylesheet, icon and manifest comes from this origin.
  for (const [, url] of html.matchAll(/<link\b[^>]*\shref="([^"]+)"/gi)) {
    assert.match(url, /^\/[^/]/, url);
  }
  // The live region is still hidden, now by the stylesheet.
  assert.match(html, /<div id="notice-live" class="visually-hidden"/);
  const css = fs.readFileSync(path.join(PUBLIC_ROOT, "styles.css"), "utf8");
  assert.match(css, /\.visually-hidden\s*\{[^}]*clip:\s*rect\(0, 0, 0, 0\)/);
});

test("no module writes a style or an event handler into markup", () => {
  const offenders = [];
  for (const file of listFiles(PUBLIC_ROOT).filter((name) => name.endsWith(".js"))) {
    fs.readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        // Comments explain what used to be here.
        if (!/^\s*(\/\/|\*|\/\*)/.test(line) && INLINE_ATTRIBUTE.test(line)) {
          offenders.push(`${path.relative(PUBLIC_ROOT, file)}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  assert.deepEqual(offenders, []);
});

test("no module evaluates text as code, and markup is assigned in one place", () => {
  const evaluators = [];
  const sinks = [];
  for (const file of listFiles(PUBLIC_ROOT).filter((name) => name.endsWith(".js"))) {
    const relative = path.relative(PUBLIC_ROOT, file);
    const code = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    if (/\beval\s*\(|new\s+Function\b|set(?:Timeout|Interval)\s*\(\s*["'`]|document\.write|import\s*\(/.test(code)) {
      evaluators.push(relative);
    }
    if (/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|srcdoc|createContextualFragment|DOMParser/.test(code)) {
      sinks.push(relative);
    }
  }
  assert.deepEqual(evaluators, []);
  assert.deepEqual(sinks, ["js/render.js"]);
});

test("the stylesheet loads nothing from anywhere", () => {
  const css = fs.readFileSync(path.join(PUBLIC_ROOT, "styles.css"), "utf8");
  assert.doesNotMatch(css, /@import|@font-face|url\s*\(/i);
});

test("no page is drawn with a style or an event handler attribute", async (t) => {
  const responses = await realResponses(t);
  for (const role of ["owner", "admin"]) {
    const page = await renderEverything(responses, role);
    assert.ok(page.length > 20000, "the pages were drawn");
    assert.doesNotMatch(page, DRAWN_INLINE_ATTRIBUTE, role);
    assert.doesNotMatch(page, /<script|<style|<iframe|<object|<embed|<base\b/i, role);
    assert.doesNotMatch(page, /javascript:/i, role);
  }
});

// --- the three things that used to be inline ------------------------------------------

test("add-on artwork is drawn without a handler of its own", async () => {
  const { renderAddonIcon } = await loadPublicModule("js/components.js");
  const markup = renderAddonIcon("https://cdn.modrinth.com/data/abc/icon.png", "A Mod");

  assert.match(markup, /<img/);
  assert.doesNotMatch(markup, /onerror/);
  assert.doesNotMatch(markup, DRAWN_INLINE_ATTRIBUTE);
  // The placeholder that shows through when the image is taken away.
  assert.match(markup, /addon-icon__fallback/);
});

test("artwork that fails to load is removed, and only artwork", async () => {
  const { removeFailedAddonIcon } = await loadPublicModule("js/actions/media.js");
  const image = (insideIcon) => {
    const element = {
      closest: (selector) => (insideIcon && selector === ".addon-icon" ? {} : null),
      removed: 0,
      remove() {
        element.removed += 1;
      },
      tagName: "IMG"
    };
    return element;
  };

  const artwork = image(true);
  removeFailedAddonIcon({ target: artwork });
  assert.equal(artwork.removed, 1);

  // The logo, or any other image, is left alone.
  const logo = image(false);
  removeFailedAddonIcon({ target: logo });
  assert.equal(logo.removed, 0);

  // Errors that are not about an image at all.
  for (const target of [null, undefined, {}, { tagName: "SCRIPT", closest: () => ({}) }, { tagName: "IMG" }]) {
    assert.doesNotThrow(() => removeFailedAddonIcon({ target }));
  }

  // It is registered for the capture phase: an image's error does not bubble.
  const entry = fs.readFileSync(path.join(PUBLIC_ROOT, "app.js"), "utf8");
  assert.match(entry, /app\.addEventListener\("error", removeFailedAddonIcon, true\)/);
});

test("the progress bar is drawn without a style attribute, and filled from script", async () => {
  const { state } = await loadPublicModule("js/state.js");
  const { renderCreateProgress } = await loadPublicModule("js/views/owner.js");
  const { applyProgressBars } = await loadPublicModule("js/progress.js");

  const saved = state.createJob;
  state.createJob = { createdAt: new Date().toISOString(), progress: 0.5, step: "downloading", stepIndex: 3, totalSteps: 6 };
  let markup;
  try {
    markup = renderCreateProgress();
  } finally {
    state.createJob = saved;
  }
  assert.doesNotMatch(markup, DRAWN_INLINE_ATTRIBUTE);
  assert.match(markup, /<div class="progress-track__fill" data-progress="50"><\/div>/);
  assert.match(markup, /aria-valuenow="50"/);

  const fill = (progress) => ({ dataset: { progress }, style: {} });
  const fills = [fill("50"), fill("0"), fill("100"), fill("250"), fill("-5"), fill("not a number"), fill(undefined)];
  const previous = appElement.querySelectorAll;
  appElement.querySelectorAll = (selector) => (selector === "[data-progress]" ? fills : []);
  try {
    applyProgressBars();
  } finally {
    appElement.querySelectorAll = previous;
  }
  assert.deepEqual(
    fills.map((element) => element.style.width),
    ["50%", "0%", "100%", "100%", "0%", "0%", "0%"]
  );

  // It runs after every render.
  const entry = fs.readFileSync(path.join(PUBLIC_ROOT, "app.js"), "utf8");
  assert.match(entry, /registerPostRender\(applyProgressBars\)/);
  // And an unfilled bar is empty, not full.
  const css = fs.readFileSync(path.join(PUBLIC_ROOT, "styles.css"), "utf8");
  assert.match(css, /\.progress-track__fill\s*\{\s*width:\s*0;/);
});
