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

// How the dashboard's last stop of a server ended, for a server that is not
// running: what it took, and when. null when the dashboard has not stopped
// it since it was last started.
//
// "stop" on the console is how a server is meant to go. SIGTERM comes after
// minutes of nothing, and Minecraft saves on it. SIGKILL comes last, and a
// server that is killed saves nothing: the page said "stopped", in green, of
// one that had been, and its owner found out from the world. `killed` is for
// that case, and everything that shows a stop asks it.
export function describeLastStop(status) {
  const stop = status && !status.running && status.lastStop;
  if (!stop || typeof stop !== "object") {
    return null;
  }
  const when = formatDate(stop.at);
  if (stop.how === "SIGKILL") {
    return { killed: true, summary: `${when} — killed. it did not stop when asked` };
  }
  if (stop.how === "SIGTERM") {
    return { killed: false, summary: `${when} — by SIGTERM` };
  }
  if (stop.how === "console") {
    return { killed: false, summary: `${when} — by "stop" on its console` };
  }
  return null;
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
