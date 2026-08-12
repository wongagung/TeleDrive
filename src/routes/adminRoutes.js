const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/authMiddleware');
const { requireAdmin } = require('../middleware/adminMiddleware');
const { getQuotaBytes, getUsedBytes, DEFAULT_QUOTA_BYTES } = require('../quota');
const { revokeAllRefreshTokensForUser } = require('../tokenUtils');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/users', (req, res) => {
  const users = db.prepare('SELECT id, username, quota_bytes, is_admin, created_at FROM users ORDER BY id ASC').all();

  const result = users.map((u) => ({
    id: u.id,
    username: u.username,
    is_admin: !!u.is_admin,
    created_at: u.created_at,
    used_bytes: getUsedBytes(u.id),
    quota_bytes: getQuotaBytes(u.id),
    has_custom_quota: u.quota_bytes > 0,
  }));

  res.json({ users: result, default_quota_bytes: DEFAULT_QUOTA_BYTES });
});

router.get('/stats', (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const totalFiles = db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
  const totalUsedBytes = db.prepare('SELECT COALESCE(SUM(size), 0) AS s FROM files').get().s;

  res.json({ totalUsers, totalFiles, totalUsedBytes });
});

router.patch('/users/:id/quota', (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

  const mb = parseInt(req.body.quota_mb, 10);
  if (Number.isNaN(mb) || mb < 0) {
    return res.status(400).json({ error: 'quota_mb harus angka >= 0 (0 = pakai default global)' });
  }

  const bytes = mb * 1024 * 1024;
  db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(bytes, targetId);
  res.json({ ok: true, id: targetId, quota_bytes: bytes > 0 ? bytes : DEFAULT_QUOTA_BYTES });
});

router.patch('/users/:id/admin', (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

  const makeAdmin = !!req.body.is_admin;

  if (!makeAdmin && user.is_admin) {
    const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Tidak bisa mencabut admin terakhir yang tersisa' });
    }
  }

  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin ? 1 : 0, targetId);
  res.json({ ok: true, id: targetId, is_admin: makeAdmin });
});

router.delete('/users/:id', (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  const user = db.prepare('SELECT id, is_admin FROM users WHERE id = ?').get(targetId);
  if (!user) return res.status(404).json({ error: 'User tidak ditemukan' });

  if (targetId === req.user.id) {
    return res.status(400).json({ error: 'Tidak bisa menghapus akun sendiri lewat sini' });
  }
  if (user.is_admin) {
    const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
    if (adminCount <= 1) {
      return res.status(400).json({ error: 'Tidak bisa menghapus admin terakhir yang tersisa' });
    }
  }

  // Catatan: ini hanya hapus metadata (folders/files cascade lewat FK).
  // File yang sudah terlanjur ke Telegram TIDAK ikut terhapus dari grup --
  // itu di luar jangkauan operasi ini, harus dihapus manual dari Telegram
  // kalau memang perlu.
  revokeAllRefreshTokensForUser(targetId);
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.json({ ok: true });
});

module.exports = router;
