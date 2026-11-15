# RipperCraft

`RipperCraft` is a browser-based Minecraft server control panel that wraps the local `servers/` directory in this workspace.

> Formerly `RipperMoonStash`. The `RIPPERMOONSTASH_*` environment variables and `rippermoonstash-` browser storage keys are still read, so an existing deployment keeps working across the rename. The systemd unit and hosting domain are deliberately untouched — rename those yourself when you are ready.

Current feature set:

- First-run owner bootstrap in the browser, gated by a one-time setup code
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

1. Look at the output of the command you just ran. While there is no owner account, RipperCraft prints a setup code when it starts:

   ```text
   ==================================================================
     RipperCraft has no owner account yet.

         Owner setup code:   7KQ0-1ZXA-M4TV-9HBC
   ...
   ```

   Running it as a service? The same banner is in the journal: `journalctl -u rippercraft -n 40`.
2. Open the dashboard and create the owner account. The first-run screen asks for the setup code, a username and a password of at least 12 characters.
3. Open the Owner view.
4. Set passphrases on each server you want guarded.
5. Create admin accounts and assign which servers they can access.

The owner can run commands on this machine, so the first-run screen is not open to whoever finds it first: without the code it creates nothing. The code is new on every start, is only ever written to standard output (never to `data/logs/`), and stops working the moment the owner exists. If you lose it, restart RipperCraft to get another.

## Sign-in and limits

**Passwords.** Every password set from now on - the owner's, a new account's, a reset or a change - needs at least 12 characters. Passwords that already exist keep working whatever their length. They are stored as scrypt hashes (`N=2^15, r=8, p=3`); hashes written by earlier versions still verify, and each one is rewritten in the new format the next time that user signs in.

**Failed sign-ins** are counted in memory, against the address they came from:

| What is counted | Limit | Then |
| --- | --- | --- |
| Failures from one address against one username | 5 in 15 minutes | That address must wait before trying that username again (`429`, with `Retry-After`): 15 minutes, and then twice as long after every further failure, up to 24 hours. It gets its five tries back by signing in, or once a day has passed since its wait ended without another failure. |
| Failures from one address, any usernames | 20 in 15 minutes | That address is refused until the oldest of them is 15 minutes old. |
| A username that 4 or more addresses have failed on within 15 minutes | no free tries | On that username every failure counts as the fifth would: the address that made it waits 15 minutes, then twice as long each time. |

While an address is waiting its attempts are not checked at all, so the right password is refused too; wait out the time shown. Signing in successfully clears that address's counts for that username.

The third rule is for guessing spread across many addresses, where five tries each is too many. All three rules only ever refuse the address that did the failing. No limit is shared by a whole account, because anyone can fail on purpose under your name: what other addresses do never stops yours being checked, and the right password from an address that has not been failing always gets in. The price is that a crowd still gets a guess per address before it is slowed, so the limits are no substitute for a password that is not on a list.

A wrong **server passphrase** is limited the same way, counted per account and server instead of per address: 5 tries in 15 minutes, then a wait of 15 minutes that doubles with every further wrong one, up to 24 hours. Unlocking the server clears it; so does a day passing after the wait has ended without another wrong one.

**Sessions.** Resetting or changing a password signs that user out everywhere else, including a sign-in with the old password that was still being checked at that moment. Restarting RipperCraft signs everyone out and clears the counts above.

**Behind a tunnel or reverse proxy.** The visitor's address is taken from the connection. Request headers are believed only when the connection comes from this machine itself (`127.0.0.1` / `::1`), which is how `cloudflared` and a local reverse proxy connect: `CF-Connecting-IP` when `X-Forwarded-For` does not contradict it, otherwise the first address in `X-Forwarded-For`. Behind Cloudflare that is always `CF-Connecting-IP`, which a visitor cannot set. Any other proxy has to *replace* `X-Forwarded-For` rather than append to what the visitor sent (Caddy does by default) and should remove `CF-Connecting-IP` from incoming requests (the Caddyfile generated by `infra/hosting` does), or visitors can pick the address they are counted under. A proxy that passes no address at all makes every visitor share one count. In the same way the session cookie is marked `Secure` when a local proxy reports HTTPS through `X-Forwarded-Proto` or `CF-Visitor`; on plain HTTP over the LAN it is not.

Requests that change anything must come from the dashboard's own page: the browser's `Origin` header has to match the `Host` header. Cloudflare Tunnel (unless its `httpHostHeader` option is set) and Caddy pass `Host` through unchanged. If your proxy rewrites it, sign-in fails with "This request came from another site"; either make the proxy pass the original `Host`, or set `RIPPERCRAFT_TRUSTED_ORIGINS`.

**Settings** (environment variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RIPPERCRAFT_MAX_UPLOAD_MB` | `4096` | Largest world archive or add-on jar that can be uploaded, in megabytes. Uploads are written straight to the server's folder, not held in memory. Cloudflare's own limit (100 MB on the free plan) applies first to uploads made through a tunnel. |
| `RIPPERCRAFT_TRUSTED_ORIGINS` | none | Comma-separated origins, such as `https://example.com,https://www.example.com`, to accept in addition to the one in the `Host` header. Only for a proxy that rewrites `Host`. |

Other request bodies are limited to 1 MB.

## Notes

- New vanilla servers are created with `eula=false`. Review Mojang's EULA before switching them to `true`.
- Graceful stopping works best for servers started through `RipperCraft` itself.
- CurseForge automation is disabled until a key is configured. Save one in Owner → Integrations (verified against CurseForge before it is stored, kept in `data/app.json`, never sent back to the browser), or set `CURSEFORGE_API_KEY`. The environment variable always wins, and the Owner page says so when it is in effect. `CURSEFORGE_GAME_ID` is optional and defaults to `432` (Minecraft).
- `data/app.json`, `data/users.json`, and `data/servers.json` hold the cookie secret, password hashes, and server passphrase hashes. They are forced to mode `600` on startup, and are replaced in one step when they change (written to a temporary file beside them, then renamed), so a crash or two saves at once cannot leave one half-written.
- Once someone has signed in on this version their password hash is in the new format, which earlier versions cannot read. Keep a copy of `data/users.json` from before the upgrade if you might need to go back.
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
