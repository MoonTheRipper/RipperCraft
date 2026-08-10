import { renderMetaRows, renderSection } from "../components.js";
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

  const infoBody = `
    ${renderMetaRows([
      ["status", server.status.running ? "online" : "offline"],
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

  return `
    <div class="tool-stack">
      <div class="inline-note">
        <span class="status-inline ${plan.safe ? "status-inline--ok" : "status-inline--danger"}">${icon("refresh")}${plan.safe ? "safe to apply" : "blocked"}</span>
        <span class="muted">target ${escapeHtml(plan.targetVersion || server.minecraftVersion || "current version")}</span>
      </div>
      ${blocked}
      ${renderMetaRows([
        ["runtime", plan.runtime?.runtimeKind || server.loader],
        ["managed add-ons", String(plan.addons?.managedCount || 0)],
        ["manual add-ons", String(plan.addons?.manualCount || 0)],
        ["untracked files", String((plan.addons?.untrackedFiles || []).length)]
      ])}
      ${updates}
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

  return renderSection(
    "updates",
    "owner-only combined runtime and add-on updates",
    `
      <p class="muted">the server must be stopped. every add-on must be tracked by the dashboard, and a compatible build must exist for the selected Minecraft version before the update button appears.</p>
      <form data-form="plan-update" class="form-inline">
        <label class="visually-hidden" for="update-target-version">target minecraft version</label>
        <input
          id="update-target-version"
          name="targetVersion"
          list="minecraft-version-list"
          placeholder="${escapeHtml(server.minecraftVersion || "choose target version")}"
        />
        <button class="button button--quiet" type="submit">${labelWithIcon("refresh", "check update safety")}</button>
        ${applyAction}
      </form>
      ${support.supported ? "" : `<p class="muted">${escapeHtml(support.reason)}</p>`}
      ${renderUpdatePlanSummary(plan, server)}
    `
  );
}
