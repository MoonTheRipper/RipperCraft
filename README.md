# RipperCraft

`RipperCraft` is a browser-based Minecraft server control panel that wraps the local `servers/` directory in this workspace.

> Formerly `RipperMoonStash`. The `RIPPERMOONSTASH_*` environment variables and `rippermoonstash-` browser storage keys are still read, so an existing deployment keeps working across the rename. The systemd unit and hosting domain are deliberately untouched — rename those yourself when you are ready.

Current feature set:

- First-run owner bootstrap in the browser
- Owner and admin accounts with per-server access lists
- Per-server passphrase unlocks before start, settings edits, world activation, and mod installs
- Start and stop controls for managed servers
- `server.properties` editing and server metadata editing
- World archive capture, zip import, activation, and export
- Debug log viewing from `logs/latest.log` and the manager runtime log
- Add-on install from Modrinth
- Optional CurseForge install support, configured in Owner → Integrations or by `CURSEFORGE_API_KEY`
- Guided manual download when a CurseForge author disables third-party downloads
- Direct URL installs and local file uploads for anything else
- Managed provisioning for vanilla, Paper, Purpur, Fabric, Forge, and NeoForge
- Existing server folder registration for any other loader
- Per-server Java binary override for servers that need a different JDK

## Run

```bash
npm start
```

Open `http://localhost:4300`.

On first launch:

1. Create the owner account in the browser.
2. Open the Owner view.
3. Set passphrases on each server you want guarded.
4. Create admin accounts and assign which servers they can access.

## Notes

- New vanilla servers are created with `eula=false`. Review Mojang's EULA before switching them to `true`.
- Graceful stopping works best for servers started through `RipperCraft` itself.
- CurseForge automation is disabled until a key is configured. Save one in Owner → Integrations (verified against CurseForge before it is stored, kept in `data/app.json`, never sent back to the browser), or set `CURSEFORGE_API_KEY`. The environment variable always wins, and the Owner page says so when it is in effect. `CURSEFORGE_GAME_ID` is optional and defaults to `432` (Minecraft).
- `data/app.json`, `data/users.json`, and `data/servers.json` hold the cookie secret, password hashes, and server passphrase hashes. They are forced to mode `600` on startup.
- Forge and NeoForge are installed by running their official installer, which needs a working Java. They produce argfiles rather than a `server.jar`, and the generated launch script handles both shapes. NeoForge has no builds before Minecraft 1.20.2.
- Pick a per-server **java version** in Settings when one server needs a different JDK from the rest, for example Forge 1.20.1 on Java 17 alongside newer servers on Java 21+. `RIPPERMOONSTASH_JAVA_BIN` and `JAVA_HOME` apply to the whole service, so they cannot express that on their own. Installed JDKs are detected automatically from the usual locations (`/usr/lib/jvm`, `/usr/java`, `/opt/java`, SDKMAN, macOS `JavaVirtualMachines`), deduplicated across version symlinks, and offered as a dropdown; the list is cached for five minutes.
- The loader dropdown is a label, not an installer. If it disagrees with the runtime actually on disk, Settings shows a mismatch warning: a server labelled `forge` but running a vanilla jar starts normally and loads no mods.
- Some CurseForge authors disable third-party downloads. Those mods still appear in search, but cannot be fetched automatically. The dashboard detects this, links straight to the file's CurseForge page, and asks you to add the jar with `upload file`.
- For Fabric, Forge, NeoForge, Quilt, Paper, or Purpur servers that already exist on disk, register the existing folder and set the matching loader in Settings so search/install targets the right add-on directory.
- Server records are stored relative to this project root, so the folder can be copied to another machine without keeping the old absolute paths.
- Managed launchers work on macOS and Linux. If Java is not already on `PATH`, set `JAVA_HOME` or `RIPPERMOONSTASH_JAVA_BIN` before starting the dashboard.

## Running it as a service

`infra/systemd/rippercraft.service` is written for one particular machine: a checkout at
`/home/ripper-moon/minecraft-server`, run by the user `ripper-moon` with Node from nvm.
Change `User`, `Group`, `WorkingDirectory` and the Node paths to match yours before
installing it. The same goes for the units under `infra/hosting/systemd/`.

To reach the dashboard from outside your home network, see `infra/free-hosting/` (Cloudflare
Tunnel and playit.gg, no server to rent) or `infra/hosting/` (a small VPS in front). Your own
values go in the files those guides tell you to create; git ignores them.

## Licence

The code is under the [MIT licence](LICENSE). The RipperCraft logo is not: see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
