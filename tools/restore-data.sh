#!/usr/bin/env sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "用法：$0 <备份文件> [--hash-file <校验文件>] [--skip-hash-check] [--force]" >&2
  exit 1
fi

project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
backup_input=$1
shift
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
target="$project_root/data/site-data.json"
if [ ! -f "$backup_file" ]; then
  echo "备份文件不存在：$backup_file" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1 || ! command -v sha256sum >/dev/null 2>&1; then
  echo '恢复需要 Node.js 和 sha256sum。' >&2
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

node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(!Array.isArray(d.events)||!Array.isArray(d.inquiries))process.exit(1)" "$backup_file" || {
  echo '备份 JSON 校验失败。' >&2
  exit 1
}
if [ "$force" = false ]; then
  printf '恢复会替换当前数据。请先停止网站服务，输入 RESTORE 继续: ' >&2
  IFS= read -r answer
  [ "$answer" = 'RESTORE' ] || { echo '已取消恢复。' >&2; exit 1; }
fi

umask 077
mkdir -p "$project_root/data" "$project_root/backups"
chmod 700 "$project_root/data" "$project_root/backups"
if [ -f "$target" ]; then
  timestamp=$(date '+%Y%m%d-%H%M%S')
  safety="$project_root/backups/before-restore-$timestamp.json"
  if [ -e "$safety" ]; then safety="$project_root/backups/before-restore-$timestamp-$$.json"; fi
  cp "$target" "$safety"
  safety_hash=$(sha256sum "$safety" | awk '{print $1}')
  printf '%s  %s\n' "$safety_hash" "$(basename -- "$safety")" > "$safety.sha256.txt"
  chmod 600 "$safety" "$safety.sha256.txt"
  echo "当前数据安全副本：$safety"
fi
temporary=$(mktemp "$project_root/data/.restore.XXXXXX")
trap 'rm -f "$temporary"' EXIT INT TERM
cp "$backup_file" "$temporary"
chmod 600 "$temporary"
mv -f "$temporary" "$target"
trap - EXIT INT TERM
echo "数据已恢复：$target"
