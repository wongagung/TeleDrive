/* TeleDrive - keeps long names inside the Name column and lets the user scroll them. */
(() => {
  function fixNames() {
    document.querySelectorAll('#mainTable td.name-cell').forEach((cell) => {
      if (cell.querySelector('.name-text-scroll')) return;

      const nodes = [...cell.childNodes].filter((node) =>
        node.nodeType === Node.TEXT_NODE && node.textContent.trim()
      );
      if (!nodes.length) return;

      const text = nodes.map((n) => n.textContent).join('');
      nodes.forEach((n) => n.remove());

      const span = document.createElement('span');
      span.className = 'name-text-scroll';
      span.textContent = text;
      cell.appendChild(span);
    });
  }

  function init() {
    fixNames();
    const body = document.getElementById('listBody');
    if (!body) return;
    new MutationObserver(fixNames).observe(body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
