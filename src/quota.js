const db = require('./db');
const { sendMessage } = require('./telegram');

const DEFAULT_QUOTA_BYTES = (parseInt(process.env.DEFAULT_QUOTA_MB, 10) || 5120) * 1024 * 1024; // default 5GB

/** Kuota efektif user: pakai quota_bytes custom kalau di-set (>0), else default global. */
function getQuotaBytes(userId) {
  const row = db.prepare('SELECT quota_bytes FROM users WHERE id = ?').get(userId);
  if (row && row.quota_bytes > 0) return row.quota_bytes;
  return DEFAULT_QUOTA_BYTES;
}

/** Total byte yang sudah dipakai user dari SEMUA file (di folder manapun). */
function getUsedBytes(userId) {
  const row = db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE user_id = ?').get(userId);
  return row.total;
}

/**
 * Pastikan menambah `incomingBytes` tidak bikin user melebihi kuotanya.
 * Lempar error dengan status 413 kalau melebihi.
 */
function assertWithinQuota(userId, incomingBytes) {
  const quota = getQuotaBytes(userId);
  const used = getUsedBytes(userId);

  if (used + incomingBytes > quota) {
    const err = new Error(
      `Kuota penyimpanan tidak cukup. Terpakai ${fmtMB(used)}/${fmtMB(quota)}, ` +
      `file ini butuh ${fmtMB(incomingBytes)}.`
    );
    err.status = 413;
    throw err;
  }
}

function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + 'MB';
}

/**
 * Cek apakah user sudah melewati ambang batas kuota (default 80% & 95%,
 * bisa di-override lewat QUOTA_WARN_THRESHOLDS di .env) dan kirim DM
 * Telegram sekali per ambang batas -- gak spam tiap kali dicek. Reset
 * otomatis kalau usage turun lagi di bawah ambang batas terendah (mis.
 * user hapus file), jadi notifikasi bisa kekirim lagi di masa depan.
 *
 * Silent no-op kalau user belum menghubungkan akun Telegram-nya.
 */
async function checkAndNotifyQuota(userId) {
  const user = db.prepare('SELECT telegram_chat_id, quota_notified_pct FROM users WHERE id = ?').get(userId);
  if (!user || !user.telegram_chat_id) return;

  const thresholds = (process.env.QUOTA_WARN_THRESHOLDS || '80,95')
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => !Number.isNaN(n) && n > 0 && n <= 100)
    .sort((a, b) => a - b);
  if (thresholds.length === 0) return;

  const quota = getQuotaBytes(userId);
  const used = getUsedBytes(userId);
  const pct = quota > 0 ? (used / quota) * 100 : 0;

  if (pct < thresholds[0]) {
    if (user.quota_notified_pct !== 0) {
      db.prepare('UPDATE users SET quota_notified_pct = 0 WHERE id = ?').run(userId);
    }
    return;
  }

  const reached = thresholds.filter((t) => pct >= t);
  const highestReached = reached[reached.length - 1];
  if (!highestReached || highestReached <= user.quota_notified_pct) return;

  try {
    const urgency = highestReached >= 95 ? '🔴 Hampir penuh!' : '🟡 Perlu diperhatikan';
    await sendMessage(
      user.telegram_chat_id,
      `${urgency} Storage Telegram Drive kamu sudah terpakai ${pct.toFixed(1)}% ` +
      `(${fmtMB(used)} / ${fmtMB(quota)}).\n\nHapus file lama, atau minta admin naikkan kuota kamu.`
    );
    db.prepare('UPDATE users SET quota_notified_pct = ? WHERE id = ?').run(highestReached, userId);
  } catch (err) {
    console.warn('[checkAndNotifyQuota] gagal kirim DM ke user', userId, ':', err.message);
  }
}

module.exports = { getQuotaBytes, getUsedBytes, assertWithinQuota, checkAndNotifyQuota, DEFAULT_QUOTA_BYTES };
