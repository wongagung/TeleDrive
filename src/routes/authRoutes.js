const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { authLimiter } = require('../middleware/rateLimiters');
const { requireTurnstile } = require('../middleware/turnstile');
const { requireAuth } = require('../middleware/authMiddleware');
const {
  signAccessToken,
  revokeAccessToken,
  createRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokensForUser,
} = require('../tokenUtils');
const { createLinkCode, sendPasswordResetCode, consumeResetCode } = require('../telegramBot');
const { getBotUsername } = require('../telegram');
const { sendEmail, verificationEmailHtml } = require('../email');

const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGISTER_CODE_TTL_MINUTES = 15;

function issueTokenPair(user) {
  return {
    token: signAccessToken(user),
    refresh_token: createRefreshToken(user.id),
    username: user.username,
  };
}

// ---------- Registrasi 2 langkah: kirim kode -> verifikasi ----------
// Baris "users" BARU DIBUAT SETELAH kode diverifikasi (lihat
// /register/verify di bawah) -- selama itu belum terjadi, gak ada akun
// sama sekali, cuma baris "pending_registrations" yang bisa kadaluarsa
// sendiri kalau kodenya gak pernah dipakai.
router.post('/register/request', authLimiter, requireTurnstile, async (req, res) => {
  if (process.env.DISABLE_REGISTRATION === 'true') {
    return res.status(403).json({ error: 'Registrasi ditutup' });
  }

  const { username, email, password } = req.body;

  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Username 3-32 karakter, hanya huruf/angka/titik/underscore/strip',
    });
  }
  if (!email || !EMAIL_RE.test(email) || email.length > 200) {
    return res.status(400).json({ error: 'Email tidak valid' });
  }
  if (!password || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password minimal 8 karakter' });
  }

  const emailNorm = email.trim().toLowerCase();

  const usernameTaken = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (usernameTaken) return res.status(409).json({ error: 'Username sudah dipakai' });

  const emailTaken = db.prepare('SELECT id FROM users WHERE email = ?').get(emailNorm);
  if (emailTaken) return res.status(409).json({ error: 'Email sudah terdaftar' });

  // Bersihin sisa pendaftaran-pending lama buat username/email yang sama
  // (mis. user minta kode ulang sebelum yang lama kadaluarsa/dipakai).
  db.prepare('DELETE FROM pending_registrations WHERE username = ? OR email = ?').run(username, emailNorm);

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = new Date(Date.now() + REGISTER_CODE_TTL_MINUTES * 60 * 1000).toISOString();
  const hash = bcrypt.hashSync(password, 12);

  db.prepare(
    'INSERT INTO pending_registrations (code, username, email, password_hash, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(code, username, emailNorm, hash, expiresAt);

  const sent = await sendEmail(emailNorm, 'Kode verifikasi VaultKu', verificationEmailHtml(code));
  if (!sent) {
    db.prepare('DELETE FROM pending_registrations WHERE code = ?').run(code);
    return res.status(502).json({ error: 'Gagal mengirim email verifikasi, coba lagi nanti' });
  }

  res.json({ ok: true, expires_in_minutes: REGISTER_CODE_TTL_MINUTES });
});

router.post('/register/verify', authLimiter, (req, res) => {
  const { username, code } = req.body;
  if (!username || !code) {
    return res.status(400).json({ error: 'Username dan kode wajib diisi' });
  }

  const pending = db
    .prepare("SELECT * FROM pending_registrations WHERE code = ? AND username = ? AND expires_at > datetime('now')")
    .get(String(code).trim(), username);

  if (!pending) {
    return res.status(400).json({ error: 'Kode salah atau kadaluarsa' });
  }

  // Cek ulang -- jaga-jaga username/email keburu diambil orang lain
  // selagi kode ini nunggu diverifikasi.
  const usernameTaken = db.prepare('SELECT id FROM users WHERE username = ?').get(pending.username);
  const emailTaken = db.prepare('SELECT id FROM users WHERE email = ?').get(pending.email);
  if (usernameTaken || emailTaken) {
    db.prepare('DELETE FROM pending_registrations WHERE code = ?').run(pending.code);
    return res.status(409).json({ error: 'Username atau email sudah keburu dipakai, silakan daftar ulang' });
  }

  const info = db
    .prepare('INSERT INTO users (username, email, password_hash, email_verified) VALUES (?, ?, ?, 1)')
    .run(pending.username, pending.email, pending.password_hash);

  db.prepare('DELETE FROM pending_registrations WHERE code = ?').run(pending.code);

  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount === 1) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(info.lastInsertRowid);
  }

  res.json(issueTokenPair({ id: info.lastInsertRowid, username: pending.username }));
});

router.post('/login', authLimiter, requireTurnstile, (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  res.json(issueTokenPair({ id: user.id, username: user.username }));
});

router.post('/refresh', authLimiter, (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token wajib diisi' });

  const result = rotateRefreshToken(refresh_token);
  if (!result) {
    return res.status(401).json({
      error: 'Refresh token tidak valid/kadaluarsa, silakan login ulang',
    });
  }

  res.json({
    token: signAccessToken(result.user),
    refresh_token: result.refreshToken,
    username: result.user.username,
  });
});

router.post('/logout', requireAuth, (req, res) => {
  revokeAccessToken(req.tokenPayload);
  if (req.body && req.body.refresh_token) {
    revokeRefreshToken(req.body.refresh_token);
  }
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    is_admin: req.user.isAdmin,
  });
});

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
  db.prepare(
    'UPDATE users SET telegram_chat_id = NULL, quota_notified_pct = 0 WHERE id = ?'
  ).run(req.user.id);
  res.json({ ok: true });
});

// Pesan generik yang sama dipakai buat kasus "user gak ada" ATAUPUN "user
// ada tapi belum hubungkan Telegram" -- supaya endpoint ini gak bisa dipakai
// buat nebak-nebak username mana yang terdaftar (username enumeration).
const FORGOT_GENERIC_MSG =
  'Kalau username tersebut terdaftar dan sudah terhubung ke Telegram, kode reset sudah dikirim lewat DM bot.';

router.post('/forgot-password', authLimiter, async (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

  const user = db.prepare('SELECT id, telegram_chat_id FROM users WHERE username = ?').get(username);

  if (user && user.telegram_chat_id) {
    try {
      await sendPasswordResetCode(user.id, user.telegram_chat_id);
    } catch (err) {
      console.warn('[forgot-password] gagal kirim DM:', err.message);
      // Tetap balas sukses generik -- jangan bocorin ke pemanggil apakah
      // pengiriman DM-nya gagal atau usernya emang gak ada/belum link.
    }
  }

  res.json({ ok: true, message: FORGOT_GENERIC_MSG });
});

router.post('/reset-password', authLimiter, (req, res) => {
  const { username, code, new_password } = req.body;

  if (!username || !code || !new_password) {
    return res.status(400).json({ error: 'Username, kode, dan password baru wajib diisi' });
  }
  if (new_password.length < 8 || new_password.length > 200) {
    return res.status(400).json({ error: 'Password minimal 8 karakter' });
  }

  const user = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!user) return res.status(400).json({ error: 'Kode salah atau kadaluarsa' });

  const valid = consumeResetCode(String(code).trim(), user.id);
  if (!valid) return res.status(400).json({ error: 'Kode salah atau kadaluarsa' });

  const hash = bcrypt.hashSync(new_password, 12);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);

  // Paksa logout dari semua sesi/perangkat lain -- kalau password bocor,
  // reset ini juga otomatis nendang siapa pun yang masih login pakai
  // password lama.
  revokeAllRefreshTokensForUser(user.id);

  res.json({ ok: true });
});

module.exports = router;
