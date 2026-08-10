import { api } from "../api.js";
import { loadBootstrap, loadServers, loadSnapshot, refreshAll } from "../data.js";
import { applyLogScroll, logScrollPinned } from "../logs-live.js";
import { clearNotice, setNotice } from "../notice.js";
import { render } from "../render.js";
import { state } from "../state.js";
import { toggleTheme } from "../theme.js";

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
      render();
      return;
    }

    if (action === "close-user-editor") {
      state.editingUserId = null;
      render();
      return;
    }

    if (action === "reset-user-password") {
      state.resettingUserId = target.dataset.userId;
      state.editingUserId = null;
      render();
      return;
    }

    if (action === "close-password-reset") {
      state.resettingUserId = null;
      render();
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
      state.modResults = [];
      state.updatePlan = null;
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
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/stop`, { method: "POST" });
      setNotice("success", "server stop command sent");
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
      await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/activate`, {
        method: "POST",
        body: { archiveName: target.dataset.archiveName }
      });
      setNotice("success", `activated world ${target.dataset.archiveName}`);
      await loadSnapshot();
      render();
      return;
    }

    if (action === "toggle-log-auto") {
      state.logAutoRefresh = !state.logAutoRefresh;
      localStorage.setItem("rippermoonstash-log-auto", state.logAutoRefresh ? "on" : "off");
      render();
      return;
    }

    if (action === "toggle-log-order") {
      state.logOrder = state.logOrder === "newest" ? "oldest" : "newest";
      localStorage.setItem("rippermoonstash-log-order", state.logOrder);
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
      state.modUpdates = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/updates`);
      setNotice(
        state.modUpdates.updatable ? "success" : "success",
        state.modUpdates.updatable
          ? `${state.modUpdates.updatable} add-on update(s) available`
          : "every tracked add-on is up to date"
      );
      return;
    }

    if (action === "dismiss-mod-updates") {
      state.modUpdates = null;
      render();
      return;
    }

    if (action === "update-mod" || action === "update-all-mods") {
      const single = action === "update-mod" ? target.dataset.fileName : null;
      const fileNames = single
        ? [single]
        : (state.modUpdates?.entries || [])
            .filter((entry) => entry.status === "update-available")
            .map((entry) => entry.fileName);

      if (!fileNames.length) {
        setNotice("error", "nothing to update");
        return;
      }
      if (
        !window.confirm(
          `Update ${fileNames.length} add-on(s)?\n\nThe server will be stopped first if it is running. Minecraft stays on ${state.modUpdates?.gameVersion || "the current version"}.`
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
      state.modUpdates = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/updates`);
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
      state.modResults = [];
      state.updatePlan = null;
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

    if (action === "apply-update") {
      if (!state.updatePlan?.plan?.safe) {
        setNotice("error", "run the update safety check first");
        return;
      }

      const targetVersion = state.updatePlan.plan.targetVersion || state.serverSnapshot?.server?.minecraftVersion || "";
      const confirmed = window.confirm(
        `Apply the safe combined update for ${state.serverSnapshot.server.name} to ${targetVersion}? The server must remain stopped during the update.`
      );
      if (!confirmed) {
        return;
      }

      const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/updates/apply`, {
        method: "POST",
        body: { targetVersion }
      });
      state.serverSnapshot = payload.snapshot;
      state.updatePlan = { plan: payload.plan, serverId: state.selectedServerId };
      setNotice("success", "combined server update applied");
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
