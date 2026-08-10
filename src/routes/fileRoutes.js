const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { uploadChunk, getLocalFilePath, deleteMessage } = require('../telegram');
const { requireAuth } = require('../middleware/authMiddleware');
const { uploadLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(requireAuth);

const TMP_DIR = process.env.TMP_DIR || './tmp';
fs.mkdirSync(TMP_DIR, { recursive: true });

const CHUNK_SIZE = (parseInt(process.env.CHUNK_SIZE_MB, 10) || 1900) * 1024 * 1024;

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB, 10) || 10240; // default 10GB/file
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

// ---------- Folders ----------

/**
 * Pastikan folderId (kalau ada) benar-benar milik user yang login.
 * Dipakai sebelum insert folder baru atau file baru, supaya user tidak bisa
 * "menyisipkan" data ke pohon folder milik user lain lewat parent_id/folder_id
 * yang ditebak/diketahui.
 */
function assertFolderOwnership(folderId, userId) {
  if (folderId === null || folderId === undefined) return; // root, selalu valid
  const owned = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(folderId, userId);
  if (!owned) {
    const err = new Error('Folder tujuan tidak ditemukan atau bukan milik kamu');
    err.status = 403;
    throw err;
  }
}

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

// ---------- Upload (dengan chunking otomatis) ----------

router.post('/upload', uploadLimiter, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: `File melebihi batas maksimal ${MAX_UPLOAD_MB}MB` });
      }
      return res.status(400).json({ error: 'Upload gagal: ' + err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Tidak ada file' });

  const localPath = req.file.path;
  const originalName = req.file.originalname;
  const totalSize = req.file.size;
  const tempChunkPaths = [];

  try {
    const folderId = req.body.folder_id ? parseInt(req.body.folder_id, 10) : null;
    assertFolderOwnership(folderId, req.user.id);

    const chunks = [];

    if (totalSize <= CHUNK_SIZE) {
      const result = await uploadChunk(localPath, originalName);
      chunks.push({ seq: 0, tg_file_id: result.file_id, message_id: result.message_id, size: totalSize });
    } else {
      // Pecah file jadi beberapa bagian sebelum dikirim
      const fh = fs.openSync(localPath, 'r');
      let offset = 0;
      let seq = 0;
      const buf = Buffer.alloc(CHUNK_SIZE);

      try {
        while (offset < totalSize) {
          const bytesToRead = Math.min(CHUNK_SIZE, totalSize - offset);
          const bytesRead = fs.readSync(fh, buf, 0, bytesToRead, offset);
          const chunkPath = path.join(TMP_DIR, `${path.basename(localPath)}.part${seq}`);
          fs.writeFileSync(chunkPath, buf.subarray(0, bytesRead));
          tempChunkPaths.push(chunkPath);

          const result = await uploadChunk(chunkPath, `${originalName}.part${seq}`);
          chunks.push({ seq, tg_file_id: result.file_id, message_id: result.message_id, size: bytesRead });

          fs.unlinkSync(chunkPath);
          tempChunkPaths.pop();
          offset += bytesRead;
          seq += 1;
        }
      } finally {
        fs.closeSync(fh);
      }
    }

    db.prepare(
      'INSERT INTO files (user_id, folder_id, original_name, size, mime_type, chunks) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, folderId, originalName, totalSize, req.file.mimetype, JSON.stringify(chunks));

    fs.unlinkSync(localPath);
    res.json({ ok: true, name: originalName, size: totalSize });
  } catch (err) {
    console.error('[upload] error:', err);
    // Bersihkan semua file sementara, termasuk chunk yang belum sempat terhapus
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    for (const p of tempChunkPaths) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    if (err.status) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Upload ke Telegram gagal: ' + err.message });
  }
});

// ---------- Download (reassemble chunks kalau perlu) ----------

router.get('/download/:id', async (req, res) => {
  const file = db
    .prepare('SELECT * FROM files WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  const chunks = JSON.parse(file.chunks).sort((a, b) => a.seq - b.seq);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name)}"`);
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Length', file.size);

  try {
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
  } catch (err) {
    console.error('[download] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal mengambil file dari Telegram' });
    else res.end();
  }
});

router.delete('/files/:id', async (req, res) => {
  const file = db
    .prepare('SELECT id, chunks FROM files WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  const chunks = JSON.parse(file.chunks);
  // Coba hapus pesan aslinya juga dari grup (butuh bot jadi admin dengan izin hapus pesan)
  await Promise.all(chunks.map((c) => (c.message_id ? deleteMessage(c.message_id) : null)));

  db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
  res.json({ ok: true });
});

module.exports = router;
