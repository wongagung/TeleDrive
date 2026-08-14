# TeleDrive — Cloudflare Turnstile

1. Buat widget Cloudflare Turnstile dengan mode Managed.
2. Tambahkan hostname TeleDrive, misalnya `teledrives.duckdns.org`.
3. Tambahkan di `.env` server:
   `TURNSTILE_SECRET_KEY=SECRET_KEY_KAMU`
   `TURNSTILE_EXPECTED_HOSTNAME=teledrives.duckdns.org`
4. Ganti `REPLACE_WITH_TURNSTILE_SITE_KEY` di `public/login.html` dengan Site Key.
5. Jangan commit `TURNSTILE_SECRET_KEY` ke Git.

CAPTCHA diwajibkan untuk `/api/auth/login` dan `/api/auth/register`.
`/refresh`, `/logout`, dan endpoint lain tidak memakai Turnstile.
