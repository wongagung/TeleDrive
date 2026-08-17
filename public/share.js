// Halaman share PUBLIK -- gak ada login, gak ada token JWT, semua fetch
// polos ke endpoint /api/public/share/:token/*.

const token = window.location.pathname.split('/').filter(Boolean).pop();
const API = `/api/public/share/${token}`;

const loadingState = document.getElementById('loadingState');
const errorState = document.getElementById('errorState');
const fileView = document.getElementById('fileView');
const folderView = document.getElementById('folderView');

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { bytes /= 1024; i++; } while (bytes >= 1024 && i < units.length - 1);
  return bytes.toFixed(1) + ' ' + units[i];
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const CATEGORY_ICONS = { dokumen: '📄', gambar: '🖼️', video: '🎬', audio: '🎵', arsip: '🗜️', lainnya: '📦' };
function categoryIcon(category) { return CATEGORY_ICONS[category] || '📦'; }

function showError(message) {
  loadingState.hidden = true;
  errorState.hidden = false;
  errorState.textContent = message;
}

async function main() {
  if (!token) return showError('Link tidak valid.');

  let res, data;
  try {
    res = await fetch(API);
    data = await res.json();
  } catch (err) {
    return showError('Gagal menghubungi server. Periksa koneksi kamu.');
  }

  if (!res.ok) {
    return showError(res.status === 404 ? 'Link ini tidak ditemukan atau sudah kadaluarsa.' : (data.error || 'Terjadi kesalahan.'));
  }

  loadingState.hidden = true;

  if (data.type === 'file') initFileView(data.file);
  else initFolderView(data.folder);
}

// ---------- Tampilan file tunggal ----------

function initFileView(file) {
  fileView.hidden = false;
  document.title = `${file.name} — VaultKu`;

  document.getElementById('fileName').textContent = file.name;
  document.getElementById('fileMeta').textContent = `${fmtSize(file.size)} · ${file.category}`;

  const thumb = document.getElementById('fileThumb');
  const isImage = file.mime_type && file.mime_type.startsWith('image/');
  if (isImage) {
    thumb.innerHTML = `<img src="${API}/preview/${file.id}" alt="${escapeHtml(file.name)}" />`;
  } else {
    thumb.textContent = categoryIcon(file.category);
  }

  const downloadBtn = document.getElementById('fileDownloadBtn');
  downloadBtn.href = `${API}/download/${file.id}`;

  if (file.previewable) {
    const previewBtn = document.getElementById('filePreviewBtn');
    previewBtn.hidden = false;
    previewBtn.onclick = () => openPreview(file.id, file.name, file.mime_type);
  }
}

// ---------- Tampilan folder (browsable, read-only) ----------

let folderStack = [];
let currentFolderId = null;
let rootFolderId = null;
let rootFolderName = '';
let lastData = null;
let viewMode = localStorage.getItem('td_share_view_mode') || 'list';

function initFolderView(folder) {
  folderView.hidden = false;
  rootFolderId = folder.id;
  rootFolderName = folder.name;
  currentFolderId = folder.id;
  document.title = `${folder.name} — VaultKu`;
  updateViewToggleUI();
  loadFolder(folder.id);
}

function renderBreadcrumb() {
  const bc = document.getElementById('breadcrumb');
  bc.innerHTML = '';
  const root = document.createElement('span');
  root.textContent = `📁 ${rootFolderName}`;
  root.onclick = () => { folderStack = []; currentFolderId = rootFolderId; loadFolder(rootFolderId); };
  bc.appendChild(root);

  folderStack.forEach((f, idx) => {
    bc.append(' / ');
    const s = document.createElement('span');
    s.textContent = f.name;
    s.onclick = () => { folderStack = folderStack.slice(0, idx + 1); currentFolderId = f.id; loadFolder(f.id); };
    bc.appendChild(s);
  });
}

async function loadFolder(folderId) {
  renderBreadcrumb();
  const res = await fetch(`${API}/list?folder=${folderId}`);
  if (!res.ok) return showError('Gagal memuat isi folder.');
  const data = await res.json();
  lastData = data;

  document.getElementById('emptyMsg').hidden = data.folders.length + data.files.length > 0;
  renderCurrentView();
}

function renderCurrentView() {
  const mainTableEl = document.getElementById('mainTable');
  const gridViewEl = document.getElementById('gridView');
  if (viewMode === 'grid') {
    mainTableEl.hidden = true; gridViewEl.hidden = false;
    renderGrid(lastData);
  } else {
    mainTableEl.hidden = false; gridViewEl.hidden = true;
    renderList(lastData);
  }
}

function openFolder(folder) {
  folderStack.push({ id: folder.id, name: folder.name });
  currentFolderId = folder.id;
  loadFolder(folder.id);
}

function isPreviewable(mime) {
  return mime && (mime.startsWith('image/') || mime === 'application/pdf' || mime.startsWith('video/') || mime.startsWith('audio/'));
}

function renderList(data) {
  const body = document.getElementById('listBody');
  body.innerHTML = '';

  data.folders.forEach((f) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="name-cell"><span class="name-text">📁 ${escapeHtml(f.name)}</span></td>
      <td>—</td>
      <td>${new Date(f.created_at).toLocaleDateString('id-ID')}</td>
      <td></td>
    `;
    tr.querySelector('.name-cell').onclick = () => openFolder(f);
    body.appendChild(tr);
  });

  data.files.forEach((f) => {
    const tr = document.createElement('tr');
    const icon = categoryIcon(f.category);
    tr.innerHTML = `
      <td class="name-cell cat-${f.category}"><span class="name-text"><span class="cat-dot"></span>${icon} ${escapeHtml(f.original_name)}</span></td>
      <td>${fmtSize(f.size)}</td>
      <td>${new Date(f.created_at).toLocaleDateString('id-ID')}</td>
      <td class="row-actions">
        ${isPreviewable(f.mime_type) ? '<button data-preview title="Lihat">👁</button>' : ''}
        <a data-dl href="${API}/download/${f.id}" download title="Download">⬇</a>
      </td>
    `;
    if (isPreviewable(f.mime_type)) {
      tr.querySelector('.name-cell').onclick = () => openPreview(f.id, f.original_name, f.mime_type);
      const pv = tr.querySelector('[data-preview]');
      if (pv) pv.onclick = () => openPreview(f.id, f.original_name, f.mime_type);
    }
    body.appendChild(tr);
  });
}

function renderGrid(data) {
  const container = document.getElementById('gridView');
  container.innerHTML = '';

  data.folders.forEach((f) => {
    const card = document.createElement('div');
    card.className = 'grid-card';
    card.innerHTML = `<div class="grid-card-thumb">📁</div><div class="grid-card-name">${escapeHtml(f.name)}</div><div class="grid-card-meta">Folder</div>`;
    card.onclick = () => openFolder(f);
    container.appendChild(card);
  });

  data.files.forEach((f) => {
    const card = document.createElement('div');
    card.className = `grid-card cat-${f.category}`;
    const isImage = f.mime_type && f.mime_type.startsWith('image/');
    const isVideo = f.mime_type && f.mime_type.startsWith('video/');
    let thumbHtml = categoryIcon(f.category);
    if (isImage) thumbHtml = `<img src="${API}/thumbnail/${f.id}" data-fallback="${API}/preview/${f.id}" alt="${escapeHtml(f.original_name)}" loading="lazy" />`;
    else if (isVideo) thumbHtml = `<img src="${API}/thumbnail/${f.id}" alt="${escapeHtml(f.original_name)}" loading="lazy" /><div class="play-badge">▶</div>`;

    card.innerHTML = `
      <div class="grid-card-actions">
        ${isPreviewable(f.mime_type) ? '<button data-preview title="Lihat">👁</button>' : ''}
        <a data-dl href="${API}/download/${f.id}" download title="Download">⬇</a>
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
          thumbImg.onerror = () => { thumbImg.remove(); card.querySelector('.grid-card-thumb').textContent = categoryIcon(f.category); };
          thumbImg.src = fallback;
          return;
        }
        if (isVideo) { thumbImg.remove(); card.querySelector('.grid-card-thumb').insertAdjacentHTML('afterbegin', categoryIcon(f.category)); }
        else card.querySelector('.grid-card-thumb').textContent = categoryIcon(f.category);
      };
    }

    if (isPreviewable(f.mime_type)) {
      card.onclick = (e) => { if (e.target.closest('a,button')) return; openPreview(f.id, f.original_name, f.mime_type); };
      const pv = card.querySelector('[data-preview]');
      if (pv) pv.onclick = (e) => { e.stopPropagation(); openPreview(f.id, f.original_name, f.mime_type); };
    }
    container.appendChild(card);
  });
}

const viewListBtn = document.getElementById('viewListBtn');
const viewGridBtn = document.getElementById('viewGridBtn');
function updateViewToggleUI() {
  viewListBtn.classList.toggle('active', viewMode === 'list');
  viewGridBtn.classList.toggle('active', viewMode === 'grid');
}
viewListBtn.onclick = () => { viewMode = 'list'; localStorage.setItem('td_share_view_mode', viewMode); updateViewToggleUI(); renderCurrentView(); };
viewGridBtn.onclick = () => { viewMode = 'grid'; localStorage.setItem('td_share_view_mode', viewMode); updateViewToggleUI(); renderCurrentView(); };

// ---------- Preview modal (sama kayak app.js, versi publik) ----------

const previewModal = document.getElementById('previewModal');
const previewBody = document.getElementById('previewBody');
const previewTitle = document.getElementById('previewTitle');
document.getElementById('previewClose').onclick = closePreview;
previewModal.onclick = (e) => { if (e.target === previewModal) closePreview(); };

function openPreview(id, name, mime) {
  previewTitle.textContent = name;
  previewModal.hidden = false;
  const url = `${API}/preview/${id}`;

  if (mime.startsWith('image/')) {
    previewBody.innerHTML = `<img src="${url}" alt="${escapeHtml(name)}" />`;
  } else if (mime === 'application/pdf') {
    previewBody.innerHTML = `<iframe src="${url}"></iframe>`;
  } else if (mime.startsWith('video/')) {
    previewBody.innerHTML = `<video src="${url}" controls autoplay preload="metadata"></video>`;
  } else if (mime.startsWith('audio/')) {
    previewBody.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
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

main();
