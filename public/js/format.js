import { state } from "./state.js";

export function formatDate(value) {
  if (!value) {
    return "unknown";
  }
  return new Date(value).toLocaleString();
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

export function isServerLocked(snapshot = state.serverSnapshot) {
  return Boolean(getServerPermissions(snapshot).requiresUnlock);
}
