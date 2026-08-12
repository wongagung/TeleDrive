const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { getLocalFilePath } = require('../telegram');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();
router.use(requireAuth);

const VIDEO_MIME = /^video\/(?:mp4|webm|ogg|quicktime|x-m4v)$/i;

async function streamVideo(file, res) {
  const chunks = JSON.parse(file.chunks).sort((a, b) => a.seq - b.seq);
  res.setHeader('Content-Type', file.mime_type || 'video/mp4');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.original_name)}"`);
  res.setHeader('Content-Length', file.size);
  res.setHeader('Accept-Ranges', 'none');

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

router.get('/video-preview/:id', async (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!file) return res.status(404).json({ error: 'File tidak ditemukan' });
  if (!VIDEO_MIME.test(file.mime_type || '')) {
    return res.status(415).json({ error: 'Tipe file ini bukan video yang didukung' });
  }

  try {
    await streamVideo(file, res);
  } catch (err) {
    console.error('[video-preview] error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Gagal mengambil video dari Telegram' });
    else res.end();
  }
});

module.exports = router;
