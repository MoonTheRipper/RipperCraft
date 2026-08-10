import { renderSection } from "../components.js";
import { escapeHtml, labelWithIcon } from "../html.js";
import { LOG_LINE_LIMIT, LOG_POLL_INTERVAL_MS } from "../logs-config.js";
import { state } from "../state.js";

// Keeps the tail, not the head: an 800-line log should open on the newest
// output, and the oldest lines are the ones worth dropping.
export function prepareLogText(raw, emptyMessage) {
  const text = String(raw || "").replace(/\s+$/, "");
  if (!text) {
    return { hiddenLines: 0, text: emptyMessage, totalLines: 0 };
  }

  const lines = text.split("\n");
  const kept = lines.slice(-LOG_LINE_LIMIT);
  if (state.logOrder === "newest") {
    kept.reverse();
  }
  return {
    hiddenLines: lines.length - kept.length,
    text: kept.join("\n"),
    totalLines: lines.length
  };
}

export function renderLogPane(key, label, raw, emptyMessage) {
  const prepared = prepareLogText(raw, emptyMessage);
  const meta = prepared.totalLines
    ? `${prepared.totalLines} lines${prepared.hiddenLines ? ` • oldest ${prepared.hiddenLines} hidden` : ""}`
    : "empty";

  // The pane scrolls, so it has to be reachable and scrollable from the
  // keyboard (WCAG 2.1.1) and it needs a name to be worth landing on.
  return `
    <div class="log-pane">
      <p class="log-label" id="log-label-${escapeHtml(key)}">${escapeHtml(label)} <span class="muted">${escapeHtml(meta)}</span></p>
      <pre
        data-log-pane="${escapeHtml(key)}"
        tabindex="0"
        role="region"
        aria-labelledby="log-label-${escapeHtml(key)}"
      >${escapeHtml(prepared.text)}</pre>
    </div>
  `;
}

export function renderLogsSection(snapshot) {
  const { logs } = snapshot;
  const newestFirst = state.logOrder === "newest";
  return renderSection(
    "logs",
    "latest.log and runtime.log",
    `
      <div class="submit-line">
        <button class="button button--quiet" data-action="refresh-logs">${labelWithIcon("refresh", "refresh logs")}</button>
        <button class="button ${state.logAutoRefresh ? "button--primary" : "button--quiet"}" data-action="toggle-log-auto">
          ${labelWithIcon("refresh", state.logAutoRefresh ? "live: on" : "live: off")}
        </button>
        <button class="button button--quiet" data-action="toggle-log-order">
          ${labelWithIcon("settings", newestFirst ? "switch to oldest first" : "switch to newest first")}
        </button>
        ${newestFirst ? "" : `<button class="button button--quiet" data-action="jump-to-latest">${labelWithIcon("refresh", "jump to latest")}</button>`}
      </div>
      <p class="muted">${state.logAutoRefresh ? `refreshing every ${LOG_POLL_INTERVAL_MS / 1000}s while this tab is open. ` : ""}${newestFirst ? "reversed: the newest line is at the top." : `opens at the newest output. showing at most the last ${LOG_LINE_LIMIT} lines.`}</p>
      <div class="log-grid">
        ${renderLogPane("latest", "latest.log", logs.latestLog, "No latest.log content yet.")}
        ${renderLogPane("runtime", "runtime.log", logs.runtimeLog, "No runtime log content yet.")}
      </div>
    `
  );
}
