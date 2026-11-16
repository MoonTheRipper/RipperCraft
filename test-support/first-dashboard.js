// A dashboard process for a test to end. It starts the server in the root it
// is given, prints that server's status as one line of JSON, and then does
// nothing until it is killed. What it leaves behind is what a dashboard that
// crashed or was restarted leaves behind: a game server that is still running,
// and no process that remembers starting it.
//
// Run by startFromAnotherProcess() in ./game-server.js:
//   node first-dashboard.js <root> [server manager options as JSON]
const { OWNER, SERVER_ID, createManager } = require("./game-server");

async function main() {
  const [root, options] = process.argv.slice(2);
  const { serverManager } = await createManager(root, JSON.parse(options || "{}"));
  const status = await serverManager.startServer(SERVER_ID, OWNER);
  process.stdout.write(`${JSON.stringify(status)}\n`);
  setInterval(() => {}, 1_000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
