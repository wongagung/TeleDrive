require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const { assertStrongJwtSecret } = require('./config');
assertStrongJwtSecret(); // server menolak start kalau JWT_SECRET lemah/default

const { cleanupExpiredTokens } = require('./tokenUtils');
cleanupExpiredTokens(); // buang baris token basi di startup, sebelum nerima traffic

const authRoutes = require('./routes/authRoutes');
const fileRoutes = require('./routes/fileRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { startPolling } = require('./telegramBot');
const { checkFfmpegAvailable } = require('./videoThumbnail');

const app = express();
app.disable('x-powered-by'); // jangan bocorkan "Express" ke response header

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      frameSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
    },
  },
}));

// CORS: default hanya izinkan same-origin (kosongkan ALLOWED_ORIGINS di .env).
// Isi ALLOWED_ORIGINS kalau memang perlu diakses dari domain/app lain, pisah koma.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // request tanpa Origin header (curl, mobile app, server-to-server) tetap diizinkan
    if (!origin) return callback(null, true);
    // hanya izinkan origin yang eksplisit terdaftar; default (kosong) = tolak semua cross-origin
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, false);
  },
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/drive', fileRoutes);
app.use('/api/admin', adminRoutes);

// Bersihkan token basi tiap 6 jam sekali biar tabelnya nggak numpuk.
setInterval(cleanupExpiredTokens, 6 * 60 * 60 * 1000).unref();

app.get('/health', (req, res) => res.json({ ok: true }));

// Error handler generik — jangan bocorkan stack trace ke client
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.publicMessage || 'Terjadi kesalahan pada server' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[telegram-drive] jalan di http://localhost:${PORT}`);
});

// Fire-and-forget: mulai polling Telegram (buat proses hubung-akun /start
// <kode>) dan cek ketersediaan ffmpeg (buat thumbnail video). Keduanya
// TIDAK boleh mem-block/gagalkan startup server kalau ada masalah -- fitur
// opsional, bukan inti aplikasi.
if (process.env.BOT_TOKEN && process.env.GROUP_ID) {
  startPolling().catch((err) => console.warn('[telegramBot] polling berhenti dengan error:', err.message));
}
checkFfmpegAvailable();
