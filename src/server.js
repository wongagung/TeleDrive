require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const { assertStrongJwtSecret } = require('./config');
assertStrongJwtSecret();

const { cleanupExpiredTokens } = require('./tokenUtils');
cleanupExpiredTokens();

const authRoutes = require('./routes/authRoutes');
const fileRoutes = require('./routes/fileRoutes');
const adminRoutes = require('./routes/adminRoutes');
const { startPolling } = require('./telegramBot');
const { checkFfmpegAvailable } = require('./videoThumbnail');

const app = express();
app.disable('x-powered-by');

// TeleDrive berjalan di belakang Nginx reverse proxy.
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      frameSrc: ["'self'", 'blob:', 'https://challenges.cloudflare.com'],
      connectSrc: ["'self'", 'https://challenges.cloudflare.com'],
    },
  },
}));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, false);
  },
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', authRoutes);
app.use('/api/drive', fileRoutes);
app.use('/api/admin', adminRoutes);

setInterval(cleanupExpiredTokens, 6 * 60 * 60 * 1000).unref();

app.get('/health', (req, res) => res.json({ ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: err.publicMessage || 'Terjadi kesalahan pada server',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[telegram-drive] jalan di http://localhost:${PORT}`);
});

if (process.env.BOT_TOKEN && process.env.GROUP_ID) {
  startPolling().catch((err) =>
    console.warn('[telegramBot] polling berhenti dengan error:', err.message)
  );
}

checkFfmpegAvailable();
