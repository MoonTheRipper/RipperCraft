import { api, wait } from "./api.js";
import { setNotice } from "./notice.js";
import { render } from "./render.js";
import { state } from "./state.js";

export async function loadBootstrap() {
  state.bootstrap = await api("/api/bootstrap");
}

export async function loadServers() {
  const payload = await api("/api/servers");
  state.servers = payload.servers;
  if (!state.selectedServerId && state.servers.length) {
    state.selectedServerId = state.servers[0].id;
  }
}

export async function loadSnapshot() {
  if (!state.selectedServerId) {
    state.serverSnapshot = null;
    return;
  }
  state.updatePlan = null;
  state.serverSnapshot = await api(`/api/servers/${encodeURIComponent(state.selectedServerId)}`);
}

export async function loadUsers() {
  if (!state.bootstrap?.user || state.bootstrap.user.role !== "owner") {
    state.users = [];
    return;
  }
  const payload = await api("/api/users");
  state.users = payload.users;
}

export async function loadVersionCatalog() {
  if (!state.bootstrap?.loggedIn || state.bootstrap.user.role !== "owner") {
    state.versionCatalog = null;
    return;
  }
  state.versionCatalog = await api("/api/minecraft/versions");
}

export async function loadIntegrations() {
  if (!state.bootstrap?.user || state.bootstrap.user.role !== "owner") {
    state.integrations = null;
    return;
  }
  const payload = await api("/api/settings/integrations");
  state.integrations = payload.integrations;
}

// Polls a provisioning job to completion, re-rendering on each step so the
// progress panel actually moves during a long Forge install.
export async function pollCreateJob(jobId) {
  for (;;) {
    await wait(1000);

    let payload;
    try {
      payload = await api(`/api/jobs/${encodeURIComponent(jobId)}`);
    } catch (error) {
      state.createJob = null;
      setNotice("error", `lost track of the creation job: ${error.message}`);
      return;
    }

    state.createJob = payload.job;

    if (payload.job.status === "succeeded") {
      const created = payload.job.result && payload.job.result.server;
      state.createJob = null;
      state.createVersionOpen = false;
      state.createServerMinecraftVersion = "latest";
      if (created) {
        state.selectedServerId = created.id;
        state.view = "server";
        state.serverSection = "overview";
      }
      setNotice("success", created ? `created ${created.name}` : "server created");
      await refreshAll();
      return;
    }

    if (payload.job.status === "failed") {
      state.createJob = null;
      setNotice("error", payload.job.error || "server creation failed");
      return;
    }

    render();
  }
}

export async function loadJavaRuntimes() {
  if (!state.bootstrap?.user || state.bootstrap.user.role !== "owner") {
    state.javaRuntimes = [];
    return;
  }
  const payload = await api("/api/java-runtimes");
  state.javaRuntimes = payload.runtimes || [];
}

export async function refreshAll() {
  await loadBootstrap();
  if (state.bootstrap.loggedIn) {
    await loadServers();
    await loadSnapshot();
    await loadUsers();
    await loadIntegrations();
    await loadJavaRuntimes();
    await loadVersionCatalog();
  } else {
    state.servers = [];
    state.serverSnapshot = null;
    state.users = [];
    state.integrations = null;
    state.javaRuntimes = [];
    state.versionCatalog = null;
    state.updatePlan = null;
  }
  render();
}
