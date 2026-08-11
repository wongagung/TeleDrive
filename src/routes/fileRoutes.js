const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { getLocalFilePath, deleteMessage } = require('../telegram');
const { sendFileToTelegram, CHUNK_SIZE } = require('../uploadPipeline');
const { requireAuth } = require('../middleware/authMiddleware');
const { uploadLimiter, blockLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(requireAuth);

const TMP_DIR = process.env.TMP_DIR || './tmp';
const SESSIONS_DIR = path.join(TMP_DIR, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB, 10) || 10240; // default 10GB/file
const BLOCK_SIZE = (parseInt(process.env.UPLOAD_BLOCK_SIZE_MB, 10) || 8) * 1024 * 1024; // default 8MB/block

const PREVIEWABLE_MIME = /^image\/|^application\/pdf$/;

// ---------- Helper: ownership & cycle checks ----------

function assertFolderOwnership(folderId, userId) {
  if (folderId === null || folderId === undefined) return; // root, selalu valid
  const owned = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId);
  if (!owned) {
    const err = new Error('Folder tujuan tidak ditemukan atau bukan milik kamu');
    err.status = 403;
    throw err;
  }
}

/** Kumpulkan semua id descendant (anak, cucu, dst) dari sebuah folder. */
function getDescendantIds(folderId, userId) {
  const ids = [];
  let frontier = [folderId];
  while (frontier.length) {
    const rows = db
      .prepare(`SELECT id FROM folders WHERE user_id = ? AND parent_id IN (${frontier.map(() => '?').join(',')})`)
      .all(userId, ...frontier);
    const nextIds = rows.map((r) => r.id);
    ids.push(...nextIds);
    frontier = nextIds;
  }
  return ids;
}

// ---------- Folders ----------

router.post('/folders', (req, res) => {
  const { name, parent_id } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nama folder wajib' });
  if (name.length > 255) return res.status(400).json({ error: 'Nama folder terlalu panjang' });

  const parentId = parent_id ? parseInt(parent_id, 10) : null;

  try {
    assertFolderOwnership(parentId, req.user.id);
    const info = db
      .prepare('INSERT INTO folders (user_id, parent_id, name) VALUES (?, ?, ?)')
      .run(req.user.id, parentId, name.trim());
    res.json({ id: info.lastInsertRowid, name: name.trim(), parent_id: parentId });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    if (String(err).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Folder dengan nama itu sudah ada di sini' });
    }
    res.status(500).json({ error: 'Gagal membuat folder' });
  }
});

// Rename dan/atau pindahkan folder.
router.patch('/folders/:id', (req, res) => {
  const folder = db
    .prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder tidak ditemukan' });

  const { name, parent_id } = req.body;
  const newName = name !== undefined ? name.trim() : folder.name;
  if (!newName) return res.status(400).json({ error: 'Nama folder tidak boleh kosong' });

  let newParentId = folder.parent_id;
  if (parent_id !== undefined) {
    newParentId = parent_id === null ? null : parseInt(parent_id, 10);

    if (newParentId === folder.id) {
      return res.status(400).json({ error: 'Folder tidak bisa dipindah ke dalam dirinya sendiri' });
    }
    try {
      assertFolderOwnership(newParentId, req.user.id);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
    if (newParentId !== null) {
      const descendants = getDescendantIds(folder.id, req.user.id);
      if (descendants.includes(newParentId)) {
        return res.status(400).json({ error: 'Tidak bisa memindahkan folder ke dalam sub-foldernya sendiri' });
      }
    }
  }

  try {
    db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(newName, newParentId, folder.id);
    res.json({ id: folder.id, name: newName, parent_id: newParentId });
  } catch (err) {
    if (String(err).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Sudah ada folder dengan nama itu di tujuan' });
    }
    res.status(500).json({ error: 'Gagal mengubah folder' });
  }
});

router.delete('/folders/:id', (req, res) => {
  const folder = db
    .prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!folder) return res.status(404).json({ error: 'Folder tidak ditemukan' });

  db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id); // cascade hapus subfolder & file
  res.json({ ok: true });
});

// ---------- List isi folder ----------

router.get('/list', (req, res) => {
  const folderId = req.query.folder_id ? parseInt(req.query.folder_id, 10) : null;

  const folders = db
    .prepare('SELECT id, name, created_at FROM folders WHERE user_id = ? AND (parent_id IS ? OR parent_id = ?)')
    .all(req.user.id, folderId, folderId);

  const files = db
    .prepare(
      'SELECT id, original_name, size, mime_type, created_at FROM files WHERE user_id = ? AND (folder_id IS ? OR folder_id = ?) ORDER BY created_at DESC'
    )
    .all(req.user.id, folderId, folderId);

  res.json({ folders, files });
});

// ---------- Rename / pindah file ----------

router.patch('/files/:id', (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  const { name, folder_id } = req.body;
  const newName = name !== undefined ? name.trim() : file.original_name;
  if (!newName) return res.status(400).json({ error: 'Nama file tidak boleh kosong' });

  let newFolderId = file.folder_id;
  if (folder_id !== undefined) {
    newFolderId = folder_id === null ? null : parseInt(folder_id, 10);
    try {
      assertFolderOwnership(newFolderId, req.user.id);
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message });
    }
  }

  db.prepare('UPDATE files SET original_name = ?, folder_id = ? WHERE id = ?').run(newName, newFolderId, file.id);
  res.json({ id: file.id, name: newName, folder_id: newFolderId });
});

// ---------- Resumable Upload ----------
// Alur: POST /upload/init -> beberapa kali PUT /upload/:id/block/:index
//       -> (opsional GET /upload/:id/status buat resume) -> POST /upload/:id/complete

router.post('/upload/init', uploadLimiter, (req, res) => {
  const { filename, size, mime_type, folder_id } = req.body;

  if (!filename || !size || size <= 0) {
    return res.status(400).json({ error: 'filename dan size wajib diisi' });
  }
  if (size > MAX_UPLOAD_MB * 1024 * 1024) {
    return res.status(413).json({ error: `File melebihi batas maksimal ${MAX_UPLOAD_MB}MB` });
  }

  const folderId = folder_id ? parseInt(folder_id, 10) : null;
  try {
    assertFolderOwnership(folderId, req.user.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO upload_sessions (id, user_id, folder_id, original_name, total_size, block_size, mime_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, req.user.id, folderId, filename, size, BLOCK_SIZE, mime_type || 'application/octet-stream');

  fs.mkdirSync(path.join(SESSIONS_DIR, id), { recursive: true });

  res.json({
    upload_id: id,
    block_size: BLOCK_SIZE,
    total_blocks: Math.ceil(size / BLOCK_SIZE),
  });
});

function getOwnedSession(sessionId, userId) {
  return db.prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?').get(sessionId, userId);
}

// Upload satu block. Idempotent — kirim ulang block yang sama akan menimpa, aman untuk retry.
router.put(
  '/upload/:id/block/:index',
  blockLimiter,
  express.raw({ type: '*/*', limit: `${Math.ceil(BLOCK_SIZE / 1024 / 1024) + 2}mb` }),
  (req, res) => {
  const session = getOwnedSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Sesi upload tidak ditemukan' });

  const index = parseInt(req.params.index, 10);
  const totalBlocks = Math.ceil(session.total_size / session.block_size);
  if (Number.isNaN(index) || index < 0 || index >= totalBlocks) {
    return res.status(400).json({ error: 'Index block tidak valid' });
  }
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'Body block kosong' });
  }

  const blockPath = path.join(SESSIONS_DIR, session.id, `block-${index}`);
  fs.writeFileSync(blockPath, req.body);
  res.json({ ok: true, index, received: req.body.length });
});

// Cek block mana saja yang sudah diterima server — dipakai client untuk resume.
router.get('/upload/:id/status', (req, res) => {
  const session = getOwnedSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Sesi upload tidak ditemukan' });

  const dir = path.join(SESSIONS_DIR, session.id);
  const received = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .filter((f) => f.startsWith('block-'))
        .map((f) => parseInt(f.slice(6), 10))
        .sort((a, b) => a - b)
    : [];

  res.json({
    total_blocks: Math.ceil(session.total_size / session.block_size),
    received_blocks: received,
  });
});

router.delete('/upload/:id', (req, res) => {
  const session = getOwnedSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Sesi upload tidak ditemukan' });

  fs.rmSync(path.join(SESSIONS_DIR, session.id), { recursive: true, force: true });
  db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(session.id);
  res.json({ ok: true });
});

// Gabungkan semua block, kirim ke Telegram, simpan metadata final.
router.post('/upload/:id/complete', uploadLimiter, async (req, res) => {
  const session = getOwnedSession(req.params.id, req.user.id);
  if (!session) return res.status(404).json({ error: 'Sesi upload tidak ditemukan' });

  const sessionDir = path.join(SESSIONS_DIR, session.id);
  const totalBlocks = Math.ceil(session.total_size / session.block_size);

  // Pastikan semua block sudah lengkap sebelum digabung
  for (let i = 0; i < totalBlocks; i++) {
    if (!fs.existsSync(path.join(sessionDir, `block-${i}`))) {
      return res.status(409).json({ error: `Block ${i} belum diterima, upload belum lengkap` });
    }
  }

  const assembledPath = path.join(sessionDir, 'assembled');
  const out = fs.createWriteStream(assembledPath);
  try {
    for (let i = 0; i < totalBlocks; i++) {
      const chunkBuf = fs.readFileSync(path.join(sessionDir, `block-${i}`));
      await new Promise((resolve, reject) => out.write(chunkBuf, (err) => (err ? reject(err) : resolve())));
    }
    await new Promise((resolve) => out.end(resolve));

    const result = await sendFileToTelegram({
      localPath: assembledPath,
      originalName: session.original_name,
      totalSize: session.total_size,
      mimeType: session.mime_type,
      userId: req.user.id,
      folderId: session.folder_id,
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[upload/complete] error:', err);
    res.status(500).json({ error: 'Upload ke Telegram gagal: ' + err.message });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(session.id);
  }
});

// ---------- Download & Preview (reassemble chunk dari Telegram kalau perlu) ----------

async function streamFileChunks(file, res, disposition) {
  const chunks = JSON.parse(file.chunks).sort((a, b) => a.seq - b.seq);

  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.original_name)}"`);
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', file.size);

  for (const chunk of chunks) {
    const localPath = await getLocalFilePath(chunk.tg_file_id);
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(localPath);
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res, { end: false });
    });
  }
  res.end();
}

router.get('/download/:id', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  try {
    await streamFileChunks(file, res, 'attachment');
  } catch (err) {
    console.error('[download] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal mengambil file dari Telegram' });
    else res.end();
  }
});

// Preview inline di browser — dibatasi hanya gambar & PDF supaya tidak ada
// risiko file lain (mis. HTML) dirender inline di origin yang sama.
router.get('/preview/:id', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  if (!PREVIEWABLE_MIME.test(file.mime_type || '')) {
    return res.status(415).json({ error: 'Tipe file ini tidak didukung untuk preview' });
  }

  try {
    await streamFileChunks(file, res, 'inline');
  } catch (err) {
    console.error('[preview] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal mengambil file dari Telegram' });
    else res.end();
  }
});

router.delete('/files/:id', async (req, res) => {
  const file = db.prepare('SELECT id, chunks FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  const chunks = JSON.parse(file.chunks);
  await Promise.all(chunks.map((c) => (c.message_id ? deleteMessage(c.message_id) : null)));

  db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
  res.json({ ok: true });
});

module.exports = router;
