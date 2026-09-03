/**
 * Resolves the theme before first paint (plan.md §15.3).
 *
 * This is a separate file rather than an inline <script> because the CSP is
 * `script-src 'self'` with no nonce and no hashes (§14.3), and it is loaded
 * blocking in <head> because the alternative is a flash of the wrong theme:
 * the app bundle is a module, so it runs after the browser has already painted.
 *
 * It resolves the *system* preference into the same attribute an explicit
 * choice sets, which is what lets index.css carry one light block instead of
 * three. Deliberately tiny and dependency-free — everything it touches is
 * re-derived by src/ui/theme.ts once React is running.
 */
(function () {
  try {
    var stored = localStorage.getItem('querylens:theme');
    var choice = stored === 'light' || stored === 'dark' ? stored : null;
    if (!choice) {
      choice = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.dataset.theme = choice;
  } catch (error) {
    // Private mode can throw on localStorage, and a themed page is not worth
    // a blank one. Dark is the CSS default, so doing nothing is a valid answer.
    document.documentElement.dataset.theme = 'dark';
  }
})();
