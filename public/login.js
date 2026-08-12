let mode = 'login';
const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const submitBtn = document.getElementById('submitBtn');
const msg = document.getElementById('msg');

tabLogin.onclick = () => { mode = 'login'; tabLogin.classList.add('active'); tabRegister.classList.remove('active'); submitBtn.textContent = 'Masuk'; };
tabRegister.onclick = () => { mode = 'register'; tabRegister.classList.add('active'); tabLogin.classList.remove('active'); submitBtn.textContent = 'Daftar'; };

document.getElementById('authForm').onsubmit = async (e) => {
  e.preventDefault();
  msg.textContent = '';
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;

  try {
    const res = await fetch(`/api/auth/${mode}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Gagal');

    localStorage.setItem('td_token', data.token);
    localStorage.setItem('td_refresh_token', data.refresh_token);
    localStorage.setItem('td_username', data.username);
    window.location.href = '/';
  } catch (err) {
    msg.textContent = err.message;
  }
};
