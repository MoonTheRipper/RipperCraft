# RipperCraft

`RipperCraft` is a browser-based Minecraft server control panel that wraps the local `servers/` directory in this workspace.

> Formerly `RipperMoonStash`. The `RIPPERMOONSTASH_*` environment variables and `rippermoonstash-` browser storage keys are still read, so an existing deployment keeps working across the rename. A dashboard still running as `rippermoonstash.service` is moved to the sandboxed `rippercraft.service` by one script: see [Running it as a service](#running-it-as-a-service). The hosting domain is yours to rename when you are ready.

Current feature set:

- First-run owner bootstrap in the browser, gated by a one-time setup code
- Owner and admin accounts with per-server access lists
- Per-server passphrase unlocks before start, settings edits, world activation, and mod installs
- Start and stop controls for managed servers, with a stop that asks the server on its console and waits for the world to be saved
- `server.properties` editing and server metadata editing
- World archive capture, zip import, activation, and export
- Debug log viewing from `logs/latest.log` and the manager runtime log
- Add-on install from Modrinth
- Optional CurseForge install support, configured in Owner → Integrations or by `CURSEFORGE_API_KEY`
- Guided manual download when a CurseForge author disables third-party downloads
- Direct URL installs (from `https://` addresses on the public internet) and local file uploads for anything else
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
| `RIPPERCRAFT_MAX_WORLD_MB` | `32768` | Largest world, measured unpacked, that can be restored from an archive, in megabytes. See [Worlds](#worlds). |
| `RIPPERCRAFT_MAX_DOWNLOAD_MB` | `1024` | Largest add-on the dashboard will download from a URL or a provider, in megabytes. See [Downloads](#downloads). |
| `RIPPERCRAFT_TRUSTED_ORIGINS` | none | Comma-separated origins, such as `https://example.com,https://www.example.com`, to accept in addition to the one in the `Host` header. Only for a proxy that rewrites `Host`. |

Other request bodies are limited to 1 MB.

## What an admin can do

An admin is someone the owner trusts with one or a few servers: to start and stop them, change the everyday settings, manage worlds and install add-ons. An admin is not trusted with the machine, with the other servers, or with the owner's account, and the dashboard is built to hold that line. The parts of it an operator will notice are below.

One thing it cannot hold: an add-on is code, and a server that loads it runs it as the same system user as the dashboard. Run as a service, the dashboard and its game servers are shut in a sandbox that keeps such code away from your home directory and the rest of the machine, but not away from the dashboard itself: see [What the sandbox does not do](#what-the-sandbox-does-not-do). Give admin accounts to people you would trust with the dashboard and every server in it.

### Starting and stopping

**Stop** tells the server to stop on its console, the same as typing `stop` there. The server tells its players, saves the world and exits. That takes seconds as a rule, and minutes on a machine that is short of memory, so the dashboard does not wait for it with the page:

- The request is answered at once. The server is shown as **stopping…** until its process has gone, in the page header, in the overview and in the server tree, and the page asks every two seconds until it has. Start and Stop are held meanwhile.
- Pressing Stop again, from the same page or another one, starts nothing new: it is the same stop. Starting a server that is still stopping is refused, and so is everything else that needs a stopped server.
- The dashboard is patient, and says when its patience runs out:

  | The server | First | If it has not exited | Last of all |
  | --- | --- | --- | --- |
  | has a console the dashboard can reach | `stop` on the console | after 3 minutes, `SIGTERM` | 1 minute after that, `SIGKILL` |
  | has none | `SIGTERM` | | after 4 minutes, `SIGKILL` |

  Minecraft saves the world on `SIGTERM` as it does on `stop`. `SIGKILL` saves nothing: whatever the server had not written is lost. Every signal is written at `WARN` to the dashboard's log and added to the server's own `runtime.log`, with how long the server had been given.
- A stop belongs to the dashboard process that began it. If the dashboard is restarted in the middle of one, the server has been told to stop already and carries on; pressing Stop again starts a new stop, as patient as the first.
- When a stop is over, the page says how it ended. **A server that had to be killed is not called stopped.** The page says, as an error, that it did not stop when it was asked to and was killed, and that its world may not have been saved; its overview goes on saying so until the server is started again. Every stop the dashboard made is shown there as *last stop*, with what it took. A stop that ends with the same process still running - it failed, or the dashboard was restarted in the middle of it - is said as an error as well.

  The status the page asks for carries this as `lastStop`: `how` (`console`, `SIGTERM` or `SIGKILL`) and `at`. It is kept in memory, for a server that is not running, until that server is next started: a dashboard that has been restarted since no longer has it, and the server's `runtime.log` has the lines that last.

**The console** is a named pipe, `data/consoles/<server id>`, that only the account can read and write: the folder is mode `700`, the pipe `600`. It is made when the server starts and removed when the server has gone. The server holds it open for as long as it runs, so it does not depend on the dashboard: restart the dashboard, and the server is still stopped by `stop`, not by a signal. Making the pipe needs `mkfifo`, which every Linux and macOS has, and a file system that can hold one. Where it cannot be made the server is started with a pipe from the dashboard itself, as it used to be, and both logs say so; such a server has a console only until the dashboard is next restarted, and is stopped by signal after that.

The pipe is not in the server's own folder, on purpose. A pipe that a running server reads holds up whatever else opens it to read: there, `grep -R`, a backup, or a copy of the folder would stop dead on it. A server whose id is not a plain file name has a pipe named `id-` and a hash of the id.

**A server is started in a process group of its own**, and it is the group that is signalled and watched. A start script that does not end in `exec` stays, as a shell, with the server as its child, and the pid the dashboard has is the shell's: a signal to that pid alone ended the shell, the dashboard called the server stopped, and Start put a second server beside the first in the same folder. Now `SIGTERM` and `SIGKILL` reach the script and the server alike, a server counts as running for as long as anything is left in its group, and a server whose start script has gone is still found, still stopped through its console, and not started a second time. Two things follow:

- A dashboard run from a terminal no longer takes its game servers with it on Ctrl-C. They carry on, as they do when the service is restarted, and the dashboard finds them when it is started again.
- A start script that puts the server in a session of its own (`setsid`) takes it out of the group. Once the script has exited the dashboard cannot see such a server, as it could not before: leave the server in the session it is started in.

**`runtime.log`**, in `.rippermoon/` in the server's folder, is written by the server itself: its output goes straight into the file, not through the dashboard. It goes on being written while the dashboard is restarting or away. The dashboard adds lines of its own: who started the server, each step of a stop, and how the process ended.

**A server that was started by an earlier version** of the dashboard has no such pipe: its console was a pipe to the dashboard process that started it. It is stopped by signal, as the one process on record, until it has been stopped and started once with this version. See [Updating](#updating) for what to do with servers that are running when you update.

**The record.** The dashboard reads `.rippermoon/pid.json` to find a server it started before a restart. That file is in the server's folder, where a mod can write and where a copy of the folder takes it along, so it is checked before it is believed - for the status, for a stop, and again before each signal:

- A pid in it counts only if it is a whole number above 1 that is not the dashboard's own.
- The record says which run of the machine it is from (the kernel's boot id) and when its process was started. Both have to agree with what `/proc` says of that pid now, and the process has to be running in this server's folder, or under it. So a copy of a running server's folder is not a second running server, and stopping the copy stops nothing; and a pid that another program has been given since - after a reboot, say - is not signalled.
- What fails one of these is not this server. It is shown as stopped, nothing is signalled, the record is removed, and the dashboard's log says what the record named and why it was not believed.
- A record that cannot be read at all - no permission, a disk error, no file handles left - is another matter. Whether the server is running is then not known: the request fails saying so, and nothing is removed.
- Where `/proc` cannot answer - a system that has none, such as macOS, or a process the dashboard may signal and not look at - a record is believed on its pid alone, as before. So is whatever an older record does not hold: one written before this version has no boot id and no start time, and is checked for the folder only.
- For a group whose first process has exited there is nothing under the recorded pid to ask. One of the processes left in the group then has to be in the session the first one made, no older than it, and running in the server's folder.

`.rippermoon` itself has to be a folder of the server's own. Not following a link guards the last step of a path only: with the folder swapped for a link to another server's, a stop would write into that server's log and clear its record away. So if it is a link, or anything but a folder, the dashboard reads, writes and removes nothing through it and says so - for the status, a start, a stop and the launch script alike. Inside it, the pid file and the launch script are replaced in one step, never written into or through a link, and the runtime log is never written through one. The console, for its part, is only written to when it is a named pipe, in a `data/consoles` that is a folder and not a link.

**Files in a server's folder are read without waiting, and only when they are files.** A named pipe, opened the ordinary way, holds the open until something writes to it. One left where `eula.txt` belongs, and four loads of the server's page, held every file operation in the dashboard, a stop request among them. That goes for all of them now - `eula.txt`, `server.properties`, `ops.json`, the logs, the launcher jars the page looks into, and the dashboard's own `worlds.json`, `addons.json` and `pid.json`:

- A log that is not a file reads as empty.
- A `eula.txt` or `server.properties` that is not a file reads as if there were none: the EULA shows as not accepted and the settings as unset, the dashboard's log says what was found, and accepting the EULA or saving the settings from the page puts a file there. They are written by replacing the file, so a pipe is not waited on there either. A link to a file is followed, as it always was.
- A launch command that is a single path is looked at before it is run, and refused if what is there is not a file.

### Server settings

- The **loader** is one of `vanilla`, `fabric`, `forge`, `neoforge`, `quilt`, `paper`, `purpur`, `folia`, `spigot`, `bukkit` or `custom`.
- A **Minecraft version** is letters, digits, dots, hyphens, underscores and plus signs, as every version Mojang has published is: `1.20.1`, `26.1.2`, `26.4-snapshot-8`, `24w14a`.
- **Names, descriptions and start commands** are one line of text.
- **Memory** is a whole number followed by `K`, `M` or `G`, such as `4G` or `512M`. A server whose stored memory setting is anything else will not start until it is corrected in Settings; the dashboard no longer writes it into the launch script as it stands.
- The settings an admin can change in **`server.properties`** take one line of text each, and the message of the day cannot end in a backslash (Minecraft would read the next setting as part of it). `\n` between the two lines of a message and `\u00a7` colour codes are written as before. The **world type** is one of Minecraft's own (`minecraft:normal`, `minecraft:flat`, `minecraft:large_biomes`, `minecraft:amplified`, `minecraft:single_biome_surface`, or the names older versions used); a world type added by a mod is set by the owner in the full `server.properties` editor, which still writes the file exactly as typed.

### Worlds

A world archive is a zip, and a zip can hold more than files.

- **Restoring** reads the archive itself rather than handing it to `unzip`, and creates only folders and regular files. An archive that holds a symbolic link, a path that leads out of the world folder (`../`), or an entry that turns out larger than its header says is refused, and says why. So is an encrypted archive and one compressed with anything but the standard `store` and `deflate` methods (Deflate64, which Windows uses for files over 2 GB, is the one you might meet): zip it again with another tool.
- A world may unpack to at most `RIPPERCRAFT_MAX_WORLD_MB` (32 GB by default), and never to more than the disk has free less 1 GB. Raise the limit if your worlds are larger than that. Folders count: each is charged 4 KB against the limit, an archive may hold at most 200,000 files and folders together, and a path in it may be at most 64 names long (63 folders and the file). No world Minecraft writes comes near either.
- The archive is unpacked into a folder beside the world folder (`.rippercraft-restore-…`, removed afterwards) and moved into place when all of it has been checked. Nothing is unpacked in `/tmp` any more. If the dashboard is killed part-way, the leftover folder is cleared by the next restore once it is a day old.
- A world is zipped for **download** beside the world folder as well (`.rippercraft-export-…`, removed once it has been sent), no longer in `/tmp`, which is often memory.
- The live world is archived before a restore or a new world replaces it. If that backup cannot be made, the restore stops and the world stays; it used to carry on. Why it could not be made is in the dashboard's log.
- Backups, restores, exports, new worlds and archive uploads for one server are done **one at a time**, in the order they were asked for, and restores one at a time across all servers. A second request waits for the first instead of running through it; the same restore clicked twice used to be able to lose the world.
- **Backing up and exporting** store a symbolic link found inside a world as a link, not as the files it points to. Such a backup cannot be restored from the dashboard, so keep worlds free of links.
- If the **world folder itself is a symbolic link** (some people keep worlds on another disk that way), the dashboard will not back it up, export it or replace it. Move the real folder into the server folder, or mount the other disk instead of linking to it - on the **server folder**, not on the world folder.
- If another disk is **mounted on the world folder**, backups, exports and new worlds work (a new world empties the folder and leaves it in place), but an archive is not restored into it: restoring swaps the folder for another, and a folder with a disk mounted on it cannot be swapped. Mount the disk on the server folder to have everything work.

`zip` has to be installed. `unzip` is no longer needed.

### Downloads

Everything the dashboard fetches from another machine - an add-on from a URL, from Modrinth or CurseForge, a server jar, a loader installer, a version list - goes through one set of rules:

- The address has to be `https://`, with no user name or password in it.
- It has to lead to the public internet. An address on this machine, on a private network (`10.x`, `172.16-31.x`, `192.168.x`), on a tailnet (`100.64.0.0/10`), link-local or otherwise reserved is refused, for IPv4 and IPv6 alike, and so is a host name that resolves to one. To install a jar you host at home, upload the file instead.
- Redirects are followed at most five times, and each has to pass the same checks.
- An add-on may be at most `RIPPERCRAFT_MAX_DOWNLOAD_MB` (1 GB by default) and has 15 minutes to arrive.
- An address that does not answer within 5 seconds is given up on and the host's next address is tried, IPv4 after IPv6 or the other way round. A machine with a broken IPv6 route no longer waits out the whole request on it.

Add-on artwork and project links are passed to the page only when they are `https://` addresses.

The dashboard makes these requests directly. It does not use an HTTP proxy from the environment.

### Add-ons and the files beside them

- What a jar says about itself - its name, its version, the loader builds it accepts - is read from the metadata file inside it, and no more than 1 MB of that. A jar whose metadata is larger, or whose sizes do not add up, is listed in the update panel among the jars that could not be checked.
- `ops.json` and the dashboard's own files in a server's folder (`.rippermoon/worlds.json`, `.rippermoon/addons.json`) are read as what they should hold. An operator without a name that is text, or an add-on record without a file name, is not listed; nothing else in those files can stop the server's page from loading.

### What a game server is started with

A game server, and anything else the dashboard runs, is started with a short list of environment variables rather than everything the dashboard itself was started with: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LANGUAGE`, `LC_*`, `TZ`, `JAVA_HOME`, `RIPPERCRAFT_JAVA_BIN`, `RIPPERMOONSTASH_JAVA_BIN`, `JAVA_TOOL_OPTIONS`, `JDK_JAVA_OPTIONS` and `_JAVA_OPTIONS`. `CURSEFORGE_API_KEY` and the rest of the service's settings are no longer passed to mods.

That is not the same as mods being unable to get them. A game server runs as the same system user as the dashboard, and on Linux a process may read the environment of any other process of its own user from `/proc`. A mod that goes looking can still find the key there, until game servers run under a user of their own. The sandbox the service runs in does not change that: it is around the dashboard and the game servers together.

If a start script of your own reads some other variable that you set for the service, set it in the script, or have the script read it from a file.

### In the browser

Every response carries a `Content-Security-Policy` that lets the page load scripts and styles from the dashboard only, images from the dashboard and from `https://` addresses (add-on artwork), and connect to nothing but the dashboard. If you put the dashboard behind a proxy that injects a script or a stylesheet into pages, that injection will be blocked.

## Notes

- New vanilla servers are created with `eula=false`. Review Mojang's EULA before switching them to `true`.
- A server is stopped through its console, and given time to save: see [Starting and stopping](#starting-and-stopping). The dashboard can only stop servers it started itself.
- CurseForge automation is disabled until a key is configured. Save one in Owner → Integrations (verified against CurseForge before it is stored, kept in `data/app.json`, never sent back to the browser), or set `CURSEFORGE_API_KEY`. The environment variable always wins, and the Owner page says so when it is in effect. `CURSEFORGE_GAME_ID` is optional and defaults to `432` (Minecraft).
- `data/app.json`, `data/users.json`, and `data/servers.json` hold the cookie secret, password hashes, and server passphrase hashes. They are forced to mode `600` on startup, and are replaced in one step when they change (written to a temporary file beside them, then renamed), so a crash or two saves at once cannot leave one half-written.
- Once someone has signed in on this version their password hash is in the new format, which earlier versions cannot read. Keep a copy of `data/users.json` from before the upgrade if you might need to go back. `infra/systemd/migrate-to-rippercraft.sh` makes one, and puts it back if it has to undo the upgrade.
- Forge and NeoForge are installed by running their official installer, which needs a working Java. They produce argfiles rather than a `server.jar`, and the generated launch script handles both shapes. NeoForge has no builds before Minecraft 1.20.2.
- Pick a per-server **java version** in Settings when one server needs a different JDK from the rest, for example Forge 1.20.1 on Java 17 alongside newer servers on Java 21+. `RIPPERMOONSTASH_JAVA_BIN` and `JAVA_HOME` apply to the whole service, so they cannot express that on their own. Installed JDKs are detected automatically from the usual locations (`/usr/lib/jvm`, `/usr/java`, `/opt/java`, SDKMAN, macOS `JavaVirtualMachines`), deduplicated across version symlinks, and offered as a dropdown; the list is cached for five minutes.
- The loader dropdown is a label, not an installer. If it disagrees with the runtime actually on disk, Settings shows a mismatch warning: a server labelled `forge` but running a vanilla jar starts normally and loads no mods.
- Some CurseForge authors disable third-party downloads. Those mods still appear in search, but cannot be fetched automatically. The dashboard detects this, links straight to the file's CurseForge page, and asks you to add the jar with `upload file`.
- For Fabric, Forge, NeoForge, Quilt, Paper, or Purpur servers that already exist on disk, register the existing folder and set the matching loader in Settings so search/install targets the right add-on directory.
- Server records are stored relative to this project root, so the folder can be copied to another machine without keeping the old absolute paths.
- Managed launchers work on macOS and Linux. If Java is not already on `PATH`, set `JAVA_HOME` or `RIPPERMOONSTASH_JAVA_BIN` before starting the dashboard.

## Running it as a service

`infra/systemd/rippercraft.service` runs the dashboard under systemd, in a sandbox. It is a template: nothing in it names a machine, an account or a path. `infra/systemd/migrate-to-rippercraft.sh` fills it in for the machine it is run on, tries the result out, and installs it.

```bash
cd /path/to/the/checkout
sudo infra/systemd/migrate-to-rippercraft.sh --check    # look; change nothing
sudo infra/systemd/migrate-to-rippercraft.sh            # install and start
```

The service runs as the account that owns the checkout, so clone it as the account the game servers should run as, not as root. It needs systemd, Node 24, Java and `zip`, and `git` and `curl` for the script. Java and `zip` have to be installed for the whole machine, not in a home directory; Node may be in one (nvm is fine). `data/` and `servers/` have to be folders in the checkout itself, not links to folders kept somewhere else: if they are on another disk, mount it there.

A service keeps every group its account is in. If the account is in `docker`, `lxd`, `incus` or `libvirt` on a machine where that service is installed, the script refuses: whoever can use such a socket is root, sandbox or no sandbox. Take the account out of the group, or give the dashboard an account of its own.

On a machine that has not run the dashboard as a service before, that is all there is to it. It listens on `127.0.0.1:4300`; `--host 0.0.0.0` and `--port` change that. Secrets such as `CURSEFORGE_API_KEY` go in `/etc/rippercraft.env`, owned by root with mode `600`, one `NAME=value` to a line.

Before it changes anything, the script fills the unit in, has systemd check it, and then starts the sandbox for a moment under another name and looks at it from the inside: the code can be read and not written, `data/` and `servers/` can be written, the home directory is empty, `/tmp` is its own, the machine's terminals, logs and crash dumps are out of reach, and node, java and zip run. If any of that is not so on your machine it stops and says which. `--check` does the same and then lists what it would do.

### Moving from `rippermoonstash.service`

The checkout is still on the old commit, and the script in it is the old one. Fetch, and run the script out of the commit you are moving to:

```bash
cd /path/to/the/checkout
git fetch
git show origin/main:infra/systemd/migrate-to-rippercraft.sh > ~/migrate-to-rippercraft.sh
sudo bash ~/migrate-to-rippercraft.sh --check
sudo bash ~/migrate-to-rippercraft.sh
```

It carries the address, the port and the node binary over from the old unit, copies `/etc/rippermoonstash.env` to `/etc/rippercraft.env`, copies `data/*.json` to `/var/backups/rippercraft/<time>/` (root only), fast-forwards the checkout to `origin/main`, and hands over. It needs no network: the fetch is the only step that does.

Game servers that are running keep running. They were started by the dashboard and belong to its unit, and stopping a unit normally stops everything in it; so the old unit is first told to signal only the dashboard, and after the handover the script checks that every game server is still the process it was. The dashboard is away for up to a minute.

If the new dashboard does not start, does not answer, answers with the old code, or a game server is gone, the script undoes all of it - the unit, the checkout, the `data/*.json` files - starts the old unit again, checks that it answers, and says what happened. It ends with status 2 then, or 3 if it could not put everything back, in which case it says in capitals what is not as it was and how to look.

Afterwards:

- Restart each game server from the dashboard, one at a time. A server that was running during the move keeps running *outside* the sandbox until it has been restarted.
- Everybody has been signed out. Passwords keep working whatever their length; ask every admin whose password is shorter than 12 characters to change it.
- Running the script again only checks, and says that there is nothing to do.

### Going back

```bash
sudo infra/systemd/migrate-to-rippercraft.sh --rollback
```

undoes the last run of the script that changed something. It stops `rippercraft.service` (game servers keep running), puts the checkout back on the commit it was on, puts back the `data/*.json` files from the backup, removes the new unit, and starts and enables what was running before. The files as they were just before going back, and `/etc/rippercraft.env` if the migration made it, are kept beside the backup.

Going back loses what has been changed in the dashboard since the migration: accounts, passwords, server settings. The older code cannot read a password once the newer code has stored it again, so the files from before are the only ones it can use. Worlds and server folders are not touched. It is meant for the days after a migration: once the checkout has been moved on with `git pull`, the script declines, and going back is the steps below.

The script prints the same steps as commands to run by hand when a migration ends. They are: stop `rippercraft`; `git reset --keep` the checkout to the commit from before; put the files from `/var/backups/rippercraft/<time>/data/` back in `data/`, yours and mode `600`; remove `/etc/systemd/system/rippercraft.service` and `sudo systemctl daemon-reload`; `sudo systemctl enable --now rippermoonstash`. When you put the files back by hand, move each into place rather than copying over what is there: `data/` is the service's to write to, and a copy would follow a link left in it. Leave the drop-in in `/etc/systemd/system/rippermoonstash.service.d/` where it is for as long as that unit is installed: it is what keeps game servers running when the unit is stopped.

### Updating

```bash
git pull --ff-only
sudo infra/systemd/migrate-to-rippercraft.sh    # only does something if the unit has changed
sudo systemctl restart rippercraft              # game servers keep running
```

The first time you update to a version that gives servers a [console of their own](#starting-and-stopping), stop every running game server from the dashboard before you do, and start them again afterwards. A server started by the older version has its console in the dashboard process that the restart ends. Stopped before the restart, it is still stopped by `stop`; left running through it, it can only be stopped by signal. Servers started since are not affected, and later updates need nothing of the kind.

After any update, reload the dashboard pages that are open in a browser. A page keeps the script it was loaded with, and an older script does not know what a newer dashboard tells it: that a server is stopping, or that one had to be killed.

### What the sandbox does

The dashboard and every game server it starts run as the account that owns the checkout, in a group of their own, `rippercraft`, with this and no more:

- **The checkout, read-only** - the code, `.git`, the unit file - with `data/` and `servers/` in it writable. Nothing the service runs can change what it will run next time, or what you run from the checkout yourself.
- **An empty home directory of its own**, kept in memory and limited to 256 MB, and an empty `/tmp` and `/var/tmp`. Not yours: no `~/.ssh`, no `~/.config`, no tokens, no shell history, and nobody else's home either.
- **The rest of the file system read-only**, and no disks or other devices.
- **Its own processes only.** It cannot see the other programs your account is running, or look into them: their files, their environment, their memory. That is what the group is for. Linux allows one process to look inside another only when both the user and the group match, and a way into any of your other programs would be a way back to your home directory.
- **None of what your account has lying about outside its home directory**: the terminals you are logged in on and your `screen` sessions, which anything running as you could otherwise read and type into; the crash dumps of your programs, which hold their memory; the system's logs; the machine's shared memory; and the kernel's key store.
- **No way to gain privileges.** `sudo` and every other setuid program stop working inside it. No mounting, no kernel modules, no tracing other processes, no setting the clock, and network and local sockets only.

Restarting or stopping the service signals the dashboard alone. Game servers keep running, with their consoles and still writing their logs, and the dashboard finds them again when it is back. A stop that was under way is not carried over: the server has been told, and Stop can be pressed again.

Two things follow for you. Do not run programs out of `data/` or `servers/` yourself: those are the two folders a mod can write to. That is why `npm test` only runs the files in `test/`. And settings of your own belong in a drop-in (`sudo systemctl edit rippercraft`), not in the installed unit, which the script rewrites.

On systemd older than 257 the service's `/tmp` is of a kind that is emptied whenever the dashboard stops, from under the game servers that are still running. They carry on, but a mod that unpacks something into `/tmp` later may fail until its server is restarted.

### What the sandbox does not do

The dashboard and the game servers are one account in one sandbox, and a mod is code that runs with everything the dashboard has.

- **The dashboard is not protected from a mod.** Anyone who can add a mod to a server can read and change everything in `data/` - the accounts, the password hashes, the cookie secret, every server's passphrase - and every other server's files. That is control of the dashboard. Access lists and passphrases hold for people, not for code a server runs.
- **A mod can read `CURSEFORGE_API_KEY`**, and whatever else the service was started with, from the dashboard's entry in `/proc`.
- **The network is open to it** as to any program: it can reach whatever listens on this machine or your LAN, and listen on any port above 1023.
- **It can read what any local account can read** outside the home directories, and talk to system services that answer any local account.
- **It can send signals** to the other programs of the same account - end them, not look into them.
- **A game server that was already running** when the dashboard moved into the sandbox is outside it until it is restarted.

What a mod can no longer do is get out: at your home directory and your keys, at the code the dashboard runs, at the rest of the system's files. Keeping one server's mods away from the dashboard and from the other servers would take a sandbox or an account for each server; that is not built.

### Memory

The dashboard itself uses a few tens of megabytes. Its heap is limited to 1 GB (`--max-old-space-size=1024` in the unit). Left alone, Node takes its limit from the size of the machine, which on one that runs game servers is gigabytes. With the limit a leak ends the dashboard at 1 GB, systemd starts it again five seconds later, and the game servers carry on. The limit is on the JavaScript heap; it does not cover memory the dashboard holds outside it.

The unit as a whole has no limit. A game server is part of the unit, so a limit on the unit is a limit on all the game servers and the dashboard together, and when it is reached the kernel ends the largest process in the unit: a game server, not the dashboard. Whether you want that depends on your machine. If you would rather lose the largest server than have a runaway push the whole machine into swap, add a limit sized for it:

```bash
sudo systemctl edit rippercraft
```

```ini
[Service]
MemoryMax=12G
MemorySwapMax=1G
```

Make it larger than what your servers may use together: each server's `-Xmx`, and about a quarter again for the JVM itself. Set too small, it ends a server for being as large as you told it it could be.

### Reaching it from outside

To reach the dashboard from outside your home network, see `infra/free-hosting/` (Cloudflare
Tunnel and playit.gg, no server to rent) or `infra/hosting/` (a small VPS in front). Your own
values go in the files those guides tell you to create; git ignores them. The other units under
`infra/hosting/systemd/` are written for one particular machine: change the user and the paths
in them before you install them.

## Licence

The code is under the [MIT licence](LICENSE). The RipperCraft logo is not: see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.
