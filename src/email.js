require('dotenv').config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// "onboarding@resend.dev" cuma buat testing (kirim ke email akun Resend
// kamu sendiri doang). Buat kirim ke SEMBARANG alamat email user, wajib
// pakai domain yang sudah diverifikasi di dashboard Resend, lalu isi
// EMAIL_FROM pakai alamat di domain itu, mis. "VaultKu <no-reply@domainkamu.com>".
const EMAIL_FROM = process.env.EMAIL_FROM || 'VaultKu <onboarding@resend.dev>';

/**
 * Kirim email lewat Resend API. Return true/false (gak throw), supaya
 * pemanggil bisa fallback dengan tenang kalau pengiriman gagal.
 */
async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY belum diisi di .env -- email tidak dikirim.');
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.warn('[email] gagal kirim:', res.status, err);
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[email] error:', err.message);
    return false;
  }
}

function verificationEmailHtml(code) {
  return `
    <div style="font-family:sans-serif;max-width:420px;margin:0 auto;padding:24px">
      <h2 style="color:#c88400">VaultKu</h2>
      <p>Kode verifikasi buat menyelesaikan pendaftaran akun kamu:</p>
      <div style="font-size:28px;font-weight:700;letter-spacing:4px;background:#f4f5f7;
                  padding:16px 24px;border-radius:8px;text-align:center;color:#20232a">
        ${code}
      </div>
      <p style="color:#646b78;font-size:13px;margin-top:16px">
        Kode ini berlaku 15 menit. Kalau bukan kamu yang mendaftar, abaikan saja email ini.
      </p>
    </div>
  `;
}

module.exports = { sendEmail, verificationEmailHtml };
