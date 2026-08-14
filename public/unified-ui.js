
/* TeleDrive — shared UI behavior: Light / Dark / Auto-by-time */
(() => {
  const KEY = 'td_ui_theme';
  const modes = ['auto','light','dark'];

  function autoTheme(){
    const h = new Date().getHours();
    return (h >= 6 && h < 18) ? 'light' : 'dark';
  }
  function apply(){
    const saved = localStorage.getItem(KEY) || 'auto';
    const actual = saved === 'auto' ? autoTheme() : saved;
    document.documentElement.dataset.uiTheme = actual;
    document.documentElement.dataset.uiThemeMode = saved;
    document.querySelectorAll('.ui-theme-control button').forEach(b =>
      b.classList.toggle('active', b.dataset.theme === saved)
    );
  }
  function makeControl(){
    if(document.querySelector('.ui-theme-control')) return;
    const host = document.querySelector('.topbar-right');
    if(!host) return;
    const box = document.createElement('div');
    box.className = 'ui-theme-control';
    box.setAttribute('aria-label','Tema');
    box.innerHTML = `
      <button type="button" data-theme="light" title="Light">☀</button>
      <button type="button" data-theme="dark" title="Dark">☾</button>
      <button type="button" data-theme="auto" title="Otomatis (06:00–17:59 Light, 18:00–05:59 Dark)">A</button>`;
    box.addEventListener('click', e => {
      const b = e.target.closest('button[data-theme]');
      if(!b) return;
      localStorage.setItem(KEY,b.dataset.theme);
      apply();
    });
    host.insertBefore(box, host.firstChild);
  }
  window.TeleDriveTheme = {apply};
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    makeControl(); apply();
    // Auto mode follows the clock without reloading the page.
    setInterval(() => {
      if((localStorage.getItem(KEY)||'auto') === 'auto') apply();
    }, 60_000);
  });
})();
