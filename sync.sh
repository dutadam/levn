#!/usr/bin/env bash
# Levn sync: Drive (kaynak) → /tmp/levn (preview server kökü)
#
# macOS sandbox'ı Drive CloudStorage path'lerinde os.getcwd() çağrısını
# engellediği için preview sunucusu /tmp/levn'den serve eder. Bu script
# Drive'daki güncel UI + data'yı oraya kopyalar.
#
# Kullanım:
#   ./sync.sh            # UI + data + assets rsync
#   ./sync.sh --fast     # assets'i atla (UI/data sık değişir, assets değişmez)
#   ./sync.sh --watch    # fswatch ile canlı sync (fswatch gerekli)

set -euo pipefail

SRC="/Users/emreal/Library/CloudStorage/GoogleDrive-emre.al@dreamgames.com/My Drive/workspace/automation/ae/Levn"
DST="/tmp/levn"

mkdir -p "$DST"

sync_once() {
  local fast="${1:-}"
  rsync -a --delete "$SRC/ui/"  "$DST/ui/"
  rsync -a --delete "$SRC/data/" "$DST/data/"
  if [[ "$fast" != "--fast" ]]; then
    rsync -a --delete "$SRC/assets/" "$DST/assets/"
  fi
  echo "[sync] $(date +%H:%M:%S) → $DST  (fast=${fast:-no})"
}

case "${1:-}" in
  --watch)
    command -v fswatch >/dev/null || { echo "fswatch gerekli: brew install fswatch"; exit 1; }
    sync_once --fast
    echo "[watch] $SRC/ui $SRC/data izleniyor…"
    fswatch -o "$SRC/ui" "$SRC/data" | while read -r _; do sync_once --fast; done
    ;;
  *)
    sync_once "${1:-}"
    ;;
esac
