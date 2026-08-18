// Browser-stored preferences moved from the "rippermoonstash-" prefix when the
// project was renamed to RipperCraft. Reads fall back to the old key so a
// returning user keeps their theme and log settings instead of silently being
// reset; writes only ever use the new key, so the old ones age out on their own.
const STORAGE_PREFIX = "rippercraft-";
const LEGACY_STORAGE_PREFIX = "rippermoonstash-";

export function readStored(key) {
  try {
    const current = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    return current === null ? localStorage.getItem(`${LEGACY_STORAGE_PREFIX}${key}`) : current;
  } catch {
    // Private browsing and blocked storage both throw here; defaults are fine.
    return null;
  }
}

export function writeStored(key, value) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, value);
  } catch {
    // A preference that cannot be persisted still applies for this session.
  }
}

export const state = {
  bootstrap: null,
  selectedServerId: null,
  serverSnapshot: null,
  servers: [],
  users: [],
  view: "server",
  serverSection: "overview",
  ownerSection: "servers",
  createServerMinecraftVersion: "latest",
  createVersionOpen: false,
  editingUserId: null,
  createJob: null,
  integrations: null,
  logAutoRefresh: readStored("log-auto") !== "off",
  modUpdates: null,
  logOrder: readStored("log-order") === "newest" ? "newest" : "oldest",
  javaRuntimes: [],
  loaderOptions: null,
  manualDownload: null,
  modProvider: "modrinth",
  modQuery: "",
  modResults: [],
  navOpen: false,
  notice: null,
  theme: readStored("theme") || "dark",
  updatePlan: null,
  versionCatalog: null,
  resettingUserId: null
};

// Everything in state that belongs to one specific server. None of it carries a
// server id of its own - add-on updates are keyed by filename, the manual
// download handoff by mod name - so a leftover from server A silently attaches
// itself to server B, and clicking "update" on B's list posts A's filename to
// B. Switching servers has to clear the lot.
export function resetServerScopedState() {
  state.loaderOptions = null;
  state.manualDownload = null;
  state.modQuery = "";
  state.modResults = [];
  state.modUpdates = null;
  state.updatePlan = null;
}

export const SERVER_SECTIONS = [
  ["overview", "overview"],
  ["settings", "settings"],
  ["worlds", "worlds"],
  ["mods", "mods"],
  ["logs", "logs"]
];

export const OWNER_SECTIONS = [
  ["servers", "server registry"],
  ["admins", "admins"],
  ["integrations", "integrations"]
];

// Every loader that can be set as a label. Which of these can actually be
// provisioned comes from the backend - see installableLoaders().
export const ALL_LOADERS = ["vanilla", "fabric", "forge", "neoforge", "quilt", "paper", "purpur", "custom"];
