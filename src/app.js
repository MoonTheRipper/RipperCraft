const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createStore } = require("./lib/store");
const { createSessionManager, hashSecret, verifySecret } = require("./lib/auth");
const { json, noContent, parseFormData, parseJsonBody, sendFile, sendStream } = require("./lib/http");
const { createServerManager } = require("./lib/servers");
const { createWorldManager } = require("./lib/worlds");
const { createModManager } = require("./lib/mod-sources");
const { createJobRegistry } = require("./lib/jobs");
const { exists, withinParent } = require("./lib/utils");

function sanitizeUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    permissions: {
      createWorldServers:
        user.permissions && Array.isArray(user.permissions.createWorldServers)
          ? user.permissions.createWorldServers
          : []
    },
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    servers: Array.isArray(user.servers) ? user.servers : [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function isBlank(value) {
  return !value || !String(value).trim();
}

function normalizeUserPermissions(rawPermissions) {
  return {
    createWorldServers:
      rawPermissions && Array.isArray(rawPermissions.createWorldServers)
        ? rawPermissions.createWorldServers.filter(Boolean)
        : []
  };
}

function normalizeServerList(value) {
  return Array.isArray(value) ? [...new Set(value.filter(Boolean).map(String))] : [];
}

function normalizeUserAccess(body) {
  const permissions = normalizeUserPermissions(body.permissions);
  const servers = normalizeServerList(body.servers);
  return {
    permissions,
    servers: [...new Set([...servers, ...permissions.createWorldServers])]
  };
}

async function createApp(rootDir = process.cwd(), options = {}) {
  const logger = options.logger || {
    error() {},
    info() {},
    warn() {}
  };
  const store = createStore(rootDir);
  await store.ensureInitialized();

  const sessionManager = createSessionManager(() => store.getAppConfig());
  const serverManager = createServerManager(store);
  const worldManager = createWorldManager(serverManager);
  const modManager = createModManager(serverManager, {
    readIntegrations: () => store.getIntegrations()
  });
  const jobs = createJobRegistry();
  const publicRoot = path.join(rootDir, "public");

  async function getContext(req) {
    const session = await sessionManager.getSessionFromRequest(req);
    if (!session) {
      return { session: null, user: null };
    }

    const users = await store.getUsers();
    const user = users.find((item) => item.id === session.userId) || null;
    if (!user) {
      sessionManager.destroySession(session.id);
      return { session: null, user: null };
    }

    return { session, user };
  }

  function ensureAuthenticated(res, context) {
    if (context.user) {
      return true;
    }
    json(res, 401, { error: "Login required." });
    return false;
  }

  function ensureOwner(res, context) {
    if (context.user && context.user.role === "owner") {
      return true;
    }
    json(res, 403, { error: "Owner access required." });
    return false;
  }

  function canMutateServer(context, server) {
    return (
      context.user.role === "owner" ||
      !server.passphraseHash ||
      sessionManager.isServerUnlocked(context.session, server.id)
    );
  }

  function ensureServerUnlocked(res, context, server, message) {
    if (canMutateServer(context, server)) {
      return true;
    }
    json(res, 403, { error: message || "Unlock the server with its passphrase first." });
    return false;
  }

  async function getVisibleServer(res, context, serverId) {
    const server = await serverManager.getServer(serverId);
    if (!server) {
      json(res, 404, { error: "Server not found." });
      return null;
    }

    if (!serverManager.userCanAccessServer(context.user, server)) {
      json(res, 403, { error: "You do not have access to that server." });
      return null;
    }

    return server;
  }

  async function respondBootstrap(res, context) {
    const appConfig = await store.getAppConfig();
    json(res, 200, {
      appName: appConfig.appName,
      installableLoaders: serverManager.getInstallableLoaders(),
      loggedIn: Boolean(context.user),
      needsSetup: !(await store.hasUsers()),
      providers: await modManager.providerAvailability(),
      user: sanitizeUser(context.user)
    });
  }

  // Describes integration credentials without ever returning the secret. Only
  // a last-four hint is exposed, and only for keys stored by the owner.
  async function describeIntegrations() {
    const providers = await modManager.providerAvailability();
    const integrations = await store.getIntegrations();
    const storedKey = String(integrations.curseforgeApiKey || "");
    return {
      curseforge: {
        configured: providers.curseforge,
        // An environment variable outranks the stored value. The key can still
        // be saved here, but it stays dormant until the variable is removed -
        // so tell the owner exactly where to go and what to change.
        envOverride:
          providers.curseforgeSource === "environment"
            ? {
                envFile: process.env.RIPPERMOONSTASH_ENV_FILE || "/etc/rippermoonstash.env",
                service: "rippermoonstash",
                variable: "CURSEFORGE_API_KEY"
              }
            : null,
        hint: storedKey.length >= 4 ? `…${storedKey.slice(-4)}` : "",
        stored: Boolean(storedKey),
        source: providers.curseforgeSource
      }
    };
  }

  async function buildCombinedUpdatePlan(serverId, targetVersion) {
    const runtime = await serverManager.planServerRuntimeUpdate(serverId, targetVersion);
    const addons = await modManager.planCombinedAddonUpdate(
      serverId,
      runtime.targetVersion || targetVersion
    );
    const blockedReasons = [
      ...(runtime.supported === false && runtime.reason ? [runtime.reason] : []),
      ...(addons.blockedReasons || [])
    ];
    return {
      addons,
      blockedReasons,
      runtime,
      safe: runtime.supported === true && addons.safe === true,
      targetVersion: runtime.targetVersion || addons.targetVersion || targetVersion || ""
    };
  }

  function logRouteMiss(kind, req, pathname, extra = {}) {
    logger.warn(`Unhandled ${kind} route`, {
      ...extra,
      method: req.method,
      path: pathname
    });
  }

  function respondNotFound(res, req, pathname, extra = {}) {
    logRouteMiss("API", req, pathname, extra);
    json(res, 404, {
      error: "Not found.",
      hint: "If you recently changed backend routes, restart npm start so the running web server loads the new API surface."
    });
  }

  async function serveStaticAsset(res, pathname) {
    const requestedPath = pathname === "/favicon.ico" ? "/icon.svg" : (pathname === "/" ? "/index.html" : pathname);
    const targetPath = path.resolve(publicRoot, `.${requestedPath}`);
    if (withinParent(publicRoot, targetPath) && (await exists(targetPath))) {
      sendFile(res, targetPath);
      return true;
    }

    const fallback = path.join(publicRoot, "index.html");
    if (await exists(fallback) && !pathname.includes(".")) {
      sendFile(res, fallback);
      return true;
    }

    logRouteMiss("static", { method: "GET" }, pathname);
    json(res, 404, { error: "Not found." });
    return true;
  }

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestPath = req.url || "/";
    res.on("finish", () => {
      logger.info("HTTP request completed", {
        durationMs: Date.now() - startedAt,
        method: req.method,
        path: requestPath,
        statusCode: res.statusCode
      });
    });

    try {
      const url = new URL(req.url || "/", "http://localhost");
      const context = await getContext(req);
      const segments = url.pathname.split("/").filter(Boolean);

      if (!url.pathname.startsWith("/api/")) {
        if (req.method === "GET" || req.method === "HEAD") {
          await serveStaticAsset(res, url.pathname);
          return;
        }
        logRouteMiss("static", req, url.pathname);
        json(res, 404, { error: "Not found." });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        await respondBootstrap(res, context);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/session") {
        if (!context.user) {
          json(res, 200, { loggedIn: false, user: null });
          return;
        }
        json(res, 200, {
          loggedIn: true,
          user: sanitizeUser(context.user)
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/setup-owner") {
        if (await store.hasUsers()) {
          json(res, 409, { error: "Initial setup is already complete." });
          return;
        }

        const body = await parseJsonBody(req);
        if (isBlank(body.username) || isBlank(body.password)) {
          json(res, 400, { error: "Username and password are required." });
          return;
        }

        const owner = await store.createUser({
          username: String(body.username).trim(),
          displayName: String(body.displayName || body.username).trim(),
          passwordHash: hashSecret(String(body.password)),
          permissions: normalizeUserPermissions(body.permissions),
          role: "owner",
          servers: []
        });

        const session = await sessionManager.createSession(owner.id);
        json(
          res,
          201,
          {
            user: sanitizeUser(owner)
          },
          { "Set-Cookie": await sessionManager.serializeSessionCookie(session) }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        const body = await parseJsonBody(req);
        const username = String(body.username || "").trim().toLowerCase();
        const password = String(body.password || "");
        const users = await store.getUsers();
        const user = users.find((item) => item.username.toLowerCase() === username);

        if (!user || !verifySecret(password, user.passwordHash)) {
          json(res, 401, { error: "Invalid username or password." });
          return;
        }

        const session = await sessionManager.createSession(user.id);
        json(
          res,
          200,
          {
            user: sanitizeUser(user)
          },
          { "Set-Cookie": await sessionManager.serializeSessionCookie(session) }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        if (context.session) {
          sessionManager.destroySession(context.session.id);
        }
        noContent(res, { "Set-Cookie": sessionManager.clearSessionCookie() });
        return;
      }

      if (!ensureAuthenticated(res, context)) {
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/servers") {
        const servers = await serverManager.listServersForUser(context.user);
        json(res, 200, {
          providers: await modManager.providerAvailability(),
          servers
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/minecraft/versions") {
        if (!ensureOwner(res, context)) {
          return;
        }
        json(res, 200, await serverManager.listAvailableMinecraftVersions());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/java-runtimes") {
        if (!ensureOwner(res, context)) {
          return;
        }
        json(res, 200, {
          runtimes: await serverManager.listJavaRuntimes({ refresh: url.searchParams.get("refresh") === "1" })
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/servers") {
        if (!ensureOwner(res, context)) {
          return;
        }

        const body = await parseJsonBody(req);
        // Provisioning Forge or NeoForge runs a real installer and can take a
        // minute, so this runs as a background job the browser polls.
        const job = jobs.create("create-server", {
          label: "starting",
          totalSteps: body.mode === "existing" ? 2 : 6
        });

        (async () => {
          try {
            const server = await serverManager.createServer(body, context.user, {
              onProgress: (step) => jobs.progress(job.id, step)
            });
            jobs.succeed(job.id, { server: serverManager.serializeServer(server) });
            logger.info("Server created", { actor: context.user.username, serverId: server.id });
          } catch (error) {
            jobs.fail(job.id, error);
            logger.error("Server creation failed", {
              actor: context.user.username,
              error: error.message,
              stack: error.stack
            });
          }
        })();

        json(res, 202, { job: jobs.get(job.id) });
        return;
      }

      if (req.method === "GET" && segments[1] === "jobs" && segments[2]) {
        if (!ensureOwner(res, context)) {
          return;
        }
        const job = jobs.get(segments[2]);
        if (!job) {
          json(res, 404, { error: "That job is no longer available." });
          return;
        }
        json(res, 200, { job });
        return;
      }

      if (segments[1] === "servers" && segments[2]) {
        const serverId = segments[2];
        const server = await getVisibleServer(res, context, serverId);
        if (!server) {
          return;
        }

        if (req.method === "DELETE" && segments.length === 3) {
          if (!ensureOwner(res, context)) {
            return;
          }
          const status = await serverManager.getServerStatus(serverId);
          if (status.running) {
            json(res, 409, { error: "Stop the server before deleting it." });
            return;
          }
          const body = await parseJsonBody(req);
          if (String(body.confirmServerId || "") !== serverId) {
            json(res, 400, { error: "Deletion confirmation did not match the server id." });
            return;
          }
          const result = await serverManager.deleteServer(serverId);
          json(res, 200, { result });
          return;
        }

        if (req.method === "GET" && segments.length === 3) {
          const snapshot = await serverManager.getServerSnapshot(
            serverId,
            context.user,
            context.user.role === "owner" || sessionManager.isServerUnlocked(context.session, serverId)
          );
          snapshot.addonCompatibility = modManager.getCompatibilityProfile(snapshot.server);
          json(res, 200, snapshot);
          return;
        }

        if (req.method === "POST" && segments[3] === "unlock") {
          if (context.user.role === "owner") {
            const unlockedUntil = await sessionManager.unlockServer(context.session, serverId);
            json(res, 200, { unlocked: true, unlockedUntil });
            return;
          }

          const body = await parseJsonBody(req);
          const valid = await serverManager.verifyServerPassphrase(serverId, body.passphrase || "");
          if (!valid) {
            json(res, 403, { error: "Passphrase did not match." });
            return;
          }
          const unlockedUntil = await sessionManager.unlockServer(context.session, serverId);
          json(res, 200, { unlocked: true, unlockedUntil });
          return;
        }

        if (req.method === "POST" && segments[3] === "start") {
          if (!canMutateServer(context, server)) {
            json(res, 403, { error: "Unlock the server with its passphrase before starting it." });
            return;
          }
          const status = await serverManager.startServer(serverId, context.user);
          json(res, 200, { status });
          return;
        }

        if (req.method === "POST" && segments[3] === "eula") {
          if (!ensureOwner(res, context)) {
            return;
          }
          const body = await parseJsonBody(req);
          const accepted = body.accepted === true;
          if (!accepted) {
            json(res, 400, { error: "This action only supports explicit EULA acceptance." });
            return;
          }
          const eulaAccepted = await serverManager.writeEulaStatus(serverId, true);
          const snapshot = await serverManager.getServerSnapshot(serverId, context.user, true);
          snapshot.addonCompatibility = modManager.getCompatibilityProfile(snapshot.server);
          json(res, 200, {
            eulaAccepted,
            snapshot
          });
          return;
        }

        if (req.method === "POST" && segments[3] === "stop") {
          if (!ensureServerUnlocked(res, context, server, "Unlock the server with its passphrase before stopping it.")) {
            return;
          }
          const status = await serverManager.stopServer(serverId);
          json(res, 200, { status });
          return;
        }

        if (req.method === "GET" && segments[3] === "logs") {
          if (!ensureServerUnlocked(res, context, server, "Unlock the server with its passphrase before viewing logs.")) {
            return;
          }
          json(res, 200, await serverManager.getServerLog(serverId));
          return;
        }

        if (req.method === "PUT" && segments[3] === "settings") {
          if (!canMutateServer(context, server)) {
            json(res, 403, { error: "Unlock the server with its passphrase before editing settings." });
            return;
          }

          const body = await parseJsonBody(req);
          if (context.user.role === "owner") {
            const metadataPatch = {
              description: body.description,
              loader: body.loader,
              maxMemory: body.maxMemory,
              minecraftVersion: body.minecraftVersion,
              minMemory: body.minMemory,
              name: body.name,
              startCommand: body.startCommand
            };

            if (typeof body.passphrase === "string" && body.passphrase.trim()) {
              metadataPatch.passphrase = body.passphrase.trim();
            }

            // Only patch javaBin when the form actually sent it, otherwise an
            // unrelated settings save would silently clear a configured path.
            if (typeof body.javaBin === "string") {
              metadataPatch.javaBin = body.javaBin;
            }

            await serverManager.setServerMetadata(serverId, metadataPatch);
            if (typeof body.propertiesText === "string") {
              await serverManager.writeServerProperties(serverId, body.propertiesText);
            }
          } else {
            const addonSettings =
              body.addonSettings && typeof body.addonSettings === "object" ? body.addonSettings : null;
            if (addonSettings) {
              if (!serverManager.userCanManageAddons(context.user, server)) {
                json(res, 403, { error: "You do not have permission to change add-on settings for this server." });
                return;
              }
              await serverManager.setServerMetadata(serverId, {
                loader: addonSettings.loader,
                minecraftVersion: addonSettings.minecraftVersion
              });
            }

            if (
              typeof body.propertiesText === "string" ||
              typeof body.passphrase === "string" ||
              typeof body.loader === "string" ||
              typeof body.minecraftVersion === "string" ||
              typeof body.maxMemory === "string" ||
              typeof body.minMemory === "string" ||
              typeof body.startCommand === "string" ||
              typeof body.javaBin === "string" ||
              typeof body.name === "string" ||
              typeof body.description === "string"
            ) {
              json(res, 403, { error: "Regular admins can only edit the safe server settings exposed in this dashboard." });
              return;
            }

            const safeProperties =
              body.safeProperties && typeof body.safeProperties === "object" ? body.safeProperties : null;
            if (!safeProperties && !addonSettings) {
              json(res, 400, { error: "Safe server settings are required." });
              return;
            }

            if (safeProperties) {
              await serverManager.writeSafeAdminProperties(serverId, safeProperties);
            }
          }

          const snapshot = await serverManager.getServerSnapshot(
            serverId,
            context.user,
            true
          );
          snapshot.addonCompatibility = modManager.getCompatibilityProfile(snapshot.server);
          json(res, 200, snapshot);
          return;
        }

        if (segments[3] === "operators") {
          if (!ensureOwner(res, context)) {
            return;
          }

          if (req.method === "POST" && segments.length === 4) {
            const body = await parseJsonBody(req);
            const operators = await serverManager.addServerOperator(serverId, {
              bypassesPlayerLimit: body.bypassesPlayerLimit === true,
              level: body.level,
              name: body.name,
              uuid: body.uuid
            });
            json(res, 200, { operators });
            return;
          }

          if (req.method === "POST" && segments[4] === "repair") {
            const result = await serverManager.repairServerOperators(serverId);
            logger.info("Operator uuids repaired", {
              actor: context.user.username,
              failures: result.failures.length,
              serverId
            });
            json(res, 200, result);
            return;
          }

          if (req.method === "DELETE" && segments[4]) {
            const operators = await serverManager.removeServerOperator(serverId, decodeURIComponent(segments[4]));
            json(res, 200, { operators });
            return;
          }
        }

        if (segments[3] === "worlds") {
          if (req.method === "GET" && segments.length === 4) {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server with its passphrase before viewing worlds.")) {
              return;
            }
            json(res, 200, { worlds: await worldManager.listWorlds(serverId) });
            return;
          }

          if (req.method === "POST" && segments[4] === "capture") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before capturing worlds." });
              return;
            }
            const body = await parseJsonBody(req);
            json(res, 200, await worldManager.captureActiveWorld(serverId, body.label));
            return;
          }

          if (req.method === "POST" && segments[4] === "create") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before creating a new world." });
              return;
            }
            if (!serverManager.userCanCreateWorld(context.user, serverId)) {
              json(res, 403, { error: "You do not have permission to create new worlds on this server." });
              return;
            }
            const body = await parseJsonBody(req);
            const result = await worldManager.createNewWorld(serverId, {
              generateStructures: body.generateStructures !== false,
              levelType: body.levelType,
              name: body.name,
              seed: body.seed
            });
            json(res, 200, result);
            return;
          }

          if (req.method === "POST" && segments[4] === "rules") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before changing world rules." });
              return;
            }
            if (!serverManager.userCanCreateWorld(context.user, serverId)) {
              json(res, 403, { error: "You do not have permission to change world rules on this server." });
              return;
            }
            const body = await parseJsonBody(req);
            json(res, 200, await worldManager.updateWorldRules(serverId, {
              forceGamemode: body.forceGamemode === true,
              generateStructures: body.generateStructures !== false,
              levelType: body.levelType
            }));
            return;
          }

          if (req.method === "POST" && segments[4] === "delete") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before deleting a world archive." });
              return;
            }
            // Deleting a backup is destructive and unrecoverable, so hold it to
            // the same bar as creating worlds rather than plain unlock.
            if (!serverManager.userCanCreateWorld(context.user, serverId)) {
              json(res, 403, { error: "You do not have permission to delete world archives for this server." });
              return;
            }
            const body = await parseJsonBody(req);
            const result = await worldManager.deleteWorldArchive(serverId, body.archiveName);
            logger.info("World archive deleted", {
              actor: context.user.username,
              archive: result.deleted,
              serverId
            });
            json(res, 200, result);
            return;
          }

          if (req.method === "POST" && segments[4] === "activate") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before activating a world." });
              return;
            }
            const body = await parseJsonBody(req);
            await worldManager.activateWorldArchive(serverId, body.archiveName);
            json(res, 200, { worlds: await worldManager.listWorlds(serverId) });
            return;
          }

          if (req.method === "POST" && segments[4] === "import") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before importing a world." });
              return;
            }
            const formData = await parseFormData(req);
            const file = formData.get("archive");
            if (!file) {
              json(res, 400, { error: "A zip archive is required." });
              return;
            }
            const result = await worldManager.importWorldArchive(
              serverId,
              file.name,
              Buffer.from(await file.arrayBuffer())
            );
            json(res, 201, result);
            return;
          }

          if (req.method === "GET" && segments[4] === "export-active") {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server with its passphrase before exporting worlds.")) {
              return;
            }
            const archive = await worldManager.createExportArchive(serverId);
            const fileName = `${serverId}-active-world.zip`;
            const stream = require("node:fs").createReadStream(archive.outputPath);
            stream.on("close", archive.cleanup);
            sendStream(res, 200, stream, {
              "Content-Disposition": `attachment; filename="${fileName}"`,
              "Content-Type": "application/zip"
            });
            return;
          }

          if (req.method === "GET" && segments[4] === "download") {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server with its passphrase before downloading worlds.")) {
              return;
            }
            const archiveName = url.searchParams.get("name");
            if (!archiveName) {
              json(res, 400, { error: "Archive name is required." });
              return;
            }
            const archivePath = await serverManager.readWorldArchivePath(serverId, archiveName);
            const stream = require("node:fs").createReadStream(archivePath);
            sendStream(res, 200, stream, {
              "Content-Disposition": `attachment; filename="${path.basename(archivePath)}"`,
              "Content-Type": "application/zip"
            });
            return;
          }
        }

        if (segments[3] === "mods") {
          if (req.method === "GET" && segments.length === 4) {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server with its passphrase before viewing add-ons.")) {
              return;
            }
            json(res, 200, { mods: await serverManager.listInstalledFiles(serverId) });
            return;
          }

          if (req.method === "POST" && segments[4] === "search") {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server with its passphrase before searching add-ons.")) {
              return;
            }
            const body = await parseJsonBody(req);
            const results = await modManager.search(server, body.provider || "modrinth", body.query || "");
            json(res, 200, { results });
            return;
          }

          if (req.method === "POST" && segments[4] === "install") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before installing mods." });
              return;
            }
            const body = await parseJsonBody(req);
            const installed = await modManager.install(serverId, body, {
              confirmManualCompatibility: body.confirmManualCompatibility === true,
              manualAllowed: serverManager.userCanManageAddons(context.user, server)
            });
            json(res, 201, { installed });
            return;
          }

          if (req.method === "GET" && segments[4] === "client-list") {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server before exporting the client mod list.")) {
              return;
            }
            const clientManifest = await modManager.buildClientManifest(serverId);
            const body = modManager.renderClientListText(clientManifest);
            const fileName = `${String(server.name || serverId).replace(/[^A-Za-z0-9._-]+/g, "-")}-client-mods.txt`;
            res.writeHead(200, {
              "Cache-Control": "no-store, max-age=0",
              "Content-Disposition": `attachment; filename="${fileName}"`,
              "Content-Type": "text/plain; charset=utf-8"
            });
            res.end(body);
            return;
          }

          if (req.method === "GET" && segments[4] === "modpack") {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server before exporting a modpack.")) {
              return;
            }
            const pack = await modManager.buildModpackArchive(serverId);
            const stream = require("node:fs").createReadStream(pack.filePath);
            // Drop the staging directory once the response has drained.
            const cleanup = () => {
              fs.rm(pack.tmpDir, { force: true, recursive: true }).catch(() => {});
            };
            stream.on("close", cleanup);
            stream.on("error", cleanup);
            sendStream(res, 200, stream, {
              "Cache-Control": "no-store, max-age=0",
              "Content-Disposition": `attachment; filename="${path.basename(pack.filePath)}"`,
              "Content-Type": "application/zip",
              "X-Modpack-Bundled": String(pack.bundled),
              "X-Modpack-Manual": String(pack.manual)
            });
            return;
          }

          if (req.method === "GET" && segments[4] === "updates") {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server before checking add-on updates.")) {
              return;
            }
            json(res, 200, await modManager.planAddonUpdates(serverId));
            return;
          }

          if (req.method === "POST" && segments[4] === "update") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before updating add-ons." });
              return;
            }
            if (!serverManager.userCanManageAddons(context.user, server)) {
              json(res, 403, { error: "You do not have permission to update add-ons on this server." });
              return;
            }
            const body = await parseJsonBody(req);
            const names = Array.isArray(body.fileNames)
              ? body.fileNames
              : body.fileName
                ? [body.fileName]
                : [];
            if (!names.length) {
              json(res, 400, { error: "At least one add-on file name is required." });
              return;
            }

            // Update each independently so one failure does not abandon the rest.
            const results = [];
            for (const name of names) {
              try {
                const result = await modManager.applyAddonUpdate(serverId, name);
                results.push({ fileName: name, ...result, mods: undefined, ok: true });
              } catch (error) {
                results.push({ error: error.message, fileName: name, ok: false });
              }
            }

            logger.info("Add-on update applied", {
              actor: context.user.username,
              failed: results.filter((entry) => !entry.ok).length,
              serverId,
              updated: results.filter((entry) => entry.ok && entry.changed).length
            });
            json(res, 200, { mods: await serverManager.listInstalledFiles(serverId), results });
            return;
          }

          if (req.method === "POST" && segments[4] === "remove") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before removing add-ons." });
              return;
            }
            if (!serverManager.userCanManageAddons(context.user, server)) {
              json(res, 403, { error: "You do not have permission to remove add-ons from this server." });
              return;
            }
            const body = await parseJsonBody(req);
            const removed = await serverManager.removeAddonFiles(serverId, [body.fileName]);
            json(res, 200, { mods: await serverManager.listInstalledFiles(serverId), removed });
            return;
          }

          if (req.method === "POST" && segments[4] === "toggle") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before toggling add-ons." });
              return;
            }
            if (!serverManager.userCanManageAddons(context.user, server)) {
              json(res, 403, { error: "You do not have permission to toggle add-ons on this server." });
              return;
            }
            const body = await parseJsonBody(req);
            const mods = await serverManager.setAddonEnabled(serverId, body.fileName, body.enabled === true);
            json(res, 200, { mods });
            return;
          }

          if (req.method === "POST" && segments[4] === "upload") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before uploading files." });
              return;
            }
            const formData = await parseFormData(req);
            const file = formData.get("file");
            if (!file) {
              json(res, 400, { error: "A file upload is required." });
              return;
            }
            const installed = await modManager.installUpload(
              serverId,
              file.name,
              Buffer.from(await file.arrayBuffer()),
              {
                manualAllowed: serverManager.userCanManageAddons(context.user, server),
                confirmManualCompatibility: String(formData.get("confirmManualCompatibility") || "") === "true"
              }
            );
            json(res, 201, { installed });
            return;
          }
        }

        if (segments[3] === "updates" && segments[4] === "plan" && req.method === "POST") {
          if (!ensureOwner(res, context)) {
            return;
          }
          const body = await parseJsonBody(req);
          const plan = await buildCombinedUpdatePlan(serverId, body.targetVersion);
          json(res, 200, { plan });
          return;
        }

        if (segments[3] === "updates" && segments[4] === "apply" && req.method === "POST") {
          if (!ensureOwner(res, context)) {
            return;
          }
          const status = await serverManager.getServerStatus(serverId);
          if (status.running) {
            json(res, 409, { error: "Stop the server before applying a combined safe update." });
            return;
          }
          const body = await parseJsonBody(req);
          const plan = await buildCombinedUpdatePlan(serverId, body.targetVersion);
          if (!plan.safe) {
            json(res, 409, {
              error: plan.blockedReasons[0] || "Combined safe update is not available for this server.",
              plan
            });
            return;
          }

          const runtimeResult = await serverManager.applyServerRuntimeUpdate(serverId, plan.runtime);
          const addonResult = await modManager.applyCombinedAddonUpdate(serverId, plan.addons);
          const snapshot = await serverManager.getServerSnapshot(serverId, context.user, true);
          snapshot.addonCompatibility = modManager.getCompatibilityProfile(snapshot.server);
          json(res, 200, {
            addonResult,
            plan,
            runtimeResult,
            snapshot
          });
          return;
        }
      }

      if (url.pathname === "/api/settings/integrations") {
        if (!ensureOwner(res, context)) {
          return;
        }

        if (req.method === "GET") {
          json(res, 200, { integrations: await describeIntegrations() });
          return;
        }

        if (req.method === "PUT") {
          const body = await parseJsonBody(req);
          if (!Object.prototype.hasOwnProperty.call(body, "curseforgeApiKey")) {
            json(res, 400, { error: "No integration values were supplied." });
            return;
          }

          const nextKey = String(body.curseforgeApiKey || "").trim();
          // Refuse to store a key that CurseForge rejects, unless explicitly
          // overridden - a silently bad key looks identical to a working one.
          if (nextKey && body.skipVerify !== true) {
            const check = await modManager.testCurseforgeKey(nextKey);
            if (!check.ok) {
              json(res, 400, { error: check.reason, verified: false });
              return;
            }
          }

          await store.saveIntegrations({ curseforgeApiKey: nextKey });
          logger.info("Integration credentials updated", {
            actor: context.user.username,
            cleared: !nextKey,
            integration: "curseforge"
          });
          json(res, 200, { integrations: await describeIntegrations() });
          return;
        }
      }

      if (req.method === "POST" && url.pathname === "/api/settings/integrations/test") {
        if (!ensureOwner(res, context)) {
          return;
        }
        const result = await modManager.testCurseforgeKey();
        json(res, 200, { result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/users") {
        if (!ensureOwner(res, context)) {
          return;
        }
        const users = (await store.getUsers()).map(sanitizeUser);
        const servers = Object.values(await serverManager.getAllServers()).map((server) => ({
          id: server.id,
          name: server.name
        }));
        json(res, 200, { users, servers });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/users") {
        if (!ensureOwner(res, context)) {
          return;
        }

        const body = await parseJsonBody(req);
        const users = await store.getUsers();
        const username = String(body.username || "").trim();
        if (isBlank(username) || isBlank(body.password)) {
          json(res, 400, { error: "Username and password are required." });
          return;
        }
        if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
          json(res, 409, { error: "That username already exists." });
          return;
        }

        const access = normalizeUserAccess(body);
        const user = await store.createUser({
          username,
          displayName: String(body.displayName || username).trim(),
          passwordHash: hashSecret(String(body.password)),
          permissions: access.permissions,
          role: body.role === "owner" ? "owner" : "admin",
          servers: access.servers
        });
        json(res, 201, { user: sanitizeUser(user) });
        return;
      }

      if (segments[1] === "users" && segments[2] && segments[3] === "reset-password" && req.method === "POST") {
        if (!ensureOwner(res, context)) {
          return;
        }

        const userId = segments[2];
        const body = await parseJsonBody(req);
        if (isBlank(body.password)) {
          json(res, 400, { error: "A new password is required." });
          return;
        }

        const users = await store.getUsers();
        const existing = users.find((user) => user.id === userId);
        if (!existing) {
          json(res, 404, { error: "User not found." });
          return;
        }

        const updated = await store.updateUser(userId, {
          passwordHash: hashSecret(String(body.password))
        });
        json(res, 200, { user: sanitizeUser(updated) });
        return;
      }

      if (segments[1] === "users" && segments[2] && req.method === "PUT") {
        if (!ensureOwner(res, context)) {
          return;
        }
        const userId = segments[2];
        const body = await parseJsonBody(req);
        const users = await store.getUsers();
        const existing = users.find((user) => user.id === userId);
        if (!existing) {
          json(res, 404, { error: "User not found." });
          return;
        }

        const ownerCount = users.filter((user) => user.role === "owner").length;
        const nextRole = body.role === "owner" ? "owner" : "admin";
        if (existing.role === "owner" && nextRole !== "owner" && ownerCount <= 1) {
          json(res, 400, { error: "At least one owner account must remain." });
          return;
        }

        const nextUsername = String(body.username || existing.username).trim();
        const duplicate = users.find(
          (user) => user.id !== userId && user.username.toLowerCase() === nextUsername.toLowerCase()
        );
        if (duplicate) {
          json(res, 409, { error: "That username already exists." });
          return;
        }

        const access = normalizeUserAccess(body);
        const patch = {
          displayName: String(body.displayName || existing.displayName).trim(),
          permissions: body.permissions === undefined ? normalizeUserPermissions(existing.permissions) : access.permissions,
          role: nextRole,
          servers:
            body.permissions === undefined && body.servers === undefined
              ? normalizeServerList(existing.servers)
              : access.servers,
          username: nextUsername
        };
        if (!isBlank(body.password)) {
          patch.passwordHash = hashSecret(String(body.password));
        }

        const updated = await store.updateUser(userId, patch);
        json(res, 200, { user: sanitizeUser(updated) });
        return;
      }

      respondNotFound(res, req, url.pathname, {
        segments
      });
    } catch (error) {
      logger.error("HTTP request failed", {
        error: error.message || "Unexpected server error.",
        method: req.method,
        path: requestPath,
        stack: error.stack
      });
      json(res, typeof error.statusCode === "number" ? error.statusCode : 500, {
        error: error.message || "Unexpected server error.",
        ...(error.code ? { code: error.code } : {}),
        ...(error.manualDownload ? { manualDownload: error.manualDownload } : {})
      });
    }
  });
}

module.exports = {
  createApp
};
