
/*
 * TeleDrive UI enhancement
 * Loaded AFTER app.js.
 * Adds:
 *  - sortable Name / Size / Date
 *  - resizable Name / Size / Date columns by dragging
 *  - browser-like Back / Forward folder navigation
 *  - prevents rapid repeated folder navigation
 *  - keeps long file names on one line; table can scroll horizontally
 */

(() => {
  'use strict';

  const SORT_KEY = 'td_sort_key';
  const SORT_DIR = 'td_sort_dir';

  let sortKey = localStorage.getItem(SORT_KEY) || 'name';
  let sortDir = localStorage.getItem(SORT_DIR) || 'asc';

  let navBack = [];
  let navForward = [];
  let navReady = false;
  let navBusy = false;
  let lastFolderId = undefined;

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function folderState() {
    return {
      id: currentFolder ?? null,
      stack: folderStack.map(x => ({ id: x.id, name: x.name }))
    };
  }

  function sameState(a, b) {
    return a && b && a.id === b.id;
  }

  function cloneState(s) {
    return { id: s.id, stack: s.stack.map(x => ({ id: x.id, name: x.name })) };
  }

  function restoreState(s) {
    folderStack = s.stack.map(x => ({ id: x.id, name: x.name }));
    currentFolder = s.id;
  }

  function recordNavigation() {
    const state = folderState();

    if (!navReady) {
      lastFolderId = state.id;
      navReady = true;
      return;
    }

    if (sameState(state, { id: lastFolderId })) return;

    if (lastFolderId !== undefined) {
      const previous = {
        id: lastFolderId,
        stack: state.stack.length
          ? state.stack.slice(0, Math.max(0, state.stack.length - 1))
          : []
      };

      // Prefer the actual previous breadcrumb state when available.
      if (state.stack.length) {
        const parentDepth = state.stack.length - 1;
        previous.stack = state.stack.slice(0, parentDepth).map(x => ({...x}));
        previous.id = parentDepth ? previous.stack[parentDepth - 1].id : null;
      } else {
        previous.id = null;
        previous.stack = [];
      }

      // Avoid duplicate entries.
      if (!navBack.length || !sameState(navBack[navBack.length - 1], previous)) {
        navBack.push(cloneState(previous));
      }
    }

    navForward = [];
    lastFolderId = state.id;
    updateNavButtons();
  }

  // More reliable navigation tracking: wrap folder navigation itself.
  const originalLoadList = loadList;
  loadList = async function(...args) {
    const before = folderState();
    const result = await originalLoadList.apply(this, args);
    const after = folderState();

    if (!navBusy && !sameState(before, after)) {
      if (!navBack.length || !sameState(navBack[navBack.length - 1], before)) {
        navBack.push(cloneState(before));
      }
      navForward = [];
    }

    lastFolderId = after.id;
    navReady = true;
    updateNavButtons();
    return result;
  };

  async function goBack() {
    if (navBusy || !navBack.length) return;
    navBusy = true;
    updateNavButtons();

    const current = folderState();
    const target = navBack.pop();
    navForward.push(cloneState(current));

    restoreState(target);
    renderBreadcrumb();

    try {
      await loadList();
    } finally {
      navBusy = false;
      updateNavButtons();
    }
  }

  async function goForward() {
    if (navBusy || !navForward.length) return;
    navBusy = true;
    updateNavButtons();

    const current = folderState();
    const target = navForward.pop();
    navBack.push(cloneState(current));

    restoreState(target);
    renderBreadcrumb();

    try {
      await loadList();
    } finally {
      navBusy = false;
      updateNavButtons();
    }
  }

  function updateNavButtons() {
    const back = document.getElementById('folderBackBtn');
    const forward = document.getElementById('folderForwardBtn');
    if (back) {
      back.disabled = navBusy || navBack.length === 0;
      back.title = navBack.length ? 'Folder sebelumnya' : 'Tidak ada folder sebelumnya';
    }
    if (forward) {
      forward.disabled = navBusy || navForward.length === 0;
      forward.title = navForward.length ? 'Folder berikutnya' : 'Tidak ada folder berikutnya';
    }
  }

  function makeNavButtons() {
    const breadcrumb = document.getElementById('breadcrumb');
    if (!breadcrumb || document.getElementById('folderBackBtn')) return;

    const wrap = document.createElement('div');
    wrap.className = 'folder-navigation';

    const back = document.createElement('button');
    back.id = 'folderBackBtn';
    back.type = 'button';
    back.className = 'folder-nav-btn';
    back.textContent = '←';
    back.onclick = goBack;

    const forward = document.createElement('button');
    forward.id = 'folderForwardBtn';
    forward.type = 'button';
    forward.className = 'folder-nav-btn';
    forward.textContent = '→';
    forward.onclick = goForward;

    breadcrumb.parentNode.insertBefore(wrap, breadcrumb);
    wrap.append(back, forward, breadcrumb);

    updateNavButtons();
  }

  function compare(a, b) {
    if (sortKey === 'size') {
      return Number(a.size || 0) - Number(b.size || 0);
    }
    if (sortKey === 'date') {
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    }
    return String(a.original_name || a.name || '')
      .localeCompare(String(b.original_name || b.name || ''), 'id', {
        numeric: true,
        sensitivity: 'base'
      });
  }

  function sortData(data) {
    if (!data) return;
    const direction = sortDir === 'desc' ? -1 : 1;

    if (Array.isArray(data.folders)) {
      data.folders.sort((a,b) => {
        const r = sortKey === 'size' ? 0 :
          sortKey === 'date'
            ? new Date(a.created_at || 0) - new Date(b.created_at || 0)
            : String(a.name || '').localeCompare(String(b.name || ''), 'id', {numeric:true, sensitivity:'base'});
        return r * direction;
      });
    }

    if (Array.isArray(data.files)) {
      data.files.sort((a,b) => compare(a,b) * direction);
    }
  }

  const originalRenderCurrentView = renderCurrentView;
  renderCurrentView = function(...args) {
    sortData(lastData);
    const result = originalRenderCurrentView.apply(this, args);
    requestAnimationFrame(() => {
      updateSortHeaders();
      updateNavButtons();
      updateSelectAllState();
    });
    return result;
  };

  function updateSortHeaders() {
    const table = document.getElementById('mainTable');
    if (!table) return;
    const headers = table.querySelectorAll('thead th');
    if (headers.length < 3) return;

    headers[0].dataset.sort = 'name';
    headers[1].dataset.sort = 'size';
    headers[2].dataset.sort = 'date';

    headers.forEach((th) => {
      th.classList.remove('sort-active', 'sort-asc', 'sort-desc');
      const key = th.dataset.sort;
      if (!key) return;
      th.classList.add('sortable');
      if (key === sortKey) {
        th.classList.add('sort-active', sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
        th.setAttribute('aria-sort', sortDir === 'asc' ? 'ascending' : 'descending');
      } else {
        th.setAttribute('aria-sort', 'none');
      }
    });
  }

  function installSortHeaders() {
    const table = document.getElementById('mainTable');
    if (!table) return;
    const headers = table.querySelectorAll('thead th');
    if (headers.length < 3) return;

    headers.forEach((th, index) => {
      const key = ['name','size','date'][index];
      if (!key || th.dataset.sortBound) return;
      th.dataset.sortBound = '1';
      th.dataset.sort = key;
      th.classList.add('sortable');
      th.addEventListener('click', () => {
        if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else {
          sortKey = key;
          sortDir = 'asc';
        }
        localStorage.setItem(SORT_KEY, sortKey);
        localStorage.setItem(SORT_DIR, sortDir);
        sortData(lastData);
        renderCurrentView();
      });
    });
    updateSortHeaders();
  }

  function installColumnResize() {
    const table = document.getElementById('mainTable');
    if (!table || table.dataset.resizeReady) return;
    table.dataset.resizeReady = '1';

    const headers = [...table.querySelectorAll('thead th')];
    const keys = ['name','size','date'];

    headers.forEach((th, index) => {
      if (index > 2) return;
      const key = keys[index];
      const handle = document.createElement('span');
      handle.className = 'column-resize-handle';
      handle.title = 'Geser untuk mengubah lebar kolom';
      th.appendChild(handle);

      handle.addEventListener('click', e => e.stopPropagation());
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        const startX = e.clientX;
        const startWidth = th.getBoundingClientRect().width;
        const min = key === 'name' ? 280 : key === 'size' ? 100 : 130;

        const move = (ev) => {
          const width = Math.max(min, startWidth + ev.clientX - startX);
          th.style.width = `${width}px`;
          table.style.minWidth = `${Math.max(table.scrollWidth, 780)}px`;
        };

        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          document.body.classList.remove('resizing-column');
        };

        document.body.classList.add('resizing-column');
        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
      });
    });
  }

  function makeSelectAll() {
    const table = document.getElementById('mainTable');
    if (!table) return;

    const first = table.querySelector('thead th:first-child');
    if (!first || first.querySelector('#selectAllFiles')) return;

    const label = document.createElement('label');
    label.className = 'select-all-wrap';
    label.title = 'Pilih semua item di folder ini';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'selectAllFiles';
    cb.className = 'select-all-checkbox';

    cb.addEventListener('click', (e) => {
      e.stopPropagation();
      const data = lastData;
      if (!data) return;

      data.folders.forEach(f => {
        if (cb.checked) selectedFolders.add(f.id);
        else selectedFolders.delete(f.id);
      });
      data.files.forEach(f => {
        if (cb.checked) selectedFiles.add(f.id);
        else selectedFiles.delete(f.id);
      });

      renderCurrentView();
    });

    label.append(cb);
    first.insertBefore(label, first.firstChild);
    updateSelectAllState();
  }

  function updateSelectAllState() {
    const cb = document.getElementById('selectAllFiles');
    if (!cb || !lastData) return;

    const total = (lastData.folders?.length || 0) + (lastData.files?.length || 0);
    const selected = (lastData.folders || []).filter(f => selectedFolders.has(f.id)).length +
      (lastData.files || []).filter(f => selectedFiles.has(f.id)).length;

    cb.checked = total > 0 && selected === total;
    cb.indeterminate = selected > 0 && selected < total;
  }

  function preventRapidFolderClicks() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('.name-cell, .grid-card');
      if (!target) return;

      const folderCheck = target.querySelector('[data-folder-check]');
      if (!folderCheck) return;

      if (navBusy) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }

      navBusy = true;
      updateNavButtons();

      // Existing app handler performs the actual navigation.
      // Release lock after the next render/request cycle.
      setTimeout(() => {
        navBusy = false;
        updateNavButtons();
      }, 700);
    }, true);
  }

  function init() {
    makeNavButtons();
    makeSelectAll();
    installSortHeaders();
    installColumnResize();
    preventRapidFolderClicks();
    updateNavButtons();

    // Re-apply controls because app.js recreates table rows on every render.
    const observer = new MutationObserver(() => {
      makeNavButtons();
      makeSelectAll();
      installSortHeaders();
      installColumnResize();
      updateSortHeaders();
      updateSelectAllState();
    });

    const main = document.querySelector('.drive-wrap') || document.body;
    observer.observe(main, {childList:true, subtree:true});
  }

  // Wait until app.js has executed its initial setup.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0), {once:true});
  } else {
    setTimeout(init, 0);
  }
})();
