requireLogin();

document.getElementById('whoami').textContent = localStorage.getItem('td_username') || '';
document.getElementById('logoutBtn').onclick = logout;

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[i];
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function init() {
  // Cek dulu user ini beneran admin -- kalau bukan, endpoint /api/admin/*
  // akan balikin 403 dan kita lempar balik ke drive biasa.
  const meRes = await api('/api/auth/me');
  if (!meRes) return;
  const me = await meRes.json();
  if (!me.is_admin) {
    alert('Halaman ini khusus admin.');
    window.location.href = '/index.html';
    return;
  }

  await loadStats();
  await loadUsers();
}

async function loadStats() {
  const res = await api('/api/admin/stats');
  if (!res || !res.ok) return;
  const stats = await res.json();

  document.getElementById('statsRow').innerHTML = `
    <div class="stat-card"><div class="stat-value">${stats.totalUsers}</div><div class="stat-label">Total User</div></div>
    <div class="stat-card"><div class="stat-value">${stats.totalFiles}</div><div class="stat-label">Total File</div></div>
    <div class="stat-card"><div class="stat-value">${fmtSize(stats.totalUsedBytes)}</div><div class="stat-label">Total Storage Terpakai</div></div>
  `;
}

async function loadUsers() {
  const res = await api('/api/admin/users');
  if (!res || !res.ok) {
    if (res) alert((await res.json()).error);
    return;
  }
  const data = await res.json();

  const body = document.getElementById('userBody');
  body.innerHTML = '';

  data.users.forEach((u) => {
    const pct = u.quota_bytes > 0 ? Math.min(100, (u.used_bytes / u.quota_bytes) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'admin-grid-row';
    row.innerHTML = `
      <div>${escapeHtml(u.username)}</div>
      <div>${new Date(u.created_at).toLocaleDateString('id-ID')}</div>
      <div>
        <div class="mini-bar"><div class="mini-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <span class="mini-bar-text">${fmtSize(u.used_bytes)} / ${fmtSize(u.quota_bytes)}${u.has_custom_quota ? ' (custom)' : ''}</span>
      </div>
      <div>${u.is_admin ? '✅' : '—'}</div>
      <div class="row-actions">
        <button data-quota title="Ubah kuota">📊</button>
        <button data-toggle-admin title="${u.is_admin ? 'Cabut admin' : 'Jadikan admin'}">${u.is_admin ? '⬇ Demote' : '⬆ Promote'}</button>
        <button data-delete title="Hapus user" class="danger-btn">🗑</button>
      </div>
    `;

    row.querySelector('[data-quota]').onclick = async () => {
      const currentMb = u.has_custom_quota ? Math.round(u.quota_bytes / 1024 / 1024) : 0;
      const input = prompt(
        `Kuota untuk "${u.username}" dalam MB (0 = pakai default global):`,
        currentMb
      );
      if (input === null) return;
      const mb = parseInt(input, 10);
      if (Number.isNaN(mb) || mb < 0) return alert('Harus angka >= 0');

      const res = await api(`/api/admin/users/${u.id}/quota`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quota_mb: mb }),
      });
      if (res.ok) loadUsers(); else alert((await res.json()).error);
    };

    row.querySelector('[data-toggle-admin]').onclick = async () => {
      const makeAdmin = !u.is_admin;
      if (!confirm(`${makeAdmin ? 'Jadikan' : 'Cabut status admin dari'} "${u.username}"?`)) return;

      const res = await api(`/api/admin/users/${u.id}/admin`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_admin: makeAdmin }),
      });
      if (res.ok) loadUsers(); else alert((await res.json()).error);
    };

    row.querySelector('[data-delete]').onclick = async () => {
      if (!confirm(`Hapus user "${u.username}" beserta SEMUA file & foldernya? Ini tidak bisa dibatalkan.`)) return;

      const res = await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      if (res.ok) { loadUsers(); loadStats(); } else alert((await res.json()).error);
    };

    body.appendChild(row);
  });
}

init();
