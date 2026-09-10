#!/usr/bin/env bash
set -euo pipefail
umask 077
environment=${1:-}
[[ "$environment" == staging || "$environment" == production ]]
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]]
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ "$DEPLOY_PATH" =~ ^/[a-zA-Z0-9_/-]+$ && "$DEPLOY_PATH" != / ]]
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$APP_IMAGE" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ ]]
[[ "$SMOKE_BASE_URL" =~ ^https://[a-zA-Z0-9][a-zA-Z0-9.-]*(:[0-9]+)?/?$ ]]
[[ -n "$DEPLOY_SSH_KEY" && -n "$DEPLOY_KNOWN_HOSTS" && -n "$SMOKE_ADMIN_PASSWORD" ]]
[[ "$SMOKE_ADMIN_PASSWORD" != *$'\n'* && "$SMOKE_ADMIN_PASSWORD" != *$'\r'* ]]
temporary=$(mktemp -d)
trap 'rm -f -- "$temporary/key" "$temporary/known_hosts" "$temporary/release.tar.gz"; rmdir -- "$temporary"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$temporary/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$temporary/known_hosts"
ssh_options=(-i "$temporary/key" -o "UserKnownHostsFile=$temporary/known_hosts" -o StrictHostKeyChecking=yes -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=3)
target="$DEPLOY_USER@$DEPLOY_HOST"
bundle="$DEPLOY_PATH/releases/$RELEASE_SHA-${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}"
[[ "$GITHUB_RUN_ID" =~ ^[0-9]+$ && "$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+$ ]]
tar -czf "$temporary/release.tar.gz" compose.staging.yaml compose.production.yaml deploy/deploy-release.sh deploy/release-db.mjs deploy/smoke-test.mjs
ssh "${ssh_options[@]}" "$target" "umask 077; mkdir -p '$DEPLOY_PATH/releases'; mkdir '$bundle'"
scp "${ssh_options[@]}" "$temporary/release.tar.gz" "$target:$bundle/release.tar.gz"
# Only validated identifiers enter the remote command. The password uses stdin,
# never a command argument, tar archive, environment file, or diagnostic output.
printf '%s\n' "$SMOKE_ADMIN_PASSWORD" | ssh "${ssh_options[@]}" "$target" \
  "set -eu; cd '$bundle'; tar -xzf release.tar.gz; rm release.tar.gz; chmod 755 . deploy; chmod 644 compose.*.yaml deploy/*; APP_IMAGE='$APP_IMAGE' RELEASE_ROOT='$DEPLOY_PATH' SMOKE_BASE_URL='$SMOKE_BASE_URL' sh deploy/deploy-release.sh '$environment'"
