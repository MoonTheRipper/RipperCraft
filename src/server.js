const path = require("node:path");
const { createApp } = require("./app");
const { createLogger } = require("./lib/logger");

async function main() {
  const rootDir = process.cwd();
  const port = Number(process.env.PORT || 4300);
  const host = process.env.HOST || "0.0.0.0";
  const logger = createLogger(rootDir);
  let shuttingDown = false;
  logger.info("Starting RipperCraft web server", {
    cwd: rootDir,
    node: process.version,
    pid: process.pid
  });

  const server = await createApp(rootDir, { logger });
  server.on("error", (error) => {
    logger.error("Web server error", error);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    logger.info("RipperCraft web server listening", {
      logFile: path.relative(rootDir, logger.logFile),
      url: `http://${host}:${port}`
    });
  });

  function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("Shutting down RipperCraft web server", { signal });
    server.close(() => {
      logger.info("RipperCraft web server stopped");
      logger.close();
      process.exit(0);
    });
  }

  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });

  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });

  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception in RipperCraft web server", error);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error(
      "Unhandled promise rejection in RipperCraft web server",
      reason instanceof Error ? reason : { reason: String(reason) }
    );
  });
}

main().catch((error) => {
  const fallbackLogger = createLogger(process.cwd());
  fallbackLogger.error("Failed to start RipperCraft web server", error);
  fallbackLogger.close();
  process.exitCode = 1;
});
