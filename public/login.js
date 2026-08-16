let mode = 'login';
let registerMethod = 'email';
let turnstileToken = '';
let pendingRegisterUsername = '';
let botUsername = '';

const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const submitBtn = document.getElementById('submitBtn');
const msg = document.getElementById('msg');
const authForm = document.getElementById('authForm');
const emailInput = document.getElementById('email');
const registerMethodToggle = document.getElementById('registerMethodToggle');
const telegramRegisterFields = document.getElementById('telegramRegisterFields');
const telegramRegisterCode = document.getElementById('telegramRegisterCode');
const openBotLink = document.getElementById('openBotLink');

// Ambil username bot sekali di awal -- dipakai buat link "Buka Bot Telegram".
fetch('/api/auth/telegram/bot-info')
  .then((r) => r.json())
  .then((data) => {
    botUsername = data.bot_username || '';
    if (botUsername) openBotLink.href = `https://t.me/${botUsername}?start=daftar`;
  })
  .catch(() => {});

window.onTurnstileSuccess = (token) => {
  turnstileToken = token;
  msg.textContent = '';
};

window.onTurnstileExpired = () => {
  turnstileToken = '';
};

window.onTurnstileError = () => {
  turnstileToken = '';
  msg.textContent = 'CAPTCHA gagal dimuat. Periksa koneksi lalu coba lagi.';
};

function applyRegisterMethod() {
  document.querySelectorAll('.method-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.method === registerMethod);
  });
  const isTelegram = registerMethod === 'telegram';
  emailInput.hidden = !(mode === 'register' && !isTelegram);
  emailInput.required = mode === 'register' && !isTelegram;
  telegramRegisterFields.hidden = !(mode === 'register' && isTelegram);
  telegramRegisterCode.required = mode === 'register' && isTelegram;
}

document.querySelectorAll('.method-btn').forEach((btn) => {
  btn.onclick = () => {
    registerMethod = btn.dataset.method;
    applyRegisterMethod();
  };
});

function setMode(nextMode) {
  mode = nextMode;
  registerMethod = 'email';
  tabLogin.classList.toggle('active', mode === 'login');
  tabRegister.classList.toggle('active', mode === 'register');
  submitBtn.textContent = mode === 'login' ? 'Masuk' : 'Daftar';
  document.getElementById('password').autocomplete =
    mode === 'login' ? 'current-password' : 'new-password';
  registerMethodToggle.hidden = mode !== 'register';
  applyRegisterMethod();
  msg.textContent = '';
  msg.style.color = '';
  turnstileToken = '';

  if (window.turnstile) {
    try { window.turnstile.reset(); } catch (_) {}
  }
}

tabLogin.onclick = () => setMode('login');
tabRegister.onclick = () => setMode('register');

authForm.onsubmit = async (e) => {
  e.preventDefault();
  msg.textContent = '';

  const username = document.getElementById('username').value.trim();
  const email = emailInput.value.trim();
  const password = document.getElementById('password').value;

  if (!turnstileToken) {
    msg.textContent = 'Silakan selesaikan verifikasi CAPTCHA terlebih dahulu.';
    return;
  }

  submitBtn.disabled = true;

  try {
    if (mode === 'login') {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, turnstile_token: turnstileToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');

      localStorage.setItem('td_token', data.token);
      localStorage.setItem('td_refresh_token', data.refresh_token);
      localStorage.setItem('td_username', data.username);
      window.location.href = '/';
      return;
    }

    if (mode === 'register' && registerMethod === 'telegram') {
      // Daftar lewat Telegram -- kode SUDAH didapat dari bot, akun langsung
      // jadi & otomatis login, gak ada langkah verifikasi terpisah lagi.
      const code = telegramRegisterCode.value.trim();
      const res = await fetch('/api/auth/register/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, code, turnstile_token: turnstileToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Gagal');

      localStorage.setItem('td_token', data.token);
      localStorage.setItem('td_refresh_token', data.refresh_token);
      localStorage.setItem('td_username', data.username);
      window.location.href = '/';
      return;
    }

    // mode === 'register' via email -- kirim kode verifikasi ke email dulu,
    // akun BELUM kebuat sampai kode itu dikonfirmasi di langkah berikutnya.
    const res = await fetch('/api/auth/register/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, email, password, turnstile_token: turnstileToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal');

    pendingRegisterUsername = username;
    switchView('registerVerify');
  } catch (err) {
    msg.textContent = err.message;
    turnstileToken = '';
    if (window.turnstile) {
      try { window.turnstile.reset(); } catch (_) {}
    }
  } finally {
    submitBtn.disabled = false;
  }
};

// ---------- Ganti tampilan: auth (login/daftar) <-> registerVerify <-> forgot ----------
const viewBlocks = {
  auth: [authForm, document.querySelector('.tabs'), msg, document.getElementById('forgotLink')],
  registerVerify: [document.getElementById('registerVerifyWrap')],
  forgot: [document.getElementById('forgotWrap')],
};

function switchView(view) {
  Object.values(viewBlocks).flat().forEach((el) => { el.hidden = true; });
  viewBlocks[view].forEach((el) => { el.hidden = false; });
}

function backToLoginView() {
  switchView('auth');

  document.getElementById('registerVerifyMsg').textContent = '';
  document.getElementById('registerCode').value = '';

  forgotStep1.hidden = false;
  forgotStep2.hidden = true;
  forgotStep1.reset();
  forgotStep2.reset();

  setMode('login');
}

document.getElementById('forgotLink').onclick = (e) => { e.preventDefault(); switchView('forgot'); };
document.getElementById('backToLogin').onclick = (e) => { e.preventDefault(); backToLoginView(); };
document.getElementById('backToLoginFromVerify').onclick = (e) => { e.preventDefault(); backToLoginView(); };

// ---------- Verifikasi kode registrasi ----------
document.getElementById('registerVerifyForm').onsubmit = async (e) => {
  e.preventDefault();
  const verifyMsg = document.getElementById('registerVerifyMsg');
  verifyMsg.textContent = '';

  const code = document.getElementById('registerCode').value.trim();
  const btn = document.getElementById('registerVerifyBtn');
  btn.disabled = true;

  try {
    const res = await fetch('/api/auth/register/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: pendingRegisterUsername, code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal verifikasi');

    localStorage.setItem('td_token', data.token);
    localStorage.setItem('td_refresh_token', data.refresh_token);
    localStorage.setItem('td_username', data.username);
    window.location.href = '/';
  } catch (err) {
    verifyMsg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};

// ---------- Lupa password ----------
const forgotWrap = document.getElementById('forgotWrap');
const forgotStep1 = document.getElementById('forgotStep1');
const forgotStep2 = document.getElementById('forgotStep2');
const forgotMsg = document.getElementById('forgotMsg');
let forgotUsernameValue = '';

forgotStep1.onsubmit = async (e) => {
  e.preventDefault();
  forgotMsg.textContent = '';
  forgotUsernameValue = document.getElementById('forgotUsername').value.trim();
  if (!forgotUsernameValue) return;

  const btn = document.getElementById('forgotStep1Btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: forgotUsernameValue }),
    });
    const data = await res.json();
    forgotMsg.style.color = 'var(--text-muted)';
    forgotMsg.textContent = data.message || 'Kalau akun ditemukan, kode reset sudah dikirim.';
    forgotStep1.hidden = true;
    forgotStep2.hidden = false;
  } catch (err) {
    forgotMsg.style.color = '';
    forgotMsg.textContent = 'Gagal menghubungi server, coba lagi.';
  } finally {
    btn.disabled = false;
  }
};

forgotStep2.onsubmit = async (e) => {
  e.preventDefault();
  forgotMsg.style.color = '';
  forgotMsg.textContent = '';

  const code = document.getElementById('resetCode').value.trim();
  const newPassword = document.getElementById('newPassword').value;
  const newPassword2 = document.getElementById('newPassword2').value;

  if (newPassword !== newPassword2) {
    forgotMsg.textContent = 'Konfirmasi password tidak cocok.';
    return;
  }
  if (newPassword.length < 8) {
    forgotMsg.textContent = 'Password minimal 8 karakter.';
    return;
  }

  const btn = document.getElementById('forgotStep2Btn');
  btn.disabled = true;
  try {
    const res = await fetch('/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: forgotUsernameValue, code, new_password: newPassword }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal reset password');

    backToLoginView();
    document.getElementById('username').value = forgotUsernameValue;
    msg.style.color = 'var(--success)';
    msg.textContent = 'Password berhasil diganti. Silakan login dengan password baru.';
  } catch (err) {
    forgotMsg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
};
