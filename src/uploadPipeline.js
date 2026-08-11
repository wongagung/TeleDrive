const fs = require('fs');
const path = require('path');
const db = require('./db');
const { uploadChunk, classifyCategory, getOrCreateTopic } = require('./telegram');

const CHUNK_SIZE = (parseInt(process.env.CHUNK_SIZE_MB, 10) || 1900) * 1024 * 1024;

/**
 * Kirim satu file (sudah utuh di disk lokal) ke Telegram, dipecah otomatis
 * kalau melebihi CHUNK_SIZE, lalu simpan metadatanya ke tabel `files`.
 * File lokal SELALU dihapus di akhir (sukses maupun gagal) oleh caller.
 *
 * @returns {Promise<{id:number, name:string, size:number}>}
 */
async function sendFileToTelegram({ localPath, originalName, totalSize, mimeType, userId, folderId }) {
  const category = classifyCategory(originalName, mimeType);
  const threadId = await getOrCreateTopic(category);

  const chunks = [];
  const tempChunkPaths = [];

  try {
    if (totalSize <= CHUNK_SIZE) {
      const result = await uploadChunk(localPath, originalName, threadId);
      chunks.push({ seq: 0, tg_file_id: result.file_id, message_id: result.message_id, size: totalSize });
    } else {
      const fh = fs.openSync(localPath, 'r');
      let offset = 0;
      let seq = 0;
      const buf = Buffer.alloc(CHUNK_SIZE);

      try {
        while (offset < totalSize) {
          const bytesToRead = Math.min(CHUNK_SIZE, totalSize - offset);
          const bytesRead = fs.readSync(fh, buf, 0, bytesToRead, offset);
          const chunkPath = path.join(path.dirname(localPath), `${path.basename(localPath)}.part${seq}`);
          fs.writeFileSync(chunkPath, buf.subarray(0, bytesRead));
          tempChunkPaths.push(chunkPath);

          const result = await uploadChunk(chunkPath, `${originalName}.part${seq}`, threadId);
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

    const info = db
      .prepare(
        'INSERT INTO files (user_id, folder_id, original_name, size, mime_type, chunks) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(userId, folderId, originalName, totalSize, mimeType, JSON.stringify(chunks));

    return { id: info.lastInsertRowid, name: originalName, size: totalSize, category };
  } catch (err) {
    for (const p of tempChunkPaths) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    throw err;
  }
}

module.exports = { sendFileToTelegram, CHUNK_SIZE };
