import { state } from "./state.js";

export function formatDate(value) {
  if (!value) {
    return "unknown";
  }
  return new Date(value).toLocaleString();
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
