#!/usr/bin/env sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "用法：$0 <备份文件> [compose文件] [--hash-file <校验文件>] [--skip-hash-check] [--force]" >&2
  exit 1
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backup_input=$1
shift
compose_file="$project_root/compose.yaml"
if [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then compose_file=$1; shift; fi
force=false
skip_hash=false
hash_input=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) force=true ;;
    --skip-hash-check) skip_hash=true ;;
    --hash-file)
      shift
      [ "$#" -gt 0 ] || { echo '--hash-file 缺少路径。' >&2; exit 1; }
      hash_input=$1
      ;;
    *) echo "无法识别的参数：$1" >&2; exit 1 ;;
  esac
  shift
done

backup_directory=$(dirname -- "$backup_input")
backup_name=$(basename -- "$backup_input")
backup_file=$(CDPATH= cd -- "$backup_directory" 2>/dev/null && pwd)/$backup_name
if [ ! -f "$backup_file" ]; then echo "备份文件不存在：$backup_file" >&2; exit 1; fi
if [ ! -f "$compose_file" ]; then echo "Compose 文件不存在：$compose_file" >&2; exit 1; fi
if ! command -v docker >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
  echo 'Docker 恢复需要 docker compose 和 sha256sum。' >&2
  exit 1
fi

if [ "$skip_hash" = false ]; then
  if [ -z "$hash_input" ]; then hash_input="$backup_file.sha256.txt"; fi
  hash_directory=$(dirname -- "$hash_input")
  hash_name=$(basename -- "$hash_input")
  hash_file=$(CDPATH= cd -- "$hash_directory" 2>/dev/null && pwd)/$hash_name
  if [ ! -f "$hash_file" ]; then
    echo "缺少 SHA-256 校验文件：$hash_file。只有明确接受风险时才使用 --skip-hash-check。" >&2
    exit 1
  fi
  expected=$(awk 'length($1)==64 && $1 ~ /^[0-9A-Fa-f]+$/ {print tolower($1); exit}' "$hash_file")
  [ -n "$expected" ] || { echo "SHA-256 校验文件格式无效：$hash_file" >&2; exit 1; }
  actual=$(sha256sum "$backup_file" | awk '{print tolower($1)}')
  [ "$actual" = "$expected" ] || { echo "SHA-256 不一致，拒绝恢复。期望 $expected，实际 $actual。" >&2; exit 1; }
  echo "SHA-256 校验通过：$actual"
else
  echo '警告：已显式跳过 SHA-256 校验。' >&2
fi

container_id=$(docker compose -f "$compose_file" ps -a -q app)
[ -n "$container_id" ] || { echo '未找到 app 容器。请先至少执行一次 docker compose up -d。' >&2; exit 1; }
mount_spec="$(dirname -- "$backup_file"):/restore:ro"
validation_user="$(id -u):$(id -g)"
docker compose -f "$compose_file" run --rm --no-deps --user "$validation_user" -v "$mount_spec" --entrypoint node app \
  -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!Array.isArray(d.events)||!Array.isArray(d.inquiries))process.exit(1)" "/restore/$(basename -- "$backup_file")" || {
    echo '备份 JSON 校验失败。' >&2
    exit 1
  }
if [ "$force" = false ]; then
  printf '恢复会替换 Docker 数据卷。输入 RESTORE 继续: ' >&2
  IFS= read -r answer
  [ "$answer" = 'RESTORE' ] || { echo '已取消恢复。' >&2; exit 1; }
fi

umask 077
safety_directory="$project_root/backups"
mkdir -p "$safety_directory"
chmod 700 "$safety_directory"
timestamp=$(date '+%Y%m%d-%H%M%S')
safety_copy="$safety_directory/before-restore-$timestamp.json"
if [ -e "$safety_copy" ]; then safety_copy="$safety_directory/before-restore-$timestamp-$$.json"; fi
docker compose -f "$compose_file" cp 'app:/app/data/site-data.json' "$safety_copy"
safety_hash=$(sha256sum "$safety_copy" | awk '{print $1}')
printf '%s  %s\n' "$safety_hash" "$(basename -- "$safety_copy")" > "$safety_copy.sha256.txt"
chmod 600 "$safety_copy" "$safety_copy.sha256.txt"
echo "当前 Docker 数据安全副本：$safety_copy"

temporary_name=".restore-$timestamp-$$.json"
app_stopped=false
restart_app() {
  if [ "$app_stopped" = true ]; then
    docker compose -f "$compose_file" start app >/dev/null 2>&1 || true
  fi
}
trap restart_app EXIT INT TERM
app_stopped=true
docker compose -f "$compose_file" stop app
docker compose -f "$compose_file" cp "$backup_file" "app:/app/data/$temporary_name"
docker compose -f "$compose_file" run --rm --no-deps --user '0:0' --cap-add CHOWN --cap-add FOWNER --cap-add DAC_OVERRIDE --entrypoint sh app -c \
  "chown node:node '/app/data/$temporary_name' && chmod 600 '/app/data/$temporary_name' && mv -f '/app/data/$temporary_name' /app/data/site-data.json"
docker compose -f "$compose_file" start app >/dev/null
app_stopped=false
trap - EXIT INT TERM

attempt=1
healthy=false
while [ "$attempt" -le 30 ]; do
  if docker compose -f "$compose_file" exec -T app node -e "fetch('http://127.0.0.1:3002/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  sleep 2
  attempt=$((attempt + 1))
done
[ "$healthy" = true ] || { echo '数据已替换，但 app 未在 60 秒内恢复健康。请检查日志，并使用安全副本回滚。' >&2; exit 1; }
echo 'Docker 数据恢复完成，app 健康检查通过。'
