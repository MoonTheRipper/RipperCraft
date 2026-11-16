import { loadServers, loadSnapshot } from "./data.js";
import { setNotice } from "./notice.js";
import { render } from "./render.js";
import { state } from "./state.js";

// How often a server that is stopping is asked whether it has stopped.
export const STOP_POLL_INTERVAL_MS = 2000;

let stopPollTimer = null;
let stopPollInFlight = false;
let stopPollFailures = 0;

function isStopping(status) {
  return Boolean(status?.running && status.stopping);
}

function stoppingServerIds() {
  const ids = new Set(state.servers.filter((server) => isStopping(server.status)).map((server) => server.id));
  if (isStopping(state.serverSnapshot?.server?.status)) {
    ids.add(state.serverSnapshot.server.id);
  }
  return ids;
}

export function anyServerStopping() {
  return stoppingServerIds().size > 0;
}

// The request that stops a server is answered at once, and the server then
// takes as long as it needs to save - seconds as a rule, minutes on a machine
// that is short of memory. Nothing tells the page when it is done, so while
// any server shown is stopping the page asks, every two seconds, until none
// is. Run after every render, like the log poller: what is on the page decides
// whether it runs.
export function syncStopPolling() {
  if (!anyServerStopping()) {
    if (stopPollTimer) {
      clearInterval(stopPollTimer);
      stopPollTimer = null;
    }
    return;
  }

  if (stopPollTimer) {
    return;
  }

  stopPollFailures = 0;
  stopPollTimer = setInterval(pollStoppingOnce, STOP_POLL_INTERVAL_MS);
}

export async function pollStoppingOnce() {
  // Skipped while the tab is in the background; the first tick after it is
  // visible again catches up.
  if (stopPollInFlight || document.hidden || !anyServerStopping()) {
    return;
  }
  stopPollInFlight = true;

  const wereStopping = stoppingServerIds();
  const selectedId = state.selectedServerId;
  try {
    await loadServers();
    stopPollFailures = 0;

    const listed = new Map(state.servers.map((server) => [server.id, server]));
    const finished = [...wereStopping].filter((id) => !isStopping(listed.get(id)?.status));
    if (!finished.length) {
      return; // Still stopping: nothing on the page has changed.
    }

    // The page of a server that has stopped is out of date in more than its
    // status: its log has the shutdown in it, and what needed a stopped
    // server can go ahead now.
    if (finished.includes(selectedId) && selectedId === state.selectedServerId) {
      await loadSnapshot();
    }

    const stopped = finished.map((id) => listed.get(id)).filter((server) => server && !server.status?.running);
    if (stopped.length) {
      setNotice("success", `${stopped.map((server) => server.name).join(", ")} stopped`);
    } else {
      render();
    }
  } catch (error) {
    stopPollFailures += 1;
    // Three in a row means the dashboard itself is not answering, or the
    // session has ended. Stop asking, and say so once. What the page showed
    // as stopping is shown as running again: that is the last thing known
    // about it, and the refresh button asks afresh.
    if (stopPollFailures >= 3) {
      for (const server of state.servers) {
        if (server.status) {
          server.status.stopping = false;
        }
      }
      if (state.serverSnapshot?.server?.status) {
        state.serverSnapshot.server.status.stopping = false;
      }
      setNotice("error", `lost touch with a server that was stopping: ${error.message}`);
    }
  } finally {
    stopPollInFlight = false;
  }
}
