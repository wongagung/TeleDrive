
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

    document.querySelectorAll('[data-theme-choice]').forEach(btn => {
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
    const mode = document.documentElement.dataset.themeMode ||
      localStorage.getItem(STORAGE) || 'auto';
    if (mode === 'auto') applyTheme('auto');
  }

  const saved = localStorage.getItem(STORAGE) || 'auto';
  applyTheme(saved);

  document.addEventListener('DOMContentLoaded', () => {
    buildThemeControl();
    applyTheme(saved);
  });

  // Saat melewati 06:00/18:00, tema otomatis ikut berubah tanpa reload.
  setInterval(refreshAutoTheme, 60 * 1000);

  window.TeleDriveTheme = { setTheme, applyTheme, autoTheme };
})();
