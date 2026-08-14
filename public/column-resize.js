/* TeleDrive — clean column resizer
 * Keeps one fixed table grid so header + every row stay perfectly aligned.
 * Filename wraps naturally; no scrollbar and no ellipsis.
 */
(() => {
  'use strict';

  const TABLE_SELECTOR = '#mainTable.drive-table';
  const STORAGE_KEY = 'td-column-widths-v2';
  const DEFAULTS = [44, 14, 16, 26];
  const MIN_PX = [220, 105, 120, 170];

  function getTable() {
    return document.querySelector(TABLE_SELECTOR);
  }

  function isGridMode(table) {
    return table?.classList.contains('grid-view') ||
      table?.classList.contains('is-grid') ||
      document.body.classList.contains('grid-view');
  }

  function readWidths() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return DEFAULTS.slice();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || parsed.length !== 4) return DEFAULTS.slice();
      const widths = parsed.map(Number);
      if (widths.some((n) => !Number.isFinite(n) || n <= 0)) return DEFAULTS.slice();
      return widths;
    } catch (_) {
      return DEFAULTS.slice();
    }
  }

  function saveWidths(widths) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(widths)); } catch (_) {}
  }

  function normalizePixels(widths) {
    const safe = widths.map((n, i) => Math.max(MIN_PX[i], Number(n) || 0));
    const total = safe.reduce((a, b) => a + b, 0);
    return safe.map((n) => (n / total) * 100);
  }

  function normalizePercent(widths) {
    const safe = widths.map((n, i) => Math.max(0.1, Number(n) || DEFAULTS[i]));
    const total = safe.reduce((a, b) => a + b, 0);
    return safe.map((n) => (n / total) * 100);
  }

  function ensureColgroup(table) {
    let colgroup = table.querySelector(':scope > colgroup');
    if (!colgroup) {
      colgroup = document.createElement('colgroup');
      for (let i = 0; i < 4; i++) colgroup.appendChild(document.createElement('col'));
      table.insertBefore(colgroup, table.firstChild);
    }
    while (colgroup.children.length < 4) colgroup.appendChild(document.createElement('col'));
    while (colgroup.children.length > 4) colgroup.lastElementChild.remove();
    return [...colgroup.children];
  }

  function applyWidths(table, widths) {
    const cols = ensureColgroup(table);
    const normalized = normalizePercent(widths);
    cols.forEach((col, i) => { col.style.width = `${normalized[i]}%`; });
    table.dataset.columnWidths = JSON.stringify(normalized);
  }

  function getHeaderCells(table) {
    const row = table.tHead?.rows?.[0];
    return row ? [...row.cells].slice(0, 4) : [];
  }

  function addHandles(table) {
    const headers = getHeaderCells(table);
    headers.forEach((th, index) => {
      th.dataset.colResize = String(index);
      if (th.querySelector('.column-resizer')) return;

      // The action column should not be resized into an unusably small area.
      if (index >= headers.length - 1) return;

      const handle = document.createElement('span');
      handle.className = 'column-resizer';
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', (event) => startDrag(event, table, index, handle));
      th.appendChild(handle);
    });
  }

  function startDrag(event, table, leftIndex, handle) {
    if (isGridMode(table)) return;
    event.preventDefault();
    event.stopPropagation();

    const cols = ensureColgroup(table);
    const tableRect = table.getBoundingClientRect();
    const tableWidth = tableRect.width;
    if (!tableWidth) return;

    const current = cols.map((col) => {
      const px = col.getBoundingClientRect().width;
      return px || tableWidth * DEFAULTS[cols.indexOf(col)] / 100;
    });

    const startX = event.clientX;
    const leftStart = current[leftIndex];
    const rightStart = current[leftIndex + 1];
    const minLeft = MIN_PX[leftIndex];
    const minRight = MIN_PX[leftIndex + 1];

    handle.classList.add('is-dragging');
    document.body.classList.add('column-resizing');
    handle.setPointerCapture?.(event.pointerId);

    const move = (e) => {
      const delta = e.clientX - startX;
      const maxDelta = rightStart - minRight;
      const minDelta = minLeft - leftStart;
      const clamped = Math.max(minDelta, Math.min(maxDelta, delta));
      current[leftIndex] = leftStart + clamped;
      current[leftIndex + 1] = rightStart - clamped;

      const total = current.reduce((a, b) => a + b, 0);
      applyWidths(table, current.map((n) => (n / total) * 100));
    };

    const stop = () => {
      document.body.classList.remove('column-resizing');
      handle.classList.remove('is-dragging');
      const widths = [...cols].map((col) => parseFloat(col.style.width) || 0);
      saveWidths(normalizePercent(widths));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
    window.addEventListener('pointercancel', stop, { once: true });
  }

  function init() {
    const table = getTable();
    if (!table) return;
    applyWidths(table, readWidths());
    addHandles(table);

    // Re-apply after app.js redraws the table or changes its view.
    const observer = new MutationObserver(() => {
      if (isGridMode(table)) return;
      addHandles(table);
    });
    observer.observe(table, { childList: true, subtree: true });

    window.addEventListener('resize', () => {
      if (!isGridMode(table)) applyWidths(table, readWidths());
    });

    window.addEventListener('td:reset-columns', () => {
      const defaults = DEFAULTS.slice();
      applyWidths(table, defaults);
      saveWidths(defaults);
    });
  }

  // Compatible with an existing "Reset kolom" button: no duplicate button is created.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('#resetColumnsBtn, [data-reset-columns], .reset-columns');
    if (!button) return;
    const table = getTable();
    if (!table) return;
    event.preventDefault();
    event.stopPropagation();
    const defaults = DEFAULTS.slice();
    applyWidths(table, defaults);
    saveWidths(defaults);
  }, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
