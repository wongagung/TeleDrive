const fs = require('fs');
const path = require('path');
require('dotenv').config();
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GROUP_ID = process.env.GROUP_ID;
const LOCAL_API_URL = process.env.LOCAL_API_URL || 'http://127.0.0.1:8081';
const BASE = `${LOCAL_API_URL}/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !GROUP_ID) {
  console.warn('[telegram.js] BOT_TOKEN / GROUP_ID belum di-set di .env');
}

// Kategori file yang didukung -> nama & ikon topic di grup Telegram.
// Tiap kategori otomatis dapat satu Topic (thread) terpisah supaya
// langsung terlihat pengelompokannya begitu buka grup di Telegram.
const CATEGORIES = {
  dokumen: { label: '📄 Dokumen' },
  gambar: { label: '🖼️ Gambar' },
  video: { label: '🎬 Video' },
  audio: { label: '🎵 Audio' },
  arsip: { label: '🗜️ Arsip' },
  lainnya: { label: '📦 Lainnya' },
};

const EXT_MAP = {
  // dokumen
  pdf: 'dokumen', doc: 'dokumen', docx: 'dokumen', xls: 'dokumen', xlsx: 'dokumen',
  ppt: 'dokumen', pptx: 'dokumen', txt: 'dokumen', csv: 'dokumen', odt: 'dokumen',
  // gambar
  jpg: 'gambar', jpeg: 'gambar', png: 'gambar', gif: 'gambar', webp: 'gambar',
  svg: 'gambar', bmp: 'gambar', heic: 'gambar',
  // video
  mp4: 'video', mkv: 'video', mov: 'video', avi: 'video', webm: 'video', flv: 'video',
  // audio
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
  // arsip
  zip: 'arsip', rar: 'arsip', '7z': 'arsip', tar: 'arsip', gz: 'arsip',
};

/**
 * Tentukan kategori file berdasarkan ekstensi nama file (fallback: mime type).
 */
function classifyCategory(originalName, mimeType) {
  const ext = (path.extname(originalName || '').slice(1) || '').toLowerCase();
  if (EXT_MAP[ext]) return EXT_MAP[ext];

  if (mimeType) {
    if (mimeType.startsWith('image/')) return 'gambar';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType === 'application/pdf') return 'dokumen';
    if (mimeType.includes('zip') || mimeType.includes('compressed')) return 'arsip';
  }
  return 'lainnya';
}

/**
 * Ambil thread_id topic Telegram untuk kategori tertentu. Kalau belum ada,
 * buat topic baru di grup (butuh grup dalam mode Forum + bot admin dengan
 * izin "Manage Topics"), lalu cache di DB supaya tidak buat topic berulang.
 */
async function getOrCreateTopic(category) {
  const cached = db.prepare('SELECT thread_id FROM telegram_topics WHERE category = ?').get(category);
  if (cached) return cached.thread_id;

  const meta = CATEGORIES[category] || CATEGORIES.lainnya;
  const form = new URLSearchParams();
  form.append('chat_id', GROUP_ID);
  form.append('name', meta.label);

  const res = await fetch(`${BASE}/createForumTopic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const data = await res.json();

  if (!data.ok) {
    throw new Error(
      `Gagal buat Topic Telegram untuk kategori "${category}": ${data.description || JSON.stringify(data)}. ` +
      `Pastikan grup sudah diaktifkan sebagai Forum (Topics) dan bot adalah admin dengan izin "Manage Topics".`
    );
  }

  const threadId = data.result.message_thread_id;
  db.prepare('INSERT INTO telegram_topics (category, thread_id) VALUES (?, ?)').run(category, threadId);
  return threadId;
}

/**
 * Upload satu chunk (file di disk lokal) ke grup Telegram, di dalam Topic
 * sesuai kategorinya. Karena Local Bot API Server jalan di mesin yang sama,
 * kita kirim path lokal langsung (jauh lebih cepat daripada multipart).
 *
 * @param {string} localFilePath
 * @param {string} displayName
 * @param {number} [threadId] - message_thread_id topic tujuan (opsional)
 * @returns {Promise<{file_id: string, file_size: number, message_id: number}>}
 */
async function uploadChunk(localFilePath, displayName, threadId) {
  const absPath = path.resolve(localFilePath);

  const form = new URLSearchParams();
  form.append('chat_id', GROUP_ID);
  form.append('document', absPath);
  form.append('caption', displayName);
  if (threadId) form.append('message_thread_id', threadId);

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
 * Ambil path lokal file dari Telegram berdasarkan file_id. Dengan Local Bot
 * API Server (--local), file_path yang dikembalikan adalah path absolut di
 * disk mesin ini — bisa langsung dibaca dengan fs.
 *
 * PENTING: Local Bot API Server MENYIMPAN salinan file ini di direktori
 * --dir miliknya sendiri (bukan cuma numpang lewat). Ini konsumsi disk VM
 * yang terpisah dari TMP_DIR aplikasi ini, dan tidak dibersihkan otomatis
 * oleh Local Bot API Server. Jalankan skrip cleanup (lihat README) secara
 * berkala supaya disk VM tidak habis.
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

module.exports = {
  uploadChunk,
  getLocalFilePath,
  deleteMessage,
  classifyCategory,
  getOrCreateTopic,
  CATEGORIES,
};
