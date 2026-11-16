import { loadServers, loadSnapshot } from "./data.js";
import { describeLastStop, describeRunState } from "./format.js";
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

// The servers shown as stopping, each with the pid of the process that is.
function stoppingServers() {
  const pids = new Map(state.servers.filter((server) => isStopping(server.status)).map((server) => [server.id, server.status.pid]));
  if (isStopping(state.serverSnapshot?.server?.status)) {
    pids.set(state.serverSnapshot.server.id, state.serverSnapshot.server.status.pid);
  }
  return pids;
}

export function anyServerStopping() {
  return stoppingServers().size > 0;
}

// What to say when stops have ended, and in which colour.
//
// A stop ends in one of four ways, and only one of them is good news. The
// server stopped: by its console or by SIGTERM, with its world saved. It was
// killed: it has stopped, and whatever it had not saved is lost. It is still
// there, the same process, with no stop under way any more: the stop failed,
// or the dashboard was restarted in the middle of it. Or the dashboard can no
// longer tell: the stop gave up on a process it could not be sure of. The
// last three are said as errors, and first.
function noticeForEndedStops({ killed, stopped, unknown, unstopped }) {
  const names = (servers) => servers.map((server) => server.name).join(", ");
  const parts = [];
  if (killed.length) {
    const one = killed.length === 1;
    parts.push(
      `${names(killed)} did not stop when asked, and ${one ? "was" : "were"} killed: the world may not have been saved, see ${one ? "its log" : "their logs"}`
    );
  }
  if (unknown.length) {
    const one = unknown.length === 1;
    parts.push(`it is no longer known whether ${names(unknown)} ${one ? "is" : "are"} running: see ${one ? "its page" : "their pages"}`);
  }
  if (unstopped.length) {
    const one = unstopped.length === 1;
    parts.push(`${names(unstopped)} ${one ? "is" : "are"} still running: the stop did not finish. see ${one ? "its log" : "their logs"}, then stop ${one ? "it" : "them"} again`);
  }
  if (stopped.length) {
    parts.push(`${names(stopped)} stopped`);
  }
  return parts.length ? { message: parts.join(". "), type: killed.length || unknown.length || unstopped.length ? "error" : "success" } : null;
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

  const wereStopping = stoppingServers();
  const selectedId = state.selectedServerId;
  try {
    await loadServers();
    stopPollFailures = 0;

    const listed = new Map(state.servers.map((server) => [server.id, server]));
    const finished = [...wereStopping.keys()].filter((id) => !isStopping(listed.get(id)?.status));
    if (!finished.length) {
      return; // Still stopping: nothing on the page has changed.
    }

    // The page of a server that has stopped is out of date in more than its
    // status: its log has the shutdown in it, and what needed a stopped
    // server can go ahead now.
    if (finished.includes(selectedId) && selectedId === state.selectedServerId) {
      await loadSnapshot();
    }

    const ended = finished.map((id) => listed.get(id)).filter(Boolean);
    const unknown = ended.filter((server) => describeRunState(server.status).unknown);
    const gone = ended.filter((server) => !server.status?.running && !unknown.includes(server));
    const notice = noticeForEndedStops({
      killed: gone.filter((server) => describeLastStop(server.status)?.killed),
      stopped: gone.filter((server) => !describeLastStop(server.status)?.killed),
      unknown,
      // Running under another pid, it has been started again since: that is
      // a server like any other, and nothing needs saying about it.
      unstopped: ended.filter((server) => server.status?.running && server.status.pid === wereStopping.get(server.id))
    });
    if (notice) {
      setNotice(notice.type, notice.message);
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
