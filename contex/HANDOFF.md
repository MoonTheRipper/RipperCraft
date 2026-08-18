# RipperMoonStash Handoff

Start a new Codex session in this repository and read:

- `README.md`
- `contex/HANDOFF.md`

Current important state:

- This workspace is now prepared for GitHub as a code/config repository, not a live server-data backup.
- `.gitignore` intentionally excludes `data/` runtime secrets and all `servers/*` live server folders.
- Keep real worlds, jars, mods, logs, user password hashes, app cookie secrets, and local server runtime state out of git.
- `rippercraft.service` is installed as a systemd service from `infra/systemd/rippercraft.service`.
  Hosts still on the pre-rename `rippermoonstash.service` migrate with
  `sudo bash infra/systemd/migrate-to-rippercraft.sh`, which hands over without
  stopping any Minecraft server that is running at the time.
- Hosting services expected on the machine:
  - `rippercraft.service` for the web dashboard on port `4300`
  - `cloudflared.service` for `rippermoonstash.com`
  - `playit.service` for Minecraft tunnel access
- Sleep, suspend, hibernate, and hybrid sleep targets were masked so the desktop can turn off the display without stopping unattended hosting.
- `rippermoonstash.com` and `www.rippermoonstash.com` were verified returning `HTTP/2 200` through Cloudflare.
- Server records were normalized to project-relative paths so the repo can be moved between machines.
- Managed launchers are portable across macOS and Linux.
- Managed launcher Java resolution order is:
  - `RIPPERMOONSTASH_JAVA_BIN`
  - `JAVA_HOME`
  - macOS `/usr/libexec/java_home` if present
  - `java` on `PATH`
- Shell-based launch commands no longer depend on `/bin/zsh`.
- Tests were passing at the time of handoff with `npm test`.

Suggested first checks on the new machine:

```bash
npm install
npm test
sudo systemctl status rippercraft.service
```

For local development without systemd:

```bash
npm start
```

If Java is not detected for managed servers, set one of:

```bash
export JAVA_HOME=/path/to/java/home
```

or

```bash
export RIPPERMOONSTASH_JAVA_BIN=/full/path/to/java
```
