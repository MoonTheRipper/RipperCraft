const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs/promises");
const { createStore } = require("./lib/store");
const { createSessionManager, hashSecret, needsRehash, verifyAccountSecret } = require("./lib/auth");
const {
  HttpError,
  applySecurityHeaders,
  closeAfterUnreadBody,
  json,
  noContent,
  parseJsonBody,
  sendFile,
  staticFileHeaders
} = require("./lib/http");
const { createServerManager } = require("./lib/servers");
const { createWorldManager } = require("./lib/worlds");
const { createModManager } = require("./lib/mod-sources");
const { createJobRegistry } = require("./lib/jobs");
const { clientAddress, isHttpsRequest } = require("./lib/peer");
const { generateSetupCode, setupCodeBanner, setupCodeMatches } = require("./lib/setup-code");
const { createAttemptThrottle, createLoginThrottle, describeWait } = require("./lib/throttle");
const { receiveUpload, resolveUploadLimitBytes } = require("./lib/upload");
const { createMutex, exists, readEnv, withinParent } = require("./lib/utils");

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

// A field of a JSON body read as text: a string as it is, a number in its
// usual spelling, and anything else - an object, a list, true, null - as
// nothing. String() would instead turn {} into "[object Object]", and on a
// list nested a few thousand deep it overflows the stack, which on the login
// route was a 500 anybody could ask for.
function textOf(value) {
  if (typeof value === "string") {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function isBlank(value) {
  return !textOf(value).trim();
}

// Applies to every password that is set from now on: the owner's at setup, a
// new account's, and any reset or change. Passwords that already exist are not
// measured against it, so nobody is locked out by the upgrade.
const PASSWORD_MIN_LENGTH = 12;

// Returns the reason a new password is not acceptable, or "" when it is.
// Length is counted in characters, not UTF-16 units, so an emoji counts once.
function newPasswordProblem(password) {
  if ([...textOf(password)].length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return "";
}

function normalizeUserPermissions(rawPermissions) {
  return {
    createWorldServers:
      rawPermissions && Array.isArray(rawPermissions.createWorldServers)
        ? rawPermissions.createWorldServers.filter(Boolean)
        : []
  };
}

// Methods that only read. Everything else can change something, and is held to
// the cross-site checks below.
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function requestMediaType(req) {
  return String(req.headers["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

// Origins to accept besides the one in the Host header, from
// RIPPERCRAFT_TRUSTED_ORIGINS: a comma-separated list such as
// "https://example.com,https://www.example.com". Only needed behind a reverse
// proxy that rewrites the Host header on its way here.
function parseTrustedOrigins(value, logger) {
  const origins = new Set();
  for (const entry of String(value || "").split(",")) {
    const text = entry.trim();
    if (!text) {
      continue;
    }
    try {
      const parsed = new URL(text);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("not http(s)");
      }
      origins.add(parsed.origin);
    } catch {
      logger.warn("Ignoring an entry in TRUSTED_ORIGINS that is not an http(s) origin", { entry: text });
    }
  }
  return origins;
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
  // The numbers and the reasoning behind them are in lib/throttle.js.
  const loginThrottle = createLoginThrottle({ now: options.now });
  const unlockThrottle = createAttemptThrottle({ now: options.now });
  const uploadLimitBytes = options.uploadLimitBytes || resolveUploadLimitBytes(logger);
  const trustedOrigins = parseTrustedOrigins(
    options.trustedOrigins === undefined ? readEnv("TRUSTED_ORIGINS") : options.trustedOrigins,
    logger
  );

  // Creating the owner takes a code that is only ever shown on this process's
  // standard output. It exists exactly while no owner does: made at start, or
  // on first need if the accounts file disappears while running, and dropped
  // the moment an owner is created.
  let setupCode = null;
  const createOwnerExclusively = createMutex();
  const announceSetupCode =
    options.onSetupCode ||
    ((code) => {
      // Straight to stdout, not through the logger: the log file is readable
      // by other local users, and this code is all it takes to become owner.
      console.log(setupCodeBanner(code));
    });

  async function currentSetupCode() {
    if (await store.hasOwner()) {
      setupCode = null;
      return null;
    }
    if (!setupCode) {
      setupCode = generateSetupCode();
      announceSetupCode(setupCode);
      logger.info(
        "No owner account exists. A setup code was printed to standard output (the terminal, or the service journal); the first-run screen asks for it."
      );
    }
    return setupCode;
  }
  await currentSetupCode();

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

  // A browser attaches Origin to every cross-site request that can change
  // anything, and it cannot be forged from a page. When it is present it has to
  // name this dashboard: the host the request was addressed to, or an origin
  // the operator listed. A request with no Origin did not come from another
  // site's page - it is curl, a script, or this page on an old browser.
  //
  // Only hosts are compared, not schemes: behind a tunnel the dashboard is
  // spoken to in plain HTTP and cannot know for certain what the visitor used.
  function originIsOurs(req) {
    const origin = req.headers.origin;
    if (origin === undefined) {
      return true;
    }
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      // "null" (a sandboxed frame, a file) and anything unparseable.
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    if (trustedOrigins.has(parsed.origin)) {
      return true;
    }
    if (!req.headers.host) {
      return false;
    }
    try {
      // Parsed the same way, so case and default ports compare equal.
      return new URL(`${parsed.protocol}//${req.headers.host}`).host === parsed.host;
    } catch {
      return false;
    }
  }

  // The cookie is SameSite=Lax, which already keeps it off cross-site POSTs in
  // current browsers. This is the second line: a form on another site can only
  // send urlencoded, multipart or text/plain bodies, so insisting on JSON makes
  // the request one a foreign page cannot produce without a CORS preflight,
  // which is never granted here. Bodyless calls are held to it too.
  function ensureJsonContentType(req, res) {
    if (requestMediaType(req) === "application/json") {
      return true;
    }
    json(res, 415, { error: "Send this request with Content-Type: application/json." });
    return false;
  }

  function sessionCookieOptions(req) {
    return { secure: isHttpsRequest(req) };
  }

  function respondTooManyAttempts(res, attempt, what) {
    json(
      res,
      429,
      {
        error: `${what} Try again in ${describeWait(attempt.retryAfterSeconds)}.`,
        retryAfterSeconds: attempt.retryAfterSeconds
      },
      { "Retry-After": String(attempt.retryAfterSeconds) }
    );
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
      // Setup is needed while there is no owner. Asking also makes sure a code
      // has been issued for it; the code itself never leaves the server.
      needsSetup: (await currentSetupCode()) !== null,
      passwordMinLength: PASSWORD_MIN_LENGTH,
      providers: await modManager.providerAvailability(),
      uploadLimitBytes,
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

  async function buildCombinedUpdatePlan(serverId, targetVersion, options = {}) {
    const runtime = await serverManager.planServerRuntimeUpdate(serverId, targetVersion, {
      loaderVersion: options.loaderVersion
    });

    // A loader-only change swaps the runtime and leaves every mod file where it
    // is, so the add-on re-resolution - and the untracked/manual gate that comes
    // with it - does not apply. The jars are instead checked directly against
    // the candidate loader build, which is the constraint that actually governs
    // whether the server will boot.
    if (runtime.mode === "loader-only") {
      const blockedReasons = [
        ...(runtime.supported === false && runtime.reason ? [runtime.reason] : []),
        ...(runtime.blockedReasons || [])
      ];
      return {
        addons: null,
        blockedReasons,
        mode: "loader-only",
        runtime,
        safe: runtime.supported === true && blockedReasons.length === 0,
        targetVersion: runtime.targetVersion || targetVersion || ""
      };
    }

    const addons = await modManager.planCombinedAddonUpdate(
      serverId,
      runtime.targetVersion || targetVersion
    );
    const blockedReasons = [
      ...(runtime.supported === false && runtime.reason ? [runtime.reason] : []),
      ...(runtime.blockedReasons || []),
      ...(addons.blockedReasons || [])
    ];
    return {
      addons,
      blockedReasons,
      mode: "version",
      runtime,
      safe: runtime.supported === true && addons.safe === true && blockedReasons.length === 0,
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
    // /favicon.ico is a real file now, so it needs no redirect of its own -
    // browsers that request it without reading the link tags get served it
    // directly.
    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const targetPath = path.resolve(publicRoot, `.${requestedPath}`);
    if (withinParent(publicRoot, targetPath)) {
      if (await sendFile(res, targetPath, staticFileHeaders(targetPath))) {
        return;
      }
      if (await exists(targetPath)) {
        // Something is there, but not a file to serve: a directory such as
        // /js. The page fallback below is for app routes, not for this.
        logRouteMiss("static", { method: "GET" }, pathname);
        json(res, 404, { error: "Not found." });
        return;
      }
    }

    const fallback = path.join(publicRoot, "index.html");
    if (!pathname.includes(".") && (await sendFile(res, fallback, staticFileHeaders(fallback)))) {
      return;
    }

    logRouteMiss("static", { method: "GET" }, pathname);
    json(res, 404, { error: "Not found." });
  }

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestPath = req.url || "/";
    applySecurityHeaders(res);
    closeAfterUnreadBody(req, res);
    res.on("finish", () => {
      logger.info("HTTP request completed", {
        durationMs: Date.now() - startedAt,
        method: req.method,
        path: requestPath,
        statusCode: res.statusCode
      });
    });

    try {
      let url;
      try {
        url = new URL(req.url || "/", "http://localhost");
      } catch {
        throw new HttpError(400, "The request URL is not valid.");
      }
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

      const changesState = !SAFE_METHODS.has(req.method);
      if (changesState && !originIsOurs(req)) {
        logger.warn("Cross-site request refused", {
          host: req.headers.host,
          method: req.method,
          origin: req.headers.origin,
          path: requestPath
        });
        json(res, 403, {
          error:
            "This request came from another site and was refused. If RipperCraft is behind a reverse proxy that changes the Host header, list the dashboard's address in RIPPERCRAFT_TRUSTED_ORIGINS."
        });
        return;
      }

      const context = await getContext(req);

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
        if (!ensureJsonContentType(req, res)) {
          return;
        }
        const expectedCode = await currentSetupCode();
        if (!expectedCode) {
          json(res, 409, { error: "Initial setup is already complete." });
          return;
        }

        const body = await parseJsonBody(req);
        // Before anything else is looked at, and before any password is hashed.
        if (!setupCodeMatches(expectedCode, body.setupCode)) {
          logger.warn("Owner setup refused: missing or wrong setup code", { address: clientAddress(req).address });
          json(res, 403, {
            error:
              "The setup code is missing or wrong. It is printed in the terminal, or the service journal, each time RipperCraft starts without an owner account."
          });
          return;
        }
        if (isBlank(body.username) || isBlank(body.password)) {
          json(res, 400, { error: "Username and password are required." });
          return;
        }
        const passwordProblem = newPasswordProblem(body.password);
        if (passwordProblem) {
          json(res, 400, { error: passwordProblem });
          return;
        }

        // One at a time: two requests that both passed the checks above must
        // not both create an owner.
        const ownerUsername = textOf(body.username).trim();
        const outcome = await createOwnerExclusively(async () => {
          const users = await store.getUsers();
          if (users.some((user) => user.role === "owner")) {
            return { error: "Initial setup is already complete." };
          }
          if (users.some((user) => user.username.toLowerCase() === ownerUsername.toLowerCase())) {
            return { error: "That username already exists." };
          }
          const created = await store.createUser({
            username: ownerUsername,
            displayName: textOf(body.displayName).trim() || ownerUsername,
            passwordHash: await hashSecret(textOf(body.password)),
            permissions: normalizeUserPermissions(body.permissions),
            role: "owner",
            servers: []
          });
          setupCode = null;
          return { owner: created };
        });
        if (!outcome.owner) {
          json(res, 409, { error: outcome.error });
          return;
        }
        const owner = outcome.owner;
        logger.info("Owner account created; the setup code is no longer valid", { username: owner.username });

        const session = await sessionManager.createSession(owner.id, { credential: owner.passwordHash });
        json(
          res,
          201,
          {
            user: sanitizeUser(owner)
          },
          { "Set-Cookie": await sessionManager.serializeSessionCookie(session, sessionCookieOptions(req)) }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/login") {
        if (!ensureJsonContentType(req, res)) {
          return;
        }
        const body = await parseJsonBody(req);
        const username = textOf(body.username).trim().toLowerCase();
        const password = textOf(body.password);

        // Counted against the address and the username exactly as typed, real
        // account or not, so being refused says nothing about the username.
        const visitor = clientAddress(req);
        const attempt = loginThrottle.begin({ address: visitor.address, username });
        if (!attempt.allowed) {
          logger.warn("Login refused after too many failed attempts", {
            address: visitor.address,
            limit: attempt.scope,
            retryAfterSeconds: attempt.retryAfterSeconds
          });
          respondTooManyAttempts(res, attempt, "Too many failed login attempts.");
          return;
        }

        let user = null;
        let verified = false;
        try {
          const users = await store.getUsers();
          user = users.find((item) => item.username.toLowerCase() === username) || null;
          // The same derivations run whether or not the account exists, so the
          // answer and the time it takes say nothing about the username.
          verified = await verifyAccountSecret(
            password,
            user ? user.passwordHash : null,
            users.map((item) => item.passwordHash)
          );
        } catch (error) {
          // The password was never checked, so this is not a failed guess.
          attempt.cancelled();
          throw error;
        }
        if (!user || !verified) {
          attempt.failed();
          // Only a real account's name is logged: whatever else was typed into
          // the username field may well be somebody's password.
          logger.warn("Login failed", { address: visitor.address, ...(user ? { username: user.username } : {}) });
          json(res, 401, { error: "Invalid username or password." });
          return;
        }
        attempt.succeeded();

        if (needsRehash(user.passwordHash)) {
          // The password is known to be right at this moment, which is the only
          // time a stronger hash of it can be made. Failing to store it must
          // not fail the login.
          try {
            const upgraded = await store.upgradePasswordHash(user.id, user.passwordHash, await hashSecret(password));
            if (upgraded) {
              logger.info("Password hash upgraded to the current format", { username: user.username });
            }
          } catch (error) {
            logger.warn("Could not upgrade a stored password hash", {
              error: error.message,
              username: user.username
            });
          }
        }

        const session = await sessionManager.createSession(user.id);
        json(
          res,
          200,
          {
            user: sanitizeUser(user)
          },
          { "Set-Cookie": await sessionManager.serializeSessionCookie(session, sessionCookieOptions(req)) }
        );
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/logout") {
        if (!ensureJsonContentType(req, res)) {
          return;
        }
        if (context.session) {
          sessionManager.destroySession(context.session.id);
        }
        noContent(res, { "Set-Cookie": sessionManager.clearSessionCookie(sessionCookieOptions(req)) });
        return;
      }

      if (!ensureAuthenticated(res, context)) {
        return;
      }

      // The two upload routes take multipart form data and check for it
      // themselves; every other call that changes something takes JSON.
      const isUploadRoute =
        req.method === "POST" &&
        segments[1] === "servers" &&
        segments.length === 5 &&
        ((segments[3] === "worlds" && segments[4] === "import") || (segments[3] === "mods" && segments[4] === "upload"));
      if (changesState && !isUploadRoute && !ensureJsonContentType(req, res)) {
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

          // The passphrase is one secret shared by every admin of the server,
          // so it gets the same limit as a password: per account, per server.
          const attempt = unlockThrottle.begin(`${context.user.id}|${serverId}`);
          if (!attempt.allowed) {
            logger.warn("Server unlock refused after too many wrong passphrases", {
              actor: context.user.username,
              retryAfterSeconds: attempt.retryAfterSeconds,
              serverId
            });
            respondTooManyAttempts(res, attempt, "Too many wrong passphrases for this server.");
            return;
          }

          let valid = false;
          try {
            const body = await parseJsonBody(req);
            valid = await serverManager.verifyServerPassphrase(serverId, textOf(body.passphrase));
          } catch (error) {
            attempt.cancelled();
            throw error;
          }
          if (!valid) {
            attempt.failed();
            json(res, 403, { error: "Passphrase did not match." });
            return;
          }
          attempt.succeeded();
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
            const upload = await receiveUpload(req, {
              directory: serverManager.resolveRecordPaths(server).worldLibraryDir,
              fileField: "archive",
              maxFileBytes: uploadLimitBytes
            });
            try {
              if (!upload.file) {
                json(res, 400, { error: "A zip archive is required." });
                return;
              }
              const result = await worldManager.importWorldArchiveFile(serverId, upload.file.fileName, upload.file.path);
              json(res, 201, result);
            } finally {
              await upload.cleanup();
            }
            return;
          }

          if (req.method === "GET" && segments[4] === "export-active") {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server with its passphrase before exporting worlds.")) {
              return;
            }
            const archive = await worldManager.createExportArchive(serverId);
            const fileName = `${serverId}-active-world.zip`;
            try {
              const sent = await sendFile(res, archive.outputPath, {
                "Content-Disposition": `attachment; filename="${fileName}"`,
                "Content-Type": "application/zip"
              });
              if (!sent) {
                json(res, 500, { error: "The export archive could not be read." });
              }
            } finally {
              await archive.cleanup();
            }
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
            const sent = await sendFile(res, archivePath, {
              "Content-Disposition": `attachment; filename="${path.basename(archivePath)}"`,
              "Content-Type": "application/zip"
            });
            if (!sent) {
              json(res, 404, { error: "That world archive does not exist." });
            }
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
            try {
              const sent = await sendFile(res, pack.filePath, {
                "Cache-Control": "no-store, max-age=0",
                "Content-Disposition": `attachment; filename="${path.basename(pack.filePath)}"`,
                "Content-Type": "application/zip",
                "X-Modpack-Bundled": String(pack.bundled),
                "X-Modpack-Manual": String(pack.manual)
              });
              if (!sent) {
                json(res, 500, { error: "The modpack archive could not be read." });
              }
            } finally {
              // Drop the staging directory once the response has drained.
              await fs.rm(pack.tmpDir, { force: true, recursive: true }).catch(() => {});
            }
            return;
          }

          if (req.method === "GET" && segments[4] === "updates") {
            if (!ensureServerUnlocked(res, context, server, "Unlock the server before checking add-on updates.")) {
              return;
            }
            json(res, 200, await modManager.planAddonUpdates(serverId));
            return;
          }

          if (req.method === "POST" && segments[4] === "refresh-details") {
            if (!canMutateServer(context, server)) {
              json(res, 403, { error: "Unlock the server before refreshing add-on details." });
              return;
            }
            if (!serverManager.userCanManageAddons(context.user, server)) {
              json(res, 403, { error: "You do not have permission to manage add-ons on this server." });
              return;
            }
            const result = await modManager.refreshAddonDetails(serverId);
            logger.info("Add-on details refreshed", {
              actor: context.user.username,
              refreshed: result.refreshed,
              serverId
            });
            json(res, 200, { mods: await serverManager.listInstalledFiles(serverId), result });
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
            // Decided before any of the file is accepted, not after it has all
            // been received.
            if (!serverManager.userCanManageAddons(context.user, server)) {
              json(res, 403, { error: "Manual add-on installs require add-on management permission for this server." });
              return;
            }
            const upload = await receiveUpload(req, {
              directory: serverManager.resolveRecordPaths(server).modsDir,
              fileField: "file",
              maxFileBytes: uploadLimitBytes
            });
            try {
              if (!upload.file) {
                json(res, 400, { error: "A file upload is required." });
                return;
              }
              const installed = await modManager.installUploadedFile(serverId, upload.file.fileName, upload.file.path, {
                confirmManualCompatibility: String(upload.fields.confirmManualCompatibility || "") === "true",
                manualAllowed: true
              });
              json(res, 201, { installed });
            } finally {
              await upload.cleanup();
            }
            return;
          }
        }

        if (segments[3] === "loader-versions" && req.method === "GET") {
          if (!ensureOwner(res, context)) {
            return;
          }
          json(res, 200, {
            loaderOptions: await serverManager.getLoaderVersionOptions(
              serverId,
              url.searchParams.get("gameVersion") || ""
            )
          });
          return;
        }

        if (segments[3] === "runtime" && segments[4] === "adopt" && req.method === "POST") {
          if (!ensureOwner(res, context)) {
            return;
          }
          const status = await serverManager.getServerStatus(serverId);
          if (status.running) {
            json(res, 409, { error: "Stop the server before adopting its runtime." });
            return;
          }
          const body = await parseJsonBody(req);
          const result = await serverManager.adoptManagedRuntime(serverId, {
            loaderVersion: body.loaderVersion,
            minecraftVersion: body.minecraftVersion
          });
          const snapshot = await serverManager.getServerSnapshot(serverId, context.user, true);
          snapshot.addonCompatibility = modManager.getCompatibilityProfile(snapshot.server);
          logger.info("Managed runtime adopted", {
            actor: context.user.username,
            loader: result.loader,
            loaderVersion: result.loaderVersion,
            serverId
          });
          json(res, 200, { result, snapshot });
          return;
        }

        if (segments[3] === "updates" && segments[4] === "plan" && req.method === "POST") {
          if (!ensureOwner(res, context)) {
            return;
          }
          const body = await parseJsonBody(req);
          const plan = await buildCombinedUpdatePlan(serverId, body.targetVersion, {
            loaderVersion: body.loaderVersion
          });
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
          const plan = await buildCombinedUpdatePlan(serverId, body.targetVersion, {
            loaderVersion: body.loaderVersion
          });
          if (!plan.safe) {
            json(res, 409, {
              error: plan.blockedReasons[0] || "Combined safe update is not available for this server.",
              plan
            });
            return;
          }

          const runtimeResult = await serverManager.applyServerRuntimeUpdate(serverId, plan.runtime);
          // Loader-only updates leave the add-ons untouched by design.
          const addonResult = plan.addons
            ? await modManager.applyCombinedAddonUpdate(serverId, plan.addons)
            : { installed: [], updatedCount: 0 };
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
        const passwordProblem = newPasswordProblem(body.password);
        if (passwordProblem) {
          json(res, 400, { error: passwordProblem });
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
          passwordHash: await hashSecret(textOf(body.password)),
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
        const passwordProblem = newPasswordProblem(body.password);
        if (passwordProblem) {
          json(res, 400, { error: passwordProblem });
          return;
        }

        const users = await store.getUsers();
        const existing = users.find((user) => user.id === userId);
        if (!existing) {
          json(res, 404, { error: "User not found." });
          return;
        }

        const updated = await store.updateUser(userId, {
          passwordHash: await hashSecret(textOf(body.password))
        });
        // Whoever was logged in with the old password - which may be the very
        // reason for the reset - is logged out. The owner doing the reset
        // keeps the session they are using.
        const endedSessions = sessionManager.destroyUserSessions(userId, { exceptSessionId: context.session.id });
        logger.info("Password reset", { actor: context.user.username, endedSessions, username: existing.username });
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

        // A blank password means "keep the current one", so only a password
        // that was actually typed is held to the minimum.
        const passwordProblem = isBlank(body.password) ? "" : newPasswordProblem(body.password);
        if (passwordProblem) {
          json(res, 400, { error: passwordProblem });
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
          patch.passwordHash = await hashSecret(textOf(body.password));
        }

        const updated = await store.updateUser(userId, patch);
        if (patch.passwordHash) {
          const endedSessions = sessionManager.destroyUserSessions(userId, { exceptSessionId: context.session.id });
          logger.info("Password changed", { actor: context.user.username, endedSessions, username: updated.username });
        }
        json(res, 200, { user: sanitizeUser(updated) });
        return;
      }

      respondNotFound(res, req, url.pathname, {
        segments
      });
    } catch (error) {
      if (error.expose === true) {
        // The client's doing - too large, malformed, gone - and already worded
        // for them. Not a fault, so no stack trace.
        logger.warn("HTTP request refused", {
          error: error.message,
          method: req.method,
          path: requestPath,
          statusCode: error.statusCode
        });
      } else {
        logger.error("HTTP request failed", {
          error: error.message || "Unexpected server error.",
          method: req.method,
          path: requestPath,
          stack: error.stack
        });
      }
      if (res.headersSent) {
        // Part of a response is already on the wire; all that is left is to end it.
        res.destroy();
        return;
      }
      json(
        res,
        typeof error.statusCode === "number" ? error.statusCode : 500,
        {
          error: error.message || "Unexpected server error.",
          ...(error.code ? { code: error.code } : {}),
          ...(error.manualDownload ? { manualDownload: error.manualDownload } : {})
        },
        error.expose === true && error.headers ? error.headers : {}
      );
    }
  });
}

module.exports = {
  createApp
};
