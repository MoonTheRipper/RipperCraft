// The smallest stand-in for a browser that lets node import the modules under
// public/js, for tests that render a view to a string and read the markup.
// Nothing here behaves like a DOM; it only has to exist.
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PUBLIC_ROOT = path.join(__dirname, "..", "public");

function installBrowserStubs() {
  const appElement = {
    addEventListener() {},
    innerHTML: "",
    querySelectorAll() {
      return [];
    }
  };
  globalThis.localStorage = {
    getItem() {
      return null;
    },
    removeItem() {},
    setItem() {}
  };
  globalThis.document = {
    activeElement: null,
    addEventListener() {},
    documentElement: { dataset: {} },
    getElementById(id) {
      return id === "app" ? appElement : null;
    },
    hidden: false,
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    title: ""
  };
  globalThis.window = {
    confirm() {
      return false;
    },
    prompt() {
      return null;
    },
    scrollTo() {},
    scrollX: 0,
    scrollY: 0
  };
  return appElement;
}

// Imports a module by its path under public/, such as "js/html.js".
function loadPublicModule(relativePath) {
  return import(pathToFileURL(path.join(PUBLIC_ROOT, relativePath)).href);
}

module.exports = {
  PUBLIC_ROOT,
  installBrowserStubs,
  loadPublicModule
};
