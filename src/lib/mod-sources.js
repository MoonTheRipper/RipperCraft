const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ensureDir, nowIso, readEnv, runCommand, safeFilename } = require("./utils");

const MODRINTH_API = "https://api.modrinth.com/v2";
const CURSEFORGE_API = "https://api.curseforge.com/v1";
const CURSEFORGE_MINECRAFT_GAME_ID = "432";
const MODDED_LOADERS = new Set(["fabric", "forge", "neoforge", "quilt"]);
const PLUGIN_LOADERS = new Set(["paper", "purpur", "folia", "spigot", "bukkit"]);
// Modrinth tags a release with the platform its author actually targets, not
// with every fork that can run it. Purpur and Folia are Paper forks and run
// Paper/Spigot/Bukkit plugins, yet almost nobody tags "purpur" - querying the
// server's own loader alone returns zero versions for EssentialsX, LuckPerms,
// WorldEdit and friends, which made installs fail outright on Purpur. Each
// loader therefore carries the full list of tags that are compatible with it,
// most specific first.
const LOADER_QUERY_TAGS = {
  bukkit: ["bukkit"],
  folia: ["folia", "paper", "spigot", "bukkit"],
  paper: ["paper", "spigot", "bukkit"],
  purpur: ["purpur", "paper", "spigot", "bukkit"],
  spigot: ["spigot", "bukkit"]
};
const RELEASE_PRIORITY = {
  release: 0,
  beta: 1,
  alpha: 2
};
const REMOTE_USER_AGENT = readEnv("USER_AGENT", "RipperCraft/0.1 (https://github.com/MoonTheRipper/RipperCraft)");

// Normalises the two providers' side fields onto one vocabulary. Modrinth
// publishes client_side/server_side per project; CurseForge has no equivalent,
// so its add-ons stay "unknown" rather than being guessed at.
function normalizeSide(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["required", "optional", "unsupported"].includes(normalized) ? normalized : "unknown";
}

function createModManager(serverManager, options = {}) {
  // Owner-managed keys live in data/app.json; an environment variable always
  // wins so ops can override whatever is stored without editing the UI.
  const readIntegrations = options.readIntegrations || (async () => ({}));
  // Project metadata (title, icon, which side it belongs on) is stable and gets
  // asked for once per add-on per install or refresh, so a short cache keeps a
  // 40-mod refresh from making 40 uncached round trips per pass.
  const projectDetailCache = new Map();

  function curseforgeGameId() {
    return String(process.env.CURSEFORGE_GAME_ID || CURSEFORGE_MINECRAFT_GAME_ID);
  }

  async function resolveCurseforgeKey() {
    const fromEnv = String(process.env.CURSEFORGE_API_KEY || "").trim();
    if (fromEnv) {
      return { key: fromEnv, source: "environment" };
    }
    const integrations = (await readIntegrations()) || {};
    const stored = String(integrations.curseforgeApiKey || "").trim();
    return stored ? { key: stored, source: "stored" } : { key: "", source: "none" };
  }

  async function providerAvailability() {
    const curseforge = await resolveCurseforgeKey();
    return {
      curseforge: Boolean(curseforge.key),
      curseforgeSource: curseforge.source,
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
        queryLoaders: LOADER_QUERY_TAGS[loader] || [loader],
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
        queryLoaders: LOADER_QUERY_TAGS[loader] || [loader],
        supportsCurseforge: false,
        supportsManagedInstalls: Boolean(gameVersion)
      };
    }

    return {
      gameVersion,
      installKind: "unsupported",
      loader,
      projectType: null,
      queryLoaders: [],
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
      const error = new Error(`Request failed with status ${response.status}.`);
      error.status = response.status;
      throw error;
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

    // Facets are AND-ed with each other and OR-ed inside one entry, so this asks
    // for "tagged with any loader this server can run".
    facets.push(profile.queryLoaders.map((tag) => `categories:${tag}`));
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
      // Search hits already carry the client/server split, so where an add-on
      // belongs is visible before it is installed rather than after.
      clientSide: normalizeSide(result.client_side),
      compatibilityLabel: `${profile.loader} • ${profile.gameVersion} • ${profile.projectType}`,
      description: result.description,
      downloads: result.downloads,
      iconUrl: result.icon_url,
      id: result.project_id,
      pageUrl: result.slug ? `https://modrinth.com/mod/${result.slug}` : "",
      provider: "modrinth",
      serverSide: normalizeSide(result.server_side),
      slug: result.slug,
      title: result.title
    }));
  }

  async function curseforgeHeaders() {
    const { key } = await resolveCurseforgeKey();
    if (!key) {
      throw new Error("CurseForge is not configured. Add an API key in Owner settings.");
    }
    return {
      Accept: "application/json",
      "x-api-key": key
    };
  }

  // Verifies a key against CurseForge without storing or echoing it. When no
  // candidate is passed the currently resolved key is tested instead.
  async function testCurseforgeKey(candidateKey) {
    const key = String(candidateKey || "").trim() || (await resolveCurseforgeKey()).key;
    if (!key) {
      return { ok: false, reason: "No CurseForge API key is configured." };
    }

    let response;
    try {
      response = await fetch(`${CURSEFORGE_API}/games/${curseforgeGameId()}`, {
        headers: {
          Accept: "application/json",
          "User-Agent": REMOTE_USER_AGENT,
          "x-api-key": key
        }
      });
    } catch (error) {
      return { ok: false, reason: `Could not reach CurseForge: ${error.message}` };
    }

    if (response.status === 403 || response.status === 401) {
      return { ok: false, reason: "CurseForge rejected the key (403). Check for typos or surrounding quotes." };
    }
    if (!response.ok) {
      return { ok: false, reason: `CurseForge returned HTTP ${response.status}.` };
    }

    const payload = await response.json().catch(() => null);
    const gameName = payload && payload.data && payload.data.name;
    return { gameName: gameName || "", ok: true, reason: `Verified against ${gameName || "CurseForge"}.` };
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
    if (!(await providerAvailability()).curseforge) {
      throw new Error("CurseForge is not configured. Add an API key in Owner settings.");
    }

    const profile = assertManagedInstallServer(server);
    if (!profile.supportsCurseforge) {
      throw new Error("CurseForge install automation is only enabled for Fabric, Forge, NeoForge, and Quilt servers.");
    }

    const loaderType = loaderToCurseforgeType(server.loader);
    const url = new URL(`${CURSEFORGE_API}/mods/search`, "https://api.curseforge.com");
    url.searchParams.set("gameId", curseforgeGameId());
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
      headers: await curseforgeHeaders()
    });

    return payload.data.map((result) => ({
      author: (result.authors || []).map((author) => author.name).join(", "),
      // CurseForge publishes no client/server split, so this stays unknown
      // instead of implying a certainty the API does not provide.
      clientSide: "unknown",
      compatibilityLabel: `${profile.loader} • ${profile.gameVersion} • mod`,
      description: result.summary,
      downloads: result.downloadCount,
      iconUrl: result.logo && result.logo.thumbnailUrl,
      id: String(result.id),
      serverSide: "unknown",
      // Authors can disable third-party downloads; flag it here so the UI can
      // point at CurseForge instead of offering an install that cannot succeed.
      manualDownloadOnly: result.allowModDistribution === false,
      pageUrl:
        result.links && /^https?:\/\//i.test(result.links.websiteUrl || "") ? result.links.websiteUrl : "",
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
    url.searchParams.set("loaders", JSON.stringify(profile.queryLoaders));
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

  async function resolveCurseforgeModPage(modId) {
    try {
      const payload = await fetchJson(`${CURSEFORGE_API}/mods/${modId}`, {
        headers: await curseforgeHeaders()
      });
      const data = payload.data || {};
      const websiteUrl = (data.links && data.links.websiteUrl) || "";
      return {
        modName: data.name || "",
        // Only ever hand an http(s) link back; this value ends up in an href.
        websiteUrl: /^https?:\/\//i.test(websiteUrl) ? websiteUrl : ""
      };
    } catch {
      return { modName: "", websiteUrl: "" };
    }
  }

  async function manualDownloadRequiredError(modId, file) {
    const { modName, websiteUrl } = await resolveCurseforgeModPage(modId);
    const pageUrl = websiteUrl ? `${websiteUrl}/files/${file.id}` : "";
    const label = modName || file.fileName || `CurseForge project ${modId}`;
    const error = new Error(
      `${label} cannot be installed automatically because its author disabled third-party downloads on CurseForge. ` +
        (pageUrl
          ? `Download it from ${pageUrl}, then add it here with "upload file".`
          : `Download it from CurseForge, then add it here with "upload file".`)
    );
    error.statusCode = 409;
    error.code = "CURSEFORGE_MANUAL_DOWNLOAD_REQUIRED";
    error.manualDownload = {
      fileId: String(file.id),
      fileName: file.fileName || "",
      modId: String(modId),
      modName: label,
      pageUrl,
      provider: "curseforge"
    };
    return error;
  }

  async function resolveCurseforgeDownloadUrl(modId, file) {
    if (file.downloadUrl) {
      return file.downloadUrl;
    }

    let payload;
    try {
      payload = await fetchJson(`${CURSEFORGE_API}/mods/${modId}/files/${file.id}/download-url`, {
        headers: await curseforgeHeaders()
      });
    } catch (error) {
      if (error.status === 403 || error.status === 404) {
        throw await manualDownloadRequiredError(modId, file);
      }
      throw error;
    }

    if (!payload || !payload.data) {
      throw await manualDownloadRequiredError(modId, file);
    }
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
      headers: await curseforgeHeaders()
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

  /**
   * Title, artwork and client/server split for one project.
   *
   * Failures are swallowed into a null-ish record on purpose: this is display
   * metadata, and an add-on that installed correctly must not be reported as
   * broken because its project page could not be reached.
   */
  async function fetchProjectDetails(provider, sourceId) {
    const cacheKey = `${provider}:${sourceId}`;
    if (projectDetailCache.has(cacheKey)) {
      return projectDetailCache.get(cacheKey);
    }

    let details = { clientSide: "unknown", iconUrl: "", pageUrl: "", serverSide: "unknown", title: "" };
    try {
      if (provider === "modrinth") {
        const project = await fetchJson(`${MODRINTH_API}/project/${encodeURIComponent(sourceId)}`);
        details = {
          clientSide: normalizeSide(project.client_side),
          iconUrl: project.icon_url || "",
          pageUrl: `https://modrinth.com/mod/${project.slug || sourceId}`,
          serverSide: normalizeSide(project.server_side),
          title: project.title || ""
        };
      } else if (provider === "curseforge") {
        const payload = await fetchJson(`${CURSEFORGE_API}/mods/${encodeURIComponent(sourceId)}`, {
          headers: await curseforgeHeaders()
        });
        const data = payload.data || {};
        const website = (data.links && data.links.websiteUrl) || "";
        details = {
          // CurseForge exposes no client/server split at all, so this stays
          // unknown rather than being invented.
          clientSide: "unknown",
          iconUrl: (data.logo && (data.logo.thumbnailUrl || data.logo.url)) || "",
          pageUrl: /^https?:\/\//i.test(website) ? website : "",
          serverSide: "unknown",
          title: data.name || ""
        };
      }
    } catch {
      // Leave the blank record in place; the caller falls back to the filename.
    }

    projectDetailCache.set(cacheKey, details);
    return details;
  }

  function normalizeTrackedEntry(server, entry) {
    const profile = getCompatibilityProfile(server);
    return {
      clientSide: normalizeSide(entry.clientSide),
      dependencyOf: entry.dependencyOf || null,
      direct: entry.direct !== false,
      fileName: safeFilename(entry.fileName),
      gameVersion: entry.gameVersion || server.minecraftVersion || "",
      // Display metadata, carried in the manifest so the add-on list renders
      // without a network round trip on every page load.
      iconUrl: String(entry.iconUrl || ""),
      installKind: entry.installKind || profile.installKind,
      loader: entry.loader || server.loader || "vanilla",
      managed: entry.managed !== false,
      manual: entry.manual === true,
      pageUrl: String(entry.pageUrl || ""),
      provider: entry.provider,
      serverSide: normalizeSide(entry.serverSide),
      sourceId: String(entry.sourceId),
      title: String(entry.title || "")
    };
  }

  // Fills in display metadata for entries that do not carry it yet, so newly
  // installed add-ons and manifests written before these fields existed end up
  // in the same shape.
  async function withProjectDetails(entries) {
    return await Promise.all(
      entries.map(async (entry) => {
        if (entry.title && entry.clientSide && entry.clientSide !== "unknown") {
          return entry;
        }
        const details = await fetchProjectDetails(entry.provider, entry.sourceId);
        return {
          ...entry,
          clientSide: entry.clientSide && entry.clientSide !== "unknown" ? entry.clientSide : details.clientSide,
          iconUrl: entry.iconUrl || details.iconUrl,
          pageUrl: entry.pageUrl || details.pageUrl,
          serverSide: entry.serverSide && entry.serverSide !== "unknown" ? entry.serverSide : details.serverSide,
          title: entry.title || details.title
        };
      })
    );
  }

  function publicInstallRecord(entry) {
    return {
      fileName: entry.fileName,
      provider: entry.provider,
      sourceId: entry.sourceId
    };
  }

  // Every write to the manifest funnels through here, so enriching at this one
  // point covers installs, updates and combined updates alike.
  async function writeTrackedEntries(serverId, server, entries) {
    const enriched = await withProjectDetails(entries.map((entry) => normalizeTrackedEntry(server, entry)));
    const normalized = enriched.map((entry) => normalizeTrackedEntry(server, entry));
    await serverManager.writeAddonManifest(serverId, normalized);
    return normalized;
  }

  /**
   * Re-read title, artwork and client/server split for every tracked add-on.
   *
   * Manifests written before these fields existed have no metadata at all, and
   * a project's client/server split can change between releases, so this is
   * offered as an explicit refresh rather than run on every page load.
   */
  async function refreshAddonDetails(serverId) {
    const server = await serverManager.getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const manifest = await serverManager.readAddonManifest(serverId);
    // Drop what is cached so a refresh actually re-queries rather than handing
    // back the values it is meant to be replacing.
    projectDetailCache.clear();

    const refreshed = await Promise.all(
      manifest.map(async (entry) => {
        const details = await fetchProjectDetails(entry.provider, entry.sourceId);
        return normalizeTrackedEntry(server, {
          ...entry,
          clientSide: details.clientSide,
          iconUrl: details.iconUrl || entry.iconUrl,
          pageUrl: details.pageUrl || entry.pageUrl,
          serverSide: details.serverSide,
          title: details.title || entry.title
        });
      })
    );

    await serverManager.writeAddonManifest(serverId, refreshed);
    return {
      refreshed: refreshed.length,
      withSide: refreshed.filter((entry) => entry.clientSide !== "unknown" || entry.serverSide !== "unknown").length
    };
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
    // Resolve the download URL before installing dependencies so an author opt-out
    // fails before anything is written to mods/ and leaves untracked files behind.
    const downloadUrl = await resolveCurseforgeDownloadUrl(modId, file);
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

  // Resolves the newest provider file for an already-installed add-on, using the
  // server's CURRENT loader and Minecraft version. Unlike the combined update
  // this never changes the game version - it just finds a newer build.
  async function resolveLatestForEntry(server, entry) {
    if (entry.provider === "modrinth") {
      const version = await resolveModrinthVersion(entry.sourceId, server);
      const file = chooseModrinthFile(version);
      // Modrinth spells it "filename"; CurseForge uses "fileName".
      return { fileName: file.filename, url: file.url, versionLabel: version.version_number || "" };
    }

    if (entry.provider === "curseforge") {
      const file = await resolveCurseforgeFile(entry.sourceId, server);
      return {
        curseforgeFile: file,
        fileName: file.fileName,
        url: null,
        versionLabel: file.displayName || ""
      };
    }

    return null;
  }

  // Per-add-on update check. One add-on failing must not hide the rest, so each
  // result carries its own status instead of blocking the whole report.
  async function planAddonUpdates(serverId) {
    const server = await serverManager.getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const profile = getCompatibilityProfile(server);
    const manifest = await serverManager.readAddonManifest(serverId);
    const installed = (await serverManager.listInstalledFiles(serverId)).map((entry) =>
      typeof entry === "string" ? { enabled: true, fileName: entry } : entry
    );
    const trackedNames = new Set(manifest.map((entry) => entry.fileName));

    const entries = [];

    for (const entry of manifest) {
      const base = {
        dependencyOf: entry.dependencyOf || null,
        fileName: entry.fileName,
        provider: entry.provider,
        sourceId: entry.sourceId
      };

      if (entry.manual === true || entry.provider === "direct" || entry.provider === "upload") {
        entries.push({
          ...base,
          reason: "Installed by hand, so there is no provider to check for updates.",
          status: "unsupported"
        });
        continue;
      }

      if (!profile.supportsManagedInstalls) {
        entries.push({
          ...base,
          reason: "Set a supported loader and Minecraft version before checking for updates.",
          status: "unsupported"
        });
        continue;
      }

      try {
        const latest = await resolveLatestForEntry(server, entry);
        if (!latest) {
          entries.push({ ...base, reason: `Provider ${entry.provider} cannot be checked.`, status: "unsupported" });
          continue;
        }
        const changed = safeFilename(latest.fileName) !== entry.fileName;
        entries.push({
          ...base,
          latestFileName: safeFilename(latest.fileName),
          latestVersion: latest.versionLabel || "",
          status: changed ? "update-available" : "up-to-date"
        });
      } catch (error) {
        entries.push({
          ...base,
          reason: error.manualDownload ? error.message : `Could not check: ${error.message}`,
          status: "error"
        });
      }
    }

    for (const file of installed) {
      if (!trackedNames.has(file.fileName)) {
        entries.push({
          fileName: file.fileName,
          provider: "untracked",
          reason: "This file is not tracked by the dashboard. Reinstall it through a provider to enable updates.",
          sourceId: "",
          status: "untracked"
        });
      }
    }

    entries.sort((left, right) => left.fileName.localeCompare(right.fileName));
    return {
      entries,
      gameVersion: profile.gameVersion,
      loader: profile.loader,
      updatable: entries.filter((entry) => entry.status === "update-available").length
    };
  }

  // Replaces one add-on's jar with the newest build. The server must be stopped:
  // swapping jars underneath a running JVM corrupts the mod state.
  async function applyAddonUpdate(serverId, fileName) {
    const server = await serverManager.getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const target = safeFilename(fileName);
    const manifest = await serverManager.readAddonManifest(serverId);
    const entry = manifest.find((item) => item.fileName === target);
    if (!entry) {
      const error = new Error(`No tracked add-on named ${fileName} was found.`);
      error.statusCode = 404;
      throw error;
    }
    if (entry.manual === true || entry.provider === "direct" || entry.provider === "upload") {
      const error = new Error(`${target} was installed by hand and cannot be updated automatically.`);
      error.statusCode = 409;
      throw error;
    }

    await serverManager.ensureServerStopped(serverId);

    const latest = await resolveLatestForEntry(server, entry);
    if (!latest) {
      const error = new Error(`Provider ${entry.provider} cannot be updated automatically.`);
      error.statusCode = 409;
      throw error;
    }

    const nextName = safeFilename(latest.fileName);
    if (nextName === entry.fileName) {
      return { changed: false, fileName: entry.fileName, mods: await serverManager.listInstalledFiles(serverId) };
    }

    const downloadUrl =
      entry.provider === "curseforge"
        ? await resolveCurseforgeDownloadUrl(entry.sourceId, latest.curseforgeFile)
        : latest.url;
    const installed = await serverManager.downloadAndInstallFile(serverId, downloadUrl, nextName);

    // Only drop the old jar once the replacement is safely on disk.
    if (installed.fileName !== entry.fileName) {
      await serverManager.removeAddonFiles(serverId, [entry.fileName]);
    }

    await serverManager.recordAddonInstalls(serverId, [
      normalizeTrackedEntry(server, {
        dependencyOf: entry.dependencyOf || null,
        direct: entry.direct !== false,
        fileName: installed.fileName,
        provider: entry.provider,
        sourceId: entry.sourceId
      })
    ]);

    return {
      changed: true,
      fileName: installed.fileName,
      fromFileName: entry.fileName,
      mods: await serverManager.listInstalledFiles(serverId)
    };
  }

  // Gathers everything needed to tell a player what to install. Modrinth
  // publishes client_side/server_side per project, so client requirements are
  // read rather than guessed. CurseForge has no equivalent field.
  async function buildClientManifest(serverId) {
    const server = await serverManager.getServer(serverId);
    if (!server) {
      throw new Error("Server not found.");
    }

    const profile = getCompatibilityProfile(server);
    const manifest = await serverManager.readAddonManifest(serverId);
    const installed = (await serverManager.listInstalledFiles(serverId)).map((entry) =>
      typeof entry === "string" ? { enabled: true, fileName: entry } : entry
    );
    // Disabled add-ons are not loaded by the server, so players must not be
    // told to install them - a mismatched mod list is rejected at login.
    const enabledNames = new Set(installed.filter((entry) => entry.enabled !== false).map((entry) => entry.fileName));
    const trackedNames = new Set(manifest.map((entry) => entry.fileName));
    const skipped = [];
    const items = [];

    for (const entry of manifest) {
      if (!enabledNames.has(entry.fileName)) {
        skipped.push(entry.fileName);
        continue;
      }
      const item = {
        clientSide: "unknown",
        fileName: entry.fileName,
        provider: entry.provider,
        serverSide: "unknown",
        sourceId: entry.sourceId,
        title: entry.fileName,
        url: ""
      };

      try {
        if (entry.provider === "modrinth") {
          const project = await fetchJson(`${MODRINTH_API}/project/${entry.sourceId}`);
          item.clientSide = project.client_side || "unknown";
          item.serverSide = project.server_side || "unknown";
          item.title = project.title || entry.fileName;
          item.url = `https://modrinth.com/mod/${project.slug || entry.sourceId}`;
        } else if (entry.provider === "curseforge") {
          const payload = await fetchJson(`${CURSEFORGE_API}/mods/${entry.sourceId}`, {
            headers: await curseforgeHeaders()
          });
          const data = payload.data || {};
          item.title = data.name || entry.fileName;
          const website = (data.links && data.links.websiteUrl) || "";
          item.url = /^https?:\/\//i.test(website) ? website : "";
          // CurseForge exposes no client/server split, so assume the player
          // needs it rather than risk telling them to skip a required mod.
          item.clientSide = "assumed-required";
          item.serverSide = "unknown";
        } else {
          item.clientSide = "assumed-required";
          item.title = entry.fileName;
        }
      } catch (error) {
        item.lookupError = error.message;
        item.clientSide = "assumed-required";
      }

      items.push(item);
    }

    for (const fileName of enabledNames) {
      if (!trackedNames.has(fileName)) {
        items.push({
          clientSide: "assumed-required",
          fileName,
          provider: "untracked",
          serverSide: "unknown",
          sourceId: "",
          title: fileName,
          untracked: true,
          url: ""
        });
      }
    }

    items.sort((left, right) => left.title.localeCompare(right.title));
    return {
      gameVersion: profile.gameVersion,
      items,
      loader: profile.loader,
      loaderVersion: (server.managedRuntime && server.managedRuntime.loaderVersion) || "",
      serverName: server.name,
      skippedDisabled: skipped.sort()
    };
  }

  function needsClient(item) {
    return item.clientSide !== "unsupported";
  }

  function renderClientListText(manifest) {
    const needed = manifest.items.filter(needsClient);
    const serverOnly = manifest.items.filter((item) => !needsClient(item));
    const lines = [];

    lines.push(`${manifest.serverName} - client mod list`);
    lines.push("=".repeat(`${manifest.serverName} - client mod list`.length));
    lines.push("");
    lines.push(`Minecraft : ${manifest.gameVersion || "unknown"}`);
    lines.push(`Loader    : ${manifest.loader}${manifest.loaderVersion ? ` ${manifest.loaderVersion}` : ""}`);
    lines.push(`Mods      : ${needed.length} required on the client`);
    lines.push("");
    lines.push(`Install ${manifest.loader} ${manifest.loaderVersion || ""} for Minecraft ${manifest.gameVersion || ""},`);
    lines.push("then put every jar below into your .minecraft/mods folder.");
    lines.push("Versions must match exactly or you will be rejected at login.");
    lines.push("");

    const groups = [
      ["MODRINTH", needed.filter((item) => item.provider === "modrinth")],
      ["CURSEFORGE", needed.filter((item) => item.provider === "curseforge")],
      ["OTHER / MANUAL", needed.filter((item) => item.provider !== "modrinth" && item.provider !== "curseforge")]
    ];

    for (const [label, list] of groups) {
      if (!list.length) {
        continue;
      }
      lines.push(`-- ${label} (${list.length}) ${"-".repeat(Math.max(0, 50 - label.length))}`);
      for (const item of list) {
        lines.push(`  ${item.title}`);
        lines.push(`      file : ${item.fileName}`);
        if (item.url) {
          lines.push(`      link : ${item.url}`);
        }
        if (item.clientSide === "assumed-required") {
          lines.push("      note : provider does not publish client/server split; assumed required");
        }
        if (item.untracked) {
          lines.push("      note : not tracked by the dashboard; source unknown");
        }
        if (item.lookupError) {
          lines.push(`      note : lookup failed (${item.lookupError})`);
        }
      }
      lines.push("");
    }

    if (serverOnly.length) {
      lines.push(`-- SERVER ONLY - do NOT install these (${serverOnly.length}) ${"-".repeat(18)}`);
      for (const item of serverOnly) {
        lines.push(`  ${item.title}  [${item.fileName}]`);
      }
      lines.push("");
    }

    if (manifest.skippedDisabled && manifest.skippedDisabled.length) {
      lines.push(`-- DISABLED ON THE SERVER - excluded (${manifest.skippedDisabled.length}) ${"-".repeat(12)}`);
      for (const fileName of manifest.skippedDisabled) {
        lines.push(`  ${fileName}`);
      }
      lines.push("");
    }

    lines.push("Generated by RipperCraft.");
    return `${lines.join("\n")}\n`;
  }

  // Builds a Modrinth-format modpack (.mrpack) of the client mods.
  //
  // Only Modrinth files can be referenced by URL: the .mrpack spec restricts
  // download hosts to a trusted allowlist that excludes CurseForge's CDN. And
  // embedding other people's jars in a pack is redistribution, which is not
  // ours to do - so CurseForge and manual mods are listed for manual install
  // instead of being bundled.
  async function buildModpackArchive(serverId) {
    const manifest = await buildClientManifest(serverId);
    const server = await serverManager.getServer(serverId);
    const paths = serverManager.resolveRecordPaths(server);
    const clientItems = manifest.items.filter(needsClient);

    const files = [];
    const manual = [];

    for (const item of clientItems) {
      if (item.provider !== "modrinth") {
        manual.push(item);
        continue;
      }

      try {
        const entryManifest = { provider: "modrinth", sourceId: item.sourceId };
        const latest = await resolveLatestForEntry(server, entryManifest);
        const jarPath = path.join(paths.modsDir, item.fileName);
        const buffer = await fsp.readFile(jarPath);
        files.push({
          downloads: [latest.url],
          env: {
            client: item.clientSide === "optional" ? "optional" : "required",
            server: item.serverSide === "unsupported" ? "unsupported" : "required"
          },
          fileSize: buffer.length,
          hashes: {
            sha1: crypto.createHash("sha1").update(buffer).digest("hex"),
            sha512: crypto.createHash("sha512").update(buffer).digest("hex")
          },
          path: `mods/${item.fileName}`
        });
      } catch (error) {
        manual.push({ ...item, lookupError: error.message });
      }
    }

    const dependencies = { minecraft: manifest.gameVersion || "" };
    if (manifest.loader === "forge" && manifest.loaderVersion) {
      dependencies.forge = manifest.loaderVersion;
    } else if (manifest.loader === "neoforge" && manifest.loaderVersion) {
      dependencies["neoforge"] = manifest.loaderVersion;
    } else if (manifest.loader === "fabric" && manifest.loaderVersion) {
      dependencies["fabric-loader"] = manifest.loaderVersion;
    }

    const index = {
      dependencies,
      files,
      formatVersion: 1,
      game: "minecraft",
      name: manifest.serverName,
      summary: `Client pack for ${manifest.serverName}`,
      versionId: nowIso().slice(0, 10)
    };

    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "rms-mrpack-"));
    try {
      await fsp.writeFile(path.join(tmpDir, "modrinth.index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
      await ensureDir(path.join(tmpDir, "overrides"));

      const notes = [
        `${manifest.serverName} - mods this pack could not include`,
        "",
        "The .mrpack format can only reference downloads from a trusted host list,",
        "which does not include CurseForge. These jars are not bundled here because",
        "redistributing them is the author's call, not ours. Add them by hand:",
        ""
      ];
      for (const item of manual) {
        notes.push(`- ${item.title}`);
        notes.push(`    file : ${item.fileName}`);
        if (item.url) {
          notes.push(`    link : ${item.url}`);
        }
        if (item.lookupError) {
          notes.push(`    note : ${item.lookupError}`);
        }
      }
      if (!manual.length) {
        notes.push("(none - every client mod is included in this pack)");
      }
      notes.push("");
      await fsp.writeFile(path.join(tmpDir, "overrides", "MANUAL-MODS.txt"), `${notes.join("\n")}\n`, "utf8");

      const outputPath = path.join(
        tmpDir,
        `${String(manifest.serverName || "modpack").replace(/[^A-Za-z0-9._-]+/g, "-")}.mrpack`
      );
      // .mrpack is a zip; build it from the staged directory.
      await runCommand("zip", ["-rq", outputPath, "modrinth.index.json", "overrides"], { cwd: tmpDir });

      return {
        bundled: files.length,
        filePath: outputPath,
        manual: manual.length,
        tmpDir
      };
    } catch (error) {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      throw error;
    }
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
    const installedFiles = (await serverManager.listInstalledFiles(serverId))
      .filter((entry) => typeof entry === "string" || entry.enabled !== false)
      .map((entry) => typeof entry === "string" ? entry : entry.fileName);
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
    applyAddonUpdate,
    applyCombinedAddonUpdate,
    buildClientManifest,
    buildModpackArchive,
    fetchProjectDetails,
    getCompatibilityProfile,
    planAddonUpdates,
    refreshAddonDetails,
    renderClientListText,
    install,
    installUpload,
    planCombinedAddonUpdate,
    providerAvailability,
    search,
    testCurseforgeKey
  };
}

module.exports = {
  createModManager,
  normalizeSide
};
