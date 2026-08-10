const rateLimit = require('express-rate-limit');

// Login/register: batasi percobaan per IP untuk cegah brute force credential.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 menit
  max: 10, // maksimal 10 percobaan per IP per 15 menit
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak percobaan. Coba lagi dalam beberapa menit.' },
});

// Upload: batasi jumlah request upload per IP (bukan mencegah file besar,
// tapi mencegah spam banyak file kecil sekaligus untuk habiskan disk/kuota Telegram).
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak upload dalam waktu singkat. Coba lagi nanti.' },
});

module.exports = { authLimiter, uploadLimiter };
