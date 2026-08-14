requireLogin();

const whoami = document.getElementById('whoami');
const logoutBtn = document.getElementById('logoutBtn');
const refreshBtn = document.getElementById('refreshBtn');
const userBody = document.getElementById('userBody');
const userCount = document.getElementById('userCount');

const quotaModal = document.getElementById('quotaModal');
const quotaInput = document.getElementById('quotaInput');
const quotaUser = document.getElementById('quotaUser');
const quotaTitle = document.getElementById('quotaTitle');

let quotaTarget = null;

whoami.textContent = localStorage.getItem('td_username') || '';
logoutBtn.onclick = logout;

function applyTheme(theme) {
  let actual = theme;

  if (theme === 'auto') {
    actual = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  document.documentElement.dataset.theme = actual;
  localStorage.setItem('td_theme_preference', theme);

  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

function initTheme() {
  const saved = localStorage.getItem('td_theme_preference') || 'auto';
  applyTheme(saved);

  document.querySelectorAll('.theme-btn').forEach((btn) => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
  });

  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener?.('change', () => {
    if ((localStorage.getItem('td_theme_preference') || 'auto') === 'auto') {
      applyTheme('auto');
    }
  });
}

function fmtSize(bytes) {
  bytes = Number(bytes) || 0;
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    bytes /= 1024;
    i++;
  } while (bytes >= 1024 && i < units.length - 1);

  return `${bytes.toFixed(1)} ${units[i]}`;
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function showToast(message, error = false) {
  const toast = document.getElementById('adminToast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3200);
}

function openQuotaModal(user) {
  quotaTarget = user;
  const currentMb = user.has_custom_quota
    ? Math.round(Number(user.quota_bytes) / 1024 / 1024)
    : 0;

  quotaTitle.textContent = 'Ubah kuota';
  quotaUser.textContent = `Kuota untuk "${user.username}"`;
  quotaInput.value = currentMb;
  quotaModal.hidden = false;

  requestAnimationFrame(() => {
    quotaInput.focus();
    quotaInput.select();
  });
}

function closeQuotaModal() {
  quotaModal.hidden = true;
  quotaTarget = null;
}

async function saveQuota() {
  if (!quotaTarget) return;

  const mb = parseInt(quotaInput.value, 10);
  if (Number.isNaN(mb) || mb < 0) {
    showToast('Kuota harus berupa angka 0 atau lebih.', true);
    quotaInput.focus();
    return;
  }

  const btn = document.getElementById('quotaSave');
  btn.disabled = true;

  try {
    const res = await api(`/api/admin/users/${quotaTarget.id}/quota`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quota_mb: mb }),
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast(data.error || 'Gagal mengubah kuota.', true);
      return;
    }

    closeQuotaModal();
    showToast('Kuota berhasil diperbarui.');
    await loadUsers();
  } catch (err) {
    showToast(err.message || 'Gagal mengubah kuota.', true);
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  initTheme();

  try {
    const meRes = await api('/api/auth/me');
    if (!meRes) return;

    const me = await meRes.json();
    if (!me.is_admin) {
      alert('Halaman ini khusus admin.');
      window.location.href = '/index.html';
      return;
    }

    await Promise.all([loadStats(), loadUsers()]);
  } catch (err) {
    showToast(err.message || 'Gagal memuat panel admin.', true);
  }
}

async function loadStats() {
  const res = await api('/api/admin/stats');
  if (!res || !res.ok) return;

  const stats = await res.json();

  document.getElementById('statsRow').innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${Number(stats.totalUsers) || 0}</div>
      <div class="stat-label">Total User</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${Number(stats.totalFiles) || 0}</div>
      <div class="stat-label">Total File</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${fmtSize(stats.totalUsedBytes)}</div>
      <div class="stat-label">Total Storage Terpakai</div>
    </div>
  `;
}

async function loadUsers() {
  userBody.innerHTML = `
    <tr><td colspan="5" class="loading-row">Memuat data…</td></tr>
  `;

  const res = await api('/api/admin/users');

  if (!res || !res.ok) {
    if (res) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error || 'Gagal memuat pengguna.', true);
    }
    return;
  }

  const data = await res.json();
  const users = Array.isArray(data.users) ? data.users : [];

  userCount.textContent = `${users.length} pengguna`;

  if (!users.length) {
    userBody.innerHTML = `
      <tr><td colspan="5" class="empty-admin">Belum ada pengguna.</td></tr>
    `;
    return;
  }

  userBody.innerHTML = '';

  users.forEach((u) => {
    const quota = Number(u.quota_bytes) || 0;
    const used = Number(u.used_bytes) || 0;
    const pct = quota > 0 ? Math.min(100, (used / quota) * 100) : 0;

    const tr = document.createElement('tr');

    const firstLetter = escapeHtml((u.username || '?').charAt(0).toUpperCase());
    const role = u.is_admin ? 'Administrator' : 'Pengguna';

    tr.innerHTML = `
      <td>
        <div class="admin-user">
          <div class="avatar">${firstLetter}</div>
          <div>
            <div class="user-name">${escapeHtml(u.username)}</div>
            <div class="user-role">${role}</div>
          </div>
        </div>
      </td>

      <td>${u.created_at ? new Date(u.created_at).toLocaleDateString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
      }) : '—'}</td>

      <td>
        <div class="admin-storage">
          <div class="storage-line">
            <span>Terpakai</span>
            <strong>${fmtSize(used)} / ${fmtSize(quota)}</strong>
          </div>
          <div class="mini-bar">
            <div class="mini-bar-fill ${pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : ''}"
                 style="width:${pct.toFixed(1)}%"></div>
          </div>
          <span class="mini-bar-text">${pct.toFixed(1)}%${u.has_custom_quota ? ' · custom' : ''}</span>
        </div>
      </td>

      <td>
        <span class="status-pill ${u.is_admin ? '' : 'user'}">
          ${u.is_admin ? '● Admin' : '● User'}
        </span>
      </td>

      <td class="row-actions">
        <button data-quota type="button" title="Ubah kuota">📊</button>
        <button data-toggle-admin type="button"
          title="${u.is_admin ? 'Cabut admin' : 'Jadikan admin'}">
          ${u.is_admin ? '↓ Demote' : '↑ Promote'}
        </button>
        <button data-delete type="button" class="danger-btn" title="Hapus user">🗑</button>
      </td>
    `;

    tr.querySelector('[data-quota]').onclick = () => openQuotaModal(u);

    tr.querySelector('[data-toggle-admin]').onclick = async () => {
      const makeAdmin = !u.is_admin;
      const question = makeAdmin
        ? `Jadikan "${u.username}" sebagai admin?`
        : `Cabut status admin dari "${u.username}"?`;

      if (!confirm(question)) return;

      try {
        const response = await api(`/api/admin/users/${u.id}/admin`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_admin: makeAdmin }),
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          showToast(result.error || 'Gagal mengubah status admin.', true);
          return;
        }

        showToast(makeAdmin ? 'User dijadikan admin.' : 'Status admin dicabut.');
        await Promise.all([loadUsers(), loadStats()]);
      } catch (err) {
        showToast(err.message || 'Gagal mengubah status admin.', true);
      }
    };

    tr.querySelector('[data-delete]').onclick = async () => {
      const question =
        `Hapus user "${u.username}" beserta SEMUA file & foldernya?\n\n` +
        `Tindakan ini tidak bisa dibatalkan.`;

      if (!confirm(question)) return;

      try {
        const response = await api(`/api/admin/users/${u.id}`, {
          method: 'DELETE',
        });

        const result = await response.json().catch(() => ({}));

        if (!response.ok) {
          showToast(result.error || 'Gagal menghapus user.', true);
          return;
        }

        showToast('User berhasil dihapus.');
        await Promise.all([loadUsers(), loadStats()]);
      } catch (err) {
        showToast(err.message || 'Gagal menghapus user.', true);
      }
    };

    userBody.appendChild(tr);
  });
}

document.getElementById('quotaClose').onclick = closeQuotaModal;
document.getElementById('quotaCancel').onclick = closeQuotaModal;
document.getElementById('quotaSave').onclick = saveQuota;

quotaModal.addEventListener('click', (event) => {
  if (event.target === quotaModal) closeQuotaModal();
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !quotaModal.hidden) closeQuotaModal();

  if (event.key === 'Enter' &&
      document.activeElement === quotaInput &&
      !quotaModal.hidden) {
    saveQuota();
  }
});

refreshBtn.onclick = async () => {
  refreshBtn.disabled = true;
  refreshBtn.textContent = '↻ Memuat…';

  try {
    await Promise.all([loadStats(), loadUsers()]);
    showToast('Data admin diperbarui.');
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '↻ Refresh';
  }
};

init();
