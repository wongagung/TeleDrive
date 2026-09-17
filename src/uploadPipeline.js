const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const db = require('./db');
const { uploadChunk, classifyCategory, getOrCreateTopic } = require('./telegram');
const { generateVideoThumbnail, generateImageThumbnail } = require('./videoThumbnail');

// 500 MB default: safely below Telegram Local Bot API's 2000 MB per-upload
// limit and keeps each Telegram operation bounded even on slower connections.
const CHUNK_SIZE = (parseInt(process.env.CHUNK_SIZE_MB, 10) || 500) * 1024 * 1024;

/**
 * Copy a byte range from a large source file to a temporary chunk without
 * allocating a giant Buffer. This keeps RAM usage small even for multi-GB files.
 */
async function copyFileRange(sourcePath, destinationPath, start, length) {
  if (length <= 0) throw new Error('Panjang chunk harus lebih dari 0');

  await pipeline(
    fs.createReadStream(sourcePath, {
      start,
      end: start + length - 1,
      highWaterMark: 8 * 1024 * 1024,
    }),
    fs.createWriteStream(destinationPath, {
      flags: 'w',
    })
  );
}

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

  // Generate thumbnail (video: ekstrak 1 frame, gambar: resize kecil)
  // KONKUREN sama proses upload ke Telegram (bukan berurutan) supaya gak
  // nambah waktu tunggu user. Best-effort: kalau gagal (ffmpeg gak ada /
  // file corrupt), tetap null, upload tetap lanjut normal.
  let thumbnailPromise = Promise.resolve(null);
  if (category === 'video') thumbnailPromise = generateVideoThumbnail(localPath);
  else if (category === 'gambar') thumbnailPromise = generateImageThumbnail(localPath);

  const chunks = [];
  const tempChunkPaths = [];

  try {
    if (totalSize <= CHUNK_SIZE) {
      const result = await uploadChunk(localPath, originalName, threadId);
      chunks.push({ seq: 0, tg_file_id: result.file_id, message_id: result.message_id, size: totalSize });
    } else {
      let offset = 0;
      let seq = 0;

      while (offset < totalSize) {
        const bytesToRead = Math.min(CHUNK_SIZE, totalSize - offset);
        const chunkPath = path.join(path.dirname(localPath), `${path.basename(localPath)}.part${seq}`);
        tempChunkPaths.push(chunkPath);

        await copyFileRange(localPath, chunkPath, offset, bytesToRead);

        const actualSize = fs.statSync(chunkPath).size;
        if (actualSize !== bytesToRead) {
          throw new Error(`Ukuran chunk tidak sesuai: expected=${bytesToRead}, actual=${actualSize}`);
        }

        const result = await uploadChunk(chunkPath, `${originalName}.part${seq}`, threadId);
        chunks.push({ seq, tg_file_id: result.file_id, message_id: result.message_id, size: actualSize });

        fs.unlinkSync(chunkPath);
        tempChunkPaths.pop();
        offset += actualSize;
        seq += 1;
      }
    }

    const thumbnail = await thumbnailPromise;

    const info = db
      .prepare(
        'INSERT INTO files (user_id, folder_id, original_name, size, mime_type, chunks, thumbnail) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(userId, folderId, originalName, totalSize, mimeType, JSON.stringify(chunks), thumbnail);

    return { id: info.lastInsertRowid, name: originalName, size: totalSize, category };
  } catch (err) {
    for (const p of tempChunkPaths) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    throw err;
  }
}

module.exports = { sendFileToTelegram, CHUNK_SIZE };
