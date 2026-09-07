#!/usr/bin/env sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$project_root"
if [ ! -f .env ]; then
  echo '缺少 .env。请先运行 ./tools/initialize-config.sh。' >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo '未找到 Node.js 20 或更高版本。' >&2
  exit 1
fi
node_major=$(node -p "Number(process.versions.node.split('.')[0])")
if [ "$node_major" -lt 20 ]; then
  echo "Node.js 版本过低（当前主版本 $node_major），需要 20 或更高版本。" >&2
  exit 1
fi
set -a
. ./.env
set +a
exec node "$project_root/server.mjs"
