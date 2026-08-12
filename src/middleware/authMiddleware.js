const jwt = require('jsonwebtoken');
const db = require('../db');
const { isAccessTokenRevoked } = require('../tokenUtils');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Token tidak ada' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (isAccessTokenRevoked(payload.jti)) {
      return res.status(401).json({ error: 'Token sudah dicabut (logout), silakan login ulang' });
    }

    // Pastikan usernya masih ada (bukan sudah dihapus admin) -- token JWT
    // yang masih berlaku secara kriptografis tetap harus gugur kalau
    // pemiliknya sudah tidak ada lagi di DB.
    const user = db.prepare('SELECT id, username, is_admin FROM users WHERE id = ?').get(payload.id);
    if (!user) {
      return res.status(401).json({ error: 'Akun tidak ditemukan, silakan login ulang' });
    }

    req.user = { id: user.id, username: user.username, isAdmin: !!user.is_admin };
    req.tokenPayload = payload; // dipakai endpoint /logout buat catat jti+exp ke revoked_tokens
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token tidak valid atau kadaluarsa' });
  }
}

module.exports = { requireAuth };
