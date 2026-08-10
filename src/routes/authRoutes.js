const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const { authLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

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

  const token = jwt.sign(
    { id: info.lastInsertRowid, username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  res.json({ token, username });
});

router.post('/login', authLimiter, (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Username atau password salah' });
  }

  const token = jwt.sign(
    { id: user.id, username: user.username },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  res.json({ token, username: user.username });
});

module.exports = router;
