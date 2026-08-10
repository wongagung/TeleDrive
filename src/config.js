const crypto = require('crypto');

const WEAK_SECRETS = new Set([
  '', 'weak', 'secret', 'changeme', 'password', '123456', 'test', 'default',
  'ganti-dengan-random-string-panjang-dan-acak', 'jwt_secret', 'your-secret-key',
]);

function assertStrongJwtSecret() {
  const secret = process.env.JWT_SECRET || '';

  if (WEAK_SECRETS.has(secret.toLowerCase()) || secret.length < 32) {
    console.error('\n============================================================');
    console.error('FATAL: JWT_SECRET tidak aman atau belum diganti dari default.');
    console.error('Server MENOLAK untuk start supaya tidak ada yang bisa forge token');
    console.error('login dan mengambil alih akun manapun.');
    console.error('');
    console.error('Set JWT_SECRET di .env dengan string acak minimal 32 karakter.');
    console.error('Contoh generate secret yang aman:');
    console.error('  ' + crypto.randomBytes(32).toString('hex'));
    console.error('============================================================\n');
    process.exit(1);
  }
}

module.exports = { assertStrongJwtSecret };
