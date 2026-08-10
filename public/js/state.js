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
