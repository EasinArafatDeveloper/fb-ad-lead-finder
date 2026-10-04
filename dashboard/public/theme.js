// Dark mode before the app loads (no flash). A separate file because the page doesn't allow inline scripts.
try {
  if (localStorage.getItem('fblf_theme') === 'dark') document.documentElement.classList.add('dark');
} catch {
  /* storage blocked */
}
