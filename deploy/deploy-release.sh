#!/bin/sh
set -eu
umask 077

environment=${1:-}
case "$environment" in staging|production) ;; *) echo 'Invalid release environment' >&2; exit 1;; esac
: "${APP_IMAGE:?Digest-qualified APP_IMAGE is required}"
: "${RELEASE_ROOT:?An existing deployment root is required}"
: "${SMOKE_BASE_URL:?The public HTTPS origin is required}"
printf '%s\n' "$APP_IMAGE" | grep -Eq '^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$' || exit 1
if [ -z "${SMOKE_ADMIN_PASSWORD:-}" ]; then IFS= read -r SMOKE_ADMIN_PASSWORD; fi
export SMOKE_ADMIN_PASSWORD APP_IMAGE
bundle=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
candidate_bundle=$bundle
RELEASE_ROOT=$(CDPATH='' cd -- "$RELEASE_ROOT" && pwd)
env_file="$RELEASE_ROOT/.env.$environment"
[ -f "$env_file" ] || { echo 'Environment file missing' >&2; exit 1; }
export STAGING_ENV_FILE="$env_file" PRODUCTION_ENV_FILE="$env_file"
state="$RELEASE_ROOT/.release-state/$environment"
mkdir -p "$state"
# Kernel lock releases even after process termination; no stale lock directories.
exec 9>"$state/lock"
flock -n 9 || { echo 'Another release is active' >&2; exit 1; }
compose() {
  docker compose --project-directory "$bundle" --env-file "$env_file" -f "$bundle/compose.$environment.yaml" "$@"
}
stage=preflight
previous=''
previous_bundle=''
backup_path=none
replaced=0
finish() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$result" -ne 0 ]; then
    rollback_result=not-attempted
    printf 'Release failed: stage=%s backup=%s previous-bundle=%s candidate-bundle=%s\n' "$stage" "$backup_path" "$previous_bundle" "$candidate_bundle" >&2
    if [ "$replaced" = 1 ] && [ -n "$previous" ]; then
      APP_IMAGE=$previous
      bundle=$previous_bundle
      export APP_IMAGE
      # Restore both services from the retained prior Compose/Caddy bundle.
      # Container readiness alone cannot prove that the public proxy recovered.
      if compose up -d --wait --wait-timeout 120 --force-recreate app caddy >/dev/null 2>&1 &&
        node "$candidate_bundle/deploy/smoke-test.mjs" "$SMOKE_BASE_URL" production; then
        printf '%s\n' "$previous" > "$state/current-image"
        printf '%s\n' "$previous_bundle" > "$state/current-bundle"
        rollback_result=restored
        echo 'Previous deployment restored; public recovery verified; database was not reverted.' >&2
      else
        rollback_result=rollback-failed
        echo 'Deployment rollback failed; operator recovery required. Database was not reverted.' >&2
      fi
    elif [ "$replaced" = 1 ]; then
      compose stop app caddy >/dev/null 2>&1 || true
      echo 'No previous deployment; failed initial staging services stopped.' >&2
    fi
    printf 'failed %s rollback=%s backup=%s previous-bundle=%s candidate-bundle=%s\n' "$stage" "$rollback_result" "$backup_path" "$previous_bundle" "$candidate_bundle" > "$state/result"
  fi
  exit "$result"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM
compose config --quiet >/dev/null 2>&1
container=$(compose ps -q app)
caddy_container=$(compose ps -a -q caddy)
if [ -n "$container" ]; then
  previous=$(docker inspect --format '{{.Config.Image}}' "$container")
  printf '%s\n' "$previous" | grep -Eq '^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$' || { echo 'Previous image must be digest-qualified' >&2; exit 1; }
  [ -n "$caddy_container" ] || { echo 'Previous proxy deployment is missing' >&2; exit 1; }
  previous_bundle=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")
  [ -d "$previous_bundle" ] || { echo 'Previous deployment bundle is unavailable' >&2; exit 1; }
  previous_bundle=$(CDPATH='' cd -- "$previous_bundle" && pwd)
  [ "$previous_bundle" != "$candidate_bundle" ] || { echo 'Release requires a distinct retained previous bundle' >&2; exit 1; }
  [ -f "$previous_bundle/compose.$environment.yaml" ] && [ -f "$previous_bundle/deploy/Caddyfile.docker" ] || { echo 'Previous deployment configuration is unavailable' >&2; exit 1; }
  for prior_container in "$container" "$caddy_container"; do
    prior_directory=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$prior_container")
    prior_files=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$prior_container")
    [ "$prior_directory" = "$previous_bundle" ] && [ "$prior_files" = "$previous_bundle/compose.$environment.yaml" ] || { echo 'Previous application and proxy configuration do not share a recoverable bundle' >&2; exit 1; }
  done
  (bundle=$previous_bundle; APP_IMAGE=$previous; export APP_IMAGE; compose config --quiet >/dev/null 2>&1)
elif [ "$environment" = production ]; then
  echo 'Production requires an existing digest-qualified application and database' >&2
  exit 1
elif [ -n "$caddy_container" ]; then
  echo 'Existing proxy without an application requires operator recovery' >&2
  exit 1
fi
printf '%s\n' "$previous" > "$state/previous-image"
printf '%s\n' "$previous_bundle" > "$state/previous-bundle"
printf '%s\n' "$APP_IMAGE" > "$state/candidate-image"
printf '%s\n' "$candidate_bundle" > "$state/candidate-bundle"
printf 'none\n' > "$state/backup-path"
printf 'in-progress\n' > "$state/result"
stage=pull
compose pull app >/dev/null 2>&1
ROLLBACK_SCHEMA_COMPATIBLE=0
if [ -n "$previous" ]; then
  if compose exec -T app node --input-type=module -e 'import { supportsForwardSchema } from "./src/db/migrate.mjs"; process.exit(supportsForwardSchema === true ? 0 : 1)' >/dev/null 2>&1; then
    ROLLBACK_SCHEMA_COMPATIBLE=1
  fi
  stage=backup
  pending_backup="/app/data/release-backups/$(date -u +%Y%m%dT%H%M%SZ)-$$.db"
  # SQLite online backup reads the existing data volume before replacement.
  compose run --rm --no-deps -T --pull never -v "$bundle/deploy:/release:ro" app node /release/release-db.mjs backup "$pending_backup" >/dev/null 2>&1
  backup_path=$pending_backup
  printf '%s\n' "$backup_path" > "$state/backup-path"
fi
stage=stop
replaced=1
compose stop app >/dev/null 2>&1
stage=migrate
export ROLLBACK_SCHEMA_COMPATIBLE
compose run --rm --no-deps -T --pull never -e ROLLBACK_SCHEMA_COMPATIBLE -v "$bundle/deploy:/release:ro" app node /release/release-db.mjs migrate > "$state/migration-result" 2>/dev/null
stage=readiness
compose up -d --wait --wait-timeout 120 app caddy >/dev/null 2>&1
stage=smoke
node "$bundle/deploy/smoke-test.mjs" "$SMOKE_BASE_URL" "$environment"
stage=record
printf '%s\n' "$APP_IMAGE" > "$state/current-image"
printf '%s\n' "$candidate_bundle" > "$state/current-bundle"
printf 'success %s backup=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$backup_path" > "$state/result"
echo 'Release passed: readiness and smoke checks complete.'
