const fs = require('fs');
const db = require('./db');
const { getLocalFilePath } = require('./telegram');

const PREVIEWABLE_MIME = /^image\/|^application\/pdf$|^video\/|^audio\//;

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

/** Kumpulkan semua id descendant (anak, cucu, dst) dari sebuah folder,
 * MILIK USER TERTENTU. Dipakai juga buat validasi "apakah folder X ini
 * beneran ada di dalam subtree folder yang di-share Y" -- biar link share
 * folder gak bisa disalahgunakan buat ngintip folder lain di luar yang
 * di-share (path traversal via folder_id di query string). */
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

module.exports = { PREVIEWABLE_MIME, parseRange, streamByteRange, streamFile, getDescendantIds };
