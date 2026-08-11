const jwt = require('jsonwebtoken');
const { isRevoked } = require('../tokenUtils');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'Token tidak ada' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    if (isRevoked(payload.jti)) {
      return res.status(401).json({ error: 'Token sudah dicabut (logout), silakan login ulang' });
    }

    req.user = { id: payload.id, username: payload.username };
    req.tokenPayload = payload; // dipakai endpoint /logout buat catat jti+exp ke revoked_tokens
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token tidak valid atau kadaluarsa' });
  }
}

module.exports = { requireAuth };
