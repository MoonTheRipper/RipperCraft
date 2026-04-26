# RipperMoonStash

`RipperMoonStash` is a browser-based Minecraft server control panel that wraps the local `servers/` directory in this workspace.

Current feature set:

- First-run owner bootstrap in the browser
- Owner and admin accounts with per-server access lists
- Per-server passphrase unlocks before start, settings edits, world activation, and mod installs
- Start and stop controls for managed servers
- `server.properties` editing and server metadata editing
- World archive capture, zip import, activation, and export
- Debug log viewing from `logs/latest.log` and the manager runtime log
- Add-on install from Modrinth
- Optional CurseForge install support when `CURSEFORGE_API_KEY` and `CURSEFORGE_GAME_ID` are set
- Direct URL installs and local file uploads for anything else
- Existing server folder registration plus vanilla server bootstrap for new folders

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
- Graceful stopping works best for servers started through `RipperMoonStash` itself.
- CurseForge automation is disabled unless you provide the API key and game id environment variables.
- For Fabric, Forge, NeoForge, Quilt, Paper, or Purpur servers that already exist on disk, register the existing folder and set the matching loader in Settings so search/install targets the right add-on directory.
- Server records are stored relative to this project root, so the folder can be copied to another machine without keeping the old absolute paths.
- Managed launchers work on macOS and Linux. If Java is not already on `PATH`, set `JAVA_HOME` or `RIPPERMOONSTASH_JAVA_BIN` before starting the dashboard.
