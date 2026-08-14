let mode = 'login';
let turnstileToken = '';

const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const submitBtn = document.getElementById('submitBtn');
const msg = document.getElementById('msg');
const authForm = document.getElementById('authForm');

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

function setMode(nextMode) {
  mode = nextMode;
  tabLogin.classList.toggle('active', mode === 'login');
  tabRegister.classList.toggle('active', mode === 'register');
  submitBtn.textContent = mode === 'login' ? 'Masuk' : 'Daftar';
  document.getElementById('password').autocomplete =
    mode === 'login' ? 'current-password' : 'new-password';
  msg.textContent = '';
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
  const password = document.getElementById('password').value;

  if (!turnstileToken) {
    msg.textContent = 'Silakan selesaikan verifikasi CAPTCHA terlebih dahulu.';
    return;
  }

  submitBtn.disabled = true;

  try {
    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        password,
        turnstile_token: turnstileToken,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal');

    localStorage.setItem('td_token', data.token);
    localStorage.setItem('td_refresh_token', data.refresh_token);
    localStorage.setItem('td_username', data.username);
    window.location.href = '/';
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
