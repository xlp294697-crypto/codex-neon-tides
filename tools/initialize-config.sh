#!/usr/bin/env sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
environment_file="$project_root/.env"
force=${1:-}

if [ -f "$environment_file" ] && [ "$force" != "--force" ]; then
  echo '.env 已存在。如确需重新生成，请添加 --force。' >&2
  exit 1
fi
if command -v node >/dev/null 2>&1 && [ "$(node -p "Number(process.versions.node.split('.')[0])")" -ge 20 ]; then
  generator='node'
elif command -v docker >/dev/null 2>&1; then
  generator='docker'
else
  echo '未找到 Node.js 或 Docker，请先安装其中之一。' >&2
  exit 1
fi

printf '设置后台管理员密码（16-250位，至少三类字符，不会显示）: ' >&2
stty -echo
trap 'stty echo 2>/dev/null || true' EXIT INT TERM
IFS= read -r password
stty echo
printf '\n再次输入后台管理员密码: ' >&2
stty -echo
IFS= read -r confirmation
stty echo
printf '\n' >&2
trap - EXIT INT TERM

if [ "$password" != "$confirmation" ]; then
  echo '两次输入的密码不一致。' >&2
  exit 1
fi

if [ "$generator" = 'node' ]; then
  generated=$(printf '%s' "$password" | node "$project_root/tools/generate-secrets.mjs")
else
  generated=$(printf '%s' "$password" | docker run --rm -i -v "$project_root:/app:ro" -w /app node:24-alpine3.24 node tools/generate-secrets.mjs)
fi
password=''
confirmation=''
umask 077
temporary=$(mktemp "$project_root/.env.tmp.XXXXXX")
trap 'rm -f "$temporary"' EXIT INT TERM
{
  printf '%s\n' 'NODE_ENV=production'
  printf '%s\n' 'REPORT_TIME_ZONE=Asia/Shanghai'
  printf '%s\n' 'SITE_DOMAIN=replace.example.com'
  printf '%s\n' 'ICP_NUMBER='
  printf '%s\n' 'HOST=127.0.0.1'
  printf '%s\n' 'PORT=3002'
  printf '%s\n' 'APP_BIND_IP=127.0.0.1'
  printf '%s\n' 'DATA_PATH=./data/site.db'
  printf '%s\n' 'MAX_BODY_BYTES=65536'
  printf '%s\n' 'EVENT_RETENTION_DAYS=180'
  printf '%s\n' 'MAX_EVENT_RECORDS=25000'
  printf '%s\n' 'MAX_INQUIRY_RECORDS=10000'
  printf '%s\n' 'BACKUP_RETENTION_DAYS=90'
  printf '%s\n' 'SESSION_HOURS=8'
  printf '%s\n' 'TRUST_PROXY=true'
  printf '%s\n' 'COOKIE_SECURE=true'
  printf '%s\n' 'ENABLE_HSTS=false'
  printf '%s' "$generated"
} > "$temporary"
mv -f "$temporary" "$environment_file"
trap - EXIT INT TERM
chmod 600 "$environment_file"
mkdir -p "$project_root/data" "$project_root/backups"
echo "安全配置已写入：$environment_file"
echo '该文件包含登录凭据，不要发送、截图或放入公开仓库。'
