// Dipakai bersama oleh app.js dan admin.js.

function getToken() { return localStorage.getItem('td_token'); }
function getRefreshToken() { return localStorage.getItem('td_refresh_token'); }

function requireLogin() {
  if (!getToken()) window.location.href = '/login.html';
}

let refreshingPromise = null;

/** Tukar refresh token ke access token baru. Dedupe kalau beberapa request
 * 401 bersamaan -- cuma satu request refresh yang beneran jalan ke server. */
async function tryRefresh() {
  if (refreshingPromise) return refreshingPromise;

  const rt = getRefreshToken();
  if (!rt) return false;

  refreshingPromise = fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: rt }),
  })
    .then(async (res) => {
      if (!res.ok) return false;
      const data = await res.json();
      localStorage.setItem('td_token', data.token);
      localStorage.setItem('td_refresh_token', data.refresh_token);
      return true;
    })
    .catch(() => false)
    .finally(() => { refreshingPromise = null; });

  return refreshingPromise;
}

/** Wrapper fetch dengan auto-attach access token + auto-refresh sekali kalau 401. */
async function api(path, opts = {}) {
  const withAuthHeader = () => ({
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${getToken()}` },
  });

  let res = await fetch(path, withAuthHeader());

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      res = await fetch(path, withAuthHeader());
    }
    if (res.status === 401) {
      localStorage.clear();
      window.location.href = '/login.html';
      return;
    }
  }
  return res;
}

async function logout() {
  try {
    await api('/api/auth/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: getRefreshToken() }),
    });
  } catch (_) { /* tetap logout lokal walau gagal cabut token di server */ }
  localStorage.clear();
  window.location.href = '/login.html';
}
