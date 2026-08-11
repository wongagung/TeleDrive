const token = localStorage.getItem('td_token');
if (!token) window.location.href = '/login.html';

document.getElementById('whoami').textContent = localStorage.getItem('td_username') || '';
document.getElementById('logoutBtn').onclick = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (_) { /* tetap logout lokal walau gagal cabut token */ }
  localStorage.clear();
  window.location.href = '/login.html';
};

let currentFolder = null; // null = root
let folderStack = []; // [{id, name}]
let selectedFiles = new Set();
let selectedFolders = new Set();

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    localStorage.clear();
    window.location.href = '/login.html';
    return;
  }
  return res;
}

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

function isPreviewable(mime) {
  return mime && (mime.startsWith('image/') || mime === 'application/pdf');
}

// ---------- Breadcrumb & list utama ----------

function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  bc.innerHTML = '';
  const root = document.createElement('span');
  root.textContent = '🏠 Root';
  root.onclick = () => { folderStack = []; currentFolder = null; loadList(); };
  bc.appendChild(root);

  folderStack.forEach((f, idx) => {
    bc.append(' / ');
    const s = document.createElement('span');
    s.textContent = f.name;
    s.onclick = () => { folderStack = folderStack.slice(0, idx + 1); currentFolder = f.id; loadList(); };
    bc.appendChild(s);
  });
}

async function loadList() {
  renderBreadcrumb();
  const q = currentFolder ? `?folder_id=${currentFolder}` : '';
  const res = await api(`/api/drive/list${q}`);
  const data = await res.json();

  renderQuota(data.quota);

  const body = document.getElementById('listBody');
  body.innerHTML = '';
  const empty = document.getElementById('emptyMsg');
  empty.hidden = data.folders.length + data.files.length > 0;

  // Buang seleksi buat item yang sudah tidak ada di folder ini (mis. setelah pindah folder)
  const visibleFolderIds = new Set(data.folders.map((f) => f.id));
  const visibleFileIds = new Set(data.files.map((f) => f.id));
  selectedFolders.forEach((id) => { if (!visibleFolderIds.has(id)) selectedFolders.delete(id); });
  selectedFiles.forEach((id) => { if (!visibleFileIds.has(id)) selectedFiles.delete(id); });

  data.folders.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="name-cell">
        <input type="checkbox" class="row-check" data-folder-check="${f.id}" ${selectedFolders.has(f.id) ? 'checked' : ''} />
        📁 ${escapeHtml(f.name)}
      </td>
      <td>—</td>
      <td>${new Date(f.created_at).toLocaleDateString('id-ID')}</td>
      <td class="row-actions">
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
      folderStack.push({ id: f.id, name: f.name });
      currentFolder = f.id;
      loadList();
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
    const icon = isPreviewable(f.mime_type) ? '🖼️' : '📄';
    tr.innerHTML = `
      <td class="name-cell">
        <input type="checkbox" class="row-check" data-file-check="${f.id}" ${selectedFiles.has(f.id) ? 'checked' : ''} />
        ${icon} ${escapeHtml(f.original_name)}
      </td>
      <td>${fmtSize(f.size)}</td>
      <td>${new Date(f.created_at).toLocaleDateString('id-ID')}</td>
      <td class="row-actions">
        ${isPreviewable(f.mime_type) ? '<button data-preview title="Lihat">👁</button>' : ''}
        <button data-dl title="Download">⬇</button>
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

  renderBulkToolbar();
}

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
}

function clearSelection() {
  selectedFiles.clear();
  selectedFolders.clear();
  document.querySelectorAll('.row-check').forEach((cb) => { cb.checked = false; });
  renderBulkToolbar();
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

async function downloadWithAuth(id, filename) {
  const res = await api(`/api/drive/download/${id}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
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

let previewObjectUrl = null;
async function openPreview(id, name, mime) {
  previewTitle.textContent = name;
  previewBody.innerHTML = '<p class="loading">Memuat...</p>';
  previewModal.hidden = false;

  try {
    const res = await api(`/api/drive/preview/${id}`);
    if (!res.ok) throw new Error((await res.json()).error || 'Gagal memuat preview');
    const blob = await res.blob();
    previewObjectUrl = URL.createObjectURL(blob);

    if (mime.startsWith('image/')) {
      previewBody.innerHTML = `<img src="${previewObjectUrl}" alt="${escapeHtml(name)}" />`;
    } else if (mime === 'application/pdf') {
      previewBody.innerHTML = `<iframe src="${previewObjectUrl}"></iframe>`;
    }
  } catch (err) {
    previewBody.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
  }
}

function closePreview() {
  previewModal.hidden = true;
  previewBody.innerHTML = '';
  if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
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
  // Jangan tampilkan folder yang sedang dipindah (atau sedang dipilih di bulk) sebagai tujuan
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

// ---------- Resumable upload ----------

document.getElementById('fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  await resumableUpload(file);
};

const progressBox = document.getElementById('uploadProgress');
const progressBar = document.getElementById('uploadBar');
const progressStatus = document.getElementById('uploadStatus');

async function resumableUpload(file) {
  progressBox.hidden = false;
  progressStatus.textContent = `Menyiapkan "${file.name}"...`;
  progressBar.style.width = '0%';

  const resumeKey = `td_resume_${file.name}_${file.size}_${currentFolder || 'root'}`;

  try {
    let uploadId, blockSize, totalBlocks, alreadyReceived = new Set();

    // Cek apakah ada sesi upload file yang sama (nama+ukuran+folder) yang belum
    // selesai dari percobaan sebelumnya (mis. tab ke-reload di tengah upload).
    const existingId = localStorage.getItem(resumeKey);
    if (existingId) {
      const statusRes = await api(`/api/drive/upload/${existingId}/status`);
      if (statusRes && statusRes.ok) {
        const status = await statusRes.json();
        uploadId = existingId;
        totalBlocks = status.total_blocks;
        alreadyReceived = new Set(status.received_blocks);
        blockSize = Math.ceil(file.size / totalBlocks);
        progressStatus.textContent = `Melanjutkan upload "${file.name}" (${alreadyReceived.size}/${totalBlocks} bagian sudah terkirim)...`;
      } else {
        localStorage.removeItem(resumeKey); // sesi lama sudah tidak valid/kadaluarsa
      }
    }

    // Sesi baru kalau belum ada / sesi lama tidak valid
    if (!uploadId) {
      const initRes = await api('/api/drive/upload/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
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

    // Upload tiap block yang BELUM diterima server, dengan retry
    for (let i = 0; i < totalBlocks; i++) {
      if (alreadyReceived.has(i)) {
        const pct = Math.round(((i + 1) / totalBlocks) * 100);
        progressBar.style.width = pct + '%';
        continue;
      }

      const start = i * blockSize;
      const end = Math.min(start + blockSize, file.size);
      const blob = file.slice(start, end);

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
          progressStatus.textContent = `Block ${i + 1}/${totalBlocks} gagal, mencoba lagi (${attempt}/3)...`;
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }

      const pct = Math.round(((i + 1) / totalBlocks) * 100);
      progressBar.style.width = pct + '%';
      progressStatus.textContent = `Mengunggah "${file.name}" — ${pct}% (${i + 1}/${totalBlocks} bagian)`;
    }

    // Selesaikan (server gabung block + kirim ke Telegram)
    progressStatus.textContent = `Mengirim "${file.name}" ke Telegram...`;
    const completeRes = await api(`/api/drive/upload/${uploadId}/complete`, { method: 'POST' });
    if (!completeRes.ok) throw new Error((await completeRes.json()).error || 'Gagal menyelesaikan upload');

    localStorage.removeItem(resumeKey);
    progressBox.hidden = true;
    loadList();
  } catch (err) {
    // JANGAN hapus resumeKey di sini — biar bisa dilanjut kalau file yang sama diupload ulang
    progressStatus.textContent = `Gagal (bisa dicoba lagi, progres tersimpan): ${err.message}`;
    setTimeout(() => { progressBox.hidden = true; }, 5000);
  }
}

loadList();
