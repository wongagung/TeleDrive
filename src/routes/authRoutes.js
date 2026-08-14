const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { authLimiter } = require('../middleware/rateLimiters');
const { requireAuth } = require('../middleware/authMiddleware');
const {
  signAccessToken,
  revokeAccessToken,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
} = require('../tokenUtils');
const { createLinkCode } = require('../telegramBot');
const { getBotUsername } = require('../telegram');

const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

function issueTokenPair(user) {
  return {
    token: signAccessToken(user), // nama field "token" dipertahankan biar kompatibel sama frontend lama
    refresh_token: createRefreshToken(user.id),
    username: user.username,
  };
}

router.post('/register', authLimiter, (req, res) => {
  if (process.env.DISABLE_REGISTRATION === 'true') {
    return res.status(403).json({ error: 'Registrasi ditutup' });
  }

  const { username, password } = req.body;

  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Username 3-32 karakter, hanya huruf/angka/titik/underscore/strip',
    });
  }
  if (!password || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password minimal 8 karakter' });
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return res.status(409).json({ error: 'Username sudah dipakai' });

  const hash = bcrypt.hashSync(password, 12);
  const info = db
    .prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run(username, hash);

  // User pertama di sistem otomatis jadi admin (lihat juga db.js untuk migrasi DB lama)
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 1) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(info.lastInsertRowid);
  }

  res.json(issueTokenPair({ id: info.lastInsertRowid, username }));
});

router.post('/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  res.json(issueTokenPair({ id: user.id, username: user.username }));
});

// Tukar refresh token yang masih valid dengan access token baru (+ refresh
// token baru juga, rotasi -- yang lama langsung invalid begitu dipakai).
router.post('/refresh', authLimiter, (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token wajib diisi' });

  const result = rotateRefreshToken(refresh_token);
  if (!result) {
    return res.status(401).json({ error: 'Refresh token tidak valid/kadaluarsa, silakan login ulang' });
  }

  res.json({
    token: signAccessToken(result.user),
    refresh_token: result.refreshToken,
    username: result.user.username,
  });
});

// Cabut access token DAN refresh token yang sedang dipakai -- dari titik ini
// keduanya langsung tidak valid lagi, walau masa berlakunya belum habis.
router.post('/logout', requireAuth, (req, res) => {
  revokeAccessToken(req.tokenPayload);
  if (req.body && req.body.refresh_token) {
    revokeRefreshToken(req.body.refresh_token);
  }
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id, username: req.user.username, is_admin: req.user.isAdmin });
});

// ---------- Hubungkan akun Telegram (buat notifikasi kuota DM) ----------

router.get('/telegram/status', requireAuth, (req, res) => {
  const user = db.prepare('SELECT telegram_chat_id FROM users WHERE id = ?').get(req.user.id);
  res.json({ linked: !!(user && user.telegram_chat_id) });
});

router.post('/telegram/link-code', requireAuth, authLimiter, async (req, res) => {
  const { code, expiresInMinutes } = createLinkCode(req.user.id);
  const botUsername = await getBotUsername();
  res.json({ code, expires_in_minutes: expiresInMinutes, bot_username: botUsername });
});

router.delete('/telegram/link', requireAuth, (req, res) => {
  db.prepare('UPDATE users SET telegram_chat_id = NULL, quota_notified_pct = 0 WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

module.exports = router;
