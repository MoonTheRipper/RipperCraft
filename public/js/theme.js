import { state } from "./state.js";

export function syncDocumentMeta() {
  const titleBase = "RipperMoonStash";
  let title = `${titleBase} | Minimal Minecraft Server Dashboard`;
  let description =
    "RipperMoonStash is a minimal Minecraft server dashboard for managing servers, mods, worlds, logs, admin access, and start-stop controls from the browser.";

  if (state.bootstrap?.loggedIn && state.view === "owner") {
    title = `${titleBase} | Owner Controls`;
    description = "Owner controls for Minecraft server registry, admin roles, server access lanes, and dashboard configuration.";
  } else if (state.bootstrap?.loggedIn && state.serverSnapshot?.server) {
    const server = state.serverSnapshot.server;
    title = `${titleBase} | ${server.name}`;
    description = `${server.name} on RipperMoonStash. Manage settings, worlds, mods, logs, and protected admin actions from one minimal interface.`;
  }

  document.title = title;

  const pairs = [
    ['meta[name="description"]', description],
    ['meta[property="og:title"]', title],
    ['meta[property="og:description"]', description],
    ['meta[name="twitter:title"]', title],
    ['meta[name="twitter:description"]', description]
  ];

  for (const [selector, value] of pairs) {
    const element = document.querySelector(selector);
    if (element) {
      element.setAttribute("content", value);
    }
  }
}

export function applyTheme() {
  document.documentElement.dataset.theme = state.theme === "light" ? "light" : "dark";
}

export function toggleTheme() {
  state.theme = state.theme === "light" ? "dark" : "light";
  localStorage.setItem("rippermoonstash-theme", state.theme);
  applyTheme();
}
