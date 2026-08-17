/*
 * TeleDrive — theme (Terang/Gelap/Otomatis) + cursor glow.
 * "Otomatis" mengikuti jam lokal perangkat: 06:00–17:59 = terang,
 * selain itu = gelap. Dipasang di <head> supaya tema kepasang
 * SEBELUM halaman pertama kali digambar (tidak ada kedipan tema).
 */
(() => {
  const STORAGE = 'td_theme';
  const THEMES = ['auto', 'light', 'dark'];

  function autoTheme() {
    const hour = new Date().getHours();
    return hour >= 6 && hour < 18 ? 'light' : 'dark';
  }

  function effectiveTheme(theme) {
    return theme === 'auto' ? autoTheme() : theme;
  }

  function applyTheme(theme) {
    if (!THEMES.includes(theme)) theme = 'auto';
    document.documentElement.dataset.theme = effectiveTheme(theme);
    document.documentElement.dataset.themeMode = theme;
    document.querySelectorAll('[data-theme-choice]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.themeChoice === theme);
      btn.setAttribute('aria-pressed', btn.dataset.themeChoice === theme ? 'true' : 'false');
    });
  }

  function setTheme(theme) {
    localStorage.setItem(STORAGE, theme);
    applyTheme(theme);
  }

  function buildThemeControl() {
    const topbarRight = document.querySelector('.topbar-right');
    if (!topbarRight || document.getElementById('themeControl')) return;

    const wrap = document.createElement('div');
    wrap.id = 'themeControl';
    wrap.className = 'theme-control';
    wrap.title = 'Tema';

    const choices = [
      ['light', '☀', 'Terang'],
      ['dark', '☾', 'Gelap'],
      ['auto', '◐', 'Otomatis'],
    ];
    for (const [theme, icon, label] of choices) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.themeChoice = theme;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.textContent = icon;
      btn.addEventListener('click', () => setTheme(theme));
      wrap.appendChild(btn);
    }
    topbarRight.insertBefore(wrap, topbarRight.firstChild);
  }

  function refreshAutoTheme() {
    const mode = document.documentElement.dataset.themeMode || localStorage.getItem(STORAGE) || 'auto';
    if (mode === 'auto') applyTheme('auto');
  }

  // Apply immediately (before first paint) to avoid a flash of the wrong theme.
  applyTheme(localStorage.getItem(STORAGE) || 'auto');

  document.addEventListener('DOMContentLoaded', () => {
    buildThemeControl();
    applyTheme(localStorage.getItem(STORAGE) || 'auto');

    const footerYear = document.getElementById('footerYear');
    if (footerYear) footerYear.textContent = new Date().getFullYear();

    // Cursor glow: a soft light that follows the pointer.
    const glow = document.createElement('div');
    glow.id = 'cursorGlow';
    document.body.appendChild(glow);
    let rafPending = false;
    let lastX = 0, lastY = 0;
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType && e.pointerType !== 'mouse') return;
      lastX = e.clientX; lastY = e.clientY;
      glow.classList.add('active');
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        glow.style.setProperty('--gx', lastX + 'px');
        glow.style.setProperty('--gy', lastY + 'px');
        rafPending = false;
      });
    });
    window.addEventListener('mouseleave', () => glow.classList.remove('active'));
  });

  // Kalau tema lagi "Otomatis" dan jam melewati 06:00/18:00 sambil tab tetap
  // terbuka, tema ikut berubah otomatis tanpa perlu reload.
  setInterval(refreshAutoTheme, 60 * 1000);

  window.TeleDriveTheme = { setTheme, applyTheme, autoTheme };
})();
