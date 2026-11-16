import { renderMetaRows, renderSection } from "../components.js";
import { describeLastStop, describeLeftover, describeRunState, formatDate } from "../format.js";
import { escapeHtml, icon, labelWithIcon, rawHtml } from "../html.js";
import { state } from "../state.js";

export function renderOverviewSection(snapshot) {
  const { server, worlds, mods, runtime, unlocked } = snapshot;
  const unlockBody = `
    <div class="inline-note">
      <span class="status-inline ${unlocked ? "status-inline--ok" : "status-inline--idle"}">${icon("unlock")}${unlocked ? "lane unlocked" : "lane locked"}</span>
      <span class="muted">${server.passphraseConfigured ? "passphrase required for edits and installs" : "no passphrase set yet"}</span>
    </div>
    <form data-form="unlock-server" class="form-inline">
      <label class="visually-hidden" for="server-unlock-passphrase">server passphrase</label>
      <input id="server-unlock-passphrase" type="password" name="passphrase" autocomplete="one-time-code" placeholder="server passphrase" ${state.bootstrap.user.role === "owner" ? "" : "required"} />
      <button class="button button--primary" type="submit">${labelWithIcon("unlock", state.bootstrap.user.role === "owner" ? "owner unlock" : "unlock")}</button>
    </form>
  `;

  const runState = describeRunState(server.status);
  const lastStop = describeLastStop(server.status);
  const left = describeLeftover(server.status);
  const infoBody = `
    ${runState.stopping
      ? `<p class="muted">this server was told to stop and is saving its world. it is given minutes to finish before anything stronger is tried, and this page shows it as stopped as soon as it has.</p>`
      : ""}
    ${runState.leftover
      ? `<p class="notice notice--error">the process this server was started as has exited, and ${left.some} that it started ${left.are} still running: something its start script started beside the server, or the server itself behind a start script that has gone. ${left.they} may be using the world, so the server still counts as running. stop ends ${left.them}, and the server cannot be started again before that.</p>`
      : ""}
    ${lastStop?.killed
      ? `<p class="notice notice--error">this server did not stop when it was asked to, and was killed. the world may not have been saved: see its log before starting it again.</p>`
      : ""}
    ${renderMetaRows([
      ["status", runState.stopping ? `${runState.label} since ${formatDate(server.status.stoppingSince)}` : runState.label],
      ...(lastStop ? [["last stop", lastStop.summary]] : []),
      ["eula", server.eulaAccepted ? "accepted" : "pending"],
      ["loader", server.loader],
      ["minecraft", server.minecraftVersion || "unknown"],
      ["directory", rawHtml(`<code>${escapeHtml(server.directory)}</code>`)],
      ["addons dir", rawHtml(`<code>${escapeHtml(runtime.modsDir)}</code>`)],
      ["world archives", String(worlds.length)],
      ["installed addons", String(mods.length)]
    ])}
  `;

  const eulaBody = `
    <div class="inline-note">
      <span class="status-inline ${server.eulaAccepted ? "status-inline--ok" : "status-inline--danger"}">${icon("overview")}${server.eulaAccepted ? "accepted" : "action required"}</span>
      <span class="muted">${server.eulaAccepted ? "the server can pass the EULA gate." : "minecraft will refuse to start until the EULA is accepted."}</span>
    </div>
    ${state.bootstrap.user.role === "owner" && !server.eulaAccepted
      ? `
        <form data-form="accept-eula" class="form-inline">
          <button class="button button--primary" type="submit">${labelWithIcon("unlock", "accept eula")}</button>
          <span class="muted">by using this button, the owner confirms acceptance of Mojang's Minecraft server EULA for this server.</span>
        </form>
      `
      : ""}
  `;

  return `
    ${renderSection("lane", "unlock before sensitive actions", unlockBody)}
    ${renderSection("eula", "minecraft startup requirement", eulaBody)}
    ${renderSection("server", "current server state", infoBody)}
    ${state.bootstrap.user.role === "owner" ? renderUpdatesSection(snapshot) : ""}
  `;
}

export function renderUpdatePlanSummary(plan, server) {
  if (!plan) {
    return "";
  }

  const blocked = plan.blockedReasons?.length
    ? `
        <div class="list-rows">
          ${plan.blockedReasons
            .map(
              (reason) => `
                <div class="list-row">
                  <div class="list-row__main">
                    <strong>blocked</strong>
                    <p class="muted">${escapeHtml(reason)}</p>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `
    : "";

  const updates = plan.addons?.updates?.length
    ? `
        <div class="list-rows">
          ${plan.addons.updates
            .map(
              (entry) => `
                <div class="list-row">
                  <div class="list-row__main">
                    <strong>${escapeHtml(entry.fileName)}</strong>
                    <p class="muted">${escapeHtml(entry.provider)} • ${escapeHtml(entry.sourceId)}</p>
                    <p class="muted">${escapeHtml(entry.fromFileName || "new dependency")} → ${escapeHtml(entry.fileName)}</p>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `
    : `<p class="muted">no managed add-ons need a file change for this target.</p>`;

  const runtime = plan.runtime || {};
  const describeMove = (from, to, direction) => {
    if (!to) {
      return "unchanged";
    }
    if (!from || from === to || direction === "unchanged") {
      return `${to} (unchanged)`;
    }
    return `${from} → ${to} (${direction})`;
  };

  const loaderRows = runtime.loaderVersioned
    ? [
        [
          "loader build",
          describeMove(runtime.currentLoaderVersion, runtime.loaderVersion, runtime.loaderDirection)
        ]
      ]
    : [];

  const modConflicts = [...(runtime.loaderConflicts || []), ...(runtime.minecraftConflicts || [])];
  const conflictRows = modConflicts.length
    ? `
        <div class="list-rows">
          ${modConflicts
            .map(
              (conflict) => `
                <div class="list-row">
                  <div class="list-row__main">
                    <strong>${escapeHtml(conflict.name || conflict.fileName)}</strong>
                    <p class="muted">${escapeHtml(conflict.fileName)}</p>
                    <p class="muted">declares ${escapeHtml(String(conflict.range))}, which this target does not satisfy</p>
                  </div>
                </div>
              `
            )
            .join("")}
        </div>
      `
    : "";

  // A loader-only plan touches no add-on files, so the add-on columns would
  // report zeroes that read as "nothing to update" rather than "not applicable".
  const addonRows = plan.mode === "loader-only"
    ? [["add-ons", "untouched — loader-only change"]]
    : [
        ["managed add-ons", String(plan.addons?.managedCount || 0)],
        ["manual add-ons", String(plan.addons?.manualCount || 0)],
        ["untracked files", String((plan.addons?.untrackedFiles || []).length)]
      ];

  return `
    <div class="tool-stack">
      <div class="inline-note">
        <span class="status-inline ${plan.safe ? "status-inline--ok" : "status-inline--danger"}">${icon("refresh")}${plan.safe ? "safe to apply" : "blocked"}</span>
        <span class="muted">${escapeHtml(plan.mode === "loader-only" ? "loader-only change" : "minecraft version change")}</span>
      </div>
      ${blocked}
      ${renderMetaRows([
        ["runtime", runtime.runtimeKind || server.loader],
        [
          "minecraft",
          describeMove(runtime.currentVersion, plan.targetVersion, runtime.versionDirection)
        ],
        ...loaderRows,
        ...addonRows
      ])}
      ${conflictRows}
      ${plan.mode === "loader-only" ? "" : updates}
    </div>
  `;
}

// The loader build a server runs on is versioned separately from Minecraft, and
// mods declare which builds they accept. This picker exists so that constraint
// is visible and selectable rather than implicit in whatever "latest" means on
// the day of the update.
function renderLoaderPicker(server) {
  const loaded = state.loaderOptions && state.loaderOptions.serverId === server.id
    ? state.loaderOptions.options
    : null;
  const current = server.managedRuntime?.loaderVersion || null;

  if (!loaded) {
    return {
      control: `
        <button class="button button--quiet" type="button" data-action="load-loader-versions">
          ${labelWithIcon("refresh", "load loader builds")}
        </button>
      `,
      note: `<p class="muted">current loader build: ${current ? escapeHtml(current) : "unknown"}. load the published builds to pin, upgrade or downgrade it.</p>`
    };
  }

  const floor = loaded.modScan?.floor || null;
  const unreadable = loaded.modScan?.unreadable || [];
  const scanned = loaded.modScan?.scannedMods ?? 0;
  const preselected = loaded.recommendedLoaderVersion || current;

  const options = loaded.versions
    .map((entry) => {
      const tags = [
        entry.current ? "current" : "",
        entry.recommended ? "recommended" : entry.stable ? "stable" : "prerelease",
        entry.satisfiesInstalledMods
          ? ""
          : `blocked by ${entry.conflicts.length} mod${entry.conflicts.length === 1 ? "" : "s"}`
      ]
        .filter(Boolean)
        .join(" • ");
      return `<option value="${escapeHtml(entry.version)}"${entry.version === preselected ? " selected" : ""}${
        entry.satisfiesInstalledMods ? "" : " disabled"
      }>${escapeHtml(entry.version)}${tags ? ` — ${escapeHtml(tags)}` : ""}</option>`;
    })
    .join("");

  return {
    control: `
      <label class="visually-hidden" for="update-loader-version">loader build</label>
      <select id="update-loader-version" name="loaderVersion">${options}</select>
    `,
    note: `
      <p class="muted">
        ${escapeHtml(String(scanned))} installed mod${scanned === 1 ? "" : "s"} scanned for loader requirements.
        ${floor
          ? `the lowest build they all accept is <strong>${escapeHtml(floor.version)}</strong>, required by ${escapeHtml(
              floor.requiredBy.map((mod) => `${mod.name} (${mod.range})`).join(", ")
            )}. builds below it are listed but disabled.`
          : "none of them declares a loader requirement, so any build listed here will load them."}
      </p>
      ${unreadable.length
        ? `<p class="muted">${escapeHtml(String(unreadable.length))} jar${unreadable.length === 1 ? "" : "s"} could not be read (${escapeHtml(
            unreadable.map((entry) => entry.fileName).join(", ")
          )}), so this list is a best effort rather than a guarantee.</p>`
        : ""}
    `
  };
}

// A server registered from an existing folder launches through its own script,
// so the dashboard has no runtime to update. Adoption is what closes that gap,
// and it is offered explicitly because it changes how the server starts.
function renderRuntimeAdoption(snapshot) {
  const { server } = snapshot;
  const adoption = server.runtimeAdoption;
  if (!adoption || adoption.alreadyManaged || !server.permissions?.canAdoptRuntime) {
    return "";
  }

  if (!adoption.installable) {
    return `<p class="muted">the dashboard cannot provision a ${escapeHtml(adoption.loader)} runtime, so this server stays manually managed.</p>`;
  }

  return `
    <div class="tool-stack">
      ${renderMetaRows([
        ["launches with", rawHtml(`<code>${escapeHtml(adoption.currentStartCommand)}</code>`)],
        ["detected loader build", adoption.detectedLoaderVersion || "not detected"],
        ["minecraft", adoption.minecraftVersion || "unknown"]
      ])}
      <p class="muted">
        adopting hands the runtime and launch script to the dashboard, which unlocks loader and version updates.
        the world, mods and configuration are untouched, and the existing <code>launch-server.sh</code> is copied into
        <code>.rippermoon/server-backups/</code> first. the server must be stopped.
      </p>
      <form data-form="adopt-runtime" class="form-inline">
        <label class="visually-hidden" for="adopt-loader-version">loader build to install</label>
        <input
          id="adopt-loader-version"
          name="loaderVersion"
          placeholder="${escapeHtml(adoption.detectedLoaderVersion || "newest compatible build")}"
        />
        <button class="button button--primary" type="submit">${labelWithIcon("refresh", "adopt runtime")}</button>
      </form>
    </div>
  `;
}

export function renderUpdatesSection(snapshot) {
  const { server } = snapshot;
  const support = server.updateSupport || { supported: false, reason: "Combined safe updates are unavailable for this server." };
  const plan = state.updatePlan && state.updatePlan.serverId === server.id ? state.updatePlan.plan : null;
  const applyAction =
    plan && plan.safe
      ? `<button class="button button--primary" type="button" data-action="apply-update">${labelWithIcon("refresh", "apply safe update")}</button>`
      : "";
  const adoptionBody = renderRuntimeAdoption(snapshot);
  const picker = support.loaderVersioned ? renderLoaderPicker(server) : { control: "", note: "" };

  const updatesBody = `
      <p class="muted">
        the server must be stopped. leave the Minecraft version blank to change only the loader build — that swaps the
        runtime and leaves every mod file in place. changing the Minecraft version re-resolves the add-ons instead, which
        requires every one of them to be tracked by the dashboard.
      </p>
      <form data-form="plan-update" class="form-inline">
        <label class="visually-hidden" for="update-target-version">target minecraft version</label>
        <input
          id="update-target-version"
          name="targetVersion"
          list="minecraft-version-list"
          placeholder="${escapeHtml(server.minecraftVersion || "choose target version")}"
        />
        ${picker.control}
        <button class="button button--quiet" type="submit">${labelWithIcon("refresh", "check update safety")}</button>
        ${applyAction}
      </form>
      ${picker.note}
      ${support.supported ? "" : `<p class="muted">${escapeHtml(support.reason)}</p>`}
      ${renderUpdatePlanSummary(plan, server)}
  `;

  return `
    ${adoptionBody ? renderSection("runtime adoption", "hand this server's runtime to the dashboard", adoptionBody) : ""}
    ${renderSection("updates", "owner-only runtime, loader and add-on updates", updatesBody)}
  `;
}
