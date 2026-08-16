require('dotenv').config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
// "onboarding@resend.dev" cuma buat testing (kirim ke email akun Resend
// kamu sendiri doang). Buat kirim ke SEMBARANG alamat email user, wajib
// pakai domain yang sudah diverifikasi di dashboard Resend, lalu isi
// EMAIL_FROM pakai alamat di domain itu, mis. "VaultKu <no-reply@domainkamu.com>".
// Sengaja pakai "no-reply@" bukan "security@" -- local-part "security@"
// itu salah satu yang paling sering dipakai phisher beneran, jadi malah
// bikin spam-filter (terutama Gmail) makin curiga ke domain yang belum
// punya riwayat kirim sama sekali.
const EMAIL_FROM = process.env.EMAIL_FROM || 'VaultKu <no-reply@resend.dev>';

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
    <div style="
      font-family:Arial,Helvetica,sans-serif;
      max-width:480px;
      margin:0 auto;
      padding:24px;
      color:#202124;
      background:#ffffff;
    ">
      
      <div style="
        text-align:center;
        margin-bottom:24px;
      ">
        <h2 style="
          margin:0;
          color:#FFC107;
          font-size:24px;
        ">
          VaultKu
        </h2>
      </div>

      <p style="font-size:15px;line-height:1.6">
        Halo,
      </p>

      <p style="font-size:15px;line-height:1.6">
        Kami menerima permintaan untuk membuat akun baru di 
        <strong>VaultKu</strong>.
      </p>

      <p style="font-size:15px;line-height:1.6">
        Gunakan kode berikut untuk melanjutkan proses pendaftaran:
      </p>

      <div style="
        background:#f1f3f4;
        padding:18px;
        border-radius:10px;
        text-align:center;
        margin:24px 0;
      ">
        <span style="
          font-size:32px;
          font-weight:700;
          letter-spacing:8px;
          color:#202124;
        ">
          ${code}
        </span>
      </div>

      <p style="
        font-size:14px;
        line-height:1.6;
        color:#5f6368;
      ">
        Kode ini hanya berlaku selama <strong>15 menit</strong>.
        Jangan bagikan kode ini kepada siapa pun.
      </p>

      <p style="
        font-size:14px;
        line-height:1.6;
        color:#5f6368;
      ">
        Jika kamu tidak merasa melakukan pendaftaran ini,
        kamu dapat mengabaikan email ini.
      </p>

      <hr style="
        border:none;
        border-top:1px solid #eeeeee;
        margin:28px 0;
      ">

      <p style="
        font-size:12px;
        color:#9aa0a6;
        text-align:center;
      ">
        © ${new Date().getFullYear()} VaultKu<br>
        Email ini dikirim secara otomatis, mohon jangan membalas.
      </p>

    </div>
  `;
}

module.exports = { sendEmail, verificationEmailHtml };
