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
// tapi mencegah spam banyak file kecil sekaligus untuk habiskan disk/kuota
// Telegram). Limit-nya dilonggarin karena sekarang upload banyak file
// sekaligus itu penggunaan NORMAL (tiap file pakai 1x /init + 1x /complete).
const uploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak upload dalam waktu singkat. Coba lagi nanti.' },
});

// Block resumable upload jauh lebih sering dipanggil (1 request per 8MB),
// jadi limitnya lebih longgar — ini cuma jaring pengaman terakhir dari abuse,
// bukan pembatas utama (pembatas utama ada di uploadLimiter utk /init & /complete).
const blockLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak request upload block. Coba lagi nanti.' },
});

// Share link publik: gak pakai login sama sekali, jadi perlu limiter
// sendiri buat cegah orang brute-force nebak token / scraping berlebihan.
// Token-nya sendiri sudah 48-bit acak (praktis mustahil ditebak), ini
// cuma jaring pengaman tambahan.
const publicShareLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak request. Coba lagi nanti.' },
});

module.exports = { authLimiter, uploadLimiter, blockLimiter, publicShareLimiter };
