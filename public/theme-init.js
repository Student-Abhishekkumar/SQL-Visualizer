// Apply the persisted theme before the bundle loads to avoid a flash.
// Keep this as a classic same-origin script so the production CSP can allow it
// without permitting inline JavaScript.
;(function () {
  try {
    var theme = localStorage.getItem('sql-visualizer-theme')
    var mode = theme === 'light' ? 'light' : 'dark'
    var root = document.documentElement
    root.dataset.theme = theme || 'dark'
    root.classList.toggle('dark', mode === 'dark')
    root.style.colorScheme = mode
    if (localStorage.getItem('sql-visualizer-reduced-effects') === 'true') {
      root.classList.add('reduce-effects')
    }
  } catch {
    // Storage unavailable: retain the dark default from the html element.
  }
})()
