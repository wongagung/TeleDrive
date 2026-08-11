#!/usr/bin/env node
// Set kuota penyimpanan custom untuk satu user (override DEFAULT_QUOTA_MB).
// Jalankan dari root project: node scripts/set-quota.js <username> <mb>
//   node scripts/set-quota.js rama 20480     -> kasih 20GB ke user "rama"
//   node scripts/set-quota.js rama 0         -> balikin ke default global

require('dotenv').config();
const db = require('../src/db');

const [, , username, mbArg] = process.argv;

if (!username || mbArg === undefined) {
  console.error('Pakai: node scripts/set-quota.js <username> <mb>');
  console.error('Contoh: node scripts/set-quota.js rama 20480   (kasih 20GB)');
  console.error('        node scripts/set-quota.js rama 0        (balik ke default global)');
  process.exit(1);
}

const mb = parseInt(mbArg, 10);
if (Number.isNaN(mb) || mb < 0) {
  console.error('mb harus angka >= 0');
  process.exit(1);
}

const user = db.prepare('SELECT id, username, quota_bytes FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`User "${username}" tidak ditemukan.`);
  process.exit(1);
}

const bytes = mb * 1024 * 1024;
db.prepare('UPDATE users SET quota_bytes = ? WHERE id = ?').run(bytes, user.id);

console.log(
  mb === 0
    ? `Kuota "${username}" dikembalikan ke default global (DEFAULT_QUOTA_MB di .env).`
    : `Kuota "${username}" di-set ke ${mb}MB (${(mb / 1024).toFixed(2)}GB).`
);
