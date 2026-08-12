(() => {
  const videoExt = /\.(mp4|webm|ogg|m4v|mov|mkv)$/i;
  const videoMimeExt = /\.(mp4|webm|ogg|m4v)$/i;
  let videoObjectUrl = null;

  function token() { return localStorage.getItem('td_token') || ''; }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function getFilenameFromRow(row) {
    const cell = row.querySelector('.name-cell');
    if (!cell) return '';
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('input,button').forEach(x => x.remove());
    return clone.textContent.replace(/^[^A-Za-z0-9À-ÿ]+/,'').trim();
  }

  async function openVideo(id, name) {
    const modal = document.getElementById('previewModal');
    const title = document.getElementById('previewTitle');
    const body = document.getElementById('previewBody');
    if (!modal || !body) return;
    title.textContent = name;
    body.innerHTML = '<div class="video-loading"><p class="loading">Menyiapkan video…</p></div>';
    modal.hidden = false;

    try {
      const res = await fetch(`/api/drive/video-preview/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${token()}` }
      });
      if (!res.ok) {
        let msg = 'Video tidak dapat dipreview.';
        try { msg = (await res.json()).error || msg; } catch (_) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      videoObjectUrl = URL.createObjectURL(blob);
      const video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.autoplay = true;
      video.src = videoObjectUrl;
      video.setAttribute('aria-label', `Preview ${name}`);
      body.innerHTML = '';
      body.appendChild(video);

      const meta = document.createElement('div');
      meta.className = 'video-meta';
      meta.innerHTML = `<span>Preview video</span><span>Space = Play/Pause · Esc = Tutup</span>`;
      body.appendChild(meta);
      video.focus();
    } catch (err) {
      body.innerHTML = `<p class="error">${escapeHtml(err.message)}</p>`;
    }
  }

  function closeVideoUrl() {
    if (videoObjectUrl) {
      URL.revokeObjectURL(videoObjectUrl);
      videoObjectUrl = null;
    }
  }

  function decorateRows() {
    document.querySelectorAll('#listBody tr').forEach(row => {
      if (row.dataset.uiEnhanced === '1') return;
      const cb = row.querySelector('[data-file-check]');
      const id = cb?.getAttribute('data-file-check');
      const name = getFilenameFromRow(row);
      if (!id || !videoExt.test(name)) return;
      row.dataset.uiEnhanced = '1';
      const actions = row.querySelector('.row-actions');
      if (!actions) return;

      const btn = document.createElement('button');
      btn.className = 'video-row-btn';
      btn.type = 'button';
      btn.title = 'Preview video';
      btn.textContent = '▶';
      btn.addEventListener('click', e => {
        e.stopPropagation();
        openVideo(id, name);
      });
      actions.prepend(btn);

      const nameCell = row.querySelector('.name-cell');
      if (nameCell) {
        nameCell.addEventListener('dblclick', e => {
          if (!e.target.closest('input')) openVideo(id, name);
        });
      }
    });
  }

  function installMotion() {
    const body = document.getElementById('listBody');
    if (!body) return;
    new MutationObserver(() => requestAnimationFrame(decorateRows)).observe(body, {childList:true,subtree:true});
    decorateRows();

    const search = document.getElementById('searchInput');
    if (search) {
      window.addEventListener('keydown', e => {
        if (e.key === '/' && document.activeElement !== search && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
          e.preventDefault(); search.focus();
        }
        if (e.key === 'Escape' && !document.getElementById('previewModal')?.hidden) {
          document.getElementById('previewClose')?.click();
        }
      });
    }
  }

  const oldClose = document.getElementById('previewClose');
  if (oldClose) oldClose.addEventListener('click', closeVideoUrl);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      document.querySelectorAll('video').forEach(v => { try { v.pause(); } catch (_) {} });
    }
  });

  installMotion();
})();
