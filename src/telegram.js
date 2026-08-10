const fs = require('fs');
const path = require('path');
require('dotenv').config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const LOCAL_API_URL = process.env.LOCAL_API_URL || 'http://127.0.0.1:8081';
const BASE = `${LOCAL_API_URL}/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !GROUP_ID) {
  console.warn('[telegram.js] BOT_TOKEN / GROUP_ID belum di-set di .env');
}

/**
 * Upload satu chunk (file yang sudah tersimpan di disk lokal) ke grup Telegram.
 * Karena Local Bot API Server jalan di mesin yang sama, kita kirim path lokal
 * langsung (didukung khusus oleh Local Bot API Server, jauh lebih cepat
 * daripada multipart upload biasa).
 *
 * @param {string} localFilePath - path absolut ke file di disk
 * @param {string} displayName - nama file yang ditampilkan di Telegram
 * @returns {Promise<{file_id: string, file_size: number, message_id: number}>}
 */
async function uploadChunk(localFilePath, displayName) {
  const absPath = path.resolve(localFilePath);

  const form = new URLSearchParams();
  form.append('chat_id', GROUP_ID);
  // Local Bot API Server: jika path file readable oleh server (sama mesin),
  // bisa dikirim sebagai string path langsung.
  form.append('document', absPath);
  form.append('caption', displayName);

  const res = await fetch(`${BASE}/sendDocument`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram sendDocument gagal: ${JSON.stringify(data)}`);
  }

  const doc = data.result.document;
  return {
    file_id: doc.file_id,
    file_size: doc.file_size,
    message_id: data.result.message_id,
  };
}

/**
 * Ambil path lokal file dari Telegram berdasarkan file_id.
 * Dengan Local Bot API Server (--local), file_path yang dikembalikan
 * adalah path absolut di disk mesin ini — bisa langsung dibaca dengan fs.
 *
 * @param {string} fileId
 * @returns {Promise<string>} path absolut ke file di disk
 */
async function getLocalFilePath(fileId) {
  const res = await fetch(`${BASE}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram getFile gagal: ${JSON.stringify(data)}`);
  }

  const filePath = data.result.file_path;

  // Jika Local API dijalankan dengan --local, file_path sudah path absolut.
  // Kalau bukan (mode non-local), kita perlu download lewat HTTP endpoint /file/.
  if (fs.existsSync(filePath)) {
    return filePath;
  }

  // Fallback: mode non-local, download ke tmp lalu kembalikan path tmp.
  const tmpDir = process.env.TMP_DIR || './tmp';
  fs.mkdirSync(tmpDir, { recursive: true });
  const dest = path.join(tmpDir, `dl-${Date.now()}-${path.basename(filePath)}`);
  const dlRes = await fetch(`${LOCAL_API_URL}/file/bot${BOT_TOKEN}/${filePath}`);
  const buf = Buffer.from(await dlRes.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

/**
 * Hapus pesan (dan filenya) dari grup. Bot harus jadi admin grup dengan
 * izin "Delete Messages" agar ini berhasil.
 */
async function deleteMessage(messageId) {
  try {
    const form = new URLSearchParams();
    form.append('chat_id', GROUP_ID);
    form.append('message_id', messageId);
    const res = await fetch(`${BASE}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    const data = await res.json();
    if (!data.ok) console.warn('[deleteMessage] gagal:', data.description);
  } catch (err) {
    console.warn('[deleteMessage] error:', err.message);
  }
}

module.exports = { uploadChunk, getLocalFilePath, deleteMessage };
