#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: d1-migrate.sh [options] <database-name> [migrations-dir]

Applies the SQL files in <migrations-dir> to a D1 database, tracking what has
already run in a _schema_migrations ledger keyed on each file's numeric prefix.

Options:
  --remote                 Target the Cloudflare-hosted database (default).
  --local                  Target the local Miniflare database used by
                           `wrangler dev --local`.
  --config <path>          wrangler config that declares the D1 binding. Local
                           state lives next to this file, so it also decides
                           which .wrangler/state directory is written.
                           Default with --local: packages/control-plane/wrangler.jsonc
  --persist-to <dir>       Override the local state directory (local only).
  --adopt                  Record every pending migration in the ledger WITHOUT
                           executing it. For a database whose schema was already
                           brought to head by hand and has no ledger rows.
  --adopt-through <ver>    Adopt only migrations up to and including <ver> (e.g.
                           0043), then apply everything after it normally.
  --yes                    Skip the confirmation prompt when adopting remotely.
  -h, --help               Show this message.

Examples:
  d1-migrate.sh openoutposts-production terraform/d1/migrations
  d1-migrate.sh --local openoutposts-test
  d1-migrate.sh --local --adopt openoutposts-test
USAGE
}

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TARGET="remote"
CONFIG_PATH=""
PERSIST_TO=""
ADOPT_THROUGH=""
ASSUME_YES=0
POSITIONAL=()

while [ $# -gt 0 ]; do
  case "$1" in
    --local)
      TARGET="local"
      shift
      ;;
    --remote)
      TARGET="remote"
      shift
      ;;
    --config)
      CONFIG_PATH="${2:?--config needs a path}"
      shift 2
      ;;
    --persist-to)
      PERSIST_TO="${2:?--persist-to needs a directory}"
      shift 2
      ;;
    --adopt)
      # Sentinel: resolved to the highest migration version once the directory
      # has been scanned.
      ADOPT_THROUGH="all"
      shift
      ;;
    --adopt-through)
      ADOPT_THROUGH="${2:?--adopt-through needs a migration version}"
      shift 2
      ;;
    --yes)
      ASSUME_YES=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      echo "ERROR: unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
    *)
      POSITIONAL+=("$1")
      shift
      ;;
  esac
done

set -- "${POSITIONAL[@]+"${POSITIONAL[@]}"}"

DATABASE_NAME="${1:?Usage: d1-migrate.sh [options] <database-name> [migrations-dir]}"
MIGRATIONS_DIR="${2:-$REPO_ROOT/terraform/d1/migrations}"

if [ "$TARGET" = "local" ] && [ -z "$CONFIG_PATH" ]; then
  # The local database only exists relative to a wrangler config, so default to
  # the control plane's — that is the binding the product actually reads.
  CONFIG_PATH="$REPO_ROOT/packages/control-plane/wrangler.jsonc"
fi

if [ -n "$CONFIG_PATH" ] && [ ! -f "$CONFIG_PATH" ]; then
  echo "ERROR: wrangler config not found: $CONFIG_PATH" >&2
  exit 1
fi

if [ -n "$PERSIST_TO" ] && [ "$TARGET" != "local" ]; then
  echo "ERROR: --persist-to only applies to --local runs." >&2
  exit 1
fi

# Every wrangler d1 call shares these, so --local and --remote runs differ in
# nothing but the target flag and therefore keep identical ledger semantics.
WRANGLER_ARGS=("--$TARGET")
if [ -n "$CONFIG_PATH" ]; then
  WRANGLER_ARGS+=("--config" "$CONFIG_PATH")
fi
if [ -n "$PERSIST_TO" ]; then
  WRANGLER_ARGS+=("--persist-to" "$PERSIST_TO")
fi

d1_execute() {
  npx wrangler d1 execute "$DATABASE_NAME" "${WRANGLER_ARGS[@]}" "$@"
}

# 0. Validate filenames and guard against duplicate version numbers. Migrations
# are deduped by their numeric prefix (the _schema_migrations version), so two
# files sharing a prefix mean one is silently skipped forever — e.g. two PRs
# that each grab the next number and then both merge. A file with no numeric
# prefix can't be tracked at all. Fail fast on either, with a clear message.
INVALID_FILES=""
PREFIXES=""
MAX_PREFIX=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  BASE=$(basename "$file")
  # `|| true` so a prefix-less filename doesn't trip the grep's non-zero exit
  # under `set -o pipefail` and abort before we can report it below.
  PREFIX=$(printf '%s' "$BASE" | grep -oE '^[0-9]+' || true)
  if [ -z "$PREFIX" ]; then
    INVALID_FILES+="  $BASE"$'\n'
  else
    PREFIXES+="$PREFIX"$'\n'
    if [ $((10#$PREFIX)) -gt "$MAX_PREFIX" ]; then
      MAX_PREFIX=$((10#$PREFIX))
    fi
  fi
done

if [ -n "$INVALID_FILES" ]; then
  echo "ERROR: migration files without a leading numeric prefix:" >&2
  printf '%s' "$INVALID_FILES" >&2
  echo "Rename them as NNNN_description.sql so they can be tracked." >&2
  exit 1
fi

DUPES=$(printf '%s' "$PREFIXES" | sort | uniq -d)
if [ -n "$DUPES" ]; then
  echo "ERROR: duplicate migration version prefixes detected:" >&2
  echo "$DUPES" | sed 's/^/  /' >&2
  echo "Renumber the colliding files so each prefix is unique before deploying." >&2
  exit 1
fi

# Resolve the adopt watermark now that the highest version is known. Adopting
# writes ledger rows for SQL that was never executed, so a remote run asks first.
ADOPT_MAX=-1
if [ -n "$ADOPT_THROUGH" ]; then
  if [ "$ADOPT_THROUGH" = "all" ]; then
    ADOPT_MAX=$MAX_PREFIX
  elif printf '%s' "$ADOPT_THROUGH" | grep -qE '^[0-9]+$'; then
    ADOPT_MAX=$((10#$ADOPT_THROUGH))
  else
    echo "ERROR: --adopt-through expects a numeric migration version, got: $ADOPT_THROUGH" >&2
    exit 1
  fi

  echo "Adopt mode: migrations up to $(printf '%04d' "$ADOPT_MAX") will be recorded as applied WITHOUT running."
  echo "Only do this when the schema is already at that point by hand."
  if [ "$TARGET" = "remote" ] && [ "$ASSUME_YES" -ne 1 ]; then
    # `|| true` so a non-interactive run falls through to the refusal below
    # instead of aborting on read's non-zero exit under `set -e`.
    REPLY_TEXT=""
    read -r -p "Adopt against REMOTE database '$DATABASE_NAME'? Type yes to continue: " REPLY_TEXT || true
    if [ "$REPLY_TEXT" != "yes" ]; then
      echo "Aborted." >&2
      exit 1
    fi
  fi
fi

echo "Target: $TARGET database '$DATABASE_NAME'"

# 1. Ensure tracking table exists
d1_execute \
  --command "CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )"

# 2. Get the applied versions and their exact filenames. A numeric prefix is
# only unique within this repository; downstream installations can already
# have used the same version for a different migration.
APPLIED_JSON=$(
  d1_execute \
    --command "SELECT version, name FROM _schema_migrations ORDER BY version" \
    --json
)
printf '%s' "$APPLIED_JSON" |
  jq -e '.[0].results | type == "array"' >/dev/null

# Each migration and its ledger row are submitted in one SQL file. D1 executes
# the file atomically, so a failed migration rolls back and a lost client
# response is safe to retry: a committed migration always has its ledger row.
MIGRATION_BATCH_DIR="$(mktemp -d)"
cleanup() {
  rm -r -- "$MIGRATION_BATCH_DIR"
}
trap cleanup EXIT

# 3. Apply pending migrations in order
COUNT=0
ADOPTED=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  FILENAME=$(basename "$file")
  VERSION=$(echo "$FILENAME" | grep -oE '^[0-9]+')
  SAFE_FILENAME=$(echo "$FILENAME" | sed "s/'/''/g")

  RECORDED_NAME=$(
    printf '%s' "$APPLIED_JSON" |
      jq -r --arg version "$VERSION" \
        '.[0].results[]? | select(.version == $version) | .name'
  )
  if [ -n "$RECORDED_NAME" ]; then
    if [ "$RECORDED_NAME" != "$FILENAME" ]; then
      echo "ERROR: version $VERSION is already recorded as $RECORDED_NAME." >&2
      echo "Renumber this migration before applying it to this installation." >&2
      exit 1
    fi
    echo "Skip (already applied): $FILENAME"
    continue
  fi

  if [ $((10#$VERSION)) -le "$ADOPT_MAX" ]; then
    echo "Adopt (recorded, not run): $FILENAME"
    d1_execute \
      --command "INSERT INTO _schema_migrations (version, name) VALUES ('$VERSION', '$SAFE_FILENAME')"
    ADOPTED=$((ADOPTED + 1))
  else
    echo "Applying: $FILENAME"
    MIGRATION_BATCH="$MIGRATION_BATCH_DIR/$FILENAME"
    cp "$file" "$MIGRATION_BATCH"
    printf "\n\nINSERT INTO _schema_migrations (version, name) VALUES ('%s', '%s');\n" \
      "$VERSION" "$SAFE_FILENAME" >>"$MIGRATION_BATCH"
    d1_execute --file "$MIGRATION_BATCH"
    COUNT=$((COUNT + 1))
  fi
done

if [ "$ADOPTED" -gt 0 ]; then
  echo "Done. Applied $COUNT migration(s), adopted $ADOPTED without running."
else
  echo "Done. Applied $COUNT migration(s)."
fi
