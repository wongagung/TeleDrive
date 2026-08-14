# Telegram Drive

Web drive multi-user yang menyimpan file di grup Telegram lewat **Local Bot API Server**
(bukan Bot API cloud biasa) supaya limit ukuran naik dari 20MB → 2000MB per chunk,
dengan chunking otomatis di level aplikasi untuk file di atas itu.

## Cara Kerja Singkat

```
Browser  →  Express (JWT auth, SQLite metadata)  →  Local Bot API Server (:8081)  →  Grup Telegram (Forum + Topics)
```

- Upload dilakukan **resumable**: file dipecah jadi block kecil (default 8MB) di browser, diupload
  satu-satu ke server. Kalau koneksi putus di tengah jalan, upload bisa dilanjut dari block terakhir
  yang berhasil — tidak perlu ulang dari nol.
- Setelah semua block diterima, server gabung jadi satu file utuh, lalu (kalau ukurannya besar)
  dipecah lagi jadi bagian ≤2000MB untuk dikirim ke Telegram (chunking level Telegram, terpisah
  dari chunking resumable di atas).
- Tiap file otomatis dikategorikan (Dokumen/Gambar/Video/Audio/Arsip/Lainnya) dan dikirim ke
  **Topic** (thread) Telegram sesuai kategorinya — jadi begitu buka grup di Telegram, semua Gambar
  ada di satu thread, semua Video di thread lain, dst. Topic dibuat otomatis sekali per kategori.
- Metadata (nama, folder, kategori, urutan chunk, file_id Telegram) disimpan di SQLite — **bukan** di Telegram.
- Preview gambar/PDF langsung di browser tanpa perlu download filenya dulu.

## PENTING: Disk VM Ikut Terpakai, Bukan Cuma Telegram

Local Bot API Server (mode `--local`) **menyimpan salinan tiap file yang lewat** (upload maupun
preview/download) di direktori `--dir` miliknya sendiri di disk VM — ini terpisah dari `TMP_DIR`
aplikasi ini, dan **tidak dibersihkan otomatis**. Kalau dibiarkan, disk VM bisa penuh meski data
aslinya aman di Telegram. Jalankan `deploy/cleanup-telegram-cache.sh` secara berkala (lihat bagian
"Setup Cron Cleanup" di bawah) — aman dihapus kapan saja karena akan didownload ulang otomatis
dari Telegram kalau memang diminta lagi.

## Keamanan

Sudah dites langsung (simulasi serangan) dan diperbaiki:

- **JWT_SECRET lemah/default → server MENOLAK start.** Wajib generate secret acak ≥32 karakter
  (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`). Tanpa ini,
  siapapun yang menebak secret bisa forge token dan ambil alih akun manapun.
- **IDOR pada `parent_id`/`folder_id`**: sebelumnya user bisa menyisipkan folder/file ke pohon
  folder milik user lain hanya dengan menebak ID-nya. Sekarang divalidasi kepemilikannya dulu,
  balikan `403` kalau bukan folder milik sendiri.
- **Rate limiting**: `/api/auth/*` dibatasi 10 percobaan/15 menit per IP (cegah brute force
  password). `/api/drive/upload` dibatasi 30 request/5 menit per IP.
- **Batas ukuran upload** (`MAX_UPLOAD_MB`, default 10GB) supaya user tidak bisa menghabiskan
  disk VM dengan upload tanpa batas.
- **Security headers** via `helmet` (CSP, X-Frame-Options, HSTS, dst) + `X-Powered-By` disembunyikan.
- **CORS default deny**: hanya origin yang didaftarkan eksplisit di `ALLOWED_ORIGINS` yang boleh
  akses API dari browser lain; default kosong = tidak ada origin asing yang diizinkan.
- **Validasi username** (regex, 3-32 karakter) dan password (min 8 karakter).
- SQL injection: **aman** (semua query pakai prepared statement `better-sqlite3`).
- JWT `alg:none` bypass: **aman** (default proteksi `jsonwebtoken` v9).
- IDOR baca (list/download/delete file & folder orang lain): **aman**, semua query di-scope
  ke `user_id` milik token yang login.
- CRLF/header injection lewat nama file: **aman** (`encodeURIComponent`).

Yang **masih jadi tanggung jawab kamu** saat deploy, bukan sesuatu yang bisa ditutup di kode:

- **Isolasi data itu logis, bukan fisik** — semua file tetap satu grup Telegram yang sama.
  Siapapun yang jadi member/admin grup itu bisa lihat file mentah di riwayat chat, terlepas
  dari sistem login web-nya. Batasi keanggotaan grup itu ketat.
- **HTTPS wajib** di depan nginx — tanpa itu, password & token JWT lewat plaintext di jaringan.
- Tidak ada mekanisme *revoke* token individual — kalau token dicuri (mis. lewat XSS di browser
  korban), token itu tetap valid sampai kadaluarsa (`JWT_EXPIRES_IN`, default 7 hari). Kalau
  butuh revoke, opsinya: perpendek masa berlaku token, atau tambah tabel blacklist token —
  bilang kalau mau saya implementasikan.
- Tidak ada kuota penyimpanan per user — satu user (kalau multi-user beneran dipakai bareng
  orang lain) tetap bisa menghabiskan seluruh limit upload berkali-kali dalam rentang rate-limit.



- Local Bot API Server maksimal **2000MB per file upload** (`--local` mode). Chunking di atas
  itu ditangani otomatis oleh aplikasi ini, tapi makin besar file, makin lama upload/download-nya
  (karena harus lewat Telegram beneran, bukan cuma disk lokal).
- Isolasi antar-user murni di level SQLite. Siapapun yang jadi admin/anggota grup Telegram bisa
  lihat file mentah di riwayat chat.
- Ini bukan storage resmi — jangan pakai untuk data sensitif/kritis produksi.
- Local Bot API Server adalah proses tambahan yang harus tetap hidup 24 jam — pastikan resource
  VM kamu cukup (biasanya ringan, tapi tetap tambahan RAM/CPU di atas service lain yang sudah jalan).

---

## 1. Setup Bot Telegram

1. Buat bot lewat [@BotFather](https://t.me/BotFather) → dapat `BOT_TOKEN`.
2. Buat grup baru di Telegram, invite bot ke grup itu, **jadikan bot admin**.
3. **Aktifkan mode Forum/Topics di grup**: buka pengaturan grup → "Topics" → aktifkan. Ini WAJIB
   supaya fitur "Topic per kategori" jalan — tanpa ini, `createForumTopic` akan gagal.
4. Beri bot izin admin **"Manage Topics"** dan **"Delete Messages"** (untuk fitur hapus file).
5. Dapatkan `GROUP_ID`: forward salah satu pesan dari grup ke [@RawDataBot](https://t.me/RawDataBot),
   atau tambahkan [@userinfobot](https://t.me/userinfobot) ke grup sebentar. ID grup biasanya
   berupa angka negatif, contoh `-1001234567890`.
6. Dapatkan `api_id` dan `api_hash` di https://my.telegram.org/apps (ini WAJIB untuk Local Bot API
   Server, beda dari `BOT_TOKEN`).

## 2. Build & Jalankan Local Bot API Server (di VM Oracle kamu)

```bash
sudo apt update
sudo apt install -y make git zlib1g-dev libssl-dev gperf cmake g++

git clone --recursive https://github.com/tdlib/telegram-bot-api.git
cd telegram-bot-api
mkdir build && cd build
cmake -DCMAKE_BUILD_TYPE=Release ..
cmake --build . --target install -j$(nproc)
```

Binary hasil build ada di `~/telegram-bot-api/build/telegram-bot-api`. Jalankan dengan `--local`
supaya file_path yang dikembalikan berupa path lokal (bukan perlu HTTP re-download):

```bash
~/telegram-bot-api/build/telegram-bot-api \
  --api-id=<API_ID_KAMU> \
  --api-hash=<API_HASH_KAMU> \
  --local \
  --dir=/home/ubuntu/telegram-bot-api-data \
  --http-port=8081
```

Buat jadi systemd service supaya auto-start:

```ini
# /etc/systemd/system/telegram-bot-api.service
[Unit]
Description=Telegram Local Bot API Server
After=network.target

[Service]
ExecStart=/home/ubuntu/telegram-bot-api/build/telegram-bot-api --api-id=<API_ID> --api-hash=<API_HASH> --local --dir=/home/ubuntu/telegram-bot-api-data --http-port=8081
Restart=always
RestartSec=5
User=ubuntu

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-bot-api
sudo systemctl status telegram-bot-api
```

## 3. Setup Aplikasi Ini

```bash
cd telegram-drive
npm install
cp .env.example .env
nano .env   # isi BOT_TOKEN, GROUP_ID, JWT_SECRET (random string panjang)
```

Test jalan manual dulu:

```bash
node src/server.js
# buka http://localhost:3000 (atau curl http://localhost:3000/health)
```

Kalau OK, buat systemd service:

```ini
# /etc/systemd/system/telegram-drive.service
[Unit]
Description=Telegram Drive Web App
After=network.target telegram-bot-api.service

[Service]
WorkingDirectory=/home/ubuntu/telegram-drive
ExecStart=/usr/bin/node src/server.js
Restart=always
RestartSec=5
User=ubuntu
EnvironmentFile=/home/ubuntu/telegram-drive/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-drive
```

## 4. Supaya Bisa Diakses Dari Mana Saja (HTTPS)

Pakai nginx sebagai reverse proxy + certbot untuk HTTPS (wajib, karena kamu kirim
username/password lewat form login):

```nginx
# /etc/nginx/sites-available/telegram-drive
server {
    listen 80;
    server_name drive.domainkamu.com;

    client_max_body_size 2100m;  # harus lebih besar dari CHUNK_SIZE_MB

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 600s;   # upload file besar butuh waktu
        proxy_send_timeout 600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/telegram-drive /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d drive.domainkamu.com
```

Kalau belum punya domain, kamu bisa pakai IP publik VM + port langsung (tanpa HTTPS) untuk
testing, tapi **jangan** kirim password asli lewat koneksi non-HTTPS di jaringan publik.

## 5. Setelah Akun Pertama Dibuat

Buka `https://drive.domainkamu.com/login.html`, daftar akun pertama. Setelah itu, set
`DISABLE_REGISTRATION=true` di `.env` dan restart service, supaya orang lain nggak bisa
daftar sembarangan — tambahkan user baru manual lewat endpoint register sekali pakai, atau
buka registrasi sementara saat memang perlu.

## 6. Setup Cron Cleanup Cache Telegram

Supaya disk VM tidak habis oleh cache Local Bot API Server (lihat bagian "PENTING" di atas):

```bash
chmod +x deploy/cleanup-telegram-cache.sh
crontab -e
```

Tambahkan baris ini (jalan tiap hari jam 3 pagi, hapus cache >3 hari):

```
0 3 * * * TG_DATA_DIR=/home/ubuntu/telegram-bot-api-data DAYS_OLD=3 /home/ubuntu/telegram-drive/deploy/cleanup-telegram-cache.sh >> /var/log/td-cleanup.log 2>&1
```

## 7. Kuota Penyimpanan per User

Default global diatur lewat `DEFAULT_QUOTA_MB` di `.env` (berlaku otomatis buat semua user
yang belum punya override). Buat kasih kuota custom ke user tertentu:

```bash
node scripts/set-quota.js rama 20480     # kasih 20GB ke user "rama"
node scripts/set-quota.js rama 0         # balikin ke default global
```

Kuota dicek dua kali: sekali di `/upload/init` (biar user tahu di awal, sebelum buang-buang
bandwidth), sekali lagi di `/upload/complete` (jaga-jaga ada upload lain yang selesai duluan
di antara init dan complete pada sesi yang sama).

## 8. Access Token + Refresh Token

Login/register sekarang balikin dua token:

- `token` (access token): JWT umur pendek (default 15 menit, `ACCESS_TOKEN_EXPIRES_IN`), dipakai
  di header `Authorization: Bearer <token>` tiap request.
- `refresh_token`: string acak umur panjang (default 30 hari, `REFRESH_TOKEN_DAYS`), disimpan
  HANYA hash-nya di database. Dipakai buat minta access token baru tanpa login ulang pakai password.

Frontend (`public/auth.js`) otomatis nuker access token baru pakai refresh token begitu dapat
`401`, transparan buat user -- gak perlu login ulang tiap 15 menit. Refresh token **rotate**
tiap dipakai (token lama langsung invalid begitu dipakai sekali), jadi kalau refresh token
lama dipakai lagi (misal karena bocor & dipakai orang lain), itu ketahuan sebagai anomali.

```
POST /api/auth/refresh
Body: {"refresh_token": "..."}
Response: {"token": "...", "refresh_token": "...", "username": "..."}
```

`POST /api/auth/logout` mencabut **keduanya sekaligus** (access token via jti, refresh token via
hash) -- kirim `refresh_token` juga di body kalau mau refresh token-nya ikut tercabut, bukan cuma
access token-nya.

## 9. Admin Panel

User **pertama** yang daftar di sistem otomatis jadi admin. Admin bisa akses `/admin.html` (muncul
link "⚙ Admin" di header drive kalau login sebagai admin), isinya:

- Statistik total user, total file, total storage terpakai
- List semua user + storage usage masing-masing
- Ubah kuota per user (alternatif GUI buat `scripts/set-quota.js`)
- Promote/demote admin (tidak bisa mencabut admin terakhir yang tersisa)
- Hapus user beserta semua folder/file-nya (tidak bisa hapus diri sendiri lewat sini)

**Catatan**: hapus user cuma hapus metadata di database. File yang sudah kadung ke Telegram
TIDAK ikut kehapus dari grup -- itu di luar jangkauan operasi ini (Telegram tidak selalu kasih
bot izin hapus pesan lama tergantung setting grup), hapus manual dari Telegram kalau perlu.

Kalau semua admin ke-lockout (misal typo demote diri sendiri), jalur darurat lewat CLI di VM:

```bash
node scripts/make-admin.js <username>        # jadikan admin
node scripts/make-admin.js <username> off    # cabut admin
```

## 10. Pencarian Nama File (Full-Text)

Search box di toolbar drive nyari lintas SEMUA folder (bukan cuma folder yang lagi dibuka),
pakai SQLite FTS5 (bukan `LIKE` biasa) -- support multi-kata dan prefix match ("keu" bisa nemu
"Keuangan"). Index-nya sinkron otomatis lewat trigger database tiap ada file baru/diganti nama/dihapus,
jadi tidak perlu proses reindex manual.

```
GET /api/drive/search?q=laporan+keuangan
```

## 11. Tampilan List/Grid + Preview Video & Audio

Toolbar drive sekarang punya toggle ☰ (list) / ▦ (grid) -- pilihan tersimpan di browser
(localStorage), jadi diingat tiap buka lagi. Grid view nampilin thumbnail asli untuk gambar,
badge ▶ untuk video, dan ikon per kategori untuk tipe lain.

Preview sekarang juga support **video dan audio**, diputar inline di modal (bukan cuma
download) dengan kontrol native browser (play/pause/seek/volume). Video bisa di-**scrub**
(geser maju/mundur di timeline) walau filenya kepecah jadi beberapa chunk di Telegram --
ini didukung lewat implementasi **HTTP Range Request** penuh di endpoint `/preview`, yang
memetakan rentang byte yang diminta browser ke chunk Telegram yang sesuai secara otomatis.

**Trade-off keamanan yang perlu kamu tahu**: tag `<video>`/`<audio>`/`<img>` HTML tidak bisa
mengirim header `Authorization` custom, jadi endpoint preview menerima access token lewat
query param (`?token=...`) sebagai fallback. Token ini tetap divalidasi persis sama seperti
lewat header (termasuk cek revocation), tapi konsekuensinya token bisa kesimpan di history
browser / access log server / `Referer` header kalau halaman pindah saat media masih
loading. Risikonya dibatasi karena access token umurnya pendek (`ACCESS_TOKEN_EXPIRES_IN`,
default 15 menit) -- tapi ini tetap trade-off yang sadar dilakukan, bukan kebetulan.

## 12. Thumbnail Video + Notifikasi Kuota via Telegram DM

**Thumbnail video**: saat upload video selesai, server otomatis ekstrak satu frame (detik ke-1)
pakai `ffmpeg`, disimpan sebagai JPEG kecil langsung di database, ditampilkan di grid view
menggantikan ikon generik. Proses ekstraksi jalan **konkuren** sama upload ke Telegram (gak
nambah waktu tunggu). Kalau `ffmpeg` gak keinstall di VM, thumbnail otomatis fallback ke
ikon+badge play seperti biasa -- upload tetap sukses, cuma thumbnailnya kosong.

```bash
sudo apt install ffmpeg   # kalau belum ada; cek log server saat startup untuk konfirmasi
```

**Notifikasi kuota via DM Telegram**: karena bot Telegram gak boleh mulai chat duluan ke user
random (anti-spam by design Telegram), ada alur "hubungkan akun" dulu:

1. User klik "🔗 Telegram" di header drive → generate kode sekali-pakai (berlaku 10 menit)
2. User kirim `/start <kode>` ke bot lewat Telegram
3. Server (via long-polling `getUpdates`, jalan otomatis di background) nangkep pesan itu,
   cocokkan kodenya, simpan `chat_id` user itu, balas konfirmasi

Setelah terhubung, tiap kali usage user melewati ambang batas (`QUOTA_WARN_THRESHOLDS`,
default 80% dan 95%), bot otomatis DM sekali per ambang batas (gak spam tiap upload). Kalau
user hapus file dan usage turun lagi, status notifikasi ke-reset otomatis -- bisa notif lagi
di masa depan kalau naik lagi.

## Struktur Project


```
telegram-drive/
├── src/
│   ├── server.js              # entry point Express (helmet, CORS, JWT secret check, start polling)
│   ├── config.js               # validasi JWT_SECRET saat startup
│   ├── db.js                    # schema (users+admin+telegram, folders, files+FTS5+thumbnail, dst)
│   ├── telegram.js              # wrapper Local Bot API (upload/download/delete/topic/DM/polling)
│   ├── telegramBot.js           # long-polling loop + proses /start <kode> buat link akun
│   ├── videoThumbnail.js        # ekstrak frame video pakai ffmpeg
│   ├── tokenUtils.js            # access token (JWT+jti) + refresh token (opaque, hash, rotate)
│   ├── quota.js                 # hitung/cek kuota + trigger notifikasi DM kalau hampir penuh
│   ├── uploadPipeline.js        # logic bersama: chunking ke Telegram + thumbnail + simpan metadata
│   ├── middleware/
│   │   ├── authMiddleware.js    # verifikasi JWT (header ATAU ?token=) + revoked_tokens + user masih ada
│   │   ├── adminMiddleware.js   # guard requireAdmin
│   │   └── rateLimiters.js      # rate limit login/register & upload
│   └── routes/
│       ├── authRoutes.js        # register/login/refresh/logout/me/telegram-link
│       ├── adminRoutes.js       # list user, set kuota, promote/demote, hapus user
│       └── fileRoutes.js        # folder CRUD+rename/move, resumable upload, download, preview
│                                 # (dengan Range request), thumbnail, bulk ops, search
├── public/
│   ├── auth.js                  # shared: token storage, auto-refresh on 401, logout
│   ├── login.html / login.js
│   ├── index.html / app.js      # drive: list/grid toggle, quota bar, search, preview, link Telegram
│   └── admin.html / admin.js    # panel admin
├── scripts/
│   ├── set-quota.js             # CLI: set kuota custom per user
│   └── make-admin.js            # CLI: promote/demote admin (jalur darurat)
├── deploy/
│   └── cleanup-telegram-cache.sh
├── .env.example
└── package.json
```

## API Ringkas

| Method | Path                                | Auth  | Keterangan                                    |
|--------|--------------------------------------|-------|-------------------------------------------------|
| POST   | /api/auth/register                    | -     | `{username, password}` -> access+refresh token   |
| POST   | /api/auth/login                        | -     | `{username, password}` -> access+refresh token   |
| POST   | /api/auth/refresh                      | -     | `{refresh_token}` -> access+refresh token baru   |
| POST   | /api/auth/logout                       | v     | Cabut access token (+ refresh token kalau dikirim) |
| GET    | /api/auth/me                           | v     | `{id, username, is_admin}`                       |
| GET    | /api/auth/telegram/status              | v     | `{linked}`                                       |
| POST   | /api/auth/telegram/link-code           | v     | Generate kode `/start` sekali-pakai (10 menit)   |
| DELETE | /api/auth/telegram/link                | v     | Putuskan koneksi Telegram                        |
| GET    | /api/drive/list?folder_id=             | v     | Isi folder + info quota + kategori per file      |
| GET    | /api/drive/search?q=                   | v     | Full-text search nama file lintas folder         |
| GET    | /api/drive/quota                       | v     | `{used, quota}` dalam bytes                      |
| POST   | /api/drive/folders                      | v     | `{name, parent_id}`                              |
| PATCH  | /api/drive/folders/:id                  | v     | `{name?, parent_id?}` -- rename/pindah           |
| DELETE | /api/drive/folders/:id                  | v     | Hapus folder + isinya                            |
| PATCH  | /api/drive/files/:id                    | v     | `{name?, folder_id?}` -- rename/pindah           |
| POST   | /api/drive/upload/init                  | v     | `{filename, size, mime_type, folder_id}`, cek quota |
| PUT    | /api/drive/upload/:id/block/:index      | v     | Body biner satu block                            |
| GET    | /api/drive/upload/:id/status            | v     | Cek block yang sudah diterima (buat resume)      |
| POST   | /api/drive/upload/:id/complete          | v     | Gabung block + kirim ke Telegram + trigger notif quota |
| DELETE | /api/drive/upload/:id                   | v     | Batalkan sesi upload yang belum selesai          |
| GET    | /api/drive/download/:id                 | v (header/query) | Download (attachment), support Range     |
| GET    | /api/drive/preview/:id                  | v (header/query) | Preview inline (image/pdf/video/audio), support Range |
| GET    | /api/drive/thumbnail/:id                | v (header/query) | JPEG thumbnail video (404 kalau belum ada) |
| DELETE | /api/drive/files/:id                    | v     | Hapus satu file (+ coba hapus di grup)           |
| POST   | /api/drive/bulk-delete                  | v     | `{file_ids[], folder_ids[]}` -- hapus banyak sekaligus |
| POST   | /api/drive/bulk-move                    | v     | `{file_ids[], folder_ids[], target_folder_id}` -- pindah banyak sekaligus |
| GET    | /api/admin/users                        | admin | List semua user + storage usage                  |
| GET    | /api/admin/stats                        | admin | Statistik total (user, file, storage)            |
| PATCH  | /api/admin/users/:id/quota              | admin | `{quota_mb}` -- 0 = pakai default global         |
| PATCH  | /api/admin/users/:id/admin              | admin | `{is_admin}` -- promote/demote                   |
| DELETE | /api/admin/users/:id                    | admin | Hapus user + semua data-nya                      |

## Yang Belum Diimplementasi

- Kuota per-folder atau per-tipe-file (saat ini kuota flat per user)
- Audit log aktivitas admin (siapa hapus/ubah apa, kapan)
- Notifikasi email (SMTP tidak di-setup; notifikasi kuota cuma lewat Telegram DM)
- Thumbnail buat gambar besar (grid view pakai file aslinya langsung sebagai thumbnail,
  belum di-resize di server -- cukup untuk pemakaian personal, tapi boros bandwidth kalau
  foto-fotonya beresolusi sangat tinggi)
