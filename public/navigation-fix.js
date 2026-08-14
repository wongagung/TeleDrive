/*
 * TeleDrive - Folder Navigation Fix
 *
 * Load AFTER navigation-columns.js and app.js.
 *
 * Fixes:
 * - Back / Forward buttons not responding.
 * - Folder history being recorded AFTER currentFolder already changed.
 * - Back/Forward history getting polluted by programmatic navigation.
 * - Rapid folder clicks without blocking the normal app click handler.
 *
 * This file intentionally does NOT replace the existing sorting, column resize,
 * Select All, list/grid, or other UI enhancements.
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'td_folder_navigation_v2';

  let backStack = [];
  let forwardStack = [];
  let restoring = false;
  let clickLock = false;

  function getState() {
    return {
      id: typeof currentFolder === 'undefined' ? null : (currentFolder ?? null),
      stack: Array.isArray(folderStack)
        ? folderStack.map(x => ({ id: x.id, name: x.name }))
        : []
    };
  }

  function cloneState(state) {
    return {
      id: state.id ?? null,
      stack: Array.isArray(state.stack)
        ? state.stack.map(x => ({ id: x.id, name: x.name }))
        : []
    };
  }

  function sameState(a, b) {
    return !!a && !!b && String(a.id ?? '') === String(b.id ?? '');
  }

  function saveHistory() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        back: backStack.slice(-50),
        forward: forwardStack.slice(-50)
      }));
    } catch (_) {}
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data.back)) backStack = data.back;
      if (Array.isArray(data.forward)) forwardStack = data.forward;
    } catch (_) {
      backStack = [];
      forwardStack = [];
    }
  }

  function updateButtons() {
    const back = document.getElementById('folderBackBtn');
    const forward = document.getElementById('folderForwardBtn');

    if (back) {
      back.disabled = restoring || backStack.length === 0;
      back.title = backStack.length
        ? 'Folder sebelumnya'
        : 'Tidak ada folder sebelumnya';
      back.setAttribute('aria-label', 'Folder sebelumnya');
    }

    if (forward) {
      forward.disabled = restoring || forwardStack.length === 0;
      forward.title = forwardStack.length
        ? 'Folder berikutnya'
        : 'Tidak ada folder berikutnya';
      forward.setAttribute('aria-label', 'Folder berikutnya');
    }
  }

  function restoreState(state) {
    folderStack = (state.stack || []).map(x => ({
      id: x.id,
      name: x.name
    }));
    currentFolder = state.id ?? null;

    if (typeof renderBreadcrumb === 'function') {
      renderBreadcrumb();
    }
  }

  async function loadCurrentFolder() {
    if (typeof loadList !== 'function') return;
    await loadList();
  }

  async function goBackFixed(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (restoring || backStack.length === 0) return;

    restoring = true;
    updateButtons();

    const current = cloneState(getState());
    const target = backStack.pop();

    if (!sameState(forwardStack[forwardStack.length - 1], current)) {
      forwardStack.push(current);
    }

    restoreState(target);
    saveHistory();

    try {
      await loadCurrentFolder();
    } catch (err) {
      console.error('[navigation-fix] Back gagal:', err);
      // Restore the previous history state if loading failed.
      backStack.push(target);
      forwardStack.pop();
    } finally {
      restoring = false;
      updateButtons();
      saveHistory();
    }
  }

  async function goForwardFixed(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (restoring || forwardStack.length === 0) return;

    restoring = true;
    updateButtons();

    const current = cloneState(getState());
    const target = forwardStack.pop();

    if (!sameState(backStack[backStack.length - 1], current)) {
      backStack.push(current);
    }

    restoreState(target);
    saveHistory();

    try {
      await loadCurrentFolder();
    } catch (err) {
      console.error('[navigation-fix] Forward gagal:', err);
      forwardStack.push(target);
      backStack.pop();
    } finally {
      restoring = false;
      updateButtons();
      saveHistory();
    }
  }

  function bindButtons() {
    const back = document.getElementById('folderBackBtn');
    const forward = document.getElementById('folderForwardBtn');

    if (back && back.dataset.navigationFixBound !== '1') {
      back.dataset.navigationFixBound = '1';
      back.onclick = null;
      back.addEventListener('click', goBackFixed);
    }

    if (forward && forward.dataset.navigationFixBound !== '1') {
      forward.dataset.navigationFixBound = '1';
      forward.onclick = null;
      forward.addEventListener('click', goForwardFixed);
    }

    updateButtons();
  }

  /*
   * IMPORTANT:
   * This listener runs in capture phase, before app.js handles the folder click.
   * Therefore currentFolder/folderStack still contain the PREVIOUS folder here.
   */
  function captureFolderNavigation() {
    document.addEventListener('click', (event) => {
      if (restoring) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      const target = event.target.closest('.name-cell, .grid-card');
      if (!target) return;

      const folderCheck = target.querySelector('[data-folder-check]');
      if (!folderCheck) return;

      // Checkbox itself must remain usable.
      if (
        event.target.closest('input[type="checkbox"]') ||
        event.target.closest('button') ||
        event.target.closest('[data-action]')
      ) {
        return;
      }

      const before = cloneState(getState());

      // Do not create duplicate history entries.
      if (!backStack.length || !sameState(backStack[backStack.length - 1], before)) {
        backStack.push(before);
      }

      // A new folder click creates a new branch.
      forwardStack = [];
      saveHistory();
      updateButtons();

      // Only debounce repeated clicks. Do NOT cancel the first click.
      if (clickLock) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }

      clickLock = true;
      setTimeout(() => {
        clickLock = false;
      }, 500);
    }, true);
  }

  /*
   * The original navigation-columns.js wraps loadList(). That wrapper is the
   * main source of the broken history because loadList() may already see the
   * new currentFolder. We cannot access its private variables, so this fix
   * simply ensures Back/Forward use their own independent history and never
   * depend on that wrapper.
   */
  function init() {
    loadHistory();

    // Do not restore a saved folder automatically. The app's current folder
    // remains authoritative after page load.
    bindButtons();
    captureFolderNavigation();

    const observer = new MutationObserver(() => {
      bindButtons();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    // The original file may create its buttons shortly after startup.
    [0, 100, 300, 700, 1200].forEach(delay => {
      setTimeout(bindButtons, delay);
    });

    window.addEventListener('beforeunload', saveHistory);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(init, 0), { once: true });
  } else {
    setTimeout(init, 0);
  }
})();
