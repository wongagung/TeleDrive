const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('./db');

/**
 * Buat token baru dengan jti unik (dipakai buat revoke individual nanti,
 * beda dari ganti JWT_SECRET yang bakal invalidate SEMUA orang sekaligus).
 */
function signToken(user) {
  const jti = crypto.randomUUID();
  const token = jwt.sign(
    { id: user.id, username: user.username, jti },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
  return token;
}

/** Cabut satu token spesifik (dipakai saat logout). */
function revokeToken(payload) {
  if (!payload.jti || !payload.exp) return;
  db.prepare('INSERT OR REPLACE INTO revoked_tokens (jti, user_id, expires_at) VALUES (?, ?, ?)').run(
    payload.jti,
    payload.id,
    new Date(payload.exp * 1000).toISOString()
  );
}

function isRevoked(jti) {
  if (!jti) return false;
  const row = db.prepare('SELECT jti FROM revoked_tokens WHERE jti = ?').get(jti);
  return !!row;
}

/** Buang baris revoked_tokens yang tokennya sendiri sudah kadaluarsa (nggak perlu disimpan lagi). */
function cleanupExpiredRevocations() {
  db.prepare("DELETE FROM revoked_tokens WHERE expires_at < datetime('now')").run();
}

module.exports = { signToken, revokeToken, isRevoked, cleanupExpiredRevocations };
