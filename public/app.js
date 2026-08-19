requireLogin();

document.getElementById('whoami').textContent = localStorage.getItem('td_username') || '';
document.getElementById('logoutBtn').onclick = logout;

let currentFolder = null; // null = root
let folderStack = []; // [{id, name}]
let selectedFiles = new Set();
let selectedFolders = new Set();

// Guard TUNGGAL untuk semua navigasi folder (list & grid). Ini yang mencegah
// folder ke-klik berkali-kali/dobel: selama sebuah navigasi masih berjalan
// (folderStack.push -> loadList -> render selesai), klik folder lain diabaikan.
// Cuma ada SATU flag ini di seluruh app -- tidak ada lagi beberapa script
// terpisah yang saling menebak state satu sama lain.
let navBusy = false;

// ---------- Riwayat folder (tombol ← →) ----------
// Prinsip: riwayat CUMA dicatat ketika kita benar-benar BERPINDAH folder
// (buka folder / klik breadcrumb / klik back / klik forward). Aksi lain
// (buat folder, rename, hapus, pindah file, sort, ganti tampilan, cari)
// TIDAK PERNAH memanggil pushHistory -- jadi tombol back tidak akan pernah
// "muncul salah" gara-gara aksi yang bukan navigasi.
let navBack = [];
let navForward = [];

function snapshotState() {
  return { id: currentFolder, stack: folderStack.map((f) => ({ ...f })) };
}

function pushHistory(prevState) {
  const last = navBack[navBack.length - 1];
  if (!last || last.id !== prevState.id) navBack.push(prevState);
  navForward = [];
  updateNavButtons();
}

function updateNavButtons() {
  const back = document.getElementById('folderBackBtn');
  const forward = document.getElementById('folderForwardBtn');
  if (back) back.disabled = navBusy || navBack.length === 0;
  if (forward) forward.disabled = navBusy || navForward.length === 0;
}

async function openFolder(folder) {
  if (navBusy) return;
  navBusy = true;
  try {
    const prevState = snapshotState();
    folderStack.push({ id: folder.id, name: folder.name });
    currentFolder = folder.id;
    pushHistory(prevState);
    await loadList();
  } finally {
    navBusy = false;
    updateNavButtons();
  }
}

async function goToBreadcrumb(idx) {
  // idx === -1 berarti Root
  if (navBusy) return;
  const targetId = idx === -1 ? null : folderStack[idx].id;
  if (targetId === currentFolder) return; // sudah di sini, bukan navigasi
  navBusy = true;
  try {
    const prevState = snapshotState();
    if (idx === -1) {
      folderStack = [];
      currentFolder = null;
    } else {
      folderStack = folderStack.slice(0, idx + 1);
      currentFolder = folderStack[idx].id;
    }
    pushHistory(prevState);
    await loadList();
  } finally {
    navBusy = false;
    updateNavButtons();
  }
}

async function goFolderBack() {
  if (navBusy || !navBack.length) return;
  navBusy = true;
  updateNavButtons();
  try {
    const current = snapshotState();
    const target = navBack.pop();
    navForward.push(current);
    folderStack = target.stack;
    currentFolder = target.id;
    await loadList();
  } finally {
    navBusy = false;
    updateNavButtons();
  }
}

async function goFolderForward() {
  if (navBusy || !navForward.length) return;
  navBusy = true;
  updateNavButtons();
  try {
    const current = snapshotState();
    const target = navForward.pop();
    navBack.push(current);
    folderStack = target.stack;
    currentFolder = target.id;
    await loadList();
  } finally {
    navBusy = false;
    updateNavButtons();
  }
}

document.getElementById('folderBackBtn').onclick = goFolderBack;
document.getElementById('folderForwardBtn').onclick = goFolderForward;
updateNavButtons();

// Tampilkan link "Admin" di topbar kalau user ini admin
(async () => {
  const res = await api('/api/auth/me');
  if (!res) return;
  const me = await res.json();
  if (me.is_admin) {
    document.getElementById('adminLink').hidden = false;
  }
})();

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[i];
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
  return (bytesPerSec / 1024 / 1024).toFixed(1) + ' MB/s';
}

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return Math.ceil(seconds) + ' detik';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return `${m}m ${s}d`;
  const h = Math.floor(m / 60);
  return `${h}j ${m % 60}m`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function isPreviewable(mime) {
  return mime && (
    mime.startsWith('image/') || mime === 'application/pdf' ||
    mime.startsWith('video/') || mime.startsWith('audio/')
  );
}

const CATEGORY_ICONS = {
  dokumen: '📄', gambar: '🖼️', video: '🎬', audio: '🎵', arsip: '🗜️', lainnya: '📦',
};
function categoryIcon(category) { return CATEGORY_ICONS[category] || '📦'; }

// ---------- Breadcrumb & list utama ----------

function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  bc.innerHTML = '';
  const root = document.createElement('span');
  root.textContent = '🏠 Root';
  root.onclick = () => goToBreadcrumb(-1);
  bc.appendChild(root);

  folderStack.forEach((f, idx) => {
    bc.append(' / ');
    const s = document.createElement('span');
    s.textContent = f.name;
    s.onclick = () => goToBreadcrumb(idx);
    bc.appendChild(s);
  });
}

let viewMode = localStorage.getItem('td_view_mode') || 'list';
let lastData = null; // cache data terakhir biar toggle view / sort gak perlu fetch ulang ke server

// ---------- Sort (Nama / Ukuran / Tanggal) ----------

const SORT_KEY = 'td_sort_key';
const SORT_DIR = 'td_sort_dir';
let sortKey = localStorage.getItem(SORT_KEY) || 'name';
let sortDir = localStorage.getItem(SORT_DIR) || 'asc';

function compareByKey(a, b, isFolder) {
  if (sortKey === 'size') {
    const av = isFolder ? 0 : Number(a.size || 0);
    const bv = isFolder ? 0 : Number(b.size || 0);
    if (av !== bv) return av - bv;
  } else if (sortKey === 'date') {
    const av = new Date(a.created_at || 0).getTime();
    const bv = new Date(b.created_at || 0).getTime();
    if (av !== bv) return av - bv;
  }
  const an = String(a.original_name || a.name || '');
  const bn = String(b.original_name || b.name || '');
  return an.localeCompare(bn, 'id', { numeric: true, sensitivity: 'base' });
}

function sortData(data) {
  if (!data) return;
  const dir = sortDir === 'desc' ? -1 : 1;
  if (Array.isArray(data.folders)) data.folders.sort((a, b) => compareByKey(a, b, true) * dir);
  if (Array.isArray(data.files)) data.files.sort((a, b) => compareByKey(a, b, false) * dir);
}

function setSort(key, dir) {
  sortKey = key;
  sortDir = dir;
  localStorage.setItem(SORT_KEY, sortKey);
  localStorage.setItem(SORT_DIR, sortDir);
  sortData(lastData);
  renderCurrentView();
}

function initSortControl() {
  const select = document.getElementById('sortSelect');
  const dirBtn = document.getElementById('sortDirBtn');
  if (!select || !dirBtn) return;
  select.value = sortKey;
  dirBtn.textContent = sortDir === 'asc' ? '↑' : '↓';
  dirBtn.title = sortDir === 'asc' ? 'Urutan naik (A-Z / kecil-besar)' : 'Urutan turun (Z-A / besar-kecil)';

  select.onchange = () => setSort(select.value, sortDir);
  dirBtn.onclick = () => {
    const nextDir = sortDir === 'asc' ? 'desc' : 'asc';
    dirBtn.textContent = nextDir === 'asc' ? '↑' : '↓';
    setSort(sortKey, nextDir);
  };
}

function updateSortHeaders() {
  const table = document.getElementById('mainTable');
  if (!table) return;
  table.querySelectorAll('thead th[data-sort-key]').forEach((th) => {
    const key = th.dataset.sortKey;
    th.classList.toggle('sort-active', key === sortKey);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = key === sortKey ? (sortDir === 'asc' ? '↑' : '↓') : '';
  });
}

function initSortHeaders() {
  const table = document.getElementById('mainTable');
  if (!table) return;
  table.querySelectorAll('thead th[data-sort-key]').forEach((th) => {
    th.classList.add('sortable');
    if (!th.querySelector('.sort-arrow')) th.insertAdjacentHTML('beforeend', ' <span class="sort-arrow"></span>');
    th.onclick = () => {
      const key = th.dataset.sortKey;
      setSort(key, key === sortKey ? (sortDir === 'asc' ? 'desc' : 'asc') : 'asc');
    };
  });
  updateSortHeaders();
}

// ---------- Select All ----------

function initSelectAll() {
  const cb = document.getElementById('selectAllBox');
  if (!cb) return;
  cb.onchange = () => {
    if (!lastData) return;
    lastData.folders.forEach((f) => { if (cb.checked) selectedFolders.add(f.id); else selectedFolders.delete(f.id); });
    lastData.files.forEach((f) => { if (cb.checked) selectedFiles.add(f.id); else selectedFiles.delete(f.id); });
    renderCurrentView();
  };
}

function updateSelectAllUI() {
  const cb = document.getElementById('selectAllBox');
  if (!cb || !lastData) return;
  const total = lastData.folders.length + lastData.files.length;
  const selected = lastData.folders.filter((f) => selectedFolders.has(f.id)).length +
    lastData.files.filter((f) => selectedFiles.has(f.id)).length;
  cb.checked = total > 0 && selected === total;
  cb.indeterminate = selected > 0 && selected < total;
}

async function loadList() {
  renderBreadcrumb();
  const q = currentFolder ? `?folder_id=${currentFolder}` : '';
  const res = await api(`/api/drive/list${q}`);
  const data = await res.json();
  sortData(data);
  lastData = data;

  renderQuota(data.quota);

  const empty = document.getElementById('emptyMsg');
  empty.hidden = data.folders.length + data.files.length > 0;

  // Buang seleksi buat item yang sudah tidak ada di folder ini (mis. setelah pindah folder)
  const visibleFolderIds = new Set(data.folders.map((f) => f.id));
  const visibleFileIds = new Set(data.files.map((f) => f.id));
  selectedFolders.forEach((id) => { if (!visibleFolderIds.has(id)) selectedFolders.delete(id); });
  selectedFiles.forEach((id) => { if (!visibleFileIds.has(id)) selectedFiles.delete(id); });

  renderCurrentView();
}

function renderCurrentView() {
  if (!lastData) return;
  const mainTableEl = document.getElementById('mainTable');
  const gridViewEl = document.getElementById('gridView');

  if (viewMode === 'grid') {
    mainTableEl.hidden = true;
    gridViewEl.hidden = false;
    renderGridView(lastData);
  } else {
    mainTableEl.hidden = false;
    gridViewEl.hidden = true;
    renderTableView(lastData);
  }
  renderBulkToolbar();
  updateSortHeaders();
  updateSelectAllUI();
}

function renderTableView(data) {
  const body = document.getElementById('listBody');
  body.innerHTML = '';

  data.folders.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="name-cell">
        <input type="checkbox" class="row-check" data-folder-check="${f.id}" ${selectedFolders.has(f.id) ? 'checked' : ''} />
        <span class="name-text">📁 ${escapeHtml(f.name)}</span>
      </td>
      <td>—</td>
      <td>${new Date(f.created_at).toLocaleDateString('id-ID')}</td>
      <td class="row-actions">
        <button data-share-folder title="Bagikan">🔗</button>
        <button data-zip-folder title="Download ZIP">📦</button>
        <button data-rename-folder title="Rename">✏️</button>
        <button data-move-folder title="Pindah">📂</button>
        <button data-del-folder title="Hapus">🗑</button>
      </td>
    `;
    tr.querySelector('[data-folder-check]').onclick = (e) => {
      e.stopPropagation();
      toggleSelect('folder', f.id, e.target.checked);
    };
    const nameSpan = tr.querySelector('.name-cell');
    nameSpan.onclick = (e) => {
      if (e.target.closest('input')) return;
      openFolder(f);
    };
    tr.querySelector('[data-share-folder]').onclick = (e) => {
      e.stopPropagation();
      openShareModal('folder', f.id, f.name);
    };
    tr.querySelector('[data-zip-folder]').onclick = (e) => {
      e.stopPropagation();
      downloadZip({ folderIds: [f.id], name: f.name });
    };
    tr.querySelector('[data-rename-folder]').onclick = async (e) => {
      e.stopPropagation();
      const newName = prompt('Nama baru:', f.name);
      if (!newName || newName === f.name) return;
      const res = await api(`/api/drive/folders/${f.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) loadList(); else alert((await res.json()).error);
    };
    tr.querySelector('[data-move-folder]').onclick = (e) => {
      e.stopPropagation();
      openMovePicker('folder', f.id, f.name);
    };
    tr.querySelector('[data-del-folder]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Hapus folder "${f.name}" beserta isinya?`)) return;
      await api(`/api/drive/folders/${f.id}`, { method: 'DELETE' });
      loadList();
    };
    body.appendChild(tr);
  });

  data.files.forEach((f) => {
    const tr = document.createElement('tr');
    const icon = categoryIcon(f.category);
    tr.innerHTML = `
      <td class="name-cell cat-${f.category}">
        <input type="checkbox" class="row-check" data-file-check="${f.id}" ${selectedFiles.has(f.id) ? 'checked' : ''} />
        <span class="name-text"><span class="cat-dot"></span>${icon} ${escapeHtml(f.original_name)}</span>
      </td>
      <td>${fmtSize(f.size)}</td>
      <td>${new Date(f.created_at).toLocaleDateString('id-ID')}</td>
      <td class="row-actions">
        ${isPreviewable(f.mime_type) ? '<button data-preview title="Lihat">👁</button>' : ''}
        <button data-dl title="Download">⬇</button>
        <button data-share-file title="Bagikan">🔗</button>
        <button data-rename-file title="Rename">✏️</button>
        <button data-move-file title="Pindah">📂</button>
        <button data-del-file title="Hapus">🗑</button>
      </td>
    `;
    tr.querySelector('[data-file-check]').onclick = (e) => {
      e.stopPropagation();
      toggleSelect('file', f.id, e.target.checked);
    };
    if (isPreviewable(f.mime_type)) {
      tr.querySelector('.name-cell').onclick = (e) => {
        if (e.target.closest('input')) return;
        openPreview(f.id, f.original_name, f.mime_type);
      };
      const pv = tr.querySelector('[data-preview]');
      if (pv) pv.onclick = () => openPreview(f.id, f.original_name, f.mime_type);
    }
    tr.querySelector('[data-dl]').onclick = () => downloadWithAuth(f.id, f.original_name);
    tr.querySelector('[data-share-file]').onclick = () => openShareModal('file', f.id, f.original_name);
    tr.querySelector('[data-rename-file]').onclick = async () => {
      const newName = prompt('Nama baru:', f.original_name);
      if (!newName || newName === f.original_name) return;
      const res = await api(`/api/drive/files/${f.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) loadList(); else alert((await res.json()).error);
    };
    tr.querySelector('[data-move-file]').onclick = () => openMovePicker('file', f.id, f.original_name);
    tr.querySelector('[data-del-file]').onclick = async () => {
      if (!confirm(`Hapus "${f.original_name}"?`)) return;
      await api(`/api/drive/files/${f.id}`, { method: 'DELETE' });
      loadList();
    };
    body.appendChild(tr);
  });
}

function renderGridView(data) {
  const container = document.getElementById('gridView');
  container.innerHTML = '';

  data.folders.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'grid-card';
    card.innerHTML = `
      <input type="checkbox" class="grid-card-check" data-folder-check="${f.id}" ${selectedFolders.has(f.id) ? 'checked' : ''} />
      <div class="grid-card-actions">
        <button data-share-folder title="Bagikan">🔗</button>
        <button data-zip-folder title="Download ZIP">📦</button>
        <button data-rename-folder title="Rename">✏️</button>
        <button data-move-folder title="Pindah">📂</button>
        <button data-del-folder title="Hapus">🗑</button>
      </div>
      <div class="grid-card-thumb">📁</div>
      <div class="grid-card-name">${escapeHtml(f.name)}</div>
      <div class="grid-card-meta">Folder</div>
    `;
    card.querySelector('[data-folder-check]').onclick = (e) => {
      e.stopPropagation();
      toggleSelect('folder', f.id, e.target.checked);
    };
    card.onclick = (e) => {
      if (e.target.closest('input') || e.target.closest('button')) return;
      openFolder(f);
    };
    card.querySelector('[data-share-folder]').onclick = (e) => {
      e.stopPropagation();
      openShareModal('folder', f.id, f.name);
    };
    card.querySelector('[data-zip-folder]').onclick = (e) => {
      e.stopPropagation();
      downloadZip({ folderIds: [f.id], name: f.name });
    };
    card.querySelector('[data-rename-folder]').onclick = async (e) => {
      e.stopPropagation();
      const newName = prompt('Nama baru:', f.name);
      if (!newName || newName === f.name) return;
      const res = await api(`/api/drive/folders/${f.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) loadList(); else alert((await res.json()).error);
    };
    card.querySelector('[data-move-folder]').onclick = (e) => {
      e.stopPropagation();
      openMovePicker('folder', f.id, f.name);
    };
    card.querySelector('[data-del-folder]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Hapus folder "${f.name}" beserta isinya?`)) return;
      await api(`/api/drive/folders/${f.id}`, { method: 'DELETE' });
      loadList();
    };
    container.appendChild(card);
  });

  data.files.forEach((f) => {
    const card = document.createElement('div');
    card.className = `grid-card cat-${f.category}`;

    const isImage = f.mime_type && f.mime_type.startsWith('image/');
    const isVideo = f.mime_type && f.mime_type.startsWith('video/');
    let thumbHtml;
    if (isImage) {
      // Pakai thumbnail kecil (dibikin server pas upload), BUKAN file
      // aslinya -- grid isi puluhan foto jadi berat banget kalau tiap
      // kartu narik file full-res. Foto lama (sebelum fitur ini ada)
      // belum punya thumbnail; fallback ke file asli ditangani di onerror.
      thumbHtml = `<img src="${thumbnailUrl(f.id)}" data-fallback="${previewUrl(f.id)}" alt="${escapeHtml(f.original_name)}" loading="lazy" />`;
    } else if (isVideo) {
      thumbHtml = `<img src="${thumbnailUrl(f.id)}" alt="${escapeHtml(f.original_name)}" loading="lazy" /><div class="play-badge">▶</div>`;
    } else {
      thumbHtml = categoryIcon(f.category);
    }

    card.innerHTML = `
      <input type="checkbox" class="grid-card-check" data-file-check="${f.id}" ${selectedFiles.has(f.id) ? 'checked' : ''} />
      <div class="grid-card-actions">
        ${isPreviewable(f.mime_type) ? '<button data-preview title="Lihat">👁</button>' : ''}
        <button data-dl title="Download">⬇</button>
        <button data-share-file title="Bagikan">🔗</button>
        <button data-rename-file title="Rename">✏️</button>
        <button data-move-file title="Pindah">📂</button>
        <button data-del-file title="Hapus">🗑</button>
      </div>
      <div class="grid-card-thumb">${thumbHtml}</div>
      <div class="grid-card-name">${escapeHtml(f.original_name)}</div>
      <div class="grid-card-meta">${fmtSize(f.size)}</div>
    `;

    const thumbImg = card.querySelector('.grid-card-thumb img');
    if (thumbImg) {
      thumbImg.onerror = () => {
        const fallback = thumbImg.dataset.fallback;
        if (fallback && thumbImg.src !== fallback) {
          // Thumbnail gagal dimuat (mis. file lama belum punya thumbnail) --
          // coba sekali lagi pakai file aslinya sebelum nyerah ke ikon.
          thumbImg.onerror = () => {
            thumbImg.remove();
            card.querySelector('.grid-card-thumb').textContent = categoryIcon(f.category);
          };
          thumbImg.src = fallback;
          return;
        }
        if (isVideo) {
          thumbImg.remove();
          card.querySelector('.grid-card-thumb').insertAdjacentHTML('afterbegin', categoryIcon(f.category));
        } else {
          card.querySelector('.grid-card-thumb').textContent = categoryIcon(f.category);
        }
      };
    }

    card.querySelector('[data-file-check]').onclick = (e) => {
      e.stopPropagation();
      toggleSelect('file', f.id, e.target.checked);
    };
    if (isPreviewable(f.mime_type)) {
      card.onclick = (e) => {
        if (e.target.closest('input') || e.target.closest('button')) return;
        openPreview(f.id, f.original_name, f.mime_type);
      };
      const pv = card.querySelector('[data-preview]');
      if (pv) pv.onclick = (e) => { e.stopPropagation(); openPreview(f.id, f.original_name, f.mime_type); };
    }
    card.querySelector('[data-dl]').onclick = (e) => { e.stopPropagation(); downloadWithAuth(f.id, f.original_name); };
    card.querySelector('[data-share-file]').onclick = (e) => { e.stopPropagation(); openShareModal('file', f.id, f.original_name); };
    card.querySelector('[data-rename-file]').onclick = async (e) => {
      e.stopPropagation();
      const newName = prompt('Nama baru:', f.original_name);
      if (!newName || newName === f.original_name) return;
      const res = await api(`/api/drive/files/${f.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName }),
      });
      if (res.ok) loadList(); else alert((await res.json()).error);
    };
    card.querySelector('[data-move-file]').onclick = (e) => { e.stopPropagation(); openMovePicker('file', f.id, f.original_name); };
    card.querySelector('[data-del-file]').onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Hapus "${f.original_name}"?`)) return;
      await api(`/api/drive/files/${f.id}`, { method: 'DELETE' });
      loadList();
    };
    container.appendChild(card);
  });
}

// ---------- Toggle List / Grid ----------

const viewListBtn = document.getElementById('viewListBtn');
const viewGridBtn = document.getElementById('viewGridBtn');

function updateViewToggleUI() {
  viewListBtn.classList.toggle('active', viewMode === 'list');
  viewGridBtn.classList.toggle('active', viewMode === 'grid');
}

viewListBtn.onclick = () => {
  viewMode = 'list';
  localStorage.setItem('td_view_mode', viewMode);
  updateViewToggleUI();
  renderCurrentView();
};
viewGridBtn.onclick = () => {
  viewMode = 'grid';
  localStorage.setItem('td_view_mode', viewMode);
  updateViewToggleUI();
  renderCurrentView();
};
updateViewToggleUI();

function renderQuota(quota) {
  if (!quota) return;
  const pct = quota.total > 0 ? Math.min(100, (quota.used / quota.total) * 100) : 0;
  document.getElementById('quotaBarFill').style.width = pct.toFixed(1) + '%';
  document.getElementById('quotaBarFill').classList.toggle('quota-warn', pct >= 90);
  document.getElementById('quotaText').textContent = `${fmtSize(quota.used)} / ${fmtSize(quota.total)} terpakai`;
}

// ---------- Multi-select & bulk actions ----------

function toggleSelect(type, id, checked) {
  const set = type === 'folder' ? selectedFolders : selectedFiles;
  if (checked) set.add(id); else set.delete(id);
  renderBulkToolbar();
  updateSelectAllUI();
}

function clearSelection() {
  selectedFiles.clear();
  selectedFolders.clear();
  document.querySelectorAll('.row-check, .grid-card-check').forEach((cb) => { cb.checked = false; });
  renderBulkToolbar();
  updateSelectAllUI();
}

function renderBulkToolbar() {
  const bar = document.getElementById('bulkToolbar');
  const count = selectedFiles.size + selectedFolders.size;
  if (count === 0) { bar.hidden = true; return; }
  bar.hidden = false;
  document.getElementById('bulkCount').textContent = `${count} item dipilih`;
}

document.getElementById('bulkCancelBtn').onclick = clearSelection;

document.getElementById('bulkDeleteBtn').onclick = async () => {
  const count = selectedFiles.size + selectedFolders.size;
  if (!confirm(`Hapus ${count} item terpilih? Ini tidak bisa dibatalkan.`)) return;

  const res = await api('/api/drive/bulk-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_ids: [...selectedFiles], folder_ids: [...selectedFolders] }),
  });
  const result = await res.json();
  clearSelection();
  loadList();
  if (result.skipped && result.skipped.length) {
    alert(`Selesai. ${result.skipped.length} item dilewati (bukan milik kamu atau tidak ditemukan).`);
  }
};

document.getElementById('bulkMoveBtn').onclick = () => {
  openMovePicker('bulk', null, `${selectedFiles.size + selectedFolders.size} item`);
};

document.getElementById('bulkZipBtn').onclick = () => {
  const count = selectedFiles.size + selectedFolders.size;
  const name = count === 1 ? 'VaultKu' : `VaultKu-${count}-item`;
  downloadZip({ fileIds: [...selectedFiles], folderIds: [...selectedFolders], name });
};

async function downloadWithAuth(id, filename) {
  const res = await api(`/api/drive/download/${id}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/** Download folder (atau hasil pilihan bulk) sebagai satu file .zip.
 * Lewat navigasi <a> langsung (bukan fetch+blob) -- biar progress
 * download-nya ditangani browser sendiri & gak numpuk di memori buat
 * folder yang isinya gede. Token lewat query param, sama kayak preview. */
function downloadZip({ fileIds = [], folderIds = [], name = 'VaultKu' } = {}) {
  const params = new URLSearchParams({ name, token: getToken() });
  if (fileIds.length) params.set('file_ids', fileIds.join(','));
  if (folderIds.length) params.set('folder_ids', folderIds.join(','));

  const a = document.createElement('a');
  a.href = `/api/drive/download-zip?${params.toString()}`;
  a.download = `${name}.zip`;
  document.body.appendChild(a); a.click(); a.remove();
}

document.getElementById('newFolderBtn').onclick = async () => {
  const name = prompt('Nama folder baru:');
  if (!name) return;
  const res = await api('/api/drive/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, parent_id: currentFolder }),
  });
  if (res.ok) loadList();
  else alert((await res.json()).error);
};

// ---------- Preview (gambar & PDF) ----------

const previewModal = document.getElementById('previewModal');
const previewBody = document.getElementById('previewBody');
const previewTitle = document.getElementById('previewTitle');
document.getElementById('previewClose').onclick = closePreview;
previewModal.onclick = (e) => { if (e.target === previewModal) closePreview(); };

/** URL langsung ke endpoint preview, token lewat query param karena elemen
 * <video>/<audio>/<img> tidak bisa kirim header Authorization custom.
 * Dipakai langsung sebagai `src` (bukan fetch+blob) supaya browser bisa
 * kirim HTTP Range request sendiri -- itu yang bikin video bisa di-seek
 * kayak YouTube tanpa nunggu download penuh dulu. */
function previewUrl(id) {
  return `/api/drive/preview/${id}?token=${encodeURIComponent(getToken())}`;
}

function thumbnailUrl(id) {
  return `/api/drive/thumbnail/${id}?token=${encodeURIComponent(getToken())}`;
}

function openPreview(id, name, mime) {
  previewTitle.textContent = name;
  previewModal.hidden = false;
  const url = previewUrl(id);

  if (mime.startsWith('image/')) {
    previewBody.innerHTML = `<img src="${url}" alt="${escapeHtml(name)}" />`;
    previewBody.querySelector('img').onerror = () => {
      previewBody.innerHTML = '<p class="error">Gagal memuat gambar.</p>';
    };
  } else if (mime === 'application/pdf') {
    previewBody.innerHTML = `<iframe src="${url}"></iframe>`;
  } else if (mime.startsWith('video/')) {
    previewBody.innerHTML = `<video src="${url}" controls autoplay preload="metadata"></video>`;
    previewBody.querySelector('video').onerror = () => {
      previewBody.innerHTML = '<p class="error">Gagal memuat video.</p>';
    };
  } else if (mime.startsWith('audio/')) {
    previewBody.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
    previewBody.querySelector('audio').onerror = () => {
      previewBody.innerHTML = '<p class="error">Gagal memuat audio.</p>';
    };
  } else {
    previewBody.innerHTML = '<p class="error">Tipe file ini tidak didukung untuk preview.</p>';
  }
}

function closePreview() {
  const media = previewBody.querySelector('video, audio');
  if (media) { media.pause(); media.removeAttribute('src'); media.load(); }
  previewModal.hidden = true;
  previewBody.innerHTML = '';
}

// ---------- Move picker (folder & file) ----------

const moveModal = document.getElementById('moveModal');
const moveBody = document.getElementById('moveBody');
const moveBreadcrumb = document.getElementById('moveBreadcrumb');
document.getElementById('moveClose').onclick = closeMovePicker;
document.getElementById('moveHereBtn').onclick = () => confirmMove();
moveModal.onclick = (e) => { if (e.target === moveModal) closeMovePicker(); };

let moveTarget = null; // {type: 'file'|'folder', id, name}
let movePickerFolder = null;
let movePickerStack = [];

function openMovePicker(type, id, name) {
  moveTarget = { type, id, name };
  movePickerFolder = null;
  movePickerStack = [];
  document.getElementById('moveTitle').textContent = `Pindahkan "${name}" ke:`;
  moveModal.hidden = false;
  loadMovePicker();
}

function closeMovePicker() {
  moveModal.hidden = true;
  moveTarget = null;
}

function renderMoveBreadcrumb() {
  moveBreadcrumb.innerHTML = '';
  const root = document.createElement('span');
  root.textContent = '🏠 Root';
  root.onclick = () => { movePickerStack = []; movePickerFolder = null; loadMovePicker(); };
  moveBreadcrumb.appendChild(root);
  movePickerStack.forEach((f, idx) => {
    moveBreadcrumb.append(' / ');
    const s = document.createElement('span');
    s.textContent = f.name;
    s.onclick = () => { movePickerStack = movePickerStack.slice(0, idx + 1); movePickerFolder = f.id; loadMovePicker(); };
    moveBreadcrumb.appendChild(s);
  });
}

async function loadMovePicker() {
  renderMoveBreadcrumb();
  const q = movePickerFolder ? `?folder_id=${movePickerFolder}` : '';
  const res = await api(`/api/drive/list${q}`);
  const data = await res.json();

  moveBody.innerHTML = '';
  const folders = data.folders.filter((f) => {
    if (moveTarget.type === 'folder' && f.id === moveTarget.id) return false;
    if (moveTarget.type === 'bulk' && selectedFolders.has(f.id)) return false;
    return true;
  });

  if (folders.length === 0) {
    moveBody.innerHTML = '<p class="empty-small">Tidak ada subfolder di sini.</p>';
    return;
  }
  folders.forEach((f) => {
    const div = document.createElement('div');
    div.className = 'move-item';
    div.textContent = '📁 ' + f.name;
    div.onclick = () => { movePickerStack.push({ id: f.id, name: f.name }); movePickerFolder = f.id; loadMovePicker(); };
    moveBody.appendChild(div);
  });
}

async function confirmMove() {
  let res;
  if (moveTarget.type === 'bulk') {
    res = await api('/api/drive/bulk-move', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_ids: [...selectedFiles],
        folder_ids: [...selectedFolders],
        target_folder_id: movePickerFolder,
      }),
    });
  } else {
    const endpoint = moveTarget.type === 'folder'
      ? `/api/drive/folders/${moveTarget.id}`
      : `/api/drive/files/${moveTarget.id}`;
    const bodyKey = moveTarget.type === 'folder' ? 'parent_id' : 'folder_id';
    res = await api(endpoint, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [bodyKey]: movePickerFolder }),
    });
  }

  if (res.ok) {
    const result = await res.json();
    closeMovePicker();
    if (moveTarget && moveTarget.type === 'bulk') clearSelection();
    loadList();
    if (result.skipped && result.skipped.length) {
      alert(`Selesai. ${result.skipped.length} item dilewati (nama bentrok / tidak valid).`);
    }
  } else {
    alert((await res.json()).error);
  }
}

// ---------- Hubungkan Telegram (notifikasi kuota via DM) ----------

const telegramModal = document.getElementById('telegramModal');
const telegramModalBody = document.getElementById('telegramModalBody');
document.getElementById('telegramModalClose').onclick = closeTelegramModal;
telegramModal.onclick = (e) => { if (e.target === telegramModal) closeTelegramModal(); };

document.getElementById('telegramLinkBtn').onclick = openTelegramModal;

function closeTelegramModal() {
  telegramModal.hidden = true;
}

async function openTelegramModal() {
  telegramModal.hidden = false;
  telegramModalBody.innerHTML = '<p class="loading">Memuat...</p>';

  const res = await api('/api/auth/telegram/status');
  if (!res) return;
  const status = await res.json();

  if (status.linked) {
    telegramModalBody.innerHTML = `
      <p class="tg-status-linked">✅ Akun Telegram kamu sudah terhubung.<br>
      Kamu akan dapat notifikasi DM otomatis kalau kuota penyimpanan hampir penuh.</p>
      <button id="tgUnlinkBtn" class="danger-btn tg-action-btn">Putuskan Koneksi</button>
    `;
    document.getElementById('tgUnlinkBtn').onclick = async () => {
      if (!confirm('Putuskan koneksi Telegram? Kamu tidak akan dapat notifikasi kuota lagi.')) return;
      const r = await api('/api/auth/telegram/link', { method: 'DELETE' });
      if (r && r.ok) openTelegramModal();
    };
  } else {
    telegramModalBody.innerHTML = `
      <p>Hubungkan akun Telegram kamu supaya dapat notifikasi DM otomatis kalau kuota penyimpanan hampir penuh.</p>
      <button id="tgGenerateBtn" class="primary-btn tg-action-btn">Generate Kode</button>
      <div id="tgCodeArea"></div>
    `;
    document.getElementById('tgGenerateBtn').onclick = generateTelegramCode;
  }
}

async function generateTelegramCode() {
  const res = await api('/api/auth/telegram/link-code', { method: 'POST' });
  if (!res) return;
  if (!res.ok) {
    document.getElementById('tgCodeArea').innerHTML = `<p class="error">${escapeHtml((await res.json()).error)}</p>`;
    return;
  }
  const data = await res.json();
  const botInfo = data.bot_username
    ? `<a href="https://t.me/${data.bot_username}" target="_blank" rel="noopener">@${escapeHtml(data.bot_username)}</a>`
    : 'bot VaultKu kamu';

  document.getElementById('tgCodeArea').innerHTML = `
    <p class="tg-code-label">Kirim pesan ini ke ${botInfo} dalam ${data.expires_in_minutes} menit:</p>
    <div class="tg-code-box">/start ${escapeHtml(data.code)}</div>
    <p class="tg-code-hint">Setelah dikirim, bot akan otomatis balas konfirmasi. Buka modal ini lagi buat cek statusnya.</p>
  `;
}

// ---------- Share link (bagikan file/folder ke siapa aja lewat link publik) ----------

const shareModal = document.getElementById('shareModal');
const shareLinkInput = document.getElementById('shareLinkInput');
document.getElementById('shareModalClose').onclick = () => { shareModal.hidden = true; };
shareModal.onclick = (e) => { if (e.target === shareModal) shareModal.hidden = true; };

let currentShareToken = null;

async function openShareModal(type, id, name) {
  document.getElementById('shareModalTitle').textContent = `🔗 Bagikan "${name}"`;
  shareLinkInput.value = 'Memuat...';
  currentShareToken = null;
  shareModal.hidden = false;

  const endpoint = type === 'folder' ? `/api/drive/folders/${id}/share` : `/api/drive/files/${id}/share`;
  const res = await api(endpoint, { method: 'POST' });
  if (!res || !res.ok) {
    shareLinkInput.value = '';
    alert('Gagal membuat link share.');
    shareModal.hidden = true;
    return;
  }
  const data = await res.json();
  currentShareToken = data.token;
  shareLinkInput.value = `${window.location.origin}/s/${data.token}`;
  shareLinkInput.focus();
  shareLinkInput.select();
}

document.getElementById('shareCopyBtn').onclick = async () => {
  const btn = document.getElementById('shareCopyBtn');
  try {
    await navigator.clipboard.writeText(shareLinkInput.value);
  } catch (err) {
    shareLinkInput.select();
    document.execCommand('copy');
  }
  const original = btn.textContent;
  btn.textContent = '✓ Disalin';
  setTimeout(() => { btn.textContent = original; }, 1500);
};

document.getElementById('shareRevokeBtn').onclick = async () => {
  if (!currentShareToken) return;
  if (!confirm('Nonaktifkan link share ini? Siapa pun yang sudah punya link ini gak akan bisa akses lagi.')) return;
  const res = await api(`/api/drive/share/${currentShareToken}`, { method: 'DELETE' });
  if (res && res.ok) {
    shareModal.hidden = true;
    currentShareToken = null;
  } else {
    alert('Gagal menonaktifkan link.');
  }
};

// ---------- Resumable upload ----------

document.getElementById('fileInputFiles').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  closeUploadMenu();
  if (!files.length) return;
  await uploadQueue(files);
};

document.getElementById('fileInputGallery').onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  closeUploadMenu();
  if (!files.length) return;
  await uploadQueue(files);
};

// Menu kecil "Berkas" vs "Galeri" -- opsi "Berkas" buka file manager
// (paling aman buat dapet file asli tanpa diproses ulang), opsi "Galeri"
// buka picker foto/video bawaan HP. Kompresi galeri itu keputusan OS
// (iOS/Android), gak bisa dipaksa dari web -- "Berkas" jalur paling aman
// buat file 1:1 asli.
const uploadMenuBtn = document.getElementById('uploadMenuBtn');
const uploadMenu = document.getElementById('uploadMenu');

function closeUploadMenu() { uploadMenu.hidden = true; }
function toggleUploadMenu() { uploadMenu.hidden = !uploadMenu.hidden; }

uploadMenuBtn.onclick = (e) => { e.stopPropagation(); toggleUploadMenu(); };
document.addEventListener('click', (e) => {
  if (!uploadMenu.hidden && !e.target.closest('.upload-menu-wrap')) closeUploadMenu();
});

const progressBox = document.getElementById('uploadProgress');
const uploadQueueList = document.getElementById('uploadQueueList');

/** Bikin satu kartu row di panel upload buat 1 file, return referensi ke
 * elemen-elemen di dalamnya biar resumableUpload() bisa update langsung
 * row ini aja (bukan elemen tunggal global kayak sebelumnya). */
function createUploadRow(file) {
  const root = document.createElement('div');
  root.className = 'upload-row state-queued';
  root.innerHTML = `
    <div class="upload-row-icon">⋯</div>
    <div class="upload-row-body">
      <div class="upload-row-top">
        <span class="upload-row-name">${escapeHtml(file.name)}</span>
        <span class="upload-row-pct"></span>
      </div>
      <div class="bar"><div class="bar-fill" style="width:0%"></div></div>
      <span class="upload-row-speed"></span>
    </div>
  `;
  uploadQueueList.appendChild(root);
  progressBox.hidden = false;

  return {
    root,
    icon: root.querySelector('.upload-row-icon'),
    name: root.querySelector('.upload-row-name'),
    pct: root.querySelector('.upload-row-pct'),
    bar: root.querySelector('.bar-fill'),
    speed: root.querySelector('.upload-row-speed'),
    setState(state) {
      root.className = `upload-row state-${state}`;
    },
    setProgress(pct) {
      this.bar.style.width = pct + '%';
      this.pct.textContent = pct + '%';
    },
  };
}

/** Hapus row dengan animasi fade-out halus, bukan langsung ilang. */
function removeUploadRow(row, delayMs) {
  setTimeout(() => {
    row.root.classList.add('removing');
    setTimeout(() => {
      row.root.remove();
      if (!uploadQueueList.children.length) progressBox.hidden = true;
    }, 260);
  }, delayMs);
}

/** Upload banyak file sekaligus, SATU PER SATU (bukan paralel) --
 * lebih aman buat koneksi & kuota server. Semua file langsung ditampilin
 * sebagai kartu di panel (status "Menunggu giliran..."), lalu tiap kartu
 * berubah status seiring gilirannya diproses -- bukan cuma 1 kartu yang
 * gonta-ganti isi kayak sebelumnya. Kalau satu file gagal, lanjut ke file
 * berikutnya (gak ngeblok semuanya), lalu tampilkan ringkasan di akhir. */
async function uploadQueue(files) {
  const failed = [];
  const rows = files.map((file) => createUploadRow(file));

  for (let i = 0; i < files.length; i++) {
    const result = await resumableUpload(files[i], rows[i]);
    if (result.status === 'failed') failed.push({ name: files[i].name, message: result.message });
  }

  loadList();
  if (failed.length) {
    const detail = failed.map((f) => `• ${f.name}\n  ${f.message}`).join('\n\n');
    alert(`${failed.length} dari ${files.length} file gagal diupload:\n\n${detail}`);
  }
}

// ---------- File duplikat: tanya timpa / ganti nama / lewati ----------

const duplicateModal = document.getElementById('duplicateModal');
duplicateModal.onclick = (e) => { if (e.target === duplicateModal) resolveDuplicateChoice('skip'); };
document.getElementById('duplicateModalClose').onclick = () => resolveDuplicateChoice('skip');
document.getElementById('dupOverwriteBtn').onclick = () => resolveDuplicateChoice('overwrite');
document.getElementById('dupRenameBtn').onclick = () => resolveDuplicateChoice('rename');
document.getElementById('dupSkipBtn').onclick = () => resolveDuplicateChoice('skip');

let duplicateResolver = null;
function resolveDuplicateChoice(action) {
  duplicateModal.hidden = true;
  if (duplicateResolver) { duplicateResolver(action); duplicateResolver = null; }
}

/** Tampilkan modal & tunggu user pilih 'overwrite' | 'rename' | 'skip'. */
function askDuplicateAction(existingFile, newFile) {
  const sameSize = existingFile.size === newFile.size;
  document.getElementById('duplicateMsg').textContent =
    `File "${newFile.name}" sudah ada di folder ini` +
    (sameSize
      ? ` dengan ukuran yang sama (${fmtSize(newFile.size)}) -- kemungkinan file yang sama persis.`
      : ` (file lama: ${fmtSize(existingFile.size)}, file baru: ${fmtSize(newFile.size)}).`) +
    ' Mau diapain?';
  duplicateModal.hidden = false;
  return new Promise((resolve) => { duplicateResolver = resolve; });
}

/** Cari nama yang belum kepakai di folder ini dengan nambahin " (1)", " (2)", dst. */
async function resolveUniqueName(originalName, folderId) {
  const dotIdx = originalName.lastIndexOf('.');
  const base = dotIdx > 0 ? originalName.slice(0, dotIdx) : originalName;
  const ext = dotIdx > 0 ? originalName.slice(dotIdx) : '';

  for (let i = 1; i <= 50; i++) {
    const candidate = `${base} (${i})${ext}`;
    const res = await api(`/api/drive/check-duplicate?filename=${encodeURIComponent(candidate)}&folder_id=${folderId ?? ''}`);
    if (res && res.ok) {
      const data = await res.json();
      if (!data.duplicate) return candidate;
    }
  }
  return `${base} (${Date.now()})${ext}`; // fallback super jarang kepakai
}
// Drop file dari luar (file manager / desktop) ke mana pun di halaman ini
// langsung upload ke folder yang lagi dibuka. Pakai counter buat
// dragenter/dragleave supaya overlay gak kedip-kedip pas mouse lewat di
// atas elemen anak (pola standar buat drag-drop di seluruh halaman).
const dropOverlay = document.getElementById('dropOverlay');
let dragCounter = 0;

function isFileDrag(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay.hidden = false;
});

window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault(); // wajib, biar browser ngizinin drop (defaultnya nolak)
});

window.addEventListener('dragleave', (e) => {
  if (!isFileDrag(e)) return;
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) dropOverlay.hidden = true;
});

window.addEventListener('drop', async (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.hidden = true;

  // Item folder yang ke-drag ikut kebawa browser sebagai "file" tanpa
  // ukuran/tipe -- disaring di sini biar gak nyoba upload folder kosong.
  const files = Array.from(e.dataTransfer.files || []).filter((f) => f.size > 0 || f.type);
  if (files.length) await uploadQueue(files);
});

async function resumableUpload(file, row) {
  row.setState('uploading');
  row.icon.textContent = '⬆';
  row.name.textContent = file.name;
  row.setProgress(0);

  const resumeKey = `td_resume_${file.name}_${file.size}_${currentFolder || 'root'}`;
  let uploadName = file.name; // bisa berubah kalau user pilih "Ganti Nama Otomatis"

  try {
    let uploadId, blockSize, totalBlocks, alreadyReceived = new Set();

    const existingId = localStorage.getItem(resumeKey);
    if (existingId) {
      const statusRes = await api(`/api/drive/upload/${existingId}/status`);
      if (statusRes && statusRes.ok) {
        const status = await statusRes.json();
        uploadId = existingId;
        totalBlocks = status.total_blocks;
        alreadyReceived = new Set(status.received_blocks);
        blockSize = Math.ceil(file.size / totalBlocks);
        row.speed.textContent = `Melanjutkan (${alreadyReceived.size}/${totalBlocks} bagian sudah terkirim)...`;
      } else {
        localStorage.removeItem(resumeKey);
      }
    }

    if (!uploadId) {
      // Sesi baru (bukan resume) -- cek dulu apakah nama ini udah dipakai
      // file lain di folder yang sama, SEBELUM mulai kirim data beneran.
      const dupRes = await api(`/api/drive/check-duplicate?filename=${encodeURIComponent(file.name)}&folder_id=${currentFolder ?? ''}`);
      if (dupRes && dupRes.ok) {
        const dup = await dupRes.json();
        if (dup.duplicate) {
          const action = await askDuplicateAction(dup.file, file);
          if (action === 'skip') {
            row.setState('skipped');
            row.speed.textContent = 'Dilewati (sudah ada)';
            removeUploadRow(row, 2000);
            return { status: 'skipped' };
          }
          if (action === 'overwrite') {
            row.speed.textContent = 'Menghapus file lama...';
            await api(`/api/drive/files/${dup.file.id}`, { method: 'DELETE' });
          } else if (action === 'rename') {
            row.speed.textContent = 'Mencari nama yang belum kepakai...';
            uploadName = await resolveUniqueName(file.name, currentFolder);
            row.name.textContent = uploadName;
          }
        }
      }

      const initRes = await api('/api/drive/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: uploadName,
          size: file.size,
          mime_type: file.type || 'application/octet-stream',
          folder_id: currentFolder,
        }),
      });
      if (!initRes.ok) throw new Error((await initRes.json()).error || 'Gagal memulai upload');
      const init = await initRes.json();
      uploadId = init.upload_id;
      blockSize = init.block_size;
      totalBlocks = init.total_blocks;
      localStorage.setItem(resumeKey, uploadId);
    }

    let speedSamples = []; // rata-rata beberapa block terakhir biar angka speed gak lompat-lompat

    for (let i = 0; i < totalBlocks; i++) {
      if (alreadyReceived.has(i)) {
        row.setProgress(Math.round(((i + 1) / totalBlocks) * 100));
        continue;
      }

      const start = i * blockSize;
      const end = Math.min(start + blockSize, file.size);
      const blob = file.slice(start, end);
      const blockStartTime = performance.now();

      let attempt = 0;
      while (true) {
        attempt++;
        try {
          const blockRes = await api(`/api/drive/upload/${uploadId}/block/${i}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob,
          });
          if (!blockRes.ok) throw new Error((await blockRes.json()).error || `Block ${i} gagal`);
          break;
        } catch (err) {
          if (attempt >= 3) throw err;
          row.speed.textContent = `Block ${i + 1}/${totalBlocks} gagal, mencoba lagi (${attempt}/3)...`;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }

      const elapsedSec = (performance.now() - blockStartTime) / 1000;
      const instantSpeed = elapsedSec > 0 ? blob.size / elapsedSec : 0;
      speedSamples.push(instantSpeed);
      if (speedSamples.length > 5) speedSamples.shift();
      const avgSpeed = speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length;

      const remainingBytes = file.size - end;
      const etaSec = avgSpeed > 0 ? remainingBytes / avgSpeed : Infinity;

      row.setProgress(Math.round(((i + 1) / totalBlocks) * 100));
      row.speed.textContent =
        `⚡ ${formatSpeed(avgSpeed)}` + (isFinite(etaSec) ? ` · sisa ${formatEta(etaSec)}` : '');
    }

    row.speed.textContent = 'Mengirim ke Telegram...';
    const completeRes = await api(`/api/drive/upload/${uploadId}/complete`, { method: 'POST' });
    if (!completeRes.ok) throw new Error((await completeRes.json()).error || 'Gagal menyelesaikan upload');

    localStorage.removeItem(resumeKey);
    row.setState('done');
    row.icon.textContent = '✓';
    row.speed.textContent = 'Selesai';
    removeUploadRow(row, 1500);
    return { status: 'ok' };
  } catch (err) {
    row.setState('failed');
    row.icon.textContent = '✕';
    row.speed.textContent = err.message;
    removeUploadRow(row, 4000);
    return { status: 'failed', message: err.message };
  }
}

// ---------- Pencarian nama file ----------

const searchInput = document.getElementById('searchInput');
const searchResults = document.getElementById('searchResults');
const searchBody = document.getElementById('searchBody');
const searchInfo = document.getElementById('searchInfo');
const mainTable = document.getElementById('mainTable');
let searchDebounce = null;

searchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();

  if (!q) {
    exitSearchMode();
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q), 300);
});

function exitSearchMode() {
  searchResults.hidden = true;
  document.getElementById('breadcrumb').hidden = false;
  renderCurrentView();
}

async function runSearch(q) {
  const res = await api(`/api/drive/search?q=${encodeURIComponent(q)}`);
  if (!res) return;
  const data = await res.json();

  mainTable.hidden = true;
  document.getElementById('gridView').hidden = true;
  document.getElementById('breadcrumb').hidden = true;
  document.getElementById('emptyMsg').hidden = true;
  searchResults.hidden = false;

  searchInfo.textContent = data.files.length === 0
    ? `Tidak ada file yang cocok dengan "${q}"`
    : `${data.files.length} hasil untuk "${q}"`;

  searchBody.innerHTML = '';
  data.files.forEach((f) => {
    const tr = document.createElement('tr');
    const icon = categoryIcon(f.category);
    const location = f.folder_path.length ? f.folder_path.join(' / ') : '🏠 Root';
    tr.innerHTML = `
      <td class="name-cell cat-${f.category}"><span class="name-text"><span class="cat-dot"></span>${icon} ${escapeHtml(f.original_name)}</span></td>
      <td class="search-location">${escapeHtml(location)}</td>
      <td>${fmtSize(f.size)}</td>
      <td class="row-actions"><button data-dl title="Download">⬇</button></td>
    `;
    tr.querySelector('[data-dl]').onclick = () => downloadWithAuth(f.id, f.original_name);
    if (isPreviewable(f.mime_type)) {
      tr.querySelector('.name-cell').onclick = () => openPreview(f.id, f.original_name, f.mime_type);
    }
    searchBody.appendChild(tr);
  });
}

initSortControl();
initSortHeaders();
initSelectAll();
loadList();
