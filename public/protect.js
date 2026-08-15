/*
 * TeleDrive — proteksi ringan (deterrent), BUKAN keamanan sungguhan.
 * Ini cuma bikin orang awam gak sengaja klik kanan / pencet F12.
 * Orang yang niat tetap bisa buka DevTools lewat menu browser (⋮ > More
 * tools > Developer tools), jadi JANGAN taruh data rahasia (API key,
 * token, dsb) di kode frontend dengan asumsi ini melindunginya.
 */
(() => {
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  document.addEventListener('keydown', (e) => {
    const key = e.key;
    const blocked =
      key === 'F12' ||
      (e.ctrlKey && e.shiftKey && ['I', 'i', 'J', 'j', 'C', 'c'].includes(key)) || // DevTools / console / inspector
      (e.ctrlKey && ['U', 'u'].includes(key)) || // View source
      (e.metaKey && e.altKey && ['I', 'i', 'J', 'j', 'C', 'c'].includes(key)); // Mac equivalent

    if (blocked) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
})();
