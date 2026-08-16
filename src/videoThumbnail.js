const { execFile } = require('child_process');

let ffmpegChecked = false;
let ffmpegAvailable = false;

/** Cek sekali apakah ffmpeg ada di PATH. Hasilnya di-cache biar gak nyoba
 * spawn ffmpeg berulang-ulang kalau memang gak keinstall. */
function checkFfmpegAvailable() {
  return new Promise((resolve) => {
    if (ffmpegChecked) return resolve(ffmpegAvailable);
    execFile('ffmpeg', ['-version'], { timeout: 5000 }, (err) => {
      ffmpegChecked = true;
      ffmpegAvailable = !err;
      if (!ffmpegAvailable) {
        console.warn(
          '[videoThumbnail] ffmpeg tidak ditemukan -- thumbnail video dinonaktifkan. ' +
          'Install dengan: sudo apt install ffmpeg (lalu restart service)'
        );
      }
      resolve(ffmpegAvailable);
    });
  });
}

/**
 * Ekstrak satu frame dari video lokal jadi JPEG kecil (buat thumbnail grid view).
 * Best-effort: return null (bukan throw) kalau ffmpeg gak ada / videonya gagal
 * diproses, supaya upload tetap sukses walau thumbnail gagal dibuat.
 *
 * @param {string} localPath - path video di disk lokal
 * @returns {Promise<Buffer|null>}
 */
async function generateVideoThumbnail(localPath) {
  const available = await checkFfmpegAvailable();
  if (!available) return null;

  return new Promise((resolve) => {
    const args = [
      '-y',
      '-hide_banner', '-loglevel', 'error', // biar log gak berisik pas gagal (skip banner version dkk)
      '-ss', '1', // ambil frame di detik ke-1 (hindari frame hitam/blank di detik ke-0 pada banyak video)
      '-i', localPath,
      '-frames:v', '1',
      '-vf', 'scale=320:-1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '5',
      'pipe:1',
    ];

    execFile('ffmpeg', args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err || !stdout || stdout.length === 0) {
        console.warn('[videoThumbnail] gagal generate thumbnail:', err ? err.message : 'output kosong');
        return resolve(null);
      }
      resolve(stdout);
    });
  });
}

/**
 * Resize gambar lokal jadi JPEG kecil (buat thumbnail grid view) --
 * sama kayak generateVideoThumbnail tapi tanpa perlu ambil frame video,
 * ffmpeg juga bisa langsung proses file gambar biasa (jpg/png/webp/gif/dst).
 * Best-effort: return null kalau gagal, upload tetap lanjut normal.
 *
 * @param {string} localPath - path gambar di disk lokal
 * @returns {Promise<Buffer|null>}
 */
async function generateImageThumbnail(localPath) {
  const available = await checkFfmpegAvailable();
  if (!available) return null;

  return new Promise((resolve) => {
    const args = [
      '-y',
      '-hide_banner', '-loglevel', 'error',
      '-i', localPath,
      '-frames:v', '1', // kalau GIF/WEBP animasi, ambil frame pertama aja
      '-vf', 'scale=320:-1',
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      '-q:v', '5',
      'pipe:1',
    ];

    execFile('ffmpeg', args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024, encoding: 'buffer' }, (err, stdout) => {
      if (err || !stdout || stdout.length === 0) {
        console.warn('[imageThumbnail] gagal generate thumbnail:', err ? err.message : 'output kosong');
        return resolve(null);
      }
      resolve(stdout);
    });
  });
}

module.exports = { generateVideoThumbnail, generateImageThumbnail, checkFfmpegAvailable };
