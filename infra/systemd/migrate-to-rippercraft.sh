#!/usr/bin/env bash
#
# Puts the dashboard under the sandboxed rippercraft.service, without stopping
# any Minecraft server that is running at the time.
#
#   sudo infra/systemd/migrate-to-rippercraft.sh --check     look, change nothing
#   sudo infra/systemd/migrate-to-rippercraft.sh             do it
#   sudo infra/systemd/migrate-to-rippercraft.sh --rollback  go back to before
#
# It works from whatever is serving the dashboard now: the old
# rippermoonstash.service, an earlier rippercraft.service, or nothing at all on
# a machine that is being set up for the first time.
#
# What it does, in order:
#
#   1. Looks before it touches anything: the checkout, the commit to move to,
#      node, java and zip as the service will see them, and the unit itself,
#      which is filled in for this machine, checked by systemd and then tried
#      out for real in a short-lived copy of the sandbox.
#   2. Copies data/*.json to a new root-only folder under /var/backups.
#   3. Makes sure stopping the running unit signals only the dashboard. Game
#      servers are started by the dashboard and so belong to its unit; with
#      systemd's default they would be stopped along with it.
#   4. Fast-forwards the checkout to the commit it was asked for.
#   5. Installs the unit, and copies the old environment file if the new one
#      does not exist.
#   6. Stops the running unit and starts the new one.
#   7. Checks that the dashboard answers, that it is the new code answering,
#      and that every game server that was running still is.
#   8. Enables the new unit and disables the old one.
#
# If anything fails once the running unit has been stopped, it stops the new
# unit, puts back the commit, the unit file and the backed-up data, starts what
# was running before, checks that it answers, and says what happened.
#
# It needs no network and no SSH key: `git fetch` first, as yourself. It can be
# run again at any time. Once everything is in place it only checks.
#
# Exit status: 0 done or nothing to do, 1 stopped before the running unit was
# touched, 2 failed and went back, 3 failed and could not go back all the way.

set -euo pipefail

OLD_UNIT="rippermoonstash.service"
NEW_UNIT="rippercraft.service"
SERVICE_GROUP="rippercraft"
DEFAULT_TARGET="origin/main"
DEFAULT_HOST="127.0.0.1"
DEFAULT_PORT="4300"
TEMPLATE_PATH="infra/systemd/rippercraft.service"
SCRIPT_PATH_IN_REPO="infra/systemd/migrate-to-rippercraft.sh"
# How long the dashboard is given to answer after it has been started.
HEALTH_SECONDS=45

# The tests point this at a scratch folder and put stand-ins for systemctl,
# runuser and curl on PATH. Nothing else should ever set it.
TESTROOT="${RIPPERCRAFT_MIGRATE_TESTROOT:-}"
if [ -n "$TESTROOT" ]; then
  HEALTH_SECONDS="${RIPPERCRAFT_MIGRATE_HEALTH_SECONDS:-$HEALTH_SECONDS}"
fi
ETC_DIR="${TESTROOT}/etc"
UNIT_DIR="${ETC_DIR}/systemd/system"
BACKUP_ROOT="${TESTROOT}/var/backups/rippercraft"
PROC_ROOT="${TESTROOT}/proc"
OLD_ENV_FILE="${ETC_DIR}/rippermoonstash.env"
NEW_ENV_FILE="${ETC_DIR}/rippercraft.env"
# What the unit replaces with empty folders, or hides.
HIDDEN_ROOTS=("${TESTROOT}/home" "${TESTROOT}/root" "${TESTROOT}/run/user" "${TESTROOT}/tmp" "${TESTROOT}/var/tmp" "${TESTROOT}/var/log" "${TESTROOT}/run/log")

MODE="migrate"
OPT_CHECKOUT=""
OPT_TARGET=""
OPT_NODE=""
OPT_HOST=""
OPT_PORT=""

CHECKOUT=""
OWNER=""
OWNER_UID=""
OWNER_GROUP=""
OWNER_GID=""
OWNER_HOME=""
OWNER_HOME_REAL=""
HEAD_SHA=""
TARGET_SHA=""
SOURCE_UNIT=""
SOURCE_WAS_ENABLED=0
NODE_BIN=""
UNIT_HOST=""
UNIT_PORT=""
UNIT_PATH=""
LOOKUP_PATH=""
SYSTEMD_VERSION=""
PRIVATE_TMP=""
GROUP_EXISTS=0
HOME_IS_HIDDEN=0
RENDERED=""
RENDERED_FOR_REHEARSAL=""
EXPECTED_CSP=""
WORK_DIR=""
BACKUP_DIR=""
LOG_FILE=""
GAME_SERVERS=()
JAVA_BINS=()
PROBLEMS=0
FOLDERS_MISSING=0

# What has been changed so far, so that it can be put back.
PHASE="preflight"
DID_GROUP=0
DID_DROPIN=""
DID_FAST_FORWARD=0
DID_INSTALL_UNIT=0
HAD_UNIT_BEFORE=0
DID_COPY_ENV=0
DID_STOP_SOURCE=0
DID_START_NEW=0
DID_ENABLE_NEW=0

# ---------------------------------------------------------------------------
# Saying things
# ---------------------------------------------------------------------------

# Everything said is also kept beside the backup, once there is one: a
# migration that loses its terminal half-way still leaves a record.
say() {
  if [ -n "$LOG_FILE" ]; then
    printf '%s\n' "$*" >>"$LOG_FILE" 2>/dev/null || true
  fi
  printf '%s\n' "$*" 2>/dev/null || true
}

step() {
  say ""
  say "==> $*"
}

note() {
  say "    $*"
}

problem() {
  say "    PROBLEM: $*"
  PROBLEMS=$((PROBLEMS + 1))
}

die() {
  say ""
  say "Stopped: $*"
  exit 1
}

usage() {
  sed -n '2,/^$/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
  cat <<'USAGE'
Options:
  --check          look and report; change nothing
  --rollback       undo the last migration recorded under /var/backups/rippercraft
  --checkout DIR   the checkout to work on (default: the one this script is in,
                   or the current directory)
  --target REV     the commit to move the checkout to (default: origin/main)
  --node PATH      the node binary to run (default: the one the running unit uses)
  --host ADDRESS   address to listen on (default: as the running unit, or 127.0.0.1)
  --port PORT      port to listen on (default: as the running unit, or 4300)
USAGE
}

# ---------------------------------------------------------------------------
# Small tools
# ---------------------------------------------------------------------------

# Everything inside the checkout is read and written as the account that owns
# it, never as root. The checkout's data/ and servers/ folders can be written by
# the service, and so by a mod: as root, a link planted there would be followed
# to wherever it points.
as_owner() {
  runuser -u "$OWNER" -- env -i HOME="$OWNER_HOME" PATH="$PATH" LANG=C LC_ALL=C "$@"
}

# Reads a file from data/ or servers/, as the owner. Those two folders can be
# written by the service, and so by a mod, and this runs outside the sandbox
# with everything the account can reach: a link left in a file's place would
# be read through to whatever it points at. So the name itself is never
# followed, and a pipe left there cannot hold the read up. With a second
# argument, no more than that many bytes are read.
read_from_checkout() {
  if [ $# -ge 2 ]; then
    as_owner dd if="$1" iflag=nofollow,nonblock bs="$2" count=1 status=none 2>/dev/null
  else
    as_owner dd if="$1" iflag=nofollow,nonblock bs=65536 status=none 2>/dev/null
  fi
}

# Puts what it is given on standard input into data/ under the name given, as
# the owner. The new file is made in the checkout itself, where the service
# cannot write, and moved into place: a move replaces whatever has that name,
# be it a file or a link a mod left there, and follows nothing.
write_into_data() {
  local name="$1" staged
  staged="$(as_owner mktemp "$CHECKOUT/.rippercraft-restore.XXXXXXXX")" || return 1
  # shellcheck disable=SC2016
  if as_owner sh -c 'cat >"$1"' sh "$staged" && as_owner chmod 600 "$staged" &&
    as_owner mv -fT -- "$staged" "$CHECKOUT/data/$name"; then
    return 0
  fi
  as_owner rm -f -- "$staged"
  return 1
}

# Hooks are switched off: `git merge` would otherwise run the checkout's
# post-merge hook in the middle of this.
owner_git() {
  as_owner git -C "$CHECKOUT" -c core.hooksPath=/dev/null "$@"
}

# Runs a command, and says whatever it printed if it fails: the terminal may be
# gone by then, and the log beside the backup is what is left.
quietly() {
  local output
  if output="$("$@" 2>&1)"; then
    return 0
  fi
  [ -z "$output" ] || say "$output"
  return 1
}

unit_prop() {
  systemctl show "$1" -p "$2" --value 2>/dev/null || true
}

unit_exists() {
  [ "$(unit_prop "$1" LoadState)" = "loaded" ]
}

# Serving, or trying to: a unit that keeps crashing and restarting counts,
# because stopping it is still what ends it.
unit_is_up() {
  case "$(unit_prop "$1" ActiveState)" in
    active | activating | reloading | deactivating) return 0 ;;
    *) return 1 ;;
  esac
}

unit_is_enabled() {
  [ "$(unit_prop "$1" UnitFileState)" = "enabled" ]
}

# The program a unit starts: the path= field of what systemd reports.
unit_program() {
  unit_prop "$1" ExecStart | sed -n 's/^{ path=\([^ ;]*\) ;.*$/\1/p' | head -n 1
}

# One variable from a unit's Environment= lines.
unit_env() {
  unit_prop "$1" Environment | tr ' ' '\n' | sed -n "s/^$2=//p" | tail -n 1
}

# One variable from an environment file. Root reads it; the file is root's.
env_file_value() {
  [ -r "$1" ] || return 0
  # As systemd reads it: blanks around the value do not count, nor do quotes.
  sed -n "s/^[[:space:]]*$2=//p" "$1" | tail -n 1 |
    sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

env_file_of() {
  if [ "$1" = "$OLD_UNIT" ]; then
    printf '%s\n' "$OLD_ENV_FILE"
  else
    printf '%s\n' "$NEW_ENV_FILE"
  fi
}

# The port a unit really listens on: its environment file wins over its
# Environment= lines, as it does for systemd.
effective_setting() {
  local unit="$1" name="$2" fallback="$3" value
  value="$(env_file_value "$(env_file_of "$unit")" "$name")"
  [ -n "$value" ] || value="$(unit_env "$unit" "$name")"
  [ -n "$value" ] || value="$fallback"
  printf '%s\n' "$value"
}

# Paths end up in a unit file, where a space separates two paths, a colon
# separates the two ends of a bind mount and a percent sign starts a specifier.
path_is_plain() {
  case "$1" in
    /*) ;;
    *) return 1 ;;
  esac
  case "$1" in
    *[!A-Za-z0-9._/+,=@-]*) return 1 ;;
    *) return 0 ;;
  esac
}

# Somewhere the sandbox replaces with an empty folder.
path_is_hidden() {
  local root real
  for root in "${HIDDEN_ROOTS[@]}"; do
    # /home may itself be a link to where the home directories really are, and
    # the paths this is asked about have had their links followed.
    real="$(readlink -f "$root" 2>/dev/null || true)"
    if inside "$root" "$1" || { [ -n "$real" ] && inside "$real" "$1"; }; then
      return 0
    fi
  done
  [ "$HOME_IS_HIDDEN" = 1 ] && { inside "$OWNER_HOME" "$1" || inside "$OWNER_HOME_REAL" "$1"; }
}

# Whether the second path is the first or somewhere beneath it.
inside() {
  case "$2/" in
    "$1"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The moment a process started, in clock ticks since boot. A pid alone can be
# handed to another process; a pid that still has the same start time cannot.
# Nothing is printed for a process that has ended and is only waiting to be
# collected by its parent.
process_start() {
  local stat
  stat="$(cat "/proc/$1/stat" 2>/dev/null)" || return 1
  # The second field is the command in brackets and may hold spaces.
  stat="${stat##*) }"
  # shellcheck disable=SC2086
  set -- $stat
  case "$1" in
    Z | X) return 1 ;;
  esac
  printf '%s\n' "${20}"
}

# Whether a process was started by one of the two units, going by the control
# group the kernel has it in. That stays true after the unit's own process has
# gone, which is the whole point of leaving the game servers running.
pid_belongs_to_service() {
  local group
  group="$(cat "$PROC_ROOT/$1/cgroup" 2>/dev/null)" || return 1
  case "$group" in
    */"$OLD_UNIT" | */"$OLD_UNIT"/* | */"$NEW_UNIT" | */"$NEW_UNIT"/*) return 0 ;;
    *) return 1 ;;
  esac
}

short() {
  printf '%s' "${1:0:7}"
}

# ---------------------------------------------------------------------------
# Looking: who, where, what is running
# ---------------------------------------------------------------------------

parse_arguments() {
  local asked=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --check | --rollback)
        # Not the last one wins: "--check --rollback" must not go back for real.
        [ -z "$asked" ] || [ "$asked" = "$1" ] || die "--check and --rollback do not go together. --rollback has no way of only looking."
        asked="$1"
        MODE="${1#--}"
        ;;
      --checkout | --target | --node | --host | --port)
        [ $# -ge 2 ] && [ -n "$2" ] || die "$1 needs a value. See --help."
        case "$1" in
          --checkout) OPT_CHECKOUT="$2" ;;
          --target) OPT_TARGET="$2" ;;
          --node) OPT_NODE="$2" ;;
          --host) OPT_HOST="$2" ;;
          --port) OPT_PORT="$2" ;;
        esac
        shift
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *) die "unknown option: $1. See --help." ;;
    esac
    shift
  done
}

require_root() {
  [ -n "$TESTROOT" ] && return 0
  [ "$(id -u)" -eq 0 ] || die "this needs root. Run it with sudo."
}

require_tools() {
  local tool missing=""
  for tool in systemctl systemd-analyze systemd-run runuser git curl install stat getent sed awk grep find cmp mktemp date readlink id; do
    command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
  done
  [ -z "$missing" ] || die "these programs are needed and were not found:$missing"
}

find_checkout() {
  local here
  if [ -n "$OPT_CHECKOUT" ]; then
    [ -d "$OPT_CHECKOUT" ] || die "$OPT_CHECKOUT is not a folder."
    CHECKOUT="$(cd "$OPT_CHECKOUT" && pwd -P)"
  else
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
    if [ -f "$here/../../src/server.js" ] && [ -e "$here/../../.git" ]; then
      CHECKOUT="$(cd "$here/../.." && pwd -P)"
    elif [ -f "$PWD/src/server.js" ] && [ -e "$PWD/.git" ]; then
      CHECKOUT="$(pwd -P)"
    else
      die "run this from the RipperCraft checkout, or name it with --checkout DIR."
    fi
  fi
  [ -f "$CHECKOUT/src/server.js" ] && [ -e "$CHECKOUT/.git" ] ||
    die "$CHECKOUT is not a RipperCraft checkout: it has no src/server.js or no .git."
  path_is_plain "$CHECKOUT" ||
    die "the checkout's path, $CHECKOUT, holds a character a unit file cannot carry. Letters, digits and . _ / + , = @ - are fine."
  if inside "${TESTROOT}/tmp" "$CHECKOUT" || inside "${TESTROOT}/var/tmp" "$CHECKOUT"; then
    die "the checkout is under a temporary folder, $CHECKOUT, that the service gets an empty one of. Move it somewhere that lasts."
  fi

  OWNER="$(stat -c %U "$CHECKOUT")"
  OWNER_UID="$(stat -c %u "$CHECKOUT")"
  [ "$OWNER_UID" != 0 ] ||
    die "the checkout belongs to root. The service runs as the account that owns it, and must not run as root: chown -R it to that account."
  case "$OWNER" in
    "" | UNKNOWN | *[!A-Za-z0-9._-]*) die "the checkout's owner (uid $OWNER_UID) has no account name a unit file can carry." ;;
  esac
  OWNER_GROUP="$(id -gn "$OWNER")"
  OWNER_GID="$(id -g "$OWNER")"
  OWNER_HOME="$(getent passwd "$OWNER" | cut -d: -f6)"
  [ -n "$OWNER_HOME" ] || die "the account $OWNER has no home directory on record."
  OWNER_HOME_REAL="$(readlink -f "$OWNER_HOME" 2>/dev/null || true)"
  [ -n "$OWNER_HOME_REAL" ] || OWNER_HOME_REAL="$OWNER_HOME"

  # The service's group has to be another one than the account's own, or it
  # tells the service apart from nothing. An account made for the dashboard
  # may well be called rippercraft, group and all.
  if [ "$OWNER_GROUP" = "$SERVICE_GROUP" ]; then
    SERVICE_GROUP="$SERVICE_GROUP-service"
  fi
}

# The home directory is replaced by an empty one when it is a real folder that
# the checkout sits inside. If the checkout *is* the home directory, or holds
# it, there is nothing to put the empty one over.
decide_home() {
  HOME_IS_HIDDEN=0
  if [ -d "$OWNER_HOME_REAL" ] && [ "$OWNER_HOME_REAL" != "/" ] && path_is_plain "$OWNER_HOME_REAL" &&
    ! inside "$CHECKOUT" "$OWNER_HOME_REAL"; then
    HOME_IS_HIDDEN=1
  fi
}

read_git_state() {
  local branch dirty template
  HEAD_SHA="$(owner_git rev-parse --verify --quiet 'HEAD^{commit}')" ||
    die "git could not read the checkout as $OWNER."
  TARGET_SHA="$(owner_git rev-parse --verify --quiet "${OPT_TARGET:-$DEFAULT_TARGET}^{commit}")" ||
    die "the commit to move to, ${OPT_TARGET:-$DEFAULT_TARGET}, is not in this checkout. Run \`git fetch\` as $OWNER first."

  # Files git does not know are left out. The service can make such files in
  # servers/ and data/, and they must not be able to hold up an update; a
  # tracked file it cannot touch.
  dirty="$(owner_git status --porcelain --untracked-files=no)" || die "git could not say whether the checkout has changes."
  if [ -n "$dirty" ]; then
    say "$dirty"
    die "the checkout has changes that are not committed (above). Commit, stash or remove them first."
  fi

  if [ "$HEAD_SHA" != "$TARGET_SHA" ]; then
    branch="$(owner_git symbolic-ref --quiet --short HEAD)" ||
      die "the checkout is not on a branch, so it cannot be fast-forwarded. Check out its branch first."
    owner_git merge-base --is-ancestor "$HEAD_SHA" "$TARGET_SHA" ||
      die "branch $branch ($(short "$HEAD_SHA")) cannot be fast-forwarded to $(short "$TARGET_SHA"): it has commits of its own."
  fi

  template="$(owner_git show "$TARGET_SHA:$TEMPLATE_PATH" 2>/dev/null)" ||
    die "commit $(short "$TARGET_SHA") has no $TEMPLATE_PATH."
  grep -q '^User=@USER@$' <<<"$template" ||
    die "commit $(short "$TARGET_SHA") (${OPT_TARGET:-$DEFAULT_TARGET}) holds an older unit that this script cannot fill in. If the newer code has not been fetched yet, run \`git fetch\` as $OWNER first."
}

# The script and the unit it installs belong together. The copy that is running
# has to be the one in the commit being installed.
require_matching_script() {
  local self="${BASH_SOURCE[0]}"
  [ -f "$self" ] || die "save this script to a file and run that: it compares itself with the commit it installs."
  if ! owner_git show "$TARGET_SHA:$SCRIPT_PATH_IN_REPO" 2>/dev/null | cmp -s - "$self"; then
    say ""
    say "This copy of the script is not the one in commit $(short "$TARGET_SHA")."
    say "Take the script from that commit and run it instead:"
    say ""
    say "    cd $CHECKOUT"
    say "    git show $(short "$TARGET_SHA"):$SCRIPT_PATH_IN_REPO > ~/migrate-to-rippercraft.sh"
    say "    sudo bash ~/migrate-to-rippercraft.sh --checkout $CHECKOUT"
    exit 1
  fi
}

# What is serving the dashboard now, and what its settings are.
read_units() {
  local settings_from=""
  SOURCE_UNIT=""
  SOURCE_WAS_ENABLED=0

  if unit_exists "$OLD_UNIT" && unit_is_up "$OLD_UNIT"; then
    SOURCE_UNIT="$OLD_UNIT"
  elif unit_exists "$NEW_UNIT" && unit_is_up "$NEW_UNIT"; then
    SOURCE_UNIT="$NEW_UNIT"
  fi
  if [ -n "$SOURCE_UNIT" ]; then
    settings_from="$SOURCE_UNIT"
    if unit_is_enabled "$SOURCE_UNIT"; then
      SOURCE_WAS_ENABLED=1
    fi
  elif unit_exists "$NEW_UNIT"; then
    settings_from="$NEW_UNIT"
  elif unit_exists "$OLD_UNIT"; then
    settings_from="$OLD_UNIT"
  fi

  if unit_exists "$OLD_UNIT" && unit_is_up "$OLD_UNIT" && unit_exists "$NEW_UNIT" && unit_is_up "$NEW_UNIT"; then
    die "$OLD_UNIT and $NEW_UNIT are both running. Stop the one that should not be, then run this again."
  fi

  NODE_BIN="$OPT_NODE"
  UNIT_HOST="$OPT_HOST"
  UNIT_PORT="$OPT_PORT"
  if [ -n "$settings_from" ]; then
    local program
    program="$(unit_program "$settings_from")"
    if [ -z "$NODE_BIN" ] && [ -n "$program" ]; then
      # An older example unit started `npm start`; node is beside npm.
      if [ "$(basename "$program")" = "node" ]; then
        NODE_BIN="$program"
      elif [ -x "$(dirname "$program")/node" ]; then
        NODE_BIN="$(dirname "$program")/node"
      fi
    fi
    [ -n "$UNIT_HOST" ] || UNIT_HOST="$(unit_env "$settings_from" HOST)"
    [ -n "$UNIT_PORT" ] || UNIT_PORT="$(unit_env "$settings_from" PORT)"
  fi
  if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(as_owner sh -c 'command -v node' 2>/dev/null || true)"
  fi
  [ -n "$UNIT_HOST" ] || UNIT_HOST="$DEFAULT_HOST"
  [ -n "$UNIT_PORT" ] || UNIT_PORT="$DEFAULT_PORT"
}

check_settings() {
  local resolved
  [ -n "$NODE_BIN" ] || die "node was not found. Name it with --node /path/to/node."
  resolved="$(readlink -f "$NODE_BIN" 2>/dev/null || true)"
  [ -n "$resolved" ] && [ -f "$resolved" ] && [ -x "$resolved" ] ||
    die "$NODE_BIN is not a program that can be run. Name the node binary with --node /path/to/node."
  NODE_BIN="$resolved"
  path_is_plain "$NODE_BIN" || die "node's path, $NODE_BIN, holds a character a unit file cannot carry."
  if inside "${TESTROOT}/tmp" "$NODE_BIN" || inside "${TESTROOT}/var/tmp" "$NODE_BIN"; then
    die "node is at $NODE_BIN, under a temporary folder that the service gets an empty one of. Install it somewhere else."
  fi
  UNIT_PATH="$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
  # The same folders, for looking programs up in.
  LOOKUP_PATH="$(dirname "$NODE_BIN"):${TESTROOT}/usr/local/sbin:${TESTROOT}/usr/local/bin:${TESTROOT}/usr/sbin:${TESTROOT}/usr/bin:${TESTROOT}/sbin:${TESTROOT}/bin"

  case "$UNIT_PORT" in
    "" | *[!0-9]*) die "the port, $UNIT_PORT, is not a number." ;;
  esac
  [ "$UNIT_PORT" -ge 1024 ] && [ "$UNIT_PORT" -le 65535 ] ||
    die "the port has to be between 1024 and 65535: the service is given no privileges, and lower ports need them."
  case "$UNIT_HOST" in
    "" | *[!A-Za-z0-9.:-]*) die "the address to listen on, $UNIT_HOST, is not an address or a host name." ;;
  esac

  SYSTEMD_VERSION="$(systemctl --version | sed -n '1s/^systemd \([0-9][0-9]*\).*/\1/p')"
  case "$SYSTEMD_VERSION" in
    "" | *[!0-9]*) die "systemctl --version did not say which systemd this is." ;;
  esac
  if [ "$SYSTEMD_VERSION" -ge 257 ]; then
    PRIVATE_TMP="disconnected"
  else
    PRIVATE_TMP="yes"
  fi

  if getent group "$SERVICE_GROUP" >/dev/null 2>&1; then
    GROUP_EXISTS=1
  else
    GROUP_EXISTS=0
    command -v groupadd >/dev/null 2>&1 || die "the group $SERVICE_GROUP has to be created, and groupadd was not found."
  fi
}

# node, java and zip, found the way the service will find them.
check_programs() {
  local version found records name java
  version="$(as_owner "$NODE_BIN" --version 2>/dev/null || true)"
  case "$version" in
    v[0-9]*)
      version="${version#v}"
      [ "${version%%.*}" -ge 24 ] || problem "node is version $version. RipperCraft needs 24 or later: name a newer one with --node."
      ;;
    *) problem "$NODE_BIN did not answer --version when run as $OWNER." ;;
  esac

  for name in java zip; do
    found="$(PATH="$LOOKUP_PATH" command -v "$name" 2>/dev/null || true)"
    if [ -z "$found" ]; then
      problem "$name was not found on the service's PATH ($UNIT_PATH). Install it."
      continue
    fi
    found="$(readlink -f "$found")"
    if path_is_hidden "$found"; then
      problem "$name is at $found, which the service will not be able to see. Install it system-wide, outside any home directory."
    elif [ "$name" = "java" ]; then
      JAVA_BINS+=("$found")
    fi
  done

  # Servers that are set to a JDK of their own.
  records="$(as_owner "$NODE_BIN" -e '
    const fs = require("fs");
    let servers = {};
    try {
      const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
      const file = fs.openSync(process.argv[1], flags);
      if (fs.fstatSync(file).isFile()) servers = JSON.parse(fs.readFileSync(file, "utf8")).servers || {};
    } catch {}
    for (const [id, record] of Object.entries(servers)) {
      const java = record && typeof record.javaBin === "string" ? record.javaBin.trim() : "";
      if (java && !/[\s]/.test(java) && !/[\s]/.test(id)) console.log(id + " " + java);
    }' "$CHECKOUT/data/servers.json" 2>/dev/null || true)"
  while read -r name java; do
    [ -n "$java" ] || continue
    if ! as_owner test -x "$java"; then
      problem "server $name is set to run $java, which is not there or cannot be run."
    elif path_is_hidden "$(readlink -f "$java")"; then
      problem "server $name is set to run $java, which the service will not be able to see. Use a JDK installed system-wide."
    elif path_is_plain "$java"; then
      JAVA_BINS+=("$java")
    fi
  done <<<"$records"
}

# data/ and servers/ have to be folders in the checkout, not links to folders
# kept somewhere else. What is in them is found by walking them, and a walk
# does not go through a link: a data/ that is one would be backed up as
# nothing at all, without a word, and a game server under a servers/ that is
# one would not be seen and so not be watched.
check_folders() {
  local folder target
  for folder in data servers; do
    as_owner test -L "$CHECKOUT/$folder" || continue
    target="$(as_owner readlink -f -- "$CHECKOUT/$folder" 2>/dev/null || true)"
    problem "$folder/ is a link, to ${target:-nowhere}. It has to be a folder in the checkout itself. If it is kept on another disk, mount that there instead of linking to it."
  done
}

# A link in servers/ or data/ that leads out of them leads to somewhere the
# service sees differently: not at all, or read-only. The two folders
# themselves are check_folders' business.
check_links() {
  local link target
  while IFS= read -r -d '' link; do
    target="$(as_owner readlink -f -- "$link" 2>/dev/null || true)"
    [ -n "$target" ] || continue
    if inside "$CHECKOUT/servers" "$target" || inside "$CHECKOUT/data" "$target"; then
      continue
    fi
    as_owner test -e "$target" || continue
    if path_is_hidden "$target"; then
      problem "$link points to $target, which the service will not be able to see. Move what it points to into the server's folder."
    else
      note "note: $link points to $target, which the service will be able to read but not change."
    fi
  done < <(as_owner find "$CHECKOUT/servers" "$CHECKOUT/data" -mindepth 1 -type l -print0 2>/dev/null || true)
}

# Only ordinary files in data/ are backed up and put back. Anything else there
# with a name that ends in .json - a link, most likely - would be left out of
# the backup without a word, and be the one file that cannot be put back.
check_data_files() {
  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    problem "data/$name is not an ordinary file. Put the file itself there, not a link to it: only ordinary files are backed up and put back."
  done < <(as_owner find "$CHECKOUT/data" -maxdepth 1 -name '*.json' ! -type f -printf '%f\n' 2>/dev/null || true)
}

# A service keeps every group its account is in; systemd can add to them, not
# take away. Most are harmless inside the sandbox. A few open a socket that
# hands out root.
check_groups() {
  local group sockets socket found
  for group in $(id -Gn "$OWNER" 2>/dev/null || true); do
    case "$group" in
      docker) sockets="/run/docker.sock" ;;
      lxd) sockets="/var/snap/lxd/common/lxd/unix.socket /var/lib/lxd/unix.socket /run/lxd-installer.socket" ;;
      incus | incus-admin) sockets="/var/lib/incus/unix.socket /run/incus/unix.socket" ;;
      libvirt) sockets="/run/libvirt/libvirt-sock" ;;
      shadow | root)
        problem "$OWNER is in the group $group, which can read what only root should. A service keeps all of its account's groups: take the account out of that one, or give the dashboard an account of its own."
        continue
        ;;
      *) continue ;;
    esac
    found=""
    for socket in $sockets; do
      if [ -e "${TESTROOT}$socket" ]; then
        found="$socket"
      fi
    done
    if [ -n "$found" ]; then
      problem "$OWNER is in the group $group, and $found is there. Whoever can use that socket is root on this machine, and a service keeps all of its account's groups: take the account out of the group (sudo gpasswd -d $OWNER $group), or give the dashboard an account of its own."
    else
      note "note: $OWNER is in the group $group, which is as good as root where its service is installed. It is not installed here; the account does not need the group."
    fi
  done
}

# The game servers the dashboard has running: the pids it recorded, where the
# process is still there, belongs to the same account and is part of a unit
# this script handles. Each is kept as "pid start-time name".
find_game_servers() {
  local file pid name start
  GAME_SERVERS=()
  while IFS= read -r -d '' file; do
    # Only a number is taken from it. A file that has gone, or cannot be read,
    # is a server that is not running.
    pid="$(read_from_checkout "$file" 4096 | tr -d '\n' | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' || true)"
    [ -n "$pid" ] || continue
    name="$(basename "$(dirname "$(dirname "$file")")")"
    case "$name" in
      *[!A-Za-z0-9._-]*) name="a-server" ;;
    esac
    kill -0 "$pid" 2>/dev/null || continue
    [ "$(stat -c %u "/proc/$pid" 2>/dev/null || true)" = "$OWNER_UID" ] || continue
    if ! pid_belongs_to_service "$pid"; then
      note "note: $name records pid $pid, which is not part of $OLD_UNIT or $NEW_UNIT. It is not watched."
      continue
    fi
    start="$(process_start "$pid")" || continue
    GAME_SERVERS+=("$pid $start $name")
  done < <(as_owner find "$CHECKOUT/servers" -mindepth 3 -maxdepth 3 -path '*/.rippermoon/pid.json' -type f -print0 2>/dev/null || true)
}

describe_game_servers() {
  local entry pid name where
  if [ ${#GAME_SERVERS[@]} -eq 0 ]; then
    note "game servers running: none"
    return 0
  fi
  for entry in "${GAME_SERVERS[@]}"; do
    read -r pid _ name <<<"$entry"
    where=""
    if [ -r "/proc/$pid/ns/mnt" ] && [ -r /proc/1/ns/mnt ]; then
      if [ "$(readlink "/proc/$pid/ns/mnt")" = "$(readlink /proc/1/ns/mnt)" ]; then
        where=", outside the sandbox until it is restarted"
      else
        where=", inside the sandbox"
      fi
    fi
    note "game server running: $name (pid $pid$where)"
  done
}

# Every game server found earlier is still the same process.
game_servers_alive() {
  local entry pid start name
  for entry in ${GAME_SERVERS[@]+"${GAME_SERVERS[@]}"}; do
    read -r pid start name <<<"$entry"
    if ! kill -0 "$pid" 2>/dev/null || [ "$(process_start "$pid" || true)" != "$start" ]; then
      say "    game server $name (pid $pid) is no longer running."
      return 1
    fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# The unit: filled in, checked, and tried out
# ---------------------------------------------------------------------------

# Writes the unit for this machine to the file named. The second argument is
# the group to run as.
render_unit() {
  local output="$1" group="$2" left
  # Two parts of the template are only wanted on some machines. Each is between
  # a "#@if NAME" line and a "#@end" line, and goes when it is not wanted.
  local node_rule='/^#@if NODE_HIDDEN$/,/^#@end$/d' home_rule='/^#@if HOME$/,/^#@end$/d'
  if path_is_hidden "$NODE_BIN"; then
    node_rule="s|@NODE_HIDDEN@|$NODE_BIN|g"
  fi
  if [ "$HOME_IS_HIDDEN" = 1 ]; then
    home_rule="s|@HOME@|$OWNER_HOME_REAL|g"
  fi

  owner_git show "$TARGET_SHA:$TEMPLATE_PATH" >"$output.template" ||
    die "git could not read $TEMPLATE_PATH from commit $(short "$TARGET_SHA")."
  sed \
      -e '/^# RipperCraft dashboard - systemd unit, as a template\.$/,/^$/d' \
      -e "s|@USER@|$OWNER|g" \
      -e "s|@UID@|$OWNER_UID|g" \
      -e "s|@GROUP@|$group|g" \
      -e "s|@CHECKOUT@|$CHECKOUT|g" \
      -e "s|@NODE@|$NODE_BIN|g" \
      -e "s|@NODE_BIN_DIR@|$(dirname "$NODE_BIN")|g" \
      -e "s|@HOST@|$UNIT_HOST|g" \
      -e "s|@PORT@|$UNIT_PORT|g" \
      -e "s|@PRIVATE_TMP@|$PRIVATE_TMP|g" \
      -e "$node_rule" \
      -e "$home_rule" \
      -e '/^#@if [A-Z_]*$/d' \
      -e '/^#@end$/d' \
      "$output.template" >"$output.body"

  # Nothing that changes from one commit to the next goes into the unit: a run
  # after `git pull` has to find the installed unit the same as this one, or
  # it would take every pull for a change to the unit.
  {
    printf '# RipperCraft dashboard. Written by %s\n' "$SCRIPT_PATH_IN_REPO"
    printf '# from %s. Run the script again rather than editing\n' "$TEMPLATE_PATH"
    printf '# this file; settings of your own belong in a drop-in:\n'
    printf '#   sudo systemctl edit %s\n\n' "$NEW_UNIT"
    cat "$output.body"
  } >"$output"
  rm -f "$output.body" "$output.template"

  left="$(grep -o '@[A-Z_]*@' "$output" | sort -u | tr '\n' ' ' || true)"
  [ -z "$left" ] || die "the unit template has values this script does not know: $left"
}

prepare_unit() {
  local group="$SERVICE_GROUP" output
  WORK_DIR="$(mktemp -d)"
  mkdir -p "$WORK_DIR/unit" "$WORK_DIR/rehearsal"
  RENDERED="$WORK_DIR/unit/$NEW_UNIT"
  RENDERED_FOR_REHEARSAL="$WORK_DIR/rehearsal/$NEW_UNIT"
  render_unit "$RENDERED" "$SERVICE_GROUP"
  # Until the group exists the sandbox can only be tried out with the
  # account's own, by number: a group's name may hold anything.
  [ "$GROUP_EXISTS" = 1 ] || group="$OWNER_GID"
  render_unit "$RENDERED_FOR_REHEARSAL" "$group"

  # Only this unit. Without the option, a mistake in any unit it depends on -
  # somebody else's - would count against it.
  local only_this=()
  if [ "$SYSTEMD_VERSION" -ge 250 ]; then
    only_this=(--recursive-errors=no)
  fi
  if ! output="$(systemd-analyze verify ${only_this[@]+"${only_this[@]}"} "$RENDERED" 2>&1)"; then
    say "$output"
    die "systemd does not accept the unit (above)."
  fi
}

# What runs inside the trial sandbox, as the service's account. It looks at the
# sandbox from the inside and reports each thing it finds. bash reads it from
# its standard input, so nothing it runs may read from there.
probe_script() {
  cat <<'PROBE'
checkout="$1"; home="$2"; node="$3"; outside_pid="$4"; home_hidden="$5"
tmp_marker="$6"; var_tmp_marker="$7"; shm_marker="$8"
shift 8
failed=0
ok() { printf '      ok    %s\n' "$*"; }
bad() { printf '      FAIL  %s\n' "$*"; failed=1; }
can_create() { ( : >"$1" ) 2>/dev/null && rm -f -- "$1"; }

if [ -r "$checkout/src/server.js" ]; then ok "the code can be read"; else bad "the code cannot be read"; fi
for place in "" /src /public /.git /infra/systemd; do
  if can_create "$checkout$place/.rippercraft-probe-$$"; then
    bad "$checkout$place can be written to"
  fi
done
[ "$failed" = 1 ] || ok "the checkout cannot be written to"
for place in data servers; do
  if can_create "$checkout/$place/.rippercraft-probe-$$"; then
    ok "$place/ can be written to"
  else
    bad "$place/ cannot be written to"
  fi
done

if [ "$home_hidden" = 1 ]; then
  extra=""
  for entry in "$home"/* "$home"/.[!.]* "$home"/..?*; do
    [ -e "$entry" ] || continue
    case "$checkout/" in "$entry"/*) continue ;; esac
    case "$node/" in "$entry"/*) continue ;; esac
    extra="$extra ${entry##*/}"
  done
  if [ -z "$extra" ]; then ok "the home directory is empty apart from the checkout and node"
  else bad "the home directory still shows:$extra"; fi
  if cp "$(type -P true)" "$home/.rippercraft-probe-run" 2>/dev/null && "$home/.rippercraft-probe-run" </dev/null; then
    ok "the home directory can be written to, and programs unpacked into it can be run"
  else
    bad "the home directory cannot be written to or run from, and Java libraries unpack into it"
  fi
  rm -f "$home/.rippercraft-probe-run"
fi
for place in /root /run/user; do
  if [ -n "$(ls -A "$place" 2>/dev/null)" ]; then bad "$place is not empty"; fi
done

for marker in "$tmp_marker" "$var_tmp_marker" "$shm_marker"; do
  [ -n "$marker" ] || continue
  place="${marker%/*}"
  if [ -e "$marker" ]; then bad "$place is the machine's own, not a private one"
  elif can_create "$place/.rippercraft-probe-$$"; then ok "$place is private and can be written to"
  else bad "$place cannot be written to"; fi
done
if cp "$(type -P true)" /tmp/.rippercraft-probe-run 2>/dev/null && /tmp/.rippercraft-probe-run </dev/null; then
  ok "programs unpacked into /tmp can be run"
else
  bad "programs in /tmp cannot be run, and Java libraries unpack there"
fi
rm -f /tmp/.rippercraft-probe-run

# The terminals the account is logged in on belong to it, and so could be read
# from and written to; and what the account's other programs leave behind when
# they crash is theirs to read as well.
if ls /dev/pts/ >/dev/null 2>&1; then bad "the machine's terminals can be reached through /dev/pts"
else ok "the machine's terminals cannot be reached"; fi
readable=""
for place in /var/log /run/log /var/crash /var/lib/systemd/coredump /var/lib/apport/coredump /run/screen; do
  if [ -e "$place" ] && ls "$place/" >/dev/null 2>&1; then readable="$readable $place"; fi
done
if [ -z "$readable" ]; then ok "logs, crash dumps and screen sessions cannot be read"
else bad "these can still be read:$readable"; fi

if [ "$outside_pid" != 0 ]; then
  # The process has to be there for its absence from /proc to mean anything.
  if ! kill -0 "$outside_pid" 2>/dev/null; then
    bad "the process this was to look for (pid $outside_pid) has gone, so it is not known whether the account's other processes can be seen"
  elif [ -e "/proc/$outside_pid" ] || ls "/proc/$outside_pid/root/" >/dev/null 2>&1; then
    bad "a process of this account outside the service (pid $outside_pid) can be seen, and through it the real home directory"
  else
    ok "the account's other processes cannot be seen"
  fi
fi
if grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status && grep -q '^Seccomp:[[:space:]]*2' /proc/self/status; then
  ok "no new privileges, and system calls are filtered"
else
  bad "privileges can be gained or system calls are not filtered"
fi

if "$node" --max-old-space-size=64 -e '
  const fs = require("fs"), net = require("net"), os = require("os");
  try { fs.readFileSync("/etc/resolv.conf"); } catch (error) {
    console.log("      note  /etc/resolv.conf cannot be read (" + error.code + "): names may not resolve");
  }
  os.networkInterfaces();
  const server = net.createServer();
  server.on("error", (error) => { console.error(error.message); process.exit(1); });
  server.listen(0, "127.0.0.1", () => server.close());' </dev/null 2>&1; then
  ok "node runs and can listen"
else
  bad "node does not run"
fi
for java in "$@"; do
  if "$java" -Xmx64m -version </dev/null >/dev/null 2>&1; then ok "$java runs"; else bad "$java does not run"; fi
done
if zip -v </dev/null >/dev/null 2>&1; then ok "zip runs"; else bad "zip does not run"; fi
exit "$failed"
PROBE
}

# Starts the unit's sandbox for a moment, under another name, and runs the
# probe in it. This is the real thing: systemd builds the same view of the
# machine it will build for the dashboard, and the probe looks at it from the
# inside. The unit that is running is not touched.
rehearse() {
  local unit_file="$1" properties=() line key tmp_marker var_tmp_marker shm_marker helper=0 status=0 with_group=0

  while IFS= read -r line; do
    key="${line%%=*}"
    case "$key" in
      Type | ExecStart | Restart | RestartSec | KillMode | KillSignal | TimeoutStopSec | OOMPolicy | EnvironmentFile) continue ;;
    esac
    properties+=(-p "$line")
  done < <(awk '/^\[Service\]/ { on = 1; next } /^\[/ { on = 0 } on && /^[A-Za-z]+=/' "$unit_file")

  # A file in the machine's own /tmp, /var/tmp and /dev/shm. The service must
  # not see any of them.
  tmp_marker="$(mktemp /tmp/rippercraft-rehearsal.XXXXXXXX)" || die "a file could not be made in /tmp."
  var_tmp_marker="$(mktemp /var/tmp/rippercraft-rehearsal.XXXXXXXX)" || die "a file could not be made in /var/tmp."
  shm_marker="$(mktemp /dev/shm/rippercraft-rehearsal.XXXXXXXX 2>/dev/null || true)"
  # A process of the same account that is not part of the service. The service
  # must not be able to see it. That can only be tested once the service has a
  # group of its own to run as.
  if grep -q "^Group=$SERVICE_GROUP\$" "$unit_file"; then
    with_group=1
    helper="$(as_owner sh -c 'sleep 300 >/dev/null 2>&1 & echo $!' 2>/dev/null || echo 0)"
    case "$helper" in
      "" | *[!0-9]*) helper=0 ;;
    esac
  fi

  # The probe goes in on standard input, not on the command line: systemd
  # replaces every ${...} it finds in a command's arguments before running it.
  # And from a file rather than a pipe, which the other end can close early.
  probe_script >"$WORK_DIR/probe"
  systemd-run --quiet --wait --collect --pipe --unit="rippercraft-rehearsal-$$" \
    -p RuntimeMaxSec=120 "${properties[@]}" \
    -- /bin/bash -s -- \
    "$CHECKOUT" "$OWNER_HOME_REAL" "$NODE_BIN" "$helper" "$HOME_IS_HIDDEN" "$tmp_marker" "$var_tmp_marker" "$shm_marker" \
    ${JAVA_BINS[@]+"${JAVA_BINS[@]}"} <"$WORK_DIR/probe" 2>&1 | while IFS= read -r line; do say "$line"; done ||
    status=$?

  rm -f "$tmp_marker" "$var_tmp_marker" ${shm_marker:+"$shm_marker"}
  if [ "$helper" != 0 ]; then
    kill "$helper" 2>/dev/null || true
  fi
  if [ "$with_group" = 0 ]; then
    note "not tried yet: whether the service can see the account's other processes."
    note "That needs the group $SERVICE_GROUP, which is created by the migration itself and tried then."
  fi
  return "$status"
}

# ---------------------------------------------------------------------------
# Asking the dashboard
# ---------------------------------------------------------------------------

# GET /api/bootstrap on the unit's port. Prints the status, then the
# Content-Security-Policy header if there is one.
ask_dashboard() {
  local unit="$1" host port headers status
  host="$(effective_setting "$unit" HOST "$UNIT_HOST")"
  port="$(effective_setting "$unit" PORT "$UNIT_PORT")"
  case "$host" in
    "" | 0.0.0.0 | :: | "[::]") host="127.0.0.1" ;;
    *:*) host="[$host]" ;;
  esac
  headers="$WORK_DIR/headers"
  : >"$headers"
  status="$(curl -sS --noproxy '*' -o /dev/null -D "$headers" -w '%{http_code}' --max-time 5 "http://$host:$port/api/bootstrap" 2>/dev/null || true)"
  printf '%s\n' "${status:-000}"
  sed -n 's/^[Cc]ontent-[Ss]ecurity-[Pp]olicy:[[:space:]]*//p' "$headers" | tr -d '\r' | head -n 1
}

# Waits for the unit to answer. With a second argument, the answer has to carry
# exactly that Content-Security-Policy: the old code sends none, so it is the
# new code answering.
wait_for_dashboard() {
  local unit="$1" want_csp="${2:-}" seconds="${3:-$HEALTH_SECONDS}" answer status csp waited=0 why="it did not answer"
  while [ "$waited" -lt "$seconds" ]; do
    answer="$(ask_dashboard "$unit")"
    status="$(printf '%s\n' "$answer" | sed -n 1p)"
    csp="$(printf '%s\n' "$answer" | sed -n 2p)"
    if [ "$status" = "200" ]; then
      if [ -z "$want_csp" ] || [ "$csp" = "$want_csp" ]; then
        return 0
      fi
      why="it answers, but without the Content-Security-Policy header the new code sends"
    else
      why="GET /api/bootstrap answered ${status}, not 200"
    fi
    if [ "$(unit_prop "$unit" ActiveState)" = "failed" ]; then
      why="$unit failed to start"
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  say "    $unit is not healthy: $why."
  return 1
}

# ---------------------------------------------------------------------------
# Changing things, and putting them back
# ---------------------------------------------------------------------------

install_as_root() {
  local mode="$1" from="$2" to="$3"
  if [ -n "$TESTROOT" ]; then
    install -m "$mode" "$from" "$to"
  else
    install -m "$mode" -o root -g root "$from" "$to"
  fi
}

make_backup() {
  local stamp name
  stamp="$(date +%Y%m%d-%H%M%S)"
  # Never an earlier run's folder: what is in it is that run's way back.
  while [ -e "$BACKUP_ROOT/$stamp" ]; do
    stamp="$stamp+"
  done
  BACKUP_DIR="$BACKUP_ROOT/$stamp"
  (
    umask 077
    mkdir -p "$BACKUP_DIR/data"
  )
  chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR" "$BACKUP_DIR/data"
  LOG_FILE="$BACKUP_DIR/migrate.log"
  # Every name in data/ that ends in .json, whatever it is: one that is not an
  # ordinary file, or has stopped being one since it was looked at, stops the
  # run here rather than being left out of the backup.
  while IFS= read -r name; do
    case "$name" in
      "" | *[!A-Za-z0-9._-]*) continue ;;
    esac
    (
      umask 077
      read_from_checkout "$CHECKOUT/data/$name" >"$BACKUP_DIR/data/$name"
    ) || die "data/$name could not be read as an ordinary file. Nothing else has been changed."
    read_from_checkout "$CHECKOUT/data/$name" | cmp -s - "$BACKUP_DIR/data/$name" ||
      die "the copy of data/$name does not match the original. Nothing else has been changed."
    note "data/$name"
  done < <(as_owner find "$CHECKOUT/data" -maxdepth 1 -name '*.json' -printf '%f\n' 2>/dev/null | sort)
  if [ -f "$UNIT_DIR/$NEW_UNIT" ]; then
    cp -p "$UNIT_DIR/$NEW_UNIT" "$BACKUP_DIR/previous-$NEW_UNIT"
  fi
  write_state "started"
}

# What --rollback needs to know later.
write_state() {
  (
    umask 077
    cat >"$BACKUP_DIR/state" <<STATE
STATE_PHASE=$1
STATE_CHECKOUT=$CHECKOUT
STATE_PREVIOUS_COMMIT=$HEAD_SHA
STATE_TARGET_COMMIT=$TARGET_SHA
STATE_SOURCE_UNIT=$SOURCE_UNIT
STATE_SOURCE_WAS_ENABLED=$SOURCE_WAS_ENABLED
STATE_HAD_UNIT_BEFORE=$HAD_UNIT_BEFORE
STATE_COPIED_ENV=$DID_COPY_ENV
STATE_HOST=$UNIT_HOST
STATE_PORT=$UNIT_PORT
STATE
  )
}

restore_data() {
  local file name failed=0
  for file in "$BACKUP_DIR"/data/*.json; do
    [ -f "$file" ] || continue
    name="$(basename "$file")"
    if write_into_data "$name" <"$file"; then
      note "put back data/$name"
    else
      note "COULD NOT put back data/$name: copy it by hand from $file"
      failed=1
    fi
  done
  return "$failed"
}

# Makes sure stopping a unit signals only its main process.
keep_game_servers_on_stop() {
  local unit="$1" directory="$UNIT_DIR/$1.d"
  if [ "$(unit_prop "$unit" KillMode)" = "process" ]; then
    note "$unit already signals only the dashboard when stopped"
    return 0
  fi
  mkdir -p "$directory"
  chmod 755 "$directory"
  cat >"$directory/10-keep-game-servers.conf" <<'DROPIN'
# Written by migrate-to-rippercraft.sh. Stopping this unit signals only the
# dashboard, so the Minecraft servers it started keep running. Leave it here
# for as long as the unit is installed: going back to this unit relies on it.
[Service]
KillMode=process
DROPIN
  chmod 644 "$directory/10-keep-game-servers.conf"
  quietly systemctl daemon-reload || true
  if [ "$(unit_prop "$unit" KillMode)" = "process" ]; then
    DID_DROPIN="$directory/10-keep-game-servers.conf"
    return 0
  fi
  # It did not take. Nothing is left behind that looks as if it had.
  rm -f "$directory/10-keep-game-servers.conf"
  rmdir "$directory" 2>/dev/null || true
  quietly systemctl daemon-reload || true
  return 1
}

# Undoes whatever has been changed, newest first, and starts what was running
# before. Used when a step fails, when the script is interrupted, and by
# --rollback. Returns 1 if the dashboard may have been left stopped.
undo_changes() {
  local dashboard_down=0 not_all_back=0 line
  set +e
  # Not to be stopped half-way, by Ctrl-C or by anything else.
  trap - EXIT
  trap '' INT TERM HUP PIPE
  PHASE="putting-back"

  # Whether a unit starts with the machine goes back to what it was, too. The
  # new unit is only disabled if it was not the one running, enabled, before;
  # and that while its file is still there to be disabled.
  if [ "$DID_ENABLE_NEW" = 1 ] && { [ "$SOURCE_UNIT" != "$NEW_UNIT" ] || [ "$SOURCE_WAS_ENABLED" = 0 ]; }; then
    systemctl disable "$NEW_UNIT" >/dev/null 2>&1
  fi
  if [ "$DID_START_NEW" = 1 ]; then
    if [ "$MODE" != "rollback" ]; then
      say "    the last lines $NEW_UNIT logged:"
      journalctl -u "$NEW_UNIT" -n 15 --no-pager 2>/dev/null | while IFS= read -r line; do say "      $line"; done
    fi
    quietly systemctl stop "$NEW_UNIT"
    if unit_is_up "$NEW_UNIT"; then
      note "COULD NOT stop $NEW_UNIT"
      not_all_back=1
    else
      note "stopped $NEW_UNIT"
    fi
  fi

  if [ "$DID_INSTALL_UNIT" = 1 ]; then
    if [ "$HAD_UNIT_BEFORE" = 1 ] && [ -f "$BACKUP_DIR/previous-$NEW_UNIT" ]; then
      install_as_root 0644 "$BACKUP_DIR/previous-$NEW_UNIT" "$UNIT_DIR/$NEW_UNIT"
      note "put back the earlier $UNIT_DIR/$NEW_UNIT"
    else
      rm -f "$UNIT_DIR/$NEW_UNIT"
      note "removed $UNIT_DIR/$NEW_UNIT"
    fi
  fi
  # Not deleted: it may have been edited since it was copied.
  if [ "$DID_COPY_ENV" = 1 ] && [ -e "$NEW_ENV_FILE" ]; then
    if mv -f "$NEW_ENV_FILE" "$BACKUP_DIR/rippercraft.env.removed"; then
      note "moved $NEW_ENV_FILE to $BACKUP_DIR/rippercraft.env.removed"
    else
      note "COULD NOT move $NEW_ENV_FILE out of the way"
      not_all_back=1
    fi
  fi
  if [ "$DID_INSTALL_UNIT" = 1 ] || [ "$DID_COPY_ENV" = 1 ]; then
    quietly systemctl daemon-reload
  fi

  if [ "$DID_FAST_FORWARD" = 1 ]; then
    if quietly owner_git reset --quiet --keep "$HEAD_SHA" || quietly owner_git reset --quiet --hard "$HEAD_SHA"; then
      note "checkout back at $(short "$HEAD_SHA")"
    else
      note "COULD NOT move the checkout back to $HEAD_SHA. Do it by hand: git reset --hard $HEAD_SHA"
      not_all_back=1
    fi
  fi

  # The new code stores a password again the first time its owner signs in, in
  # a form the old code cannot read. If the new code ran at all, the files as
  # they were go back.
  if [ "$DID_START_NEW" = 1 ] && [ -n "$BACKUP_DIR" ]; then
    restore_data || not_all_back=1
  fi

  if [ "$DID_STOP_SOURCE" = 1 ] && [ -n "$SOURCE_UNIT" ]; then
    if quietly systemctl start "$SOURCE_UNIT" && wait_for_dashboard "$SOURCE_UNIT"; then
      note "$SOURCE_UNIT is running again and answers"
    else
      note "COULD NOT bring $SOURCE_UNIT back"
      dashboard_down=1
    fi
  fi
  if [ -n "$SOURCE_UNIT" ] && [ "$SOURCE_WAS_ENABLED" = 1 ] && ! unit_is_enabled "$SOURCE_UNIT"; then
    if systemctl enable "$SOURCE_UNIT" >/dev/null 2>&1; then
      note "$SOURCE_UNIT is enabled again"
    else
      note "COULD NOT enable $SOURCE_UNIT. It is running, but will not start with the machine: sudo systemctl enable $SOURCE_UNIT"
    fi
  fi

  if ! game_servers_alive; then
    say "    A game server that was running before is not running now. Its log is in the dashboard."
  fi
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
  if [ "$dashboard_down" = 1 ]; then
    return 1
  fi
  if [ "$not_all_back" = 1 ]; then
    return 2
  fi
  return 0
}

# Says how going back fell short, and ends the script. The first argument is
# what undo_changes returned.
end_after_incomplete_undo() {
  say ""
  if [ "$1" = 1 ]; then
    say "THE DASHBOARD IS DOWN. Going back did not work all the way; what failed is above."
    if [ -n "$SOURCE_UNIT" ]; then
      say "Look at:   systemctl status $SOURCE_UNIT"
      say "           journalctl -u $SOURCE_UNIT -n 50"
      say "Start it:  sudo systemctl start $SOURCE_UNIT"
    fi
  else
    say "GOING BACK DID NOT WORK ALL THE WAY. ${SOURCE_UNIT:-Nothing} is serving the dashboard, but"
    say "not everything is as it was: each thing that is not is marked COULD NOT above."
  fi
  [ -z "$BACKUP_DIR" ] || say "The data as it was before is in $BACKUP_DIR/data, and the log of this run beside it."
  exit 3
}

# A step failed. Everything goes back, and the script ends here.
put_back() {
  local reason="$1" outcome=0
  step "Going back: $reason"
  undo_changes || outcome=$?
  [ "$outcome" = 0 ] || end_after_incomplete_undo "$outcome"
  say ""
  if [ "$DID_STOP_SOURCE" = 1 ]; then
    say "The migration did not go through, and everything is back as it was:"
    say "$SOURCE_UNIT is serving the dashboard at commit $(short "$HEAD_SHA")."
  elif [ -n "$SOURCE_UNIT" ]; then
    say "The migration did not go through. The running dashboard was never stopped,"
    say "and the checkout and the installed units are as they were."
  else
    say "The install did not go through. What it had put in place has been taken out again."
  fi
  [ -z "$DID_DROPIN" ] || say "Left in place, and harmless: $DID_DROPIN"
  [ "$DID_GROUP" = 0 ] || say "Left in place, and harmless: the group $SERVICE_GROUP"
  say "Why: $reason"
  [ -z "$LOG_FILE" ] || say "The log of this run: $LOG_FILE"
  exit 2
}

# If the script ends in the middle for any reason - an error nobody foresaw,
# Ctrl-C - the dashboard is not left stopped.
on_exit() {
  local status=$?
  if [ "$PHASE" = "changing" ]; then
    put_back "the script ended unexpectedly (status $status)"
  fi
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
  exit "$status"
}

on_signal() {
  if [ "$PHASE" = "changing" ]; then
    put_back "interrupted"
  fi
  exit 130
}

# ---------------------------------------------------------------------------
# The three things this script does
# ---------------------------------------------------------------------------

preflight() {
  step "Looking"
  find_checkout
  decide_home
  read_git_state
  require_matching_script
  read_units
  check_settings

  note "checkout:      $CHECKOUT (owner $OWNER)"
  if [ "$HEAD_SHA" = "$TARGET_SHA" ]; then
    note "commit:        $(short "$HEAD_SHA"), already the one asked for"
  else
    note "commit:        $(short "$HEAD_SHA") now, $(short "$TARGET_SHA") asked for (a fast-forward)"
  fi
  note "serving now:   ${SOURCE_UNIT:-nothing}"
  note "runs as:       $OWNER, group $SERVICE_GROUP$([ "$GROUP_EXISTS" = 1 ] || printf ' (to be created)')"
  note "node:          $NODE_BIN"
  note "listens on:    $UNIT_HOST port $UNIT_PORT"
  note "private /tmp:  PrivateTmp=$PRIVATE_TMP"
  if [ "$HOME_IS_HIDDEN" = 0 ]; then
    note "note: $OWNER's home directory is the checkout itself or inside it, so it is not replaced by an empty one."
  fi

  check_programs
  check_folders
  check_links
  check_data_files
  check_groups
  find_game_servers
  describe_game_servers
  [ "$PROBLEMS" = 0 ] || die "$PROBLEMS problem(s) above have to be dealt with first. Nothing has been changed."

  prepare_unit
  note "unit:          filled in for this machine; systemd accepts it"

  # The check that will judge the new dashboard has to pass for the one that is
  # running now. If it cannot be asked, a migration that worked could not be
  # told from one that did not, and neither could going back.
  if [ -n "$SOURCE_UNIT" ]; then
    wait_for_dashboard "$SOURCE_UNIT" "" 5 ||
      die "$SOURCE_UNIT is running, but the dashboard does not answer GET /api/bootstrap on port $(effective_setting "$SOURCE_UNIT" PORT "$UNIT_PORT") with 200. Nothing has been changed."
    note "answers now:   yes, on port $(effective_setting "$SOURCE_UNIT" PORT "$UNIT_PORT")"
  fi

  # A checkout that has never been run has no data/ or servers/ yet. The
  # dashboard would make them, but not from inside a sandbox that is only
  # allowed to write to those two folders.
  if ! as_owner test -d "$CHECKOUT/data" || ! as_owner test -d "$CHECKOUT/servers"; then
    if [ "$MODE" = "check" ]; then
      FOLDERS_MISSING=1
      note "note: data/ and servers/ do not exist yet. They are made first, and the sandbox is tried out then."
      return 0
    fi
    as_owner mkdir -p "$CHECKOUT/data" "$CHECKOUT/servers" || die "data/ and servers/ could not be made in the checkout."
    note "made data/ and servers/ in the checkout"
  fi

  step "Trying the sandbox out"
  if [ "$GROUP_EXISTS" = 0 ]; then
    note "(as group $OWNER_GROUP for now: $SERVICE_GROUP does not exist yet)"
  fi
  rehearse "$RENDERED_FOR_REHEARSAL" ||
    die "the sandbox does not behave as it should on this machine (above). Nothing has been changed."
}

# True when there is nothing left to do.
already_in_place() {
  [ "$SOURCE_UNIT" = "$NEW_UNIT" ] && [ "$HEAD_SHA" = "$TARGET_SHA" ] && [ "$GROUP_EXISTS" = 1 ] &&
    [ -f "$UNIT_DIR/$NEW_UNIT" ] && cmp -s "$RENDERED" "$UNIT_DIR/$NEW_UNIT" &&
    ! { unit_exists "$OLD_UNIT" && unit_is_up "$OLD_UNIT"; }
}

report_in_place() {
  step "Already in place"
  EXPECTED_CSP="$(expected_csp)"
  if wait_for_dashboard "$NEW_UNIT" "$EXPECTED_CSP"; then
    note "$NEW_UNIT answers on port $(effective_setting "$NEW_UNIT" PORT "$UNIT_PORT") with the new code"
  else
    die "$NEW_UNIT is installed and current, but does not answer as it should. Look at: journalctl -u $NEW_UNIT -n 50"
  fi
  if unit_is_enabled "$NEW_UNIT"; then
    note "$NEW_UNIT is enabled: it starts with the machine"
  else
    note "note: $NEW_UNIT is not enabled. To have it start with the machine: sudo systemctl enable $NEW_UNIT"
  fi
  if unit_exists "$OLD_UNIT" && unit_is_enabled "$OLD_UNIT"; then
    note "note: $OLD_UNIT is still enabled. Disable it: sudo systemctl disable $OLD_UNIT"
  fi
  say ""
  say "Nothing to do: the dashboard runs sandboxed as $NEW_UNIT at commit $(short "$HEAD_SHA")."
}

# The policy the code in the checkout sends, read from the code itself.
expected_csp() {
  # shellcheck disable=SC2016
  as_owner "$NODE_BIN" -e 'process.stdout.write(String(require(process.argv[1]).CONTENT_SECURITY_POLICY || ""))' \
    "$CHECKOUT/src/lib/http.js" 2>/dev/null || true
}

print_plan() {
  local n=1
  step "What would be done"
  if [ "$FOLDERS_MISSING" = 1 ]; then
    note "$n. make data/ and servers/ in the checkout, and try the sandbox out" && n=$((n + 1))
  fi
  note "$n. copy data/*.json to a new folder under $BACKUP_ROOT (root only)" && n=$((n + 1))
  if [ -n "$SOURCE_UNIT" ] && [ "$(unit_prop "$SOURCE_UNIT" KillMode)" != "process" ]; then
    note "$n. add a KillMode=process drop-in to $SOURCE_UNIT, so that stopping it leaves game servers running" && n=$((n + 1))
  fi
  if [ "$GROUP_EXISTS" = 0 ]; then
    note "$n. create the group $SERVICE_GROUP, and try the sandbox out again with it" && n=$((n + 1))
  fi
  if [ "$HEAD_SHA" != "$TARGET_SHA" ]; then
    note "$n. fast-forward the checkout from $(short "$HEAD_SHA") to $(short "$TARGET_SHA")" && n=$((n + 1))
  fi
  note "$n. install $UNIT_DIR/$NEW_UNIT" && n=$((n + 1))
  if [ -f "$OLD_ENV_FILE" ] && [ ! -e "$NEW_ENV_FILE" ]; then
    note "$n. copy $OLD_ENV_FILE to $NEW_ENV_FILE" && n=$((n + 1))
  fi
  if [ -n "$SOURCE_UNIT" ]; then
    note "$n. stop $SOURCE_UNIT and start $NEW_UNIT (the dashboard is away for up to a minute)" && n=$((n + 1))
  else
    note "$n. start $NEW_UNIT" && n=$((n + 1))
  fi
  note "$n. check that it answers with the new code and that every game server is still running" && n=$((n + 1))
  note "$n. enable $NEW_UNIT$([ "$SOURCE_UNIT" = "$OLD_UNIT" ] && printf ' and disable %s' "$OLD_UNIT")"
  if [ -n "$SOURCE_UNIT" ]; then
    note "If a check fails after the stop, all of it is undone and $SOURCE_UNIT is started again."
  else
    note "If a check fails, all of it is undone."
  fi
}

migrate() {
  local step_failed=""

  step "Backing up data/*.json"
  if [ -f "$UNIT_DIR/$NEW_UNIT" ]; then
    HAD_UNIT_BEFORE=1
  fi
  make_backup
  note "in $BACKUP_DIR"

  # From here on, ending for any reason puts back what has been changed.
  PHASE="changing"
  trap on_exit EXIT
  trap on_signal INT TERM
  trap '' HUP PIPE

  if [ -n "$SOURCE_UNIT" ]; then
    step "Making sure stopping $SOURCE_UNIT leaves game servers running"
    keep_game_servers_on_stop "$SOURCE_UNIT" ||
      put_back "$SOURCE_UNIT would still stop its game servers when stopped (KillMode=$(unit_prop "$SOURCE_UNIT" KillMode))"
    [ -z "$DID_DROPIN" ] || note "wrote $DID_DROPIN"
  fi

  if [ "$GROUP_EXISTS" = 0 ]; then
    step "Creating the group $SERVICE_GROUP"
    quietly groupadd --system "$SERVICE_GROUP" || put_back "the group $SERVICE_GROUP could not be created"
    DID_GROUP=1
    GROUP_EXISTS=1
    step "Trying the sandbox out as group $SERVICE_GROUP"
    rehearse "$RENDERED" || put_back "the sandbox does not behave as it should with group $SERVICE_GROUP"
  fi

  if [ "$HEAD_SHA" != "$TARGET_SHA" ]; then
    step "Fast-forwarding the checkout to $(short "$TARGET_SHA")"
    quietly owner_git merge --quiet --ff-only "$TARGET_SHA" || put_back "git could not fast-forward the checkout"
    DID_FAST_FORWARD=1
    note "was at $(short "$HEAD_SHA")"
  fi
  EXPECTED_CSP="$(expected_csp)"
  [ -n "$EXPECTED_CSP" ] || put_back "the code at $(short "$TARGET_SHA") names no Content-Security-Policy to check for"

  step "Installing $NEW_UNIT"
  DID_INSTALL_UNIT=1
  quietly install_as_root 0644 "$RENDERED" "$UNIT_DIR/$NEW_UNIT" || put_back "the unit could not be written to $UNIT_DIR"
  if [ -f "$OLD_ENV_FILE" ] && [ ! -e "$NEW_ENV_FILE" ]; then
    DID_COPY_ENV=1
    quietly install_as_root 0600 "$OLD_ENV_FILE" "$NEW_ENV_FILE" || put_back "$OLD_ENV_FILE could not be copied to $NEW_ENV_FILE"
    note "copied $OLD_ENV_FILE to $NEW_ENV_FILE"
  fi
  quietly systemctl daemon-reload || put_back "systemd could not reload its units"
  write_state "installed"

  # The list from the start is old by now: someone may have started a server.
  find_game_servers

  if [ -n "$SOURCE_UNIT" ]; then
    step "Stopping $SOURCE_UNIT"
    note "(this can take half a minute: the dashboard is given time to finish what it is doing)"
    if [ "$(unit_prop "$SOURCE_UNIT" KillMode)" != "process" ]; then
      put_back "$SOURCE_UNIT no longer has KillMode=process"
    fi
    DID_STOP_SOURCE=1
    quietly systemctl stop "$SOURCE_UNIT" || step_failed="$SOURCE_UNIT could not be stopped"
    if [ -z "$step_failed" ] && unit_is_up "$SOURCE_UNIT"; then
      step_failed="$SOURCE_UNIT is still running after being stopped"
    fi
    [ -z "$step_failed" ] || put_back "$step_failed"
  fi

  step "Starting $NEW_UNIT"
  DID_START_NEW=1
  quietly systemctl start "$NEW_UNIT" || put_back "$NEW_UNIT could not be started"

  step "Checking"
  wait_for_dashboard "$NEW_UNIT" "$EXPECTED_CSP" || put_back "the new dashboard did not pass its check"
  note "GET /api/bootstrap answers 200, with the new code's Content-Security-Policy"
  game_servers_alive || put_back "a game server that was running is not running any more"
  if [ ${#GAME_SERVERS[@]} -gt 0 ]; then
    note "every game server that was running still is: ${#GAME_SERVERS[@]} of ${#GAME_SERVERS[@]}"
  fi

  step "Enabling $NEW_UNIT"
  systemctl enable "$NEW_UNIT" >/dev/null 2>&1 || put_back "$NEW_UNIT could not be enabled"
  DID_ENABLE_NEW=1
  if [ "$SOURCE_UNIT" = "$OLD_UNIT" ] || { unit_exists "$OLD_UNIT" && unit_is_enabled "$OLD_UNIT"; }; then
    systemctl disable "$OLD_UNIT" >/dev/null 2>&1 || put_back "$OLD_UNIT could not be disabled"
    note "disabled $OLD_UNIT"
  fi

  PHASE="done"
  trap - EXIT INT TERM HUP PIPE
  write_state "done"
  # What --rollback undoes: the last migration that went through.
  ln -sfn "$(basename "$BACKUP_DIR")" "$BACKUP_ROOT/latest"
  summary
  rm -rf "$WORK_DIR"
}

summary() {
  local self="$CHECKOUT/$SCRIPT_PATH_IN_REPO"
  find_game_servers
  say ""
  say "Done. The dashboard runs sandboxed as $NEW_UNIT."
  say ""
  say "What changed"
  if [ "$DID_FAST_FORWARD" = 1 ]; then
    say "  - the checkout moved from $(short "$HEAD_SHA") to $(short "$TARGET_SHA")"
  fi
  say "  - $UNIT_DIR/$NEW_UNIT is installed, enabled and running"
  if [ "$DID_GROUP" = 1 ]; then
    say "  - the group $SERVICE_GROUP was created; the service runs as $OWNER in that group"
  fi
  if [ "$DID_COPY_ENV" = 1 ]; then
    say "  - $OLD_ENV_FILE was copied to $NEW_ENV_FILE, which is the file the new unit reads"
  fi
  if [ "$SOURCE_UNIT" = "$OLD_UNIT" ]; then
    say "  - $OLD_UNIT is stopped and disabled. It is still installed, with a drop-in"
    say "    that makes stopping it safe, so that going back stays possible."
  fi
  say ""
  say "Backup"
  say "  - $BACKUP_DIR"
  say "    data/*.json as they were, and this run's log. Root only."
  say ""
  say "Game servers"
  describe_game_servers
  say ""
  say "To go back"
  say "    sudo $self --rollback"
  say "  stops $NEW_UNIT, puts the checkout back at $(short "$HEAD_SHA"), puts back the data/*.json"
  say "  files from the backup and starts ${SOURCE_UNIT:-nothing}. Game servers keep running."
  say "  Accounts and server settings changed after this moment are lost by going back:"
  say "  the older code cannot read passwords once the newer code has stored them again."
  say "  The same by hand:"
  say "    sudo systemctl stop $NEW_UNIT"
  if [ "$DID_FAST_FORWARD" = 1 ]; then
    say "    sudo -u $OWNER git -C $CHECKOUT reset --keep $(short "$HEAD_SHA")"
  fi
  say "    sudo sh -c 'cd $BACKUP_DIR/data && for f in *.json; do install -m 600 -o $OWNER -g $OWNER_GID \$f $CHECKOUT/.put-back-\$f && mv -fT $CHECKOUT/.put-back-\$f $CHECKOUT/data/\$f; done'"
  if [ "$HAD_UNIT_BEFORE" = 1 ]; then
    say "    sudo cp $BACKUP_DIR/previous-$NEW_UNIT $UNIT_DIR/$NEW_UNIT && sudo systemctl daemon-reload"
  else
    say "    sudo systemctl disable $NEW_UNIT && sudo rm $UNIT_DIR/$NEW_UNIT && sudo systemctl daemon-reload"
  fi
  if [ "$SOURCE_UNIT" = "$OLD_UNIT" ] && [ "$SOURCE_WAS_ENABLED" = 1 ]; then
    say "    sudo systemctl enable --now $OLD_UNIT"
  elif [ -n "$SOURCE_UNIT" ]; then
    say "    sudo systemctl start $SOURCE_UNIT"
  fi
  say ""
  say "Next"
  say "  - Restart each game server from the dashboard, one at a time, when its players"
  say "    can spare a minute. A server that was already running keeps running outside"
  say "    the sandbox until it has been restarted."
  say "  - Everyone has been signed out. Passwords still work whatever their length, but"
  say "    a new one needs 12 characters: ask every admin with a shorter one to change it."
  say "  - The log: journalctl -u ${NEW_UNIT%.service} -n 40"
  if [ "$SOURCE_UNIT" = "$OLD_UNIT" ]; then
    say "  - When you are sure you will not go back:"
    say "      sudo rm -r $UNIT_DIR/$OLD_UNIT $UNIT_DIR/$OLD_UNIT.d && sudo systemctl daemon-reload"
  fi
}

# Undoes the last migration from what it recorded.
rollback() {
  local state STATE_PHASE="" STATE_CHECKOUT="" STATE_PREVIOUS_COMMIT="" STATE_TARGET_COMMIT=""
  local STATE_SOURCE_UNIT="" STATE_SOURCE_WAS_ENABLED=0 STATE_HAD_UNIT_BEFORE=0 STATE_COPIED_ENV=0
  local STATE_HOST="" STATE_PORT="" key value current outcome=0

  step "Looking"
  [ -d "$BACKUP_ROOT/latest/data" ] || die "no migration that went through is on record under $BACKUP_ROOT."
  BACKUP_DIR="$(cd "$BACKUP_ROOT/latest" && pwd -P)"
  state="$BACKUP_DIR/state"
  [ -f "$state" ] || die "$BACKUP_DIR has no record of what was done."
  while IFS='=' read -r key value; do
    case "$key" in
      STATE_PHASE) STATE_PHASE="$value" ;;
      STATE_CHECKOUT) STATE_CHECKOUT="$value" ;;
      STATE_PREVIOUS_COMMIT) STATE_PREVIOUS_COMMIT="$value" ;;
      STATE_TARGET_COMMIT) STATE_TARGET_COMMIT="$value" ;;
      STATE_SOURCE_UNIT) STATE_SOURCE_UNIT="$value" ;;
      STATE_SOURCE_WAS_ENABLED) STATE_SOURCE_WAS_ENABLED="$value" ;;
      STATE_HAD_UNIT_BEFORE) STATE_HAD_UNIT_BEFORE="$value" ;;
      STATE_COPIED_ENV) STATE_COPIED_ENV="$value" ;;
      STATE_HOST) STATE_HOST="$value" ;;
      STATE_PORT) STATE_PORT="$value" ;;
    esac
  done <"$state"
  case "$STATE_PHASE" in
    done) ;;
    rolled-back) die "the migration recorded in $BACKUP_DIR has been undone already." ;;
    *) die "the migration recorded in $BACKUP_DIR did not go through, and undid itself at the time. There is nothing of it left to undo." ;;
  esac

  OPT_CHECKOUT="${OPT_CHECKOUT:-$STATE_CHECKOUT}"
  find_checkout
  [ "$CHECKOUT" = "$STATE_CHECKOUT" ] || die "the record in $BACKUP_DIR is for $STATE_CHECKOUT, not $CHECKOUT."
  decide_home
  current="$(owner_git rev-parse --verify --quiet 'HEAD^{commit}')" || die "git could not read the checkout as $OWNER."
  [ "$current" = "$STATE_TARGET_COMMIT" ] ||
    die "the checkout is at $(short "$current"), not at $(short "$STATE_TARGET_COMMIT") where the migration left it. Going back from here is not something this script can judge."
  [ -z "$(owner_git status --porcelain --untracked-files=no)" ] || die "the checkout has changes that are not committed."
  if [ -n "$STATE_SOURCE_UNIT" ] && [ "$STATE_SOURCE_UNIT" != "$NEW_UNIT" ] && unit_is_up "$STATE_SOURCE_UNIT"; then
    die "$STATE_SOURCE_UNIT is already running. There is nothing to go back to that is not there already."
  fi
  if [ -n "$STATE_SOURCE_UNIT" ]; then
    unit_exists "$STATE_SOURCE_UNIT" || die "$STATE_SOURCE_UNIT is no longer installed, so there is nothing to go back to."
  fi

  HEAD_SHA="$STATE_PREVIOUS_COMMIT"
  TARGET_SHA="$STATE_TARGET_COMMIT"
  SOURCE_UNIT="$STATE_SOURCE_UNIT"
  SOURCE_WAS_ENABLED="$STATE_SOURCE_WAS_ENABLED"
  HAD_UNIT_BEFORE="$STATE_HAD_UNIT_BEFORE"
  UNIT_HOST="$STATE_HOST"
  UNIT_PORT="$STATE_PORT"
  WORK_DIR="$(mktemp -d)"
  LOG_FILE="$BACKUP_DIR/rollback.log"

  note "the migration of $(basename "$BACKUP_DIR"): $(short "$HEAD_SHA") to $(short "$TARGET_SHA"), from ${SOURCE_UNIT:-nothing}"
  find_game_servers
  describe_game_servers

  # The data as it is now is kept too, so that going back can itself be undone.
  step "Keeping the data as it is now"
  (
    umask 077
    mkdir -p "$BACKUP_DIR/data-before-rollback"
  )
  while IFS= read -r key; do
    case "$key" in
      "" | *[!A-Za-z0-9._-]*) continue ;;
    esac
    (
      umask 077
      read_from_checkout "$CHECKOUT/data/$key" >"$BACKUP_DIR/data-before-rollback/$key"
    ) || note "note: data/$key could not be read as an ordinary file, and is not kept."
  done < <(as_owner find "$CHECKOUT/data" -maxdepth 1 -type f -name '*.json' -printf '%f\n' 2>/dev/null | sort)
  note "in $BACKUP_DIR/data-before-rollback"

  if [ -n "$SOURCE_UNIT" ]; then
    step "Making sure $SOURCE_UNIT will leave game servers running when stopped"
    keep_game_servers_on_stop "$SOURCE_UNIT" || die "$SOURCE_UNIT would stop its game servers when stopped. Nothing has been changed."
  fi
  if unit_is_up "$NEW_UNIT" && [ "$(unit_prop "$NEW_UNIT" KillMode)" != "process" ]; then
    die "$NEW_UNIT does not have KillMode=process: stopping it would stop the game servers. Nothing has been changed."
  fi

  # Everything the migration did counts as done, and undo_changes undoes it.
  if [ "$HEAD_SHA" != "$TARGET_SHA" ]; then
    DID_FAST_FORWARD=1
  fi
  DID_INSTALL_UNIT=1
  DID_COPY_ENV="$STATE_COPIED_ENV"
  DID_START_NEW=1
  DID_ENABLE_NEW=1
  if [ -n "$SOURCE_UNIT" ]; then
    DID_STOP_SOURCE=1
  fi
  PHASE="changing"
  trap on_exit EXIT
  trap on_signal INT TERM
  trap '' HUP PIPE
  step "Going back"
  undo_changes || outcome=$?
  [ "$outcome" = 0 ] || end_after_incomplete_undo "$outcome"
  sed -i 's/^STATE_PHASE=.*/STATE_PHASE=rolled-back/' "$state"
  say ""
  say "Done. ${SOURCE_UNIT:-Nothing} serves the dashboard again, at commit $(short "$HEAD_SHA")."
  say "The data as it was just before going back is in $BACKUP_DIR/data-before-rollback."
  if [ "$HAD_UNIT_BEFORE" = 1 ]; then
    say "$UNIT_DIR/$NEW_UNIT is the one from before again."
  else
    say "$UNIT_DIR/$NEW_UNIT is gone."
  fi
  say "The group $SERVICE_GROUP and the backup are left where they are."
}

remove_work_dir() {
  [ -z "$WORK_DIR" ] || rm -rf "$WORK_DIR"
}

main() {
  parse_arguments "$@"
  require_root
  require_tools
  trap remove_work_dir EXIT
  if [ "$MODE" = "rollback" ]; then
    rollback
    return 0
  fi

  preflight
  if already_in_place; then
    report_in_place
    rm -rf "$WORK_DIR"
    return 0
  fi
  if [ "$MODE" = "check" ]; then
    print_plan
    rm -rf "$WORK_DIR"
    say ""
    say "Nothing has been changed. Run it again without --check to do this."
    return 0
  fi
  migrate
}

main "$@"
