const crypto = require('crypto');
const db = require('./db');
const { sendMessage, getUpdates } = require('./telegram');

const LINK_CODE_TTL_MINUTES = 10;

/** Buat kode sekali-pakai buat user hubungkan akunnya ke Telegram. */
function createLinkCode(userId) {
  // Bersihkan kode lama milik user ini dulu (kalau generate ulang sebelum expired)
  db.prepare('DELETE FROM telegram_link_codes WHERE user_id = ?').run(userId);

  const code = crypto.randomBytes(4).toString('hex').toUpperCase(); // 8 karakter, gampang diketik manual
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MINUTES * 60 * 1000).toISOString();

  db.prepare('INSERT INTO telegram_link_codes (code, user_id, expires_at) VALUES (?, ?, ?)').run(code, userId, expiresAt);
  return { code, expiresInMinutes: LINK_CODE_TTL_MINUTES };
}

function consumeLinkCode(code) {
  const row = db
    .prepare("SELECT * FROM telegram_link_codes WHERE code = ? AND expires_at > datetime('now')")
    .get(code);
  if (!row) return null;
  db.prepare('DELETE FROM telegram_link_codes WHERE code = ?').run(code);
  return row;
}

async function handlePrivateMessage(message) {
  const text = (message.text || '').trim();
  const chatId = message.chat.id;

  const match = /^\/start\s+([A-Za-z0-9]+)$/.exec(text) || /^\/link\s+([A-Za-z0-9]+)$/.exec(text);

  if (!match) {
    // Pesan lain (bukan kode valid) -- balas sekali dengan petunjuk, jangan diam
    // supaya user gak bingung, tapi juga jangan jadi chatbot beneran.
    try {
      await sendMessage(
        chatId,
        'Halo! Untuk menghubungkan akun Telegram Drive kamu, buka halaman web drive-nya, ' +
        'klik "🔗 Hubungkan Telegram", lalu kirim kode yang muncul ke sini.'
      );
    } catch (err) {
      console.warn('[telegramBot] gagal balas pesan:', err.message);
    }
    return;
  }

  const code = match[1].toUpperCase();
  const linked = consumeLinkCode(code);

  if (!linked) {
    try {
      await sendMessage(chatId, '❌ Kode tidak valid atau sudah kedaluwarsa. Coba generate kode baru dari halaman web.');
    } catch (err) {
      console.warn('[telegramBot] gagal balas pesan:', err.message);
    }
    return;
  }

  db.prepare('UPDATE users SET telegram_chat_id = ? WHERE id = ?').run(chatId, linked.user_id);

  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(linked.user_id);
  try {
    await sendMessage(
      chatId,
      `✅ Berhasil! Akun Telegram kamu sekarang terhubung ke Telegram Drive (${user ? user.username : ''}). ` +
      `Kamu akan dapat notifikasi DM dari sini kalau kuota penyimpanan hampir penuh.`
    );
  } catch (err) {
    console.warn('[telegramBot] gagal kirim konfirmasi:', err.message);
  }
}

let polling = false;
let pollOffset = undefined;

/** Loop long-polling getUpdates, jalan terus sampai server mati. Dipanggil
 * sekali dari server.js saat startup (fire-and-forget, gak di-await). */
async function startPolling() {
  if (polling) return;
  polling = true;
  console.log('[telegramBot] mulai polling update Telegram (buat proses hubung-akun)...');

  while (polling) {
    try {
      const updates = await getUpdates(pollOffset, 25);
      for (const update of updates) {
        pollOffset = update.update_id + 1;
        const msg = update.message;
        if (msg && msg.chat && msg.chat.type === 'private') {
          await handlePrivateMessage(msg);
        }
      }
    } catch (err) {
      console.warn('[telegramBot] error saat polling, coba lagi dalam 5 detik:', err.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

function stopPolling() {
  polling = false;
}

module.exports = { createLinkCode, startPolling, stopPolling };
