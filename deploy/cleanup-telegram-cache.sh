#!/bin/bash
# Hapus file cache Local Bot API Server yang lebih tua dari N hari.
# AMAN dijalankan rutin: data aslinya tetap ada permanen di server Telegram,
# file ini cuma salinan cache lokal yang akan di-download ulang otomatis
# oleh telegram-bot-api kalau memang diminta lagi (lewat getFile).
#
# Pasang sebagai cron/systemd timer harian, contoh crontab:
#   0 3 * * * /home/ubuntu/telegram-drive/deploy/cleanup-telegram-cache.sh >> /var/log/td-cleanup.log 2>&1

set -euo pipefail

# Sesuaikan dengan --dir yang dipakai saat menjalankan telegram-bot-api
TG_DATA_DIR="${TG_DATA_DIR:-/home/ubuntu/telegram-bot-api-data}"
DAYS_OLD="${DAYS_OLD:-3}"

if [ ! -d "$TG_DATA_DIR" ]; then
  echo "[cleanup] Direktori $TG_DATA_DIR tidak ditemukan, cek TG_DATA_DIR." >&2
  exit 1
fi

echo "[cleanup] $(date): membersihkan file cache >${DAYS_OLD} hari di $TG_DATA_DIR"

BEFORE=$(du -sh "$TG_DATA_DIR" 2>/dev/null | cut -f1)
find "$TG_DATA_DIR" -type f -mtime +"$DAYS_OLD" -print -delete
AFTER=$(du -sh "$TG_DATA_DIR" 2>/dev/null | cut -f1)

echo "[cleanup] Selesai. Ukuran sebelum: $BEFORE, sesudah: $AFTER"
