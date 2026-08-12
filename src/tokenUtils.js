const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

// Access token: JWT umur pendek, dipakai di header Authorization tiap request.
// Default 15 menit -- kalau ADA .env lama pakai JWT_EXPIRES_IN (dari sebelum
// refresh token ada), itu tetap dihormati sebagai fallback biar gak putus.
const ACCESS_TOKEN_EXPIRES_IN =
  process.env.ACCESS_TOKEN_EXPIRES_IN || process.env.JWT_EXPIRES_IN || '15m';

// Refresh token: umur panjang, dipakai buat minta access token baru tanpa
// login ulang. Rotate tiap dipakai (token lama langsung invalid begitu
// dipakai sekali) supaya kalau token ini bocor & dipakai orang lain,
// pemakaian keduanya (oleh pemilik asli) akan gagal dan ketahuan.
const REFRESH_TOKEN_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS, 10) || 30;

/**
 * Buat access token baru dengan jti unik (dipakai buat revoke individual,
 * beda dari ganti JWT_SECRET yang bakal invalidate SEMUA orang sekaligus).
 */
function signAccessToken(user) {
  const jti = crypto.randomUUID();
  return jwt.sign(
    { id: user.id, username: user.username, jti },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
  );
}

/** Cabut satu access token spesifik (dipakai saat logout). */
function revokeAccessToken(payload) {
  if (!payload.jti || !payload.exp) return;
  db.prepare('INSERT OR REPLACE INTO revoked_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)').run(
    payload.jti,
    payload.id,
    new Date(payload.exp * 1000).toISOString()
  );
}

function isAccessTokenRevoked(jti) {
  if (!jti) return false;
  const row = db.prepare('SELECT jti FROM revoked_tokens WHERE jti = ?').get(jti);
  return !!row;
}

function hashRefreshToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Buat refresh token baru (random string, bukan JWT) untuk user, simpan
 * HASH-nya saja di DB. Token mentahnya cuma ada di response sekali ini saja.
 */
function createRefreshToken(userId) {
  const raw = crypto.randomBytes(48).toString('hex');
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
  ).run(id, userId, hashRefreshToken(raw), expiresAt);

  return raw;
}

/**
 * Validasi refresh token, lalu ROTATE: token lama langsung dicabut, token
 * baru diterbitkan. Return null kalau token nggak valid/kadaluarsa/dicabut.
 */
function rotateRefreshToken(rawToken) {
  const hash = hashRefreshToken(rawToken);
  const row = db
    .prepare(
      `SELECT * FROM refresh_tokens
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > datetime('now')`
    )
    .get(hash);

  if (!row) return null;

  db.prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE id = ?").run(row.id);

  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(row.user_id);
  if (!user) return null;

  const newRawToken = createRefreshToken(user.id);
  return { user, refreshToken: newRawToken };
}

/** Cabut satu refresh token spesifik berdasarkan nilai mentahnya (dipakai saat logout). */
function revokeRefreshToken(rawToken) {
  if (!rawToken) return;
  const hash = hashRefreshToken(rawToken);
  db.prepare("UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE token_hash = ?").run(hash);
}

/** Cabut SEMUA refresh token milik user (dipakai admin saat hapus/nonaktifkan akun). */
function revokeAllRefreshTokensForUser(userId) {
  db.prepare(
    "UPDATE refresh_tokens SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL"
  ).run(userId);
}

/** Buang baris token yang sendirinya sudah kadaluarsa (nggak perlu disimpan lagi). */
function cleanupExpiredTokens() {
  db.prepare("DELETE FROM revoked_tokens WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM refresh_tokens WHERE expires_at < datetime('now')").run();
}

module.exports = {
  signAccessToken,
  revokeAccessToken,
  isAccessTokenRevoked,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
  cleanupExpiredTokens,
};
