const db = require('./db');

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

module.exports = { getQuotaBytes, getUsedBytes, assertWithinQuota, DEFAULT_QUOTA_BYTES };
