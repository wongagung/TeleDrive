const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { getLocalFilePath, deleteMessage, classifyCategory } = require('../telegram');
const { sendFileToTelegram, CHUNK_SIZE } = require('../uploadPipeline');
const { requireAuth } = require('../middleware/authMiddleware');
const { uploadLimiter, blockLimiter } = require('../middleware/rateLimiters');
const { getQuotaBytes, getUsedBytes, assertWithinQuota } = require('../quota');

const router = express.Router();
router.use(requireAuth);

const TMP_DIR = process.env.TMP_DIR || './tmp';
const SESSIONS_DIR = path.join(TMP_DIR, 'sessions');
fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB, 10) || 10240; // default 10GB/file
const BLOCK_SIZE = (parseInt(process.env.UPLOAD_BLOCK_SIZE_MB, 10) || 8) * 1024 * 1024; // default 8MB/block

const PREVIEWABLE_MIME = /^image\/|^application\/pdf$|^video\/|^audio\//;

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

// ---------- Kuota penyimpanan ----------

router.get('/quota', (req, res) => {
  const used = getUsedBytes(req.user.id);
  const quota = getQuotaBytes(req.user.id);
  res.json({ used, quota });
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
    .all(req.user.id, folderId, folderId)
    .map((f) => ({ ...f, category: classifyCategory(f.original_name, f.mime_type) }));

  res.json({
    folders,
    files,
    quota: { used: getUsedBytes(req.user.id), total: getQuotaBytes(req.user.id) },
  });
});

// ---------- Pencarian nama file (full-text, FTS5) ----------

/** Bangun query FTS5 yang aman dari input user: tiap kata dikutip literal
 * (supaya kata seperti "OR"/"NOT" tidak diartikan sebagai operator FTS5),
 * dan diberi akhiran prefix match biar terasa "search-as-you-type". */
function buildFtsQuery(raw) {
  const tokens = raw.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');
}

/** Path folder dari root sampai folderId, buat ditampilkan di hasil pencarian. */
function getFolderPath(folderId, userId) {
  const parts = [];
  let current = folderId;
  let guard = 0;
  while (current !== null && current !== undefined && guard < 50) {
    const folder = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ? AND user_id = ?').get(current, userId);
    if (!folder) break;
    parts.unshift(folder.name);
    current = folder.parent_id;
    guard++;
  }
  return parts;
}

router.get('/search', (req, res) => {
  const q = (req.query.q || '').toString();
  if (!q.trim()) return res.json({ files: [] });

  const ftsQuery = buildFtsQuery(q);
  if (!ftsQuery) return res.json({ files: [] });

  let rows;
  try {
    rows = db
      .prepare(
        `SELECT files.id, files.original_name, files.size, files.mime_type, files.folder_id, files.created_at
         FROM files_fts JOIN files ON files.id = files_fts.rowid
         WHERE files_fts MATCH ? AND files.user_id = ?
         ORDER BY rank LIMIT 50`
      )
      .all(ftsQuery, req.user.id);
  } catch (err) {
    // Query FTS5 yang aneh (mis. cuma simbol) bisa bikin MATCH error -- anggap saja tidak ada hasil.
    return res.json({ files: [] });
  }

  const files = rows.map((f) => ({
    ...f,
    folder_path: getFolderPath(f.folder_id, req.user.id),
    category: classifyCategory(f.original_name, f.mime_type),
  }));
  res.json({ files });
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
    assertWithinQuota(req.user.id, size);
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
    // Cek ulang kuota di sini (bukan cuma di /init) buat jaga-jaga kalau ada
    // upload lain yang selesai duluan di antara /init dan /complete punya sesi ini.
    assertWithinQuota(req.user.id, session.total_size);

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
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Upload ke Telegram gagal: ' + err.message });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    db.prepare('DELETE FROM upload_sessions WHERE id = ?').run(session.id);
  }
});

// ---------- Download & Preview (reassemble chunk dari Telegram kalau perlu) ----------

/** Parse header Range HTTP standar ("bytes=start-end"). Return null kalau
 * tidak ada/tidak valid format, atau string 'invalid' kalau rentangnya di
 * luar ukuran file (buat balikin 416). */
function parseRange(rangeHeader, totalSize) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;

  let [, startStr, endStr] = match;
  if (!startStr && !endStr) return null;

  let start, end;
  if (!startStr) {
    // suffix range, contoh "bytes=-500" = 500 byte terakhir
    const suffixLength = parseInt(endStr, 10);
    start = Math.max(0, totalSize - suffixLength);
    end = totalSize - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr ? parseInt(endStr, 10) : totalSize - 1;
  }

  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= totalSize) {
    return 'invalid';
  }
  return { start, end };
}

/** Stream rentang byte [start, end] (inklusif) dari file yang mungkin
 * kepecah jadi beberapa chunk Telegram, dengan memetakan rentang global ke
 * rentang lokal per chunk. Ini yang bikin video bisa di-seek/scrub. */
async function streamByteRange(file, start, end, res) {
  const chunks = JSON.parse(file.chunks).sort((a, b) => a.seq - b.seq);

  let cumulativeOffset = 0;
  for (const chunk of chunks) {
    const chunkStart = cumulativeOffset;
    const chunkEnd = cumulativeOffset + chunk.size - 1;
    cumulativeOffset += chunk.size;

    if (end < chunkStart || start > chunkEnd) continue; // chunk ini di luar rentang yang diminta

    const localStart = Math.max(0, start - chunkStart);
    const localEnd = Math.min(chunk.size - 1, end - chunkStart);

    const localPath = await getLocalFilePath(chunk.tg_file_id);
    await new Promise((resolve, reject) => {
      const stream = fs.createReadStream(localPath, { start: localStart, end: localEnd });
      stream.on('error', reject);
      stream.on('end', resolve);
      stream.pipe(res, { end: false });
    });

    if (cumulativeOffset > end) break; // sudah lewat rentang yang diminta, gak perlu chunk berikutnya
  }
  res.end();
}

async function streamFile(file, res, req, disposition) {
  res.setHeader('Content-Disposition', `${disposition}; filename="${encodeURIComponent(file.original_name)}"`);
  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes'); // wajib biar <video>/<audio> tahu boleh minta Range

  const range = parseRange(req.headers.range, file.size);

  if (range === 'invalid') {
    res.setHeader('Content-Range', `bytes */${file.size}`);
    return res.status(416).end();
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
    await streamByteRange(file, range.start, range.end, res);
  } else {
    res.setHeader('Content-Length', file.size);
    await streamByteRange(file, 0, file.size - 1, res);
  }
}

router.get('/download/:id', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  try {
    await streamFile(file, res, req, 'attachment');
  } catch (err) {
    console.error('[download] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal mengambil file dari Telegram' });
    else res.end();
  }
});

// Preview inline di browser — gambar, PDF, video, dan audio. Dibatasi ke
// tipe ini supaya tidak ada risiko file lain (mis. HTML) dirender inline
// di origin yang sama (self-XSS lewat file yang diupload sendiri).
router.get('/preview/:id', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  if (!PREVIEWABLE_MIME.test(file.mime_type || '')) {
    return res.status(415).json({ error: 'Tipe file ini tidak didukung untuk preview' });
  }

  try {
    await streamFile(file, res, req, 'inline');
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

// ---------- Bulk operations (multi-select di UI) ----------
// Body selalu: { file_ids: [...], folder_ids: [...] } — keduanya opsional,
// item yang bukan milik user (atau tidak ada) dilewati diam-diam & dilaporkan
// di `skipped`, supaya satu item nyasar tidak menggagalkan seluruh batch.

function normalizeIds(arr) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n)))];
}

router.post('/bulk-delete', async (req, res) => {
  const fileIds = normalizeIds(req.body.file_ids);
  const folderIds = normalizeIds(req.body.folder_ids);

  let deletedFiles = 0;
  let deletedFolders = 0;
  const skipped = [];

  for (const id of fileIds) {
    const file = db.prepare('SELECT id, chunks FROM files WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!file) { skipped.push({ type: 'file', id }); continue; }

    const chunks = JSON.parse(file.chunks);
    await Promise.all(chunks.map((c) => (c.message_id ? deleteMessage(c.message_id) : null)));
    db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    deletedFiles++;
  }

  for (const id of folderIds) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!folder) { skipped.push({ type: 'folder', id }); continue; }

    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id); // cascade
    deletedFolders++;
  }

  res.json({ ok: true, deletedFiles, deletedFolders, skipped });
});

router.post('/bulk-move', (req, res) => {
  const fileIds = normalizeIds(req.body.file_ids);
  const folderIds = normalizeIds(req.body.folder_ids);
  const targetFolderId = req.body.target_folder_id ? parseInt(req.body.target_folder_id, 10) : null;

  try {
    assertFolderOwnership(targetFolderId, req.user.id);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  let movedFiles = 0;
  let movedFolders = 0;
  const skipped = [];

  for (const id of fileIds) {
    const file = db.prepare('SELECT id FROM files WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!file) { skipped.push({ type: 'file', id, reason: 'not_found' }); continue; }
    db.prepare('UPDATE files SET folder_id = ? WHERE id = ?').run(targetFolderId, file.id);
    movedFiles++;
  }

  for (const id of folderIds) {
    const folder = db.prepare('SELECT id FROM folders WHERE id = ? AND user_id = ?').get(id, req.user.id);
    if (!folder) { skipped.push({ type: 'folder', id, reason: 'not_found' }); continue; }
    if (id === targetFolderId) { skipped.push({ type: 'folder', id, reason: 'self' }); continue; }

    const descendants = getDescendantIds(id, req.user.id);
    if (targetFolderId !== null && descendants.includes(targetFolderId)) {
      skipped.push({ type: 'folder', id, reason: 'cycle' });
      continue;
    }

    try {
      db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(targetFolderId, id);
      movedFolders++;
    } catch (err) {
      skipped.push({ type: 'folder', id, reason: 'name_conflict' });
    }
  }

  res.json({ ok: true, movedFiles, movedFolders, skipped });
});

module.exports = router;
