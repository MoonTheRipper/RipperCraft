import { state } from "./state.js";

// A time is text or a number. Anything else has no date in it, and asking
// Date to make one of it can throw.
export function formatDate(value) {
  const date = typeof value === "string" || typeof value === "number" ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toLocaleString() : "unknown";
}

// "512 KB", "3.5 MB", "4 GB" - for telling someone how big a file is.
export function formatBytes(bytes) {
  const units = ["KB", "MB", "GB", "TB"];
  let value = Number(bytes) / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${Math.round(value * 10) / 10} ${units[unit]}`;
}

// What a server is doing, for every place that shows it: the chip in the page
// header, the row in the overview, the word in the server tree.
//
// A server that has been told to stop is still running until its process has
// gone: it is saving the world, and that can take minutes. It is shown as
// neither up nor down, and it can be neither started nor stopped again.
export function describeRunState(status) {
  if (status?.running && status.stopping) {
    return { label: "stopping…", short: "stopping", stopping: true, tone: "warn" };
  }
  if (status?.running) {
    return { label: "online", short: "up", stopping: false, tone: "ok" };
  }
  return { label: "offline", short: "down", stopping: false, tone: "idle" };
}

export function getServerPermissions(snapshot = state.serverSnapshot) {
  return (
    snapshot?.server?.permissions || {
      canAccessDangerousSettings: false,
      canManageAddonSettings: false,
      canApplyCombinedUpdates: false,
      canCreateWorlds: false,
      canControlRuntime: false,
      canUseManualAddons: false,
      canViewProtectedTools: false,
      canWriteSafeSettings: false,
      requiresUnlock: false,
      unlocked: false
    }
  );
}
