/*
 * TeleDrive UI/UX fixes
 * Loaded BEFORE app.js.
 *
 * Fixes:
 * 1. Prevent repeated folder navigation clicks from firing multiple requests.
 * 2. Sort folders/files by name, size, created/upload date.
 * 3. Add Select All for the current folder in both list and grid views.
 * 4. Keep sort preference in localStorage.
 */
(() => {
  'use strict';

  const SORT_KEY = 'td_sort_mode';
  const SORT_DIR_KEY = 'td_sort_dir';

  const state = {
    mode: localStorage.getItem(SORT_KEY) || 'name',
    dir: localStorage.getItem(SORT_DIR_KEY) || 'asc'
  };

  function normalize(value) {
    return String(value || '').trim().toLocaleLowerCase('id-ID');
  }

  function timestamp(item) {
    const value = item && (item.created_at || item.uploaded_at || item.createdAt || item.uploadedAt);
    const t = value ? Date.parse(value) : 0;
    return Number.isFinite(t) ? t : 0;
  }

  function itemName(item) {
    return item && (item.original_name || item.name || '');
  }

  function compareItems(a, b) {
    let av, bv;
    if (state.mode === 'size') {
      av = Number(a.size || 0);
      bv = Number(b.size || 0);
    } else if (state.mode === 'date') {
      av = timestamp(a);
      bv = timestamp(b);
    } else {
      av = normalize(itemName(a));
      bv = normalize(itemName(b));
    }

    let result;
    if (typeof av === 'string') {
      result = av.localeCompare(bv, 'id', { numeric: true, sensitivity: 'base' });
    } else {
      result = av - bv;
    }

    if (result === 0) {
      result = normalize(itemName(a)).localeCompare(
        normalize(itemName(b)), 'id', { numeric: true, sensitivity: 'base' }
      );
    }
    return state.dir === 'desc' ? -result : result;
  }

  function sortData(data) {
    if (!data || !Array.isArray(data.folders) || !Array.isArray(data.files)) return data;

    // Keep folders and files together visually in the same sort order.
    // The existing renderer outputs folders first, so sort within each group.
    data.folders.sort(compareItems);
    data.files.sort(compareItems);
    return data;
  }

  // Intercept the list response BEFORE app.js consumes it.
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await nativeFetch(...args);
    try {
      const requestUrl = typeof args[0] === 'string'
        ? args[0]
        : (args[0] && args[0].url) || '';

      if (requestUrl.includes('/api/drive/list')) {
        const clone = response.clone();
        const data = await clone.json();
        sortData(data);

        return new Response(JSON.stringify(data), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      }
    } catch (_) {
      // Never break normal API traffic because of UI sorting.
    }
    return response;
  };

  function currentVisibleChecks() {
    return Array.from(document.querySelectorAll(
      '#listBody .row-check, #gridView .grid-card-check'
    ));
  }

  function setAllChecks(checked) {
    currentVisibleChecks().forEach((checkbox) => {
      if (checkbox.checked !== checked) checkbox.click();
    });
  }

  function updateSelectAllUI() {
    const boxes = currentVisibleChecks();
    const selectAll = document.getElementById('tdSelectAll');
    if (!selectAll) return;

    if (!boxes.length) {
      selectAll.checked = false;
      selectAll.indeterminate = false;
      selectAll.disabled = true;
      return;
    }

    selectAll.disabled = false;
    const checked = boxes.filter((b) => b.checked).length;
    selectAll.checked = checked === boxes.length;
    selectAll.indeterminate = checked > 0 && checked < boxes.length;
  }

  function ensureSelectAll() {
    const toolbar = document.querySelector('.toolbar');
    if (!toolbar) return;

    let wrapper = document.getElementById('tdSelectAllWrap');
    if (!wrapper) {
      wrapper = document.createElement('label');
      wrapper.id = 'tdSelectAllWrap';
      wrapper.className = 'td-select-all-control';
      wrapper.title = 'Pilih semua item di folder ini';
      wrapper.innerHTML = `
        <input id="tdSelectAll" type="checkbox" aria-label="Pilih semua item di folder ini">
        <span>Pilih semua</span>
      `;
      const actions = toolbar.querySelector('.actions');
      if (actions) actions.insertBefore(wrapper, actions.firstElementChild);
      else toolbar.appendChild(wrapper);

      wrapper.querySelector('#tdSelectAll').addEventListener('change', (e) => {
        setAllChecks(e.target.checked);
      });
    }

    updateSelectAllUI();
  }

  function ensureSortControls() {
    const toolbar = document.querySelector('.toolbar');
    if (!toolbar || document.getElementById('tdSortControl')) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'td-sort-control';
    wrapper.id = 'tdSortControl';
    wrapper.innerHTML = `
      <label for="tdSortSelect">Urutkan</label>
      <select id="tdSortSelect">
        <option value="name">Nama</option>
        <option value="size">Ukuran</option>
        <option value="date">Tanggal</option>
      </select>
      <button id="tdSortDir" type="button" title="Ubah arah urutan" aria-label="Ubah arah urutan">
        ${state.dir === 'asc' ? '↑' : '↓'}
      </button>
    `;

    const select = wrapper.querySelector('#tdSortSelect');
    const dirButton = wrapper.querySelector('#tdSortDir');
    select.value = state.mode;

    select.addEventListener('change', () => {
      state.mode = select.value;
      localStorage.setItem(SORT_KEY, state.mode);
      refreshSort();
    });

    dirButton.addEventListener('click', () => {
      state.dir = state.dir === 'asc' ? 'desc' : 'asc';
      localStorage.setItem(SORT_DIR_KEY, state.dir);
      dirButton.textContent = state.dir === 'asc' ? '↑' : '↓';
      refreshSort();
    });

    // Put sorting beside the view controls, before +Folder.
    const actions = toolbar.querySelector('.actions');
    if (actions) {
      actions.insertBefore(wrapper, actions.firstElementChild);
    } else {
      toolbar.appendChild(wrapper);
    }
  }

  function sortDomFallback() {
    // Handles the first render that may have started before this script was
    // installed. Sorting response data is still the primary mechanism.
    const tbody = document.getElementById('listBody');
    if (!tbody) return;

    const rows = Array.from(tbody.children);
    if (rows.length < 2) return;

    const keyForRow = (row) => {
      const cells = row.querySelectorAll('td');
      if (state.mode === 'size') {
        const text = cells[1]?.textContent.trim() || '';
        if (text === '—') return 0;
        const m = text.match(/^([\d.,]+)\s*(B|KB|MB|GB|TB)$/i);
        if (!m) return 0;
        const n = Number(m[1].replace(',', '.'));
        const units = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4 };
        return n * Math.pow(1024, units[m[2].toUpperCase()] || 0);
      }
      if (state.mode === 'date') {
        return Date.parse(cells[2]?.textContent || '') || 0;
      }
      return normalize(cells[0]?.textContent || '');
    };

    rows.sort((a, b) => {
      const av = keyForRow(a);
      const bv = keyForRow(b);
      const result = typeof av === 'string'
        ? av.localeCompare(bv, 'id', { numeric: true, sensitivity: 'base' })
        : av - bv;
      return state.dir === 'desc' ? -result : result;
    });

    rows.forEach((row) => tbody.appendChild(row));
  }

  function refreshSort() {
    // Reload so both list and grid are rendered from the same sorted API data.
    // The selected sort mode/direction is stored in localStorage first.
    window.location.reload();
  }

  // Prevent rapid repeated folder navigation. The actual app click handlers
  // remain untouched; this simply ignores repeated clicks on the same folder
  // while its navigation request is still settling.
  let navigationLock = false;
  let lastFolderElement = null;

  document.addEventListener('click', (event) => {
    const folderName = event.target.closest('.name-cell, .grid-card');
    if (!folderName) return;

    const folderCheck = event.target.closest('[data-folder-check]');
    if (folderCheck) return;
    if (event.target.closest('button, input')) return;

    const isFolder = folderName.querySelector('[data-folder-check]')?.hasAttribute('data-folder-check')
      && !folderName.querySelector('[data-file-check]');
    if (!isFolder) return;

    if (navigationLock && lastFolderElement === folderName) {
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }

    navigationLock = true;
    lastFolderElement = folderName;
    setTimeout(() => {
      navigationLock = false;
      lastFolderElement = null;
    }, 650);
  }, true);

  const observer = new MutationObserver(() => {
    ensureSortControls();
    ensureSelectAll();
    updateSelectAllUI();
  });

  document.addEventListener('DOMContentLoaded', () => {
    ensureSortControls();
    ensureSelectAll();
    observer.observe(document.body, { childList: true, subtree: true });
  });

  window.addEventListener('load', () => {
    ensureSortControls();
    ensureSelectAll();
    sortDomFallback();
    updateSelectAllUI();
  });
})();
