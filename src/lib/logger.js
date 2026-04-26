const fs = require("node:fs");
const path = require("node:path");

function formatMeta(meta) {
  if (meta === undefined || meta === null) {
    return "";
  }

  if (meta instanceof Error) {
    return ` ${JSON.stringify({
      message: meta.message,
      stack: meta.stack
    })}`;
  }

  return ` ${JSON.stringify(meta)}`;
}

function createLogger(rootDir) {
  const logDir = path.join(rootDir, "data", "logs");
  fs.mkdirSync(logDir, { recursive: true });

  const logFile = path.join(logDir, "rippermoonstash-web.log");
  const stream = fs.createWriteStream(logFile, { flags: "a" });

  function write(level, message, meta) {
    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${message}${formatMeta(meta)}`;
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
    stream.write(`${line}\n`);
  }

  return {
    close() {
      stream.end();
    },
    error(message, meta) {
      write("error", message, meta);
    },
    info(message, meta) {
      write("info", message, meta);
    },
    logFile,
    warn(message, meta) {
      write("warn", message, meta);
    }
  };
}

module.exports = {
  createLogger
};
