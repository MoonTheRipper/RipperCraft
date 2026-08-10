import { state } from "./state.js";

// Several world and add-on operations call ensureServerStopped() on the way in.
// Despite the name it does not stop anything - it refuses the request outright
// while the server is online ("Stop the server before making this change."), so
// backing up a world on a busy server just fails with an error banner and no
// explanation of what to do about it.
//
// These helpers put that in front of the click instead: what the action needs,
// and what stopping the server costs. Nothing is blocked outright, because the
// cached status can be a few seconds stale - the user can always continue and
// let the backend give the authoritative answer.

const STOP_FIRST_WARNING =
  "This server is online, and the dashboard refuses this change until it is stopped. Stopping the server disconnects everyone who is playing.";

export function serverIsRunning() {
  return Boolean(state.serverSnapshot?.server?.status?.running);
}

export function activeWorldName() {
  const active = (state.serverSnapshot?.worlds || []).find((world) => world.active);
  return active ? active.name : "";
}

// A stopped server has nothing to warn about, so this stays silent there and
// only speaks up when the action is about to be refused.
export function confirmRequiresStoppedServer(actionSentence) {
  if (!serverIsRunning()) {
    return true;
  }
  return window.confirm(`${actionSentence}\n\n${STOP_FIRST_WARNING}\n\nTry anyway?`);
}

// For actions that deserve a confirmation whether or not the server is up:
// keeps their own prompt and appends the stop warning only when it applies.
export function confirmWithStopNotice(message) {
  return window.confirm(serverIsRunning() ? `${message}\n\n${STOP_FIRST_WARNING}` : message);
}

// Restoring is the one world action that deletes the live world directory, so
// it always asks, and it names what is about to be replaced.
export function confirmRestoreWorld(archiveName) {
  const active = activeWorldName();
  const lines = [
    `Restore the archived world "${archiveName}"?`,
    "",
    active
      ? `This replaces the live world "${active}" on this server.`
      : "This replaces the live world on this server.",
    "The live world is archived first, then its folder is deleted and rebuilt from the archive you picked."
  ];
  if (serverIsRunning()) {
    lines.push("", STOP_FIRST_WARNING);
  }
  return window.confirm(lines.join("\n"));
}
