const token = localStorage.getItem('td_token');
if (!token) window.location.href = '/login.html';

document.getElementById('whoami').textContent = localStorage.getItem('td_username') || '';
document.getElementById('logoutBtn').onclick = () => {
  localStorage.clear();
  window.location.href = '/login.html';
};

let currentFolder = null; // null = root
let folderStack = []; // [{id, name}]

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

  const body = document.getElementById('listBody');
  body.innerHTML = '';
  const empty = document.getElementById('emptyMsg');
  empty.hidden = data.folders.length + data.files.length > 0;

  data.folders.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="name-cell">📁 ${escapeHtml(f.name)}</td>
      <td>—</td>
      <td>${new Date(f.created_at).toLocaleDateString('id-ID')}</td>
      <td class="row-actions"><button data-del-folder="${f.id}">🗑</button></td>
    `;
    tr.querySelector('.name-cell').onclick = () => {
      folderStack.push({ id: f.id, name: f.name });
      currentFolder = f.id;
      loadList();
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
    tr.innerHTML = `
      <td class="name-cell">📄 ${escapeHtml(f.original_name)}</td>
      <td>${fmtSize(f.size)}</td>
      <td>${new Date(f.created_at).toLocaleDateString('id-ID')}</td>
      <td class="row-actions">
        <button data-dl="${f.id}">⬇</button>
        <button data-del-file="${f.id}">🗑</button>
      </td>
    `;
    tr.querySelector('[data-dl]').onclick = () => {
      const a = document.createElement('a');
      a.href = `/api/drive/download/${f.id}?token=${token}`;
      // fetch manual karena butuh header Authorization
      downloadWithAuth(f.id, f.original_name);
    };
    tr.querySelector('[data-del-file]').onclick = async () => {
      if (!confirm(`Hapus "${f.original_name}"?`)) return;
      await api(`/api/drive/files/${f.id}`, { method: 'DELETE' });
      loadList();
    };
    body.appendChild(tr);
  });
}

async function downloadWithAuth(id, filename) {
  const res = await api(`/api/drive/download/${id}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

document.getElementById('fileInput').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const progress = document.getElementById('uploadProgress');
  const bar = document.getElementById('uploadBar');
  const status = document.getElementById('uploadStatus');
  progress.hidden = false;
  status.textContent = `Mengunggah ${file.name} (${fmtSize(file.size)})...`;
  bar.style.width = '0%';

  const form = new FormData();
  form.append('file', file);
  if (currentFolder) form.append('folder_id', currentFolder);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/drive/upload');
  xhr.setRequestHeader('Authorization', `Bearer ${token}`);
  xhr.upload.onprogress = (ev) => {
    if (ev.lengthComputable) bar.style.width = Math.round((ev.loaded / ev.total) * 100) + '%';
  };
  xhr.onload = () => {
    progress.hidden = true;
    e.target.value = '';
    if (xhr.status === 200) loadList();
    else alert('Upload gagal: ' + xhr.responseText);
  };
  xhr.onerror = () => { progress.hidden = true; alert('Upload gagal'); };
  xhr.send(form);
};

loadList();
