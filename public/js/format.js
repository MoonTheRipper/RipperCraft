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
