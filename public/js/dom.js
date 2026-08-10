// The single mount point every renderer and listener writes to. It used to be
// a module-scope `const app = document.getElementById("app")`; resolving it
// lazily keeps the lookup identical at runtime (the script is deferred, so the
// element always exists by the time anything calls this) while letting the
// modules be imported without a live DOM.
let appElement = null;

export function getApp() {
  if (!appElement) {
    appElement = document.getElementById("app");
  }
  return appElement;
}
