// For tests about what a restricted admin can and cannot do: an app with an
// owner, and an admin who holds DemoServer and has unlocked it.
const assert = require("node:assert/strict");
const { ADMIN_PASSWORD, startApp } = require("./app");

const PASSPHRASE = "lane-secret";

async function startWithAdmin(t, options = {}) {
  const app = await startApp(t, options);
  const owner = await app.setupOwner();
  const prepared = await owner("PUT", "/api/servers/DemoServer/settings", {
    json: { loader: "fabric", minecraftVersion: "1.21.1", passphrase: PASSPHRASE }
  });
  assert.equal(prepared.status, 200, prepared.text);

  const created = await owner("POST", "/api/users", {
    json: {
      password: ADMIN_PASSWORD,
      permissions: { createWorldServers: options.withoutWorldCreation ? [] : ["DemoServer"] },
      servers: ["DemoServer"],
      username: "lane"
    }
  });
  assert.equal(created.status, 201, created.text);

  const admin = app.client();
  assert.equal((await admin("POST", "/api/login", { json: { password: ADMIN_PASSWORD, username: "lane" } })).status, 200);
  const unlocked = await admin("POST", "/api/servers/DemoServer/unlock", { json: { passphrase: PASSPHRASE } });
  assert.equal(unlocked.status, 200, unlocked.text);

  return { admin, adminId: created.json.user.id, app, owner };
}

module.exports = {
  PASSPHRASE,
  startWithAdmin
};
