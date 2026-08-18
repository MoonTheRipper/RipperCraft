#!/usr/bin/env bash
#
# Migrate the dashboard service from rippermoonstash.service to
# rippercraft.service, without taking down any Minecraft server that happens to
# be running at the time.
#
#   sudo bash infra/systemd/migrate-to-rippercraft.sh
#
# The ordering here is the whole point. Game servers are spawned as children of
# the dashboard, so they sit in its cgroup, and the old unit uses the default
# KillMode=control-group. Stopping it the ordinary way SIGTERMs every running
# game server too. So a KillMode=process drop-in is applied to the OLD unit and
# reloaded FIRST; only then is it safe to stop it and hand over.
#
# Safe to re-run: every step is idempotent, and it refuses to continue if the
# safety gate did not take effect.

set -euo pipefail

OLD_UNIT="rippermoonstash.service"
NEW_UNIT="rippercraft.service"
UNIT_DIR="/etc/systemd/system"
DROPIN_DIR="${UNIT_DIR}/${OLD_UNIT}.d"
SOURCE_UNIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${NEW_UNIT}"

if [ "$(id -u)" -ne 0 ]; then
  echo "This needs root: sudo bash $0" >&2
  exit 1
fi

if [ ! -f "$SOURCE_UNIT" ]; then
  echo "Unit file not found next to this script: $SOURCE_UNIT" >&2
  exit 1
fi

game_pids() {
  # Every Minecraft server the dashboard has launched, by its recorded pid.
  local pid
  for pidfile in /home/ripper-moon/minecraft-server/servers/*/.rippermoon/pid.json; do
    [ -f "$pidfile" ] || continue
    pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9]\+\).*/\1/p' "$pidfile")"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
  done
}

BEFORE="$(game_pids | sort -n | tr '\n' ' ')"
echo "Game servers running before migration: ${BEFORE:-none}"

echo "==> 1/6 installing ${NEW_UNIT}"
install -m 0644 -o root -g root "$SOURCE_UNIT" "${UNIT_DIR}/${NEW_UNIT}"

if systemctl list-unit-files "$OLD_UNIT" >/dev/null 2>&1 && [ -f "${UNIT_DIR}/${OLD_UNIT}" ]; then
  echo "==> 2/6 applying KillMode=process safety gate to ${OLD_UNIT}"
  mkdir -p "$DROPIN_DIR"
  cat > "${DROPIN_DIR}/killmode.conf" <<'DROPIN'
# Applied before the old unit is stopped so that stopping it does not tear down
# the Minecraft servers running inside its cgroup. Removed once the migration
# completes; the replacement unit sets KillMode=process directly.
[Service]
KillMode=process
DROPIN
  systemctl daemon-reload

  # Refuse to continue if the gate did not take, rather than stopping the old
  # unit and discovering the hard way that it took the game servers with it.
  EFFECTIVE="$(systemctl show "$OLD_UNIT" -p KillMode --value)"
  if [ "$EFFECTIVE" != "process" ]; then
    echo "ABORT: ${OLD_UNIT} still has KillMode=${EFFECTIVE}; stopping it would kill running servers." >&2
    exit 1
  fi
  echo "    safety gate active (KillMode=process)"

  echo "==> 3/6 migrating the environment file"
  if [ -f /etc/rippermoonstash.env ] && [ ! -f /etc/rippercraft.env ]; then
    install -m 0600 -o root -g root /etc/rippermoonstash.env /etc/rippercraft.env
    echo "    copied /etc/rippermoonstash.env -> /etc/rippercraft.env"
  else
    echo "    nothing to copy (target exists, or no source file)"
  fi

  echo "==> 4/6 stopping and disabling ${OLD_UNIT}"
  systemctl disable "$OLD_UNIT" >/dev/null 2>&1 || true
  systemctl stop "$OLD_UNIT"
else
  echo "==> 2-4/6 ${OLD_UNIT} not installed, nothing to migrate from"
  systemctl daemon-reload
fi

echo "==> 5/6 enabling and starting ${NEW_UNIT}"
systemctl daemon-reload
systemctl enable "$NEW_UNIT" >/dev/null
systemctl start "$NEW_UNIT"

echo "==> 6/6 verifying"
sleep 3
AFTER="$(game_pids | sort -n | tr '\n' ' ')"
echo "    dashboard: $(systemctl is-active "$NEW_UNIT")"
echo "    game servers after migration: ${AFTER:-none}"

if [ "$BEFORE" != "$AFTER" ]; then
  echo "    WARNING: the set of running game servers changed across the migration." >&2
  echo "             before: ${BEFORE:-none}" >&2
  echo "             after:  ${AFTER:-none}" >&2
else
  echo "    game servers survived the handover unchanged"
fi

# The gate belonged to the old unit, which is now stopped and disabled.
rm -rf "$DROPIN_DIR"

echo
echo "Done. The old unit file is left at ${UNIT_DIR}/${OLD_UNIT} (disabled)."
echo "Remove it once you are happy:  sudo rm ${UNIT_DIR}/${OLD_UNIT}"
echo "From now on:                   sudo systemctl restart ${NEW_UNIT}"
