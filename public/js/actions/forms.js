import { api } from "../api.js";
import { confirmRequiresStoppedServer, confirmWithStopNotice } from "../confirm.js";
import { loadBootstrap, loadServers, loadSnapshot, pollCreateJob, refreshAll } from "../data.js";
import { installableLoaders, isInstallableLoader } from "../loaders.js";
import { releaseReturnFocus } from "../modal.js";
import { clearNotice, setNotice } from "../notice.js";
import { render } from "../render.js";
import { state } from "../state.js";

export function checkedValues(form, name) {
  return Array.from(form.querySelectorAll(`input[name="${name}"]:checked`)).map((input) => input.value);
}

export function normalizeAccessSelection(accessServers, worldServers) {
  return [...new Set([...(accessServers || []), ...(worldServers || [])])];
}

export async function handleAppSubmit(event) {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }

  event.preventDefault();

  try {
    switch (form.dataset.form) {
      case "login": {
        await api("/api/login", {
          method: "POST",
          body: Object.fromEntries(new FormData(form).entries())
        });
        clearNotice();
        await refreshAll();
        break;
      }
      case "setup": {
        await api("/api/setup-owner", {
          method: "POST",
          body: Object.fromEntries(new FormData(form).entries())
        });
        clearNotice();
        await refreshAll();
        break;
      }
      case "unlock-server": {
        const passphrase = new FormData(form).get("passphrase");
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/unlock`, {
          method: "POST",
          body: { passphrase }
        });
        setNotice("success", "server lane unlocked");
        await loadSnapshot();
        render();
        break;
      }
      case "unlock-server-popup": {
        const passphrase = new FormData(form).get("passphrase");
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/unlock`, {
          method: "POST",
          body: { passphrase }
        });
        setNotice("success", "server lane unlocked");
        await loadSnapshot();
        render();
        break;
      }
      case "save-settings": {
        const data = Object.fromEntries(new FormData(form).entries());
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/settings`, {
          method: "PUT",
          body: data
        });
        setNotice("success", "settings saved");
        await loadServers();
        await loadSnapshot();
        render();
        break;
      }
      case "save-safe-settings": {
        const formData = new FormData(form);
        const safeProperties = Object.fromEntries(formData.entries());
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/settings`, {
          method: "PUT",
          body: { safeProperties }
        });
        setNotice("success", "safe settings saved");
        await loadSnapshot();
        render();
        break;
      }
      case "save-addon-settings": {
        const formData = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/settings`, {
          method: "PUT",
          body: {
            addonSettings: {
              loader: formData.get("loader"),
              minecraftVersion: formData.get("minecraftVersion")
            }
          }
        });
        setNotice("success", "add-on settings saved");
        state.modResults = [];
        await loadServers();
        await loadSnapshot();
        render();
        break;
      }
      case "add-server-operator": {
        const formData = new FormData(form);
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/operators`, {
          method: "POST",
          body: {
            bypassesPlayerLimit: formData.get("bypassesPlayerLimit") === "on",
            level: formData.get("level"),
            name: formData.get("name")
          }
        });
        setNotice("success", "server admin added");
        form.reset();
        await loadSnapshot();
        render();
        break;
      }
      case "capture-world": {
        const data = Object.fromEntries(new FormData(form).entries());
        // Archiving zips the live world directory, which the backend refuses to
        // do underneath a running server.
        if (!confirmRequiresStoppedServer("Back up the active world of this server?")) {
          break;
        }
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/capture`, {
          method: "POST",
          body: data
        });
        setNotice("success", "active world archived");
        await loadSnapshot();
        render();
        break;
      }
      case "create-world": {
        const formData = new FormData(form);
        // Creating archives the world that is live now and repoints the server
        // at a brand new one, so it needs the server down as well.
        if (
          !confirmRequiresStoppedServer(
            `Create the new world "${formData.get("name") || ""}"? The world that is live now is archived first, and the server switches to the new one.`
          )
        ) {
          break;
        }
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/create`, {
          method: "POST",
          body: {
            generateStructures: formData.get("generateStructures") === "true",
            levelType: formData.get("levelType"),
            name: formData.get("name"),
            seed: formData.get("seed")
          }
        });
        setNotice("success", "new world prepared. start the server to generate it");
        await loadSnapshot();
        render();
        break;
      }
      case "save-world-rules": {
        const formData = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/rules`, {
          method: "POST",
          body: {
            forceGamemode: formData.get("forceGamemode") === "true",
            generateStructures: formData.get("generateStructures") === "true",
            levelType: formData.get("levelType")
          }
        });
        setNotice("success", "world rules saved");
        await loadSnapshot();
        render();
        break;
      }
      case "import-world": {
        const data = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/worlds/import`, {
          method: "POST",
          body: data
        });
        setNotice("success", "world archive imported");
        await loadSnapshot();
        render();
        break;
      }
      case "save-integration": {
        const data = Object.fromEntries(new FormData(form).entries());
        const payload = await api("/api/settings/integrations", {
          method: "PUT",
          body: { curseforgeApiKey: data.curseforgeApiKey || "" }
        });
        state.integrations = payload.integrations;
        form.reset();
        // Provider availability gates the curseforge option in mod search.
        await loadBootstrap();
        setNotice(
          "success",
          payload.integrations.curseforge.envOverride
            ? "key verified and saved, but an environment variable is still overriding it"
            : "curseforge key verified and saved"
        );
        render();
        break;
      }
      case "search-mods": {
        const data = Object.fromEntries(new FormData(form).entries());
        state.modProvider = data.provider === "curseforge" ? "curseforge" : "modrinth";
        state.modQuery = data.query || "";
        const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/search`, {
          method: "POST",
          body: data
        });
        state.modResults = payload.results;
        setNotice("success", `found ${payload.results.length} results`);
        render();
        break;
      }
      case "install-direct": {
        const data = Object.fromEntries(new FormData(form).entries());
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/install`, {
          method: "POST",
          body: {
            confirmManualCompatibility: data.confirmManualCompatibility === "true",
            provider: "direct",
            url: data.url
          }
        });
        setNotice("success", "direct download installed");
        await loadSnapshot();
        await loadServers();
        render();
        break;
      }
      case "upload-mod": {
        const data = new FormData(form);
        state.updatePlan = null;
        await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/mods/upload`, {
          method: "POST",
          body: data
        });
        setNotice("success", "file uploaded");
        await loadSnapshot();
        await loadServers();
        render();
        break;
      }
      case "create-server": {
        const formData = new FormData(form);
        const mode = String(formData.get("mode") || "managed");
        const loader = String(formData.get("loader") || "vanilla");
        if (mode !== "existing" && !isInstallableLoader(loader)) {
          throw new Error(
            `Managed server creation cannot provision the ${loader} loader. Supported loaders are ${installableLoaders().join(", ")}. Switch to existing mode to register a folder you installed yourself.`
          );
        }
        state.updatePlan = null;
        const payload = await api("/api/servers", {
          method: "POST",
          body: Object.fromEntries(formData.entries())
        });
        // A backend that has not been restarted yet still answers 201 with the
        // finished server instead of 202 with a job. Handle both so a stale
        // service produces a working create rather than a crash.
        if (payload && payload.job && payload.job.id) {
          state.createJob = payload.job;
          render();
          await pollCreateJob(payload.job.id);
          break;
        }

        state.createVersionOpen = false;
        state.createServerMinecraftVersion = "latest";
        if (payload && payload.server) {
          state.selectedServerId = payload.server.id;
          state.view = "server";
          state.serverSection = "overview";
          setNotice("success", `created ${payload.server.name}`);
        } else {
          setNotice("success", "server created");
        }
        await refreshAll();
        break;
      }
      case "plan-update": {
        const formData = new FormData(form);
        const targetVersion = String(formData.get("targetVersion") || "").trim();
        const loaderVersion = String(formData.get("loaderVersion") || "").trim();
        const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/updates/plan`, {
          method: "POST",
          body: { loaderVersion, targetVersion }
        });
        state.updatePlan = {
          plan: payload.plan,
          serverId: state.selectedServerId
        };
        setNotice(payload.plan.safe ? "success" : "error", payload.plan.safe ? "safe update is ready" : (payload.plan.blockedReasons?.[0] || "combined update is blocked"));
        render();
        break;
      }
      case "adopt-runtime": {
        const formData = new FormData(form);
        const loaderVersion = String(formData.get("loaderVersion") || "").trim();
        const serverName = state.serverSnapshot?.server?.name || state.selectedServerId;
        // Always confirms: adoption changes how the server starts, so it earns a
        // prompt whether or not the server happens to be online right now.
        if (!confirmWithStopNotice(
          `Adopt the runtime for ${serverName}?\n\nThe dashboard will provision the loader and take over the launch script. Your existing launch-server.sh is copied into .rippermoon/server-backups/ first. The world, mods and configuration are not touched.`
        )) {
          break;
        }

        const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/runtime/adopt`, {
          method: "POST",
          body: { loaderVersion }
        });
        state.serverSnapshot = payload.snapshot;
        // The adopted build changes what the picker should show, so the stale
        // catalog is dropped rather than left to describe the previous runtime.
        state.loaderOptions = null;
        state.updatePlan = null;
        setNotice(
          "success",
          `runtime adopted — ${payload.result.loader} ${payload.result.loaderVersion || ""} on ${payload.result.minecraftVersion}`.trim()
        );
        await loadServers();
        render();
        break;
      }
      case "accept-eula": {
        const payload = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}/eula`, {
          method: "POST",
          body: { accepted: true }
        });
        state.serverSnapshot = payload.snapshot;
        setNotice("success", "server eula accepted");
        render();
        break;
      }
      case "create-user": {
        const formData = new FormData(form);
        const createWorldServers = checkedValues(form, "createWorldServers");
        const servers = normalizeAccessSelection(checkedValues(form, "servers"), createWorldServers);
        state.view = "owner";
        state.ownerSection = "admins";
        await api("/api/users", {
          method: "POST",
          body: {
            displayName: formData.get("displayName"),
            password: formData.get("password"),
            permissions: {
              createWorldServers
            },
            role: formData.get("role"),
            servers,
            username: formData.get("username")
          }
        });
        setNotice("success", "user created");
        await refreshAll();
        break;
      }
      case "update-user": {
        const formData = new FormData(form);
        const userId = formData.get("userId");
        const createWorldServers = checkedValues(form, "createWorldServers");
        const servers = normalizeAccessSelection(checkedValues(form, "servers"), createWorldServers);
        state.view = "owner";
        state.ownerSection = "admins";
        await api(`/api/users/${encodeURIComponent(userId)}`, {
          method: "PUT",
          body: {
            displayName: formData.get("displayName"),
            password: formData.get("password"),
            permissions: {
              createWorldServers
            },
            role: formData.get("role"),
            servers,
            username: formData.get("username")
          }
        });
        setNotice("success", "user updated");
        state.editingUserId = null;
        await refreshAll();
        releaseReturnFocus();
        break;
      }
      case "reset-user-password": {
        const formData = new FormData(form);
        const userId = formData.get("userId");
        state.view = "owner";
        state.ownerSection = "admins";
        await api(`/api/users/${encodeURIComponent(userId)}/reset-password`, {
          method: "POST",
          body: {
            password: formData.get("password")
          }
        });
        setNotice("success", "password reset");
        state.resettingUserId = null;
        await refreshAll();
        releaseReturnFocus();
        break;
      }
      default:
        break;
    }
  } catch (error) {
    if (error.manualDownload) {
      state.manualDownload = error.manualDownload;
    }
    setNotice("error", error.message);
  }
}
