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
  logAutoRefresh: localStorage.getItem("rippermoonstash-log-auto") !== "off",
  modUpdates: null,
  logOrder: localStorage.getItem("rippermoonstash-log-order") === "newest" ? "newest" : "oldest",
  javaRuntimes: [],
  manualDownload: null,
  modProvider: "modrinth",
  modQuery: "",
  modResults: [],
  navOpen: false,
  notice: null,
  theme: localStorage.getItem("rippermoonstash-theme") || "dark",
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
