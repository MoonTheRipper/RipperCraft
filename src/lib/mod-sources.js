const { safeFilename } = require("./utils");

const MODRINTH_API = "https://api.modrinth.com/v2";
const CURSEFORGE_API = "https://api.curseforge.com/v1";
const MODDED_LOADERS = new Set(["fabric", "forge", "neoforge", "quilt"]);
const PLUGIN_LOADERS = new Set(["paper", "purpur", "folia", "spigot", "bukkit"]);
const RELEASE_PRIORITY = {
  release: 0,
  beta: 1,
  alpha: 2
};
const REMOTE_USER_AGENT = process.env.RIPPERMOONSTASH_USER_AGENT || "RipperMoonStash/0.1 (https://localhost)";

function createModManager(serverManager) {
  function providerAvailability() {
    return {
      curseforge: Boolean(process.env.CURSEFORGE_API_KEY && process.env.CURSEFORGE_GAME_ID),
      direct: true,
      modrinth: true,
      upload: true
    };
  }

  function normalizeLoader(loader) {
    return String(loader || "vanilla").toLowerCase();
  }

  function getGameVersion(server) {
    return server.minecraftVersion && server.minecraftVersion !== "unknown" ? server.minecraftVersion : "";
  }

  function getCompatibilityProfileForServerLike(serverLike) {
    const loader = normalizeLoader(serverLike.loader);
    const gameVersion = getGameVersion(serverLike);

    if (MODDED_LOADERS.has(loader)) {
      return {
        gameVersion,
        installKind: "mod",
        loader,
        projectType: "mod",
        supportsCurseforge: true,
        supportsManagedInstalls: Boolean(gameVersion)
      };
    }

    if (PLUGIN_LOADERS.has(loader)) {
      return {
        gameVersion,
        installKind: "plugin",
        loader,
        projectType: "plugin",
        supportsCurseforge: false,
        supportsManagedInstalls: Boolean(gameVersion)
      };
    }

    return {
      gameVersion,
      installKind: "unsupported",
      loader,
      projectType: null,
      supportsCurseforge: false,
      supportsManagedInstalls: false
    };
  }

  function getCompatibilityProfile(server) {
    return getCompatibilityProfileForServerLike(server);
  }

  function assertManagedInstallServer(server) {
    const profile = getCompatibilityProfile(server);
    if (!profile.supportsManagedInstalls) {
      throw new Error(
        "This server loader does not support compatibility-checked add-on installs. Set the server loader to Fabric, Forge, NeoForge, Quilt, Paper, or Purpur first."
      );
    }
    return profile;
  }

  async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": REMOTE_USER_AGENT,
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}.`);
    }
    return await response.json();
  }

  async function downloadBuffer(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        "User-Agent": REMOTE_USER_AGENT,
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      throw new Error(`Download failed with status ${response.status}.`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async function searchModrinth(server, query) {
    const profile = assertManagedInstallServer(server);
    const facets = [];

    facets.push([`categories:${profile.loader}`]);
    facets.push([`versions:${profile.gameVersion}`]);
    facets.push([`project_type:${profile.projectType}`]);

    const url = new URL(`${MODRINTH_API}/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("index", "downloads");
    url.searchParams.set("limit", "12");
    if (facets.length) {
      url.searchParams.set("facets", JSON.stringify(facets));
    }

    const payload = await fetchJson(url.toString());
    return payload.hits.map((result) => ({
      author: result.author,
      compatibilityLabel: `${profile.loader} • ${profile.gameVersion} • ${profile.projectType}`,
      description: result.description,
      downloads: result.downloads,
      iconUrl: result.icon_url,
      id: result.project_id,
      provider: "modrinth",
      slug: result.slug,
      title: result.title
    }));
  }

  function curseforgeHeaders() {
    return {
      Accept: "application/json",
      "x-api-key": process.env.CURSEFORGE_API_KEY
    };
  }

  function loaderToCurseforgeType(loader) {
    switch (normalizeLoader(loader)) {
      case "forge":
        return "1";
      case "fabric":
        return "4";
      case "quilt":
        return "5";
      case "neoforge":
        return "6";
      default:
        return null;
    }
  }

  async function searchCurseforge(server, query) {
    if (!providerAvailability().curseforge) {
      throw new Error("CurseForge is not configured. Set CURSEFORGE_API_KEY and CURSEFORGE_GAME_ID.");
    }

    const profile = assertManagedInstallServer(server);
    if (!profile.supportsCurseforge) {
      throw new Error("CurseForge install automation is only enabled for Fabric, Forge, NeoForge, and Quilt servers.");
    }

    const loaderType = loaderToCurseforgeType(server.loader);
    const url = new URL(`${CURSEFORGE_API}/mods/search`, "https://api.curseforge.com");
    url.searchParams.set("gameId", process.env.CURSEFORGE_GAME_ID);
    url.searchParams.set("searchFilter", query);
    url.searchParams.set("classId", "6");
    url.searchParams.set("pageSize", "12");
    if (profile.gameVersion) {
      url.searchParams.set("gameVersion", profile.gameVersion);
    }
    if (loaderType) {
      url.searchParams.set("modLoaderType", loaderType);
    }

    const payload = await fetchJson(url.toString(), {
      headers: curseforgeHeaders()
    });

    return payload.data.map((result) => ({
      author: (result.authors || []).map((author) => author.name).join(", "),
      compatibilityLabel: `${profile.loader} • ${profile.gameVersion} • mod`,
      description: result.summary,
      downloads: result.downloadCount,
      iconUrl: result.logo && result.logo.thumbnailUrl,
      id: String(result.id),
      provider: "curseforge",
      slug: result.slug,
      title: result.name
    }));
  }

  async function search(server, provider, query) {
    if (!query || !query.trim()) {
      return [];
    }
    if (provider === "modrinth") {
      return await searchModrinth(server, query.trim());
    }
    if (provider === "curseforge") {
      return await searchCurseforge(server, query.trim());
    }
    throw new Error(`Unsupported provider: ${provider}`);
  }

  function compareVersions(left, right) {
    const leftPriority = RELEASE_PRIORITY[left.version_type] ?? 99;
    const rightPriority = RELEASE_PRIORITY[right.version_type] ?? 99;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    return new Date(right.date_published) - new Date(left.date_published);
  }

  function chooseModrinthFile(version) {
    const file = version.files.find((item) => item.primary) || version.files[0];
    if (!file || !String(file.filename || "").toLowerCase().endsWith(".jar")) {
      throw new Error("The selected Modrinth file is not a server-ready .jar file.");
    }
    return file;
  }

  async function resolveModrinthVersion(projectId, server) {
    const profile = assertManagedInstallServer(server);
    const url = new URL(`${MODRINTH_API}/project/${projectId}/version`);
    url.searchParams.set("loaders", JSON.stringify([profile.loader]));
    url.searchParams.set("game_versions", JSON.stringify([profile.gameVersion]));
    url.searchParams.set("include_changelog", "false");

    let versions = await fetchJson(url.toString());
    if (!versions.length) {
      throw new Error("No compatible Modrinth version was found for this server.");
    }
    versions = versions.sort(compareVersions);
    return versions[0];
  }

  function curseforgeFileScore(file) {
    const releaseMap = { 1: 0, 2: 1, 3: 2 };
    return releaseMap[file.releaseType] ?? 99;
  }

  async function resolveCurseforgeDownloadUrl(modId, file) {
    if (file.downloadUrl) {
      return file.downloadUrl;
    }
    const payload = await fetchJson(`${CURSEFORGE_API}/mods/${modId}/files/${file.id}/download-url`, {
      headers: curseforgeHeaders()
    });
    return payload.data;
  }

  async function resolveCurseforgeFile(modId, server) {
    const profile = assertManagedInstallServer(server);
    if (!profile.supportsCurseforge) {
      throw new Error("CurseForge install automation is only enabled for Fabric, Forge, NeoForge, and Quilt servers.");
    }

    const loaderType = loaderToCurseforgeType(server.loader);
    const url = new URL(`${CURSEFORGE_API}/mods/${modId}/files`, "https://api.curseforge.com");
    if (profile.gameVersion) {
      url.searchParams.set("gameVersion", profile.gameVersion);
    }
    if (loaderType) {
      url.searchParams.set("modLoaderType", loaderType);
    }
    url.searchParams.set("pageSize", "50");

    const payload = await fetchJson(url.toString(), {
      headers: curseforgeHeaders()
    });
    const files = (payload.data || []).sort((left, right) => {
      const releaseDiff = curseforgeFileScore(left) - curseforgeFileScore(right);
      if (releaseDiff !== 0) {
        return releaseDiff;
      }
      return new Date(right.fileDate) - new Date(left.fileDate);
    });

    if (!files.length) {
      throw new Error("No compatible CurseForge file was found for this server.");
    }
    if (!String(files[0].fileName || "").toLowerCase().endsWith(".jar")) {
      throw new Error("The selected CurseForge file is not a server-ready .jar file.");
    }
    return files[0];
  }

  function normalizeTrackedEntry(server, entry) {
    const profile = getCompatibilityProfile(server);
    return {
      dependencyOf: entry.dependencyOf || null,
      direct: entry.direct !== false,
      fileName: safeFilename(entry.fileName),
      gameVersion: entry.gameVersion || server.minecraftVersion || "",
      installKind: entry.installKind || profile.installKind,
      loader: entry.loader || server.loader || "vanilla",
      managed: entry.managed !== false,
      manual: entry.manual === true,
      provider: entry.provider,
      sourceId: String(entry.sourceId)
    };
  }

  function publicInstallRecord(entry) {
    return {
      fileName: entry.fileName,
      provider: entry.provider,
      sourceId: entry.sourceId
    };
  }

  async function writeTrackedEntries(serverId, server, entries) {
    const normalized = entries.map((entry) => normalizeTrackedEntry(server, entry));
    await serverManager.writeAddonManifest(serverId, normalized);
    return normalized;
  }

  async function installModrinth(serverId, server, projectId, seenProjects = new Set(), dependencyOf = null) {
    if (seenProjects.has(projectId)) {
      return [];
    }
    seenProjects.add(projectId);

    const selectedVersion = await resolveModrinthVersion(projectId, server);
    const installedFiles = [];

    for (const dependency of selectedVersion.dependencies || []) {
      if (dependency.dependency_type !== "required" || !dependency.project_id) {
        continue;
      }
      const nested = await installModrinth(serverId, server, dependency.project_id, seenProjects, `modrinth:${projectId}`);
      installedFiles.push(...nested);
    }

    const file = chooseModrinthFile(selectedVersion);
    const installed = await serverManager.downloadAndInstallFile(serverId, file.url, file.filename);
    installedFiles.push({
      dependencyOf,
      direct: dependencyOf === null,
      fileName: installed.fileName,
      provider: "modrinth",
      sourceId: projectId
    });

    return installedFiles;
  }

  async function installCurseforge(serverId, server, modId, seenMods = new Set(), dependencyOf = null) {
    if (seenMods.has(modId)) {
      return [];
    }
    seenMods.add(modId);

    const file = await resolveCurseforgeFile(modId, server);
    const installedFiles = [];

    for (const dependency of file.dependencies || []) {
      if (dependency.relationType !== 3) {
        continue;
      }
      const nested = await installCurseforge(
        serverId,
        server,
        String(dependency.modId),
        seenMods,
        `curseforge:${modId}`
      );
      installedFiles.push(...nested);
    }

    const downloadUrl = await resolveCurseforgeDownloadUrl(modId, file);
    const installed = await serverManager.downloadAndInstallFile(serverId, downloadUrl, file.fileName);
    installedFiles.push({
      dependencyOf,
      direct: dependencyOf === null,
      fileName: installed.fileName,
      provider: "curseforge",
      sourceId: modId
    });

    return installedFiles;
  }

  function assertJarLikeName(fileName) {
    if (!String(fileName || "").toLowerCase().endsWith(".jar")) {
      throw new Error("Only .jar server add-on files are accepted here.");
    }
  }

  function assertManualInstallAllowed(server, payload, options = {}) {
    if (!options.manualAllowed) {
      throw new Error("Manual add-on installs require add-on management permission for this server.");
    }

    if (!payload.confirmManualCompatibility) {
      throw new Error("Manual add-on installs require an explicit compatibility confirmation.");
    }

    const profile = getCompatibilityProfile(server);
    if (profile.installKind === "unsupported") {
      throw new Error(
        "Manual add-on installs are disabled for vanilla and custom loaders here. Set a supported server loader first to avoid startup errors."
      );
    }
  }

  async function install(serverId, payload, options = {}) {
    const server = await serverManager.getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    let installed;

    if (payload.provider === "modrinth") {
      installed = await installModrinth(serverId, server, payload.projectId || payload.id);
    } else if (payload.provider === "curseforge") {
      installed = await installCurseforge(serverId, server, String(payload.modId || payload.id));
    } else if (payload.provider === "direct") {
      assertManualInstallAllowed(server, payload, options);
      assertJarLikeName(payload.fileName || payload.url);
      const result = await serverManager.downloadAndInstallFile(serverId, payload.url, payload.fileName);
      installed = [
        {
          direct: true,
          fileName: result.fileName,
          managed: false,
          manual: true,
          provider: "direct",
          sourceId: payload.url
        }
      ];
    } else {
      throw new Error(`Unsupported install provider: ${payload.provider}`);
    }

    const tracked = await serverManager.recordAddonInstalls(
      serverId,
      installed.map((entry) => normalizeTrackedEntry(server, entry))
    );

    const fileNameSet = new Set(installed.map((entry) => safeFilename(entry.fileName)));
    return tracked.filter((entry) => fileNameSet.has(entry.fileName)).map(publicInstallRecord);
  }

  async function installUpload(serverId, fileName, buffer, options = {}) {
    const server = await serverManager.getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    assertManualInstallAllowed(server, options, options);
    assertJarLikeName(fileName);
    const installedName = await serverManager.installManagedFile(serverId, safeFilename(fileName), buffer);
    const tracked = await serverManager.recordAddonInstalls(serverId, [
      normalizeTrackedEntry(server, {
        direct: true,
        fileName: installedName,
        managed: false,
        manual: true,
        provider: "upload",
        sourceId: installedName
      })
    ]);
    return tracked.filter((entry) => entry.fileName === installedName).map(publicInstallRecord);
  }

  async function buildModrinthPlan(server, projectId, seenProjects = new Set(), dependencyOf = null) {
    if (seenProjects.has(projectId)) {
      return [];
    }
    seenProjects.add(projectId);

    const selectedVersion = await resolveModrinthVersion(projectId, server);
    const planEntries = [];

    for (const dependency of selectedVersion.dependencies || []) {
      if (dependency.dependency_type !== "required" || !dependency.project_id) {
        continue;
      }
      const nested = await buildModrinthPlan(server, dependency.project_id, seenProjects, `modrinth:${projectId}`);
      planEntries.push(...nested);
    }

    const profile = assertManagedInstallServer(server);
    const file = chooseModrinthFile(selectedVersion);
    planEntries.push({
      dependencyOf,
      direct: dependencyOf === null,
      downloadUrl: file.url,
      fileName: safeFilename(file.filename),
      gameVersion: server.minecraftVersion || "",
      installKind: profile.installKind,
      loader: server.loader,
      managed: true,
      manual: false,
      provider: "modrinth",
      sourceId: String(projectId)
    });

    return planEntries;
  }

  async function buildCurseforgePlan(server, modId, seenMods = new Set(), dependencyOf = null) {
    if (seenMods.has(modId)) {
      return [];
    }
    seenMods.add(modId);

    const file = await resolveCurseforgeFile(modId, server);
    const planEntries = [];

    for (const dependency of file.dependencies || []) {
      if (dependency.relationType !== 3) {
        continue;
      }
      const nested = await buildCurseforgePlan(
        server,
        String(dependency.modId),
        seenMods,
        `curseforge:${modId}`
      );
      planEntries.push(...nested);
    }

    const profile = assertManagedInstallServer(server);
    planEntries.push({
      dependencyOf,
      direct: dependencyOf === null,
      downloadUrl: await resolveCurseforgeDownloadUrl(modId, file),
      fileName: safeFilename(file.fileName),
      gameVersion: server.minecraftVersion || "",
      installKind: profile.installKind,
      loader: server.loader,
      managed: true,
      manual: false,
      provider: "curseforge",
      sourceId: String(modId)
    });

    return planEntries;
  }

  async function planCombinedAddonUpdate(serverId, targetVersion) {
    const server = await serverManager.getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const nextServer = {
      ...server,
      minecraftVersion: String(targetVersion || server.minecraftVersion || "").trim()
    };
    const manifest = await serverManager.readAddonManifest(serverId);
    const installedFiles = await serverManager.listInstalledFiles(serverId);
    const trackedFileNames = new Set(manifest.map((entry) => entry.fileName));
    const untrackedFiles = installedFiles.filter((fileName) => !trackedFileNames.has(fileName));
    const manualEntries = manifest.filter(
      (entry) => entry.manual === true || entry.managed === false || entry.provider === "direct" || entry.provider === "upload"
    );
    const blockedReasons = [];

    if (untrackedFiles.length) {
      blockedReasons.push(
        `Untracked add-on files are present: ${untrackedFiles.join(", ")}. Reinstall them through the dashboard or remove them before running a combined safe update.`
      );
    }

    if (manualEntries.length) {
      blockedReasons.push(
        `Manual add-ons are present: ${manualEntries.map((entry) => entry.fileName).join(", ")}. Combined safe updates only run when every add-on was installed through a compatibility-checked provider.`
      );
    }

    if (blockedReasons.length) {
      return {
        blockedReasons,
        managedCount: manifest.length,
        manualCount: manualEntries.length,
        safe: false,
        targetVersion: nextServer.minecraftVersion || "",
        untrackedFiles,
        updates: []
      };
    }

    const updateSeeds = manifest.filter((entry) => entry.direct !== false);
    const seedEntries = updateSeeds.length ? updateSeeds : manifest;
    const plannedEntries = [];

    for (const entry of seedEntries) {
      if (entry.provider === "modrinth") {
        plannedEntries.push(...(await buildModrinthPlan(nextServer, entry.sourceId)));
        continue;
      }

      if (entry.provider === "curseforge") {
        plannedEntries.push(...(await buildCurseforgePlan(nextServer, entry.sourceId)));
        continue;
      }

      blockedReasons.push(`Provider ${entry.provider} cannot be updated automatically.`);
    }

    if (blockedReasons.length) {
      return {
        blockedReasons,
        managedCount: manifest.length,
        manualCount: 0,
        safe: false,
        targetVersion: nextServer.minecraftVersion || "",
        untrackedFiles,
        updates: []
      };
    }

    const currentBySource = new Map(
      manifest.map((entry) => [`${entry.provider}:${entry.sourceId}`, entry])
    );
    const normalizedPlan = plannedEntries.map((entry) => normalizeTrackedEntry(nextServer, entry));

    return {
      blockedReasons: [],
      managedCount: manifest.length,
      manualCount: 0,
      planEntries: normalizedPlan,
      safe: true,
      targetVersion: nextServer.minecraftVersion || "",
      untrackedFiles,
      updates: normalizedPlan.map((entry) => {
        const current = currentBySource.get(`${entry.provider}:${entry.sourceId}`);
        return {
          changed: !current || current.fileName !== entry.fileName || current.gameVersion !== entry.gameVersion,
          direct: entry.direct,
          fileName: entry.fileName,
          fromFileName: current ? current.fileName : null,
          provider: entry.provider,
          sourceId: entry.sourceId
        };
      })
    };
  }

  async function applyCombinedAddonUpdate(serverId, plan) {
    if (!plan || plan.safe !== true) {
      throw new Error(plan && plan.blockedReasons && plan.blockedReasons.length ? plan.blockedReasons[0] : "Combined add-on update is not safe to apply.");
    }

    const downloads = await Promise.all(
      (plan.planEntries || []).map(async (entry) => ({
        buffer: await downloadBuffer(entry.downloadUrl),
        entry
      }))
    );

    const existingManifest = await serverManager.readAddonManifest(serverId);
    await serverManager.removeInstalledFiles(
      serverId,
      existingManifest.map((entry) => entry.fileName)
    );

    const server = await serverManager.getServer(serverId);
    const installedEntries = [];
    for (const item of downloads) {
      const installedName = await serverManager.installManagedFile(serverId, item.entry.fileName, item.buffer);
      installedEntries.push(
        normalizeTrackedEntry(server, {
          ...item.entry,
          fileName: installedName
        })
      );
    }

    await writeTrackedEntries(serverId, server, installedEntries);

    return {
      installed: installedEntries.map(publicInstallRecord),
      updatedCount: installedEntries.length
    };
  }

  return {
    applyCombinedAddonUpdate,
    getCompatibilityProfile,
    install,
    installUpload,
    planCombinedAddonUpdate,
    providerAvailability,
    search
  };
}

module.exports = {
  createModManager
};
