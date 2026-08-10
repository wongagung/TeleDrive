# Telegram Drive

Web drive multi-user yang menyimpan file di grup Telegram lewat **Local Bot API Server**
(bukan Bot API cloud biasa) supaya limit ukuran naik dari 20MB → 2000MB per chunk,
dengan chunking otomatis di level aplikasi untuk file di atas itu.

## Cara Kerja Singkat

```
Browser  →  Express (JWT auth, SQLite metadata)  →  Local Bot API Server (:8081)  →  Grup Telegram
```

- File besar dipecah jadi beberapa bagian (default 1900MB/bagian) sebelum dikirim.
- Metadata (nama, folder, urutan chunk, file_id Telegram) disimpan di SQLite — **bukan** di Telegram.
- Saat download, backend narik tiap chunk balik dari Telegram lalu di-stream gabung ke browser.

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
2. Buat grup baru di Telegram, invite bot ke grup itu, **jadikan bot admin** (supaya bisa
   `deleteMessage` saat file dihapus dari drive).
3. Dapatkan `GROUP_ID`: forward salah satu pesan dari grup ke [@RawDataBot](https://t.me/RawDataBot),
   atau tambahkan [@userinfobot](https://t.me/userinfobot) ke grup sebentar. ID grup biasanya
   berupa angka negatif, contoh `-1001234567890`.
4. Dapatkan `api_id` dan `api_hash` di https://my.telegram.org/apps (ini WAJIB untuk Local Bot API
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

## Struktur Project

```
telegram-drive/
├── src/
│   ├── server.js          # entry point Express
│   ├── db.js               # SQLite schema (users, folders, files)
│   ├── telegram.js         # wrapper Local Bot API (upload/download/delete)
│   ├── middleware/
│   │   └── authMiddleware.js
│   └── routes/
│       ├── authRoutes.js   # register/login
│       └── fileRoutes.js   # folder CRUD, upload (chunked), download, delete
├── public/                 # web UI (login.html, index.html, app.js, style.css)
├── .env.example
└── package.json
```

## API Ringkas

| Method | Path                        | Auth | Keterangan                        |
|--------|------------------------------|------|------------------------------------|
| POST   | /api/auth/register            | -    | `{username, password}`             |
| POST   | /api/auth/login                | -    | `{username, password}` → JWT       |
| GET    | /api/drive/list?folder_id=    | ✓    | Isi folder                         |
| POST   | /api/drive/folders             | ✓    | `{name, parent_id}`                |
| DELETE | /api/drive/folders/:id         | ✓    | Hapus folder + isinya              |
| POST   | /api/drive/upload              | ✓    | multipart `file`, optional `folder_id` |
| GET    | /api/drive/download/:id        | ✓    | Stream file (reassemble chunk)     |
| DELETE | /api/drive/files/:id           | ✓    | Hapus file (+ coba hapus di grup)  |

## Yang Belum Diimplementasi (kalau butuh, bilang saja)

- Rename/move file & folder
- Preview file (gambar/PDF) langsung di browser tanpa download
- Resumable upload (kalau koneksi putus di tengah upload besar, harus ulang dari awal)
- Rate limiting / brute-force protection di endpoint login
