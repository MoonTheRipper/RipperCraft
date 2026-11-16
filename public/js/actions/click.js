import { api } from "../api.js";
import { confirmRestoreWorld, confirmRequiresStoppedServer, confirmWithStopNotice } from "../confirm.js";
import { loadBootstrap, loadServers, loadSnapshot, refreshAll } from "../data.js";
import { applyLogScroll, logScrollPinned } from "../logs-live.js";
import { releaseReturnFocus, rememberReturnFocus } from "../modal.js";
import { clearNotice, setNotice } from "../notice.js";
import { render } from "../render.js";
import { resetServerScopedState, state, writeStored } from "../state.js";
import { toggleTheme } from "../theme.js";
import { currentModUpdates } from "../views/server-mods.js";

// Update results are keyed by filename alone, so they are stamped with the
// server they were fetched for and discarded if the selection moved on while
// the check was running.
async function fetchModUpdates(serverId) {
  const payload = await api(`/api/servers/${encodeURIComponent(serverId)}/mods/updates`);
  if (serverId !== state.selectedServerId) {
    return null;
  }
  state.modUpdates = { ...payload, serverId };
  return state.modUpdates;
}

export async function handleAppClick(event) {
  if (state.createVersionOpen && !event.target.closest("[data-version-picker]")) {
    state.createVersionOpen = false;
    render();
    return;
  }

  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  try {
    const action = target.dataset.action;

    if (action === "logout") {
      await api("/api/logout", { method: "POST" });
      state.selectedServerId = null;
      clearNotice();
      await refreshAll();
      return;
    }

    if (action === "toggle-theme") {
      toggleTheme();
      render();
      return;
    }

    if (action === "toggle-nav") {
      state.navOpen = !state.navOpen;
      render();
      return;
    }

    if (action === "close-nav") {
      state.navOpen = false;
      render();
      return;
    }

    if (action === "toggle-create-version-picker") {
      state.createVersionOpen = !state.createVersionOpen;
      render();
      return;
    }

    if (action === "edit-user") {
      state.editingUserId = target.dataset.userId;
      state.resettingUserId = null;
      rememberReturnFocus(`[data-action="edit-user"][data-user-id="${target.dataset.userId}"]`);
      render();
      return;
    }

    if (action === "close-user-editor") {
      state.editingUserId = null;
      render();
      releaseReturnFocus();
      return;
    }

    if (action === "reset-user-password") {
      state.resettingUserId = target.dataset.userId;
      state.editingUserId = null;
      rememberReturnFocus(`[data-action="reset-user-password"][data-user-id="${target.dataset.userId}"]`);
      render();
      return;
    }

    if (action === "close-password-reset") {
      state.resettingUserId = null;
      render();
      releaseReturnFocus();
      return;
    }

    if (action === "select-create-version") {
      state.createServerMinecraftVersion = target.dataset.version || "latest";
      state.createVersionOpen = false;
      render();
      return;
    }

    if (action === "show-owner") {
      state.view = "owner";
      state.ownerSection = state.ownerSection || "servers";
      state.navOpen = false;
      render();
      return;
    }

    if (action === "show-servers") {
      state.view = "server";
      state.serverSection = state.serverSection || "overview";
      state.navOpen = false;
      render();
      return;
    }

    if (action === "select-server") {
      state.view = "server";
      state.selectedServerId = target.dataset.serverId;
      state.serverSection = "overview";
      resetServerScopedState();
      state.navOpen = false;
      await loadSnapshot();
      render();
      return;
    }

    if (action === "select-server-section") {
      state.view = "server";
      state.serverSection = target.dataset.section;
      state.navOpen = false;
      render();
      return;
    }

    if (action === "select-owner-section") {
      state.view = "owner";
      state.ownerSection = target.dataset.ownerSection;
      state.navOpen = false;
      render();
      return;
    }

    if (action === "start-server") {
      state.updatePlan = null;
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/start`, { method: "POST" });
      setNotice("success", "server start command sent");
      await loadServers();
      await loadSnapshot();
      render();
      return;
    }

    if (action === "stop-server") {
      state.updatePlan = null;
      // Answered at once: the server is told to stop and then given the time
      // it needs to save. The page shows it as stopping from here on, and
      // stopping-live.js watches until it has gone.
      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/stop`, { method: "POST" });
      setNotice(
        "success",
        payload?.status?.stopping ? "stopping — the server saves the world first" : "the server is not running"
      );
      await loadServers();
      await loadSnapshot();
      render();
      return;
    }

    if (action === "refresh-server" || action === "refresh-logs") {
      state.updatePlan = null;
      await loadServers();
      await loadSnapshot();
      render();
      return;
    }

    if (action === "delete-world") {
      const archiveName = target.dataset.archiveName;
      // Unrecoverable: no trash, no undo. Make the name explicit in the prompt.
      if (
        !window.confirm(
          `Permanently delete the world archive "${archiveName}" (${target.dataset.size})?\n\nThis cannot be undone. The active world is not affected.`
        )
      ) {
        return;
      }
      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/delete`, {
        method: "POST",
        body: { archiveName }
      });
      if (state.serverSnapshot) {
        state.serverSnapshot.worlds = payload.worlds;
      }
      setNotice("success", `deleted archive ${payload.deleted}`);
      await loadSnapshot();
      render();
      return;
    }

    if (action === "activate-world") {
      const archiveName = target.dataset.archiveName;
      // The only world action that deletes the live world directory, so it
      // names what is being replaced and always asks first.
      if (!confirmRestoreWorld(archiveName)) {
        return;
      }
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/activate`, {
        method: "POST",
        body: { archiveName }
      });
      setNotice("success", `restored world ${archiveName}`);
      await loadServers();
      await loadSnapshot();
      render();
      return;
    }

    if (action === "export-active-world") {
      // A plain download link, but the export zips the live world and is
      // refused while the server is online. Cancelling cancels the navigation.
      if (!confirmRequiresStoppedServer("Export the active world as a zip download?")) {
        event.preventDefault();
      }
      return;
    }

    if (action === "toggle-log-auto") {
      state.logAutoRefresh = !state.logAutoRefresh;
      writeStored("log-auto", state.logAutoRefresh ? "on" : "off");
      render();
      return;
    }

    if (action === "toggle-log-order") {
      state.logOrder = state.logOrder === "newest" ? "oldest" : "newest";
      writeStored("log-order", state.logOrder);
      logScrollPinned.latest = true;
      logScrollPinned.runtime = true;
      render();
      return;
    }

    if (action === "jump-to-latest") {
      logScrollPinned.latest = true;
      logScrollPinned.runtime = true;
      applyLogScroll();
      return;
    }

    if (action === "repair-operators") {
      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/operators/repair`, {
        method: "POST"
      });
      setNotice(
        payload.failures.length ? "error" : "success",
        payload.failures.length
          ? `some uuids could not be resolved: ${payload.failures.map((f) => `${f.name} (${f.reason})`).join("; ")}`
          : "operator uuids fixed — restart the server for minecraft to reload ops.json"
      );
      await loadSnapshot();
      render();
      return;
    }

    if (action === "test-integration") {
      const payload = await api("/api/settings/integrations/test", { method: "POST" });
      setNotice(payload.result.ok ? "success" : "error", payload.result.reason);
      return;
    }

    if (action === "clear-integration") {
      if (!window.confirm("Remove the stored CurseForge key? Search and installs will be disabled.")) {
        return;
      }
      const payload = await api("/api/settings/integrations", {
        method: "PUT",
        body: { curseforgeApiKey: "" }
      });
      state.integrations = payload.integrations;
      await loadBootstrap();
      setNotice("success", "curseforge key removed");
      return;
    }

    if (action === "dismiss-manual-download") {
      state.manualDownload = null;
      render();
      return;
    }

    if (action === "install-result") {
      state.updatePlan = null;
      state.manualDownload = null;
      const payload =
        target.dataset.provider === "curseforge"
          ? { provider: "curseforge", modId: target.dataset.id }
          : { provider: "modrinth", projectId: target.dataset.id };
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/install`, {
        method: "POST",
        body: payload
      });
      setNotice("success", "install completed");
      await loadSnapshot();
      await loadServers();
      render();
      return;
    }

    if (action === "check-mod-updates") {
      setNotice("success", "checking every tracked add-on against its provider…");
      const updates = await fetchModUpdates(state.selectedServerId);
      if (!updates) {
        return;
      }
      // The ternary here used to read `updatable ? "success" : "success"`. Both
      // outcomes are a successful check, so the branch that carries meaning is
      // the one every neighbouring handler uses: entries the dashboard could
      // not check at all are a failure and must not be reported as success.
      const failed = updates.entries.filter((entry) => entry.status === "error").length;
      setNotice(
        failed ? "error" : "success",
        [
          updates.updatable ? `${updates.updatable} add-on update(s) available` : "every tracked add-on is up to date",
          failed ? `${failed} add-on(s) could not be checked` : ""
        ]
          .filter(Boolean)
          .join(" • ")
      );
      return;
    }

    if (action === "dismiss-mod-updates") {
      state.modUpdates = null;
      render();
      return;
    }

    if (action === "update-mod" || action === "update-all-mods") {
      const updates = currentModUpdates();
      const single = action === "update-mod" ? target.dataset.fileName : null;
      const fileNames = single
        ? [single]
        : (updates?.entries || [])
            .filter((entry) => entry.status === "update-available")
            .map((entry) => entry.fileName);

      if (!fileNames.length) {
        setNotice("error", "nothing to update");
        return;
      }
      if (
        !confirmWithStopNotice(
          `Update ${fileNames.length} add-on(s)?\n\nMinecraft stays on ${updates?.gameVersion || "the current version"}.`
        )
      ) {
        return;
      }

      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/update`, {
        method: "POST",
        body: { fileNames }
      });

      const failed = payload.results.filter((entry) => !entry.ok);
      const changed = payload.results.filter((entry) => entry.ok && entry.changed);
      setNotice(
        failed.length ? "error" : "success",
        failed.length
          ? `updated ${changed.length}, failed ${failed.length}: ${failed.map((entry) => `${entry.fileName} (${entry.error})`).join("; ")}`
          : `updated ${changed.length} add-on(s)`
      );

      // Re-check so the panel reflects the new state rather than stale results.
      await fetchModUpdates(state.selectedServerId);
      await loadSnapshot();
      render();
      return;
    }

    if (action === "remove-mod") {
      state.updatePlan = null;
      const fileName = target.dataset.fileName;
      if (!window.confirm(`Remove ${fileName} from this server?`)) {
        return;
      }
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/remove`, {
        method: "POST",
        body: { fileName }
      });
      setNotice("success", "add-on removed");
      await loadSnapshot();
      await loadServers();
      render();
      return;
    }

    if (action === "toggle-mod") {
      state.updatePlan = null;
      const fileName = target.dataset.fileName;
      const currentlyEnabled = target.dataset.enabled === "true";
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/toggle`, {
        method: "POST",
        body: {
          enabled: !currentlyEnabled,
          fileName
        }
      });
      setNotice("success", currentlyEnabled ? "add-on disabled" : "add-on enabled");
      await loadSnapshot();
      await loadServers();
      render();
      return;
    }

    if (action === "remove-server-operator") {
      const uuid = target.dataset.uuid;
      if (!uuid || !window.confirm("Remove this in-game operator from the server?")) {
        return;
      }
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/operators/${encodeURIComponent(uuid)}`, {
        method: "DELETE"
      });
      setNotice("success", "server admin removed");
      await loadSnapshot();
      render();
      return;
    }

    if (action === "owner-open-server") {
      state.view = "server";
      state.selectedServerId = target.dataset.serverId;
      state.serverSection = "overview";
      resetServerScopedState();
      await loadSnapshot();
      render();
      return;
    }

    if (action === "delete-server") {
      const serverId = target.dataset.serverId;
      const serverName = target.dataset.serverName || serverId;
      const confirmation = window.prompt(
        `Type ${serverId} to delete ${serverName}. This removes the server folder and its dashboard record.`,
        ""
      );
      if (confirmation !== serverId) {
        setNotice("error", "server deletion cancelled");
        return;
      }

      await api(`/api/servers/${encodeURIComponent(serverId)}`, {
        method: "DELETE",
        body: { confirmServerId: serverId }
      });
      if (state.selectedServerId === serverId) {
        state.selectedServerId = null;
        state.serverSnapshot = null;
        state.updatePlan = null;
      }
      setNotice("success", "server deleted");
      await refreshAll();
      return;
    }

    if (action === "refresh-mod-details") {
      const serverId = state.selectedServerId;
      const payload = await api(`/api/servers/${encodeURIComponent(serverId)}/mods/refresh-details`, {
        method: "POST"
      });
      if (serverId !== state.selectedServerId) {
        return;
      }
      if (state.serverSnapshot) {
        state.serverSnapshot = { ...state.serverSnapshot, mods: payload.mods };
      }
      setNotice(
        "success",
        `refreshed ${payload.result.refreshed} add-on${payload.result.refreshed === 1 ? "" : "s"} — ${payload.result.withSide} report a client/server side`
      );
      render();
      return;
    }

    if (action === "load-loader-versions") {
      const serverId = state.selectedServerId;
      // The catalog is fetched against the version currently typed in the form,
      // so the builds listed are the ones that exist for the intended target.
      const targetVersion = String(
        document.querySelector('[data-form="plan-update"] [name="targetVersion"]')?.value || ""
      ).trim();
      const query = targetVersion ? `?gameVersion=${encodeURIComponent(targetVersion)}` : "";
      const payload = await api(`/api/servers/${encodeURIComponent(serverId)}/loader-versions${query}`);
      if (serverId !== state.selectedServerId) {
        return;
      }
      state.loaderOptions = { options: payload.loaderOptions, serverId };
      const floor = payload.loaderOptions.modScan?.floor;
      setNotice(
        "success",
        floor
          ? `${payload.loaderOptions.versions.length} builds listed — installed mods need ${floor.version} or newer`
          : `${payload.loaderOptions.versions.length} builds listed`
      );
      render();
      return;
    }

    if (action === "apply-update") {
      if (!state.updatePlan?.plan?.safe) {
        setNotice("error", "run the update safety check first");
        return;
      }

      const plan = state.updatePlan.plan;
      const targetVersion = plan.targetVersion || state.serverSnapshot?.server?.minecraftVersion || "";
      const loaderVersion = plan.runtime?.loaderVersion || "";
      // The prompt names both axes, because "update to 26.1.2" reads as a no-op
      // when the game version is unchanged and only the loader is moving.
      const summary = plan.mode === "loader-only"
        ? `Move the loader build to ${loaderVersion} on Minecraft ${targetVersion}? Mod files are left untouched.`
        : `Apply the safe combined update for ${state.serverSnapshot.server.name} to Minecraft ${targetVersion}${
            loaderVersion ? ` with loader build ${loaderVersion}` : ""
          }? Managed add-ons are re-resolved for the new version.`;
      const confirmed = window.confirm(`${summary}\n\nThe server must remain stopped during the update.`);
      if (!confirmed) {
        return;
      }

      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/updates/apply`, {
        method: "POST",
        body: { loaderVersion, targetVersion }
      });
      state.serverSnapshot = payload.snapshot;
      state.updatePlan = { plan: payload.plan, serverId: state.selectedServerId };
      state.loaderOptions = null;
      setNotice(
        "success",
        payload.runtimeResult?.loaderVersion
          ? `runtime updated — loader build ${payload.runtimeResult.loaderVersion}`
          : "combined server update applied"
      );
      await loadServers();
      render();
      return;
    }
  } catch (error) {
    if (error.manualDownload) {
      state.manualDownload = error.manualDownload;
    }
    setNotice("error", error.message);
  }
}
