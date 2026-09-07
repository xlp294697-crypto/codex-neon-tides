#!/usr/bin/env sh
set -eu

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
compose_file=${1:-"$project_root/compose.yaml"}
destination=${2:-"$project_root/backups"}
retention_days=${3:-${BACKUP_RETENTION_DAYS:-90}}
case "$retention_days" in ''|*[!0-9]*) echo '备份保留天数必须是整数。' >&2; exit 1 ;; esac
if [ "$retention_days" -lt 1 ] || [ "$retention_days" -gt 3650 ]; then
  echo '备份保留天数必须在 1 到 3650 之间。' >&2
  exit 1
fi
if [ ! -f "$compose_file" ]; then
  echo "Compose 文件不存在：$compose_file" >&2
  exit 1
fi
if ! command -v docker >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
  echo 'Docker 备份需要 docker compose 和 sha256sum。' >&2
  exit 1
fi

umask 077
mkdir -p "$destination"
destination=$(CDPATH= cd -- "$destination" && pwd)
if [ "$destination" = / ]; then
  echo '拒绝把磁盘根目录作为备份目录。' >&2
  exit 1
fi
chmod 700 "$destination"
timestamp=$(date '+%Y%m%d-%H%M%S')
backup_file="$destination/site-data-docker-$timestamp.json"
if [ -e "$backup_file" ]; then backup_file="$destination/site-data-docker-$timestamp-$$.json"; fi

docker compose -f "$compose_file" exec -T app node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('/app/data/site-data.json','utf8'));if(!Array.isArray(d.events)||!Array.isArray(d.inquiries))process.exit(1)"
docker compose -f "$compose_file" cp 'app:/app/data/site-data.json' "$backup_file"
hash=$(sha256sum "$backup_file" | awk '{print $1}')
hash_file="$backup_file.sha256.txt"
printf '%s  %s\n' "$hash" "$(basename -- "$backup_file")" > "$hash_file"
chmod 600 "$backup_file" "$hash_file"

find "$destination" -maxdepth 1 -type f \( \
  -name 'site-data-[0-9]*.json' -o -name 'site-data-[0-9]*.json.sha256.txt' -o \
  -name 'site-data-docker-[0-9]*.json' -o -name 'site-data-docker-[0-9]*.json.sha256.txt' -o \
  -name 'before-restore-[0-9]*.json' -o -name 'before-restore-[0-9]*.json.sha256.txt' \
\) -mtime +"$retention_days" -exec rm -f -- {} +

echo "Docker 数据备份完成：$backup_file"
echo "SHA-256：$hash"
echo "轮换策略：保留 $retention_days 天。"
