const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const dbPath = process.env.DB_PATH || './data/drive.db';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 0, -- 0 = pakai DEFAULT_QUOTA_MB dari .env
  is_admin INTEGER NOT NULL DEFAULT 0,
  telegram_chat_id INTEGER, -- diisi setelah user hubungkan akun Telegram-nya
  quota_notified_pct INTEGER NOT NULL DEFAULT 0, -- threshold notifikasi kuota tertinggi yang sudah dikirim
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, parent_id, name)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT,
  chunks TEXT NOT NULL, -- JSON array [{seq, tg_file_id, size}]
  thumbnail BLOB, -- JPEG kecil hasil ekstrak frame video (NULL kalau bukan video / ffmpeg gagal)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_files_user_folder ON files(user_id, folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_user_parent ON folders(user_id, parent_id);

-- Topic Telegram (forum topic) per kategori file, supaya tiap kategori
-- langsung terlihat sebagai thread terpisah di dalam grup.
CREATE TABLE IF NOT EXISTS telegram_topics (
  category TEXT PRIMARY KEY,
  thread_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Sesi upload resumable: file dipecah jadi block di sisi client,
-- diupload satu-satu, baru digabung + dikirim ke Telegram saat /complete.
CREATE TABLE IF NOT EXISTS upload_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  total_size INTEGER NOT NULL,
  block_size INTEGER NOT NULL,
  mime_type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Token yang dicabut sebelum masa berlaku aslinya habis (logout paksa / kompromi).
-- Disimpan pakai jti (JWT ID unik per token), bukan token mentah.
CREATE TABLE IF NOT EXISTS revoked_tokens (
  jti TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  revoked_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL -- buat pembersihan baris basi, sama dgn exp asli token
);
CREATE INDEX IF NOT EXISTS idx_revoked_expires ON revoked_tokens(expires_at);

-- Refresh token: opaque random string, HANYA hash-nya yang disimpan (bukan
-- token mentah). Access token (JWT) umurnya pendek; refresh token ini yang
-- dipakai buat minta access token baru tanpa harus login ulang password.
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_refresh_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_hash ON refresh_tokens(token_hash);

-- Kode sekali-pakai buat menghubungkan akun web dengan chat Telegram user
-- (dibutuhkan supaya bot boleh DM user itu -- Telegram tidak izinkan bot
-- mulai chat duluan ke user yang belum pernah kontak bot itu sendiri).
CREATE TABLE IF NOT EXISTS telegram_link_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_link_codes_expires ON telegram_link_codes(expires_at);

-- Kode sekali-pakai buat reset password lewat DM Telegram (dipakai kalau
-- user lupa password DAN akunnya sudah terhubung ke Telegram).
CREATE TABLE IF NOT EXISTS password_reset_codes (
  code TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reset_codes_expires ON password_reset_codes(expires_at);

-- Registrasi TIDAK langsung bikin baris di "users" -- data calon akun
-- (username/email/password yang sudah di-hash) ditaruh di sini dulu
-- sampai kode verifikasi di-email dikonfirmasi. Kalau kode gak pernah
-- dimasukkan / salah terus / kadaluarsa, akunnya emang gak akan pernah
-- kebuat sama sekali.
CREATE TABLE IF NOT EXISTS pending_registrations (
  code TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pending_reg_expires ON pending_registrations(expires_at);

-- Index full-text buat pencarian nama file. External-content FTS5: data
-- aslinya tetap di tabel files, FTS5 cuma nyimpen index tokennya supaya
-- hemat storage & otomatis sinkron lewat trigger di bawah.
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  original_name,
  content='files',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS files_fts_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, original_name) VALUES (new.id, new.original_name);
END;
CREATE TRIGGER IF NOT EXISTS files_fts_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, original_name) VALUES ('delete', old.id, old.original_name);
END;
CREATE TRIGGER IF NOT EXISTS files_fts_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, original_name) VALUES ('delete', old.id, old.original_name);
  INSERT INTO files_fts(rowid, original_name) VALUES (new.id, new.original_name);
END;
`);

// Migrasi ringan untuk DB lama yang dibuat sebelum kolom2 ini ada.
const userCols2 = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols2.includes('quota_bytes')) {
  db.exec('ALTER TABLE users ADD COLUMN quota_bytes INTEGER NOT NULL DEFAULT 0');
}
if (!userCols2.includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}
if (!userCols2.includes('telegram_chat_id')) {
  db.exec('ALTER TABLE users ADD COLUMN telegram_chat_id INTEGER');
}
if (!userCols2.includes('quota_notified_pct')) {
  db.exec('ALTER TABLE users ADD COLUMN quota_notified_pct INTEGER NOT NULL DEFAULT 0');
}
if (!userCols2.includes('email')) {
  db.exec('ALTER TABLE users ADD COLUMN email TEXT');
}
if (!userCols2.includes('email_verified')) {
  // User lama (sebelum fitur ini ada) otomatis dianggap terverifikasi --
  // mereka gak perlu diverifikasi ulang, akun mereka udah lama jalan.
  db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)');

const fileCols = db.prepare("PRAGMA table_info(files)").all().map((c) => c.name);
if (!fileCols.includes('thumbnail')) {
  db.exec('ALTER TABLE files ADD COLUMN thumbnail BLOB');
}

// User pertama yang pernah terdaftar otomatis jadi admin kalau belum ada
// admin sama sekali (mis. setelah migrasi dari versi lama tanpa is_admin).
const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
if (adminCount === 0) {
  const firstUser = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  if (firstUser) {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(firstUser.id);
  }
}

// Backfill index FTS5 kalau ada file lama dari sebelum tabel files_fts ada
// (external content FTS5 butuh diisi manual sekali untuk data yang sudah ada).
const ftsCount = db.prepare('SELECT COUNT(*) AS c FROM files_fts').get().c;
const filesCount = db.prepare('SELECT COUNT(*) AS c FROM files').get().c;
if (ftsCount < filesCount) {
  db.exec(`INSERT INTO files_fts(rowid, original_name) SELECT id, original_name FROM files
           WHERE id NOT IN (SELECT rowid FROM files_fts)`);
}

module.exports = db;
