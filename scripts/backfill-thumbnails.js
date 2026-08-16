#!/usr/bin/env node
// Backfill thumbnail buat file gambar/video yang SUDAH keupload SEBELUM
// fitur thumbnail ada -- itu yang bikin grid view berat (grid nge-load
// file aslinya karena belum punya thumbnail kecil).
//
// Cara pakai (dari root project, di server):
//   node scripts/backfill-thumbnails.js
//
// Script ini nyambungin tiap chunk file dari Telegram jadi 1 file utuh
// sementara di disk, generate thumbnail 320px pakai ffmpeg (sama kayak
// upload baru), simpen ke database, lalu hapus file sementara itu.
// Diproses SATU PER SATU (bukan paralel) biar gak bikin server ngos-ngosan.
// Aman dijalankan berkali-kali -- file yang udah punya thumbnail dilewatin.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const { getLocalFilePath, classifyCategory } = require('../src/telegram');
const { generateImageThumbnail, generateVideoThumbnail } = require('../src/videoThumbnail');

const TMP_DIR = process.env.TMP_DIR || './tmp';

async function reconstructLocalFile(chunks, destPath) {
  const writeStream = fs.createWriteStream(destPath);
  for (const chunk of chunks) {
    const localPath = await getLocalFilePath(chunk.tg_file_id);
    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(localPath);
      readStream.on('error', reject);
      readStream.on('end', resolve);
      readStream.pipe(writeStream, { end: false });
    });
  }
  await new Promise((resolve, reject) => writeStream.end((err) => (err ? reject(err) : resolve())));
}

async function main() {
  const files = db.prepare('SELECT id, original_name, mime_type, chunks FROM files WHERE thumbnail IS NULL').all();

  const targets = files.filter((f) => {
    const cat = classifyCategory(f.original_name, f.mime_type);
    return cat === 'gambar' || cat === 'video';
  });

  console.log(`Ketemu ${targets.length} file (gambar/video) yang belum punya thumbnail.\n`);
  if (targets.length === 0) {
    console.log('Gak ada yang perlu diproses. Selesai.');
    return;
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });
  let done = 0;
  let failed = 0;

  for (const [i, file] of targets.entries()) {
    const cat = classifyCategory(file.original_name, file.mime_type);
    const tmpPath = path.join(TMP_DIR, `backfill-${file.id}-${Date.now()}`);
    process.stdout.write(`[${i + 1}/${targets.length}] ${file.original_name} ... `);

    try {
      const chunks = JSON.parse(file.chunks);
      await reconstructLocalFile(chunks, tmpPath);

      const thumb = cat === 'video'
        ? await generateVideoThumbnail(tmpPath)
        : await generateImageThumbnail(tmpPath);

      if (thumb) {
        db.prepare('UPDATE files SET thumbnail = ? WHERE id = ?').run(thumb, file.id);
        console.log('OK');
        done++;
      } else {
        console.log('DILEWATI (ffmpeg gagal proses file ini)');
        failed++;
      }
    } catch (err) {
      console.log(`GAGAL (${err.message})`);
      failed++;
    } finally {
      fs.unlink(tmpPath, () => {});
    }
  }

  console.log(`\nSelesai. ${done} berhasil, ${failed} gagal/dilewati, dari ${targets.length} total.`);
}

main()
  .catch((err) => {
    console.error('Fatal:', err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
