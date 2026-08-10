import { api, wait } from "./api.js";
import { setNotice } from "./notice.js";
import { render } from "./render.js";
import { state } from "./state.js";

// Responses can land out of order - selecting server A then server B quickly
// let A's slower answer overwrite B's. Every loader stamps its request with a
// generation, and a response whose generation has been superseded is dropped
// instead of written to state.
const requestGenerations = new Map();

function beginRequest(key) {
  const generation = (requestGenerations.get(key) || 0) + 1;
  requestGenerations.set(key, generation);
  return () => requestGenerations.get(key) === generation;
}

export async function loadBootstrap() {
  const isCurrent = beginRequest("bootstrap");
  const payload = await api("/api/bootstrap");
  if (isCurrent()) {
    state.bootstrap = payload;
  }
}

export async function loadServers() {
  const isCurrent = beginRequest("servers");
  const payload = await api("/api/servers");
  if (!isCurrent()) {
    return;
  }
  state.servers = payload.servers;
  if (!state.selectedServerId && state.servers.length) {
    state.selectedServerId = state.servers[0].id;
  }
}

export async function loadSnapshot() {
  const isCurrent = beginRequest("snapshot");
  const serverId = state.selectedServerId;

  if (!serverId) {
    state.serverSnapshot = null;
    return;
  }

  state.updatePlan = null;
  const snapshot = await api(`/api/servers/${encodeURIComponent(serverId)}`);

  // Dropping a stale snapshot matters more here than anywhere else: the view is
  // rendered from state.serverSnapshot while every action handler targets
  // state.selectedServerId, so a mismatch means the delete button on a world
  // row from server A issues its DELETE against server B.
  if (!isCurrent() || serverId !== state.selectedServerId) {
    return;
  }
  state.serverSnapshot = snapshot;
}

export async function loadUsers() {
  if (!state.bootstrap?.user || state.bootstrap.user.role !== "owner") {
    state.users = [];
    return;
  }
  const isCurrent = beginRequest("users");
  const payload = await api("/api/users");
  if (isCurrent()) {
    state.users = payload.users;
  }
}

export async function loadVersionCatalog() {
  if (!state.bootstrap?.loggedIn || state.bootstrap.user.role !== "owner") {
    state.versionCatalog = null;
    return;
  }
  const isCurrent = beginRequest("versions");
  const payload = await api("/api/minecraft/versions");
  if (isCurrent()) {
    state.versionCatalog = payload;
  }
}

export async function loadIntegrations() {
  if (!state.bootstrap?.user || state.bootstrap.user.role !== "owner") {
    state.integrations = null;
    return;
  }
  const isCurrent = beginRequest("integrations");
  const payload = await api("/api/settings/integrations");
  if (isCurrent()) {
    state.integrations = payload.integrations;
  }
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
  const isCurrent = beginRequest("java-runtimes");
  const payload = await api("/api/java-runtimes");
  if (isCurrent()) {
    state.javaRuntimes = payload.runtimes || [];
  }
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
