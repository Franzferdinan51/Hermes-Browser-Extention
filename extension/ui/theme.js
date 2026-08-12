/**
 * Shared appearance applicator. Loaded as a classic script in panel, popup, and options.
 */
(function (root) {
  const THEMES = ['midnight', 'aurora', 'ember', 'marble'];
  const DENSITIES = ['comfortable', 'compact'];

  function normalize(cfg = {}) {
    return {
      theme: THEMES.includes(cfg.theme) ? cfg.theme : 'midnight',
      density: DENSITIES.includes(cfg.density) ? cfg.density : 'comfortable',
      accentGlow: cfg.accentGlow !== false
    };
  }

  function apply(cfg = {}) {
    const next = normalize(cfg);
    const nodes = [document.documentElement, document.body].filter(Boolean);
    for (const node of nodes) {
      node.dataset.theme = next.theme;
      node.dataset.density = next.density;
      node.dataset.glow = next.accentGlow ? 'on' : 'off';
    }
    return next;
  }

  async function syncFromStore() {
    if (!root.chrome?.runtime?.sendMessage) return apply();
    const response = await chrome.runtime.sendMessage({ kind: 'get-config' }).catch(() => null);
    return apply(response?.config || {});
  }

  function watch() {
    if (!root.chrome?.storage?.onChanged) return;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.theme || changes.density || changes.accentGlow) syncFromStore();
    });
  }

  root.HermesTheme = { THEMES, DENSITIES, normalize, apply, syncFromStore, watch };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { syncFromStore(); watch(); }, { once: true });
  } else {
    syncFromStore();
    watch();
  }
})(globalThis);
