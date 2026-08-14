
(() => {
  const KEY = 'td_column_widths_v2';
  const DEFAULTS = [52, 16, 20, 12]; // Nama, Ukuran, Tanggal, Aksi
  const MIN = [280, 110, 150, 80];

  function table() {
    return document.getElementById('mainTable');
  }

  function widths() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      return Array.isArray(saved) && saved.length === 4 ? saved : DEFAULTS.slice();
    } catch {
      return DEFAULTS.slice();
    }
  }

  function applyWidths(values) {
    const t = table();
    if (!t) return;
    let colgroup = t.querySelector('colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      for (let i = 0; i < 4; i++) colgroup.appendChild(document.createElement('col'));
      t.insertBefore(colgroup, t.firstChild);
    }

    const total = values.reduce((a,b) => a+b, 0) || 100;
    [...colgroup.children].forEach((col, i) => {
      col.style.width = `${(values[i] / total) * 100}%`;
    });
  }

  function addHandles() {
    const t = table();
    if (!t || t.dataset.resizeReady === '1') return;
    const headers = t.querySelectorAll('thead th');
    if (headers.length !== 4) return;

    t.dataset.resizeReady = '1';
    headers.forEach((th, index) => {
      if (index === headers.length - 1) return;

      const handle = document.createElement('span');
      handle.className = 'column-resizer';
      handle.title = 'Geser untuk mengubah lebar kolom • klik dua kali untuk reset';
      th.appendChild(handle);

      handle.addEventListener('dblclick', e => {
        e.preventDefault();
        localStorage.removeItem(KEY);
        applyWidths(DEFAULTS);
      });

      handle.addEventListener('pointerdown', e => {
        e.preventDefault();
        handle.setPointerCapture?.(e.pointerId);
        handle.classList.add('dragging');
        document.body.classList.add('is-resizing');

        const startX = e.clientX;
        const start = widths();
        const tableWidth = Math.max(t.getBoundingClientRect().width, 760);
        const left = index;
        const right = index + 1;

        const move = ev => {
          const delta = ((ev.clientX - startX) / tableWidth) * 100;
          const next = start.slice();
          const minLeft = (MIN[left] / tableWidth) * 100;
          const minRight = (MIN[right] / tableWidth) * 100;

          next[left] = Math.max(minLeft, start[left] + delta);
          const consumed = next[left] - start[left];
          next[right] = Math.max(minRight, start[right] - consumed);

          // Jangan biarkan kolom kanan melewati batas minimum.
          if (next[right] === minRight) {
            next[left] = start[left] + (start[right] - minRight);
          }

          applyWidths(next);
          localStorage.setItem(KEY, JSON.stringify(next));
        };

        const end = () => {
          handle.classList.remove('dragging');
          document.body.classList.remove('is-resizing');
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', end);
        };

        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end, { once: true });
      });
    });

    applyWidths(widths());
  }

  function addResetButton() {
    const actions = document.querySelector('.actions');
    if (!actions || document.getElementById('resetColumnsBtn')) return;

    const btn = document.createElement('button');
    btn.id = 'resetColumnsBtn';
    btn.type = 'button';
    btn.className = 'column-reset-btn';
    btn.textContent = '↔ Reset kolom';
    btn.title = 'Kembalikan ukuran kolom ke ukuran awal';
    btn.addEventListener('click', () => {
      localStorage.removeItem(KEY);
      applyWidths(DEFAULTS);
    });

    actions.insertBefore(btn, actions.firstChild);
  }

  function init() {
    addHandles();
    addResetButton();
  }

  document.addEventListener('DOMContentLoaded', init);

  // app.js tidak mengubah header, tetapi tabel dapat dirender ulang.
  const observer = new MutationObserver(() => {
    if (table() && !table().dataset.resizeReady) init();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  window.TeleDriveColumns = {
    reset() {
      localStorage.removeItem(KEY);
      applyWidths(DEFAULTS);
    }
  };
})();
