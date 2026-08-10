import { api } from "./api.js";
import { getApp } from "./dom.js";
import { LOG_POLL_INTERVAL_MS } from "./logs-config.js";
import { setNotice } from "./notice.js";
import { render } from "./render.js";
import { state } from "./state.js";

let logPollTimer = null;
let logPollInFlight = false;
let logPollFailures = 0;

export function logsTabIsOpen() {
  return (
    state.view === "server" &&
    state.serverSection === "logs" &&
    Boolean(state.selectedServerId) &&
    Boolean(state.serverSnapshot)
  );
}

// Only polls while the logs tab is actually on screen, so navigating away or
// switching servers stops the background requests.
export function syncLogPolling() {
  const shouldPoll = state.logAutoRefresh && logsTabIsOpen();

  if (!shouldPoll) {
    if (logPollTimer) {
      clearInterval(logPollTimer);
      logPollTimer = null;
    }
    return;
  }

  if (logPollTimer) {
    return;
  }

  logPollFailures = 0;
  logPollTimer = setInterval(pollLogsOnce, LOG_POLL_INTERVAL_MS);
}

export async function pollLogsOnce() {
  // Skip while the tab is in the background; the next tick after it is visible
  // again picks straight back up.
  if (logPollInFlight || document.hidden || !logsTabIsOpen()) {
    return;
  }
  logPollInFlight = true;

  const serverId = state.selectedServerId;
  try {
    const logs = await api(`/api/servers/${encodeURIComponent(serverId)}/logs`);
    logPollFailures = 0;

    // The server may have changed under us while the request was in flight.
    if (serverId !== state.selectedServerId || !state.serverSnapshot) {
      return;
    }

    const current = state.serverSnapshot.logs || {};
    if (current.latestLog === logs.latestLog && current.runtimeLog === logs.runtimeLog) {
      return; // Nothing new: skip the re-render so the view does not flicker.
    }

    state.serverSnapshot.logs = logs;
    render();
  } catch (error) {
    logPollFailures += 1;
    // Three consecutive failures means something real is wrong (server down,
    // session expired). Stop hammering it and say so once.
    if (logPollFailures >= 3) {
      state.logAutoRefresh = false;
      localStorage.setItem("rippermoonstash-log-auto", "off");
      syncLogPolling();
      setNotice("error", `log auto refresh stopped: ${error.message}`);
    }
  } finally {
    logPollInFlight = false;
  }
}

// render() replaces innerHTML, which resets scroll to the top - the reason logs
// always opened on the oldest lines. Re-pin each pane to the newest output
// unless the reader has deliberately scrolled up.
export const logScrollPinned = { latest: true, runtime: true };

export function applyLogScroll() {
  for (const pane of getApp().querySelectorAll("[data-log-pane]")) {
    const key = pane.dataset.logPane;
    if (state.logOrder === "newest") {
      pane.scrollTop = 0;
    } else if (logScrollPinned[key] !== false) {
      pane.scrollTop = pane.scrollHeight;
    }

    pane.addEventListener("scroll", () => {
      const distanceFromBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      logScrollPinned[key] = distanceFromBottom < 40;
    });
  }
}
