#!/usr/bin/env node
// Promote/demote user jadi admin lewat CLI (jalur darurat kalau kepepet,
// misal semua admin ke-lockout dari web). Biasanya cukup pakai admin panel web.
// Jalankan dari root project: node scripts/make-admin.js <username> [on|off]

require('dotenv').config();
const db = require('../src/db');

const [, , username, mode] = process.argv;

if (!username) {
  console.error('Pakai: node scripts/make-admin.js <username> [on|off]');
  console.error('Default mode = on (jadikan admin). Pakai "off" buat cabut status admin.');
  process.exit(1);
}

const makeAdmin = mode !== 'off';

const user = db.prepare('SELECT id, username, is_admin FROM users WHERE username = ?').get(username);
if (!user) {
  console.error(`User "${username}" tidak ditemukan.`);
  process.exit(1);
}

if (!makeAdmin) {
  const adminCount = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_admin = 1').get().c;
  if (adminCount <= 1 && user.is_admin) {
    console.error('Tidak bisa mencabut admin terakhir yang tersisa.');
    process.exit(1);
  }
}

db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(makeAdmin ? 1 : 0, user.id);
console.log(`"${username}" sekarang ${makeAdmin ? 'ADMIN' : 'BUKAN admin'}.`);
