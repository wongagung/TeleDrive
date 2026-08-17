const express = require('express');
const db = require('../db');
const { classifyCategory } = require('../telegram');
const { PREVIEWABLE_MIME, streamFile, getDescendantIds } = require('../fileStreaming');
const { publicShareLimiter } = require('../middleware/rateLimiters');

const router = express.Router();
router.use(publicShareLimiter);

function getShare(token) {
  const row = db.prepare('SELECT * FROM share_links WHERE token = ?').get(token);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) return null; // expired = anggap gak ada
  return row;
}

/** Cari file yang boleh diakses lewat share ini, dengan validasi supaya
 * link share FOLDER gak bisa disalahgunakan buat ngintip file di LUAR
 * folder yang di-share (lewat parameter fileId sembarangan). */
function resolveAccessibleFile(share, fileId) {
  if (share.file_id) {
    // Share tipe file: cuma file itu doang yang boleh, gak peduli fileId apa yang diminta.
    return db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(share.file_id, share.owner_id);
  }

  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, share.owner_id);
  if (!file) return null;

  const allowedFolderIds = new Set([share.folder_id, ...getDescendantIds(share.folder_id, share.owner_id)]);
  if (file.folder_id === null || !allowedFolderIds.has(file.folder_id)) return null; // di luar subtree yang di-share

  return file;
}

// ---------- Info dasar share (dipanggil pertama kali buka link) ----------
router.get('/:token', (req, res) => {
  const share = getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Link tidak ditemukan atau sudah kadaluarsa' });

  if (share.file_id) {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(share.file_id, share.owner_id);
    if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

    return res.json({
      type: 'file',
      file: {
        id: file.id,
        name: file.original_name,
        size: file.size,
        mime_type: file.mime_type,
        category: classifyCategory(file.original_name, file.mime_type),
        previewable: PREVIEWABLE_MIME.test(file.mime_type || ''),
      },
    });
  }

  const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND user_id = ?').get(share.folder_id, share.owner_id);
  if (!folder) return res.status(404).json({ error: 'Folder tidak ditemukan' });

  res.json({ type: 'folder', folder: { id: folder.id, name: folder.name } });
});

// ---------- Isi folder yang di-share (browsable, cuma dalam subtree-nya) ----------
router.get('/:token/list', (req, res) => {
  const share = getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Link tidak ditemukan atau sudah kadaluarsa' });
  if (!share.folder_id) return res.status(400).json({ error: 'Link ini bukan share folder' });

  const requested = req.query.folder ? parseInt(req.query.folder, 10) : share.folder_id;
  const allowedFolderIds = new Set([share.folder_id, ...getDescendantIds(share.folder_id, share.owner_id)]);
  if (!allowedFolderIds.has(requested)) {
    return res.status(403).json({ error: 'Folder ini di luar link yang dibagikan' });
  }

  const folders = db
    .prepare('SELECT id, name, created_at FROM folders WHERE user_id = ? AND parent_id = ?')
    .all(share.owner_id, requested);

  const files = db
    .prepare('SELECT id, original_name, size, mime_type, created_at FROM files WHERE user_id = ? AND folder_id = ? ORDER BY created_at DESC')
    .all(share.owner_id, requested)
    .map((f) => ({ ...f, category: classifyCategory(f.original_name, f.mime_type) }));

  const current = db.prepare('SELECT id, name FROM folders WHERE id = ?').get(requested);

  res.json({ folders, files, current: current || { id: share.folder_id, name: null }, root_folder_id: share.folder_id });
});

// ---------- Download / preview / thumbnail file dalam share ----------
router.get('/:token/download/:fileId', async (req, res) => {
  const share = getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Link tidak ditemukan atau sudah kadaluarsa' });

  const file = resolveAccessibleFile(share, parseInt(req.params.fileId, 10));
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });

  try {
    await streamFile(file, res, req, 'attachment');
  } catch (err) {
    console.error('[public share download] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal mengambil file' });
    else res.end();
  }
});

router.get('/:token/preview/:fileId', async (req, res) => {
  const share = getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Link tidak ditemukan atau sudah kadaluarsa' });

  const file = resolveAccessibleFile(share, parseInt(req.params.fileId, 10));
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });
  if (!PREVIEWABLE_MIME.test(file.mime_type || '')) {
    return res.status(415).json({ error: 'Tipe file ini tidak didukung untuk preview' });
  }

  try {
    await streamFile(file, res, req, 'inline');
  } catch (err) {
    console.error('[public share preview] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal mengambil file' });
    else res.end();
  }
});

router.get('/:token/thumbnail/:fileId', (req, res) => {
  const share = getShare(req.params.token);
  if (!share) return res.status(404).json({ error: 'Link tidak ditemukan atau sudah kadaluarsa' });

  const file = resolveAccessibleFile(share, parseInt(req.params.fileId, 10));
  if (!file || !file.thumbnail) return res.status(404).json({ error: 'Thumbnail tidak tersedia' });

  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.end(file.thumbnail);
});

module.exports = router;
