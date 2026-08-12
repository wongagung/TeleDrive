/** Dipasang SETELAH requireAuth. Cek req.user.isAdmin yang sudah divalidasi fresh dari DB. */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: 'Khusus admin' });
  }
  next();
}

module.exports = { requireAdmin };
