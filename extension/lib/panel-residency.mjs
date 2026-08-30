export const PANEL_RESIDENCY_MODES = Object.freeze({
  TAB_ATTACHED: 'tab-attached',
  GLOBAL: 'global',
});

export const DEFAULT_PANEL_RESIDENCY_MODE = PANEL_RESIDENCY_MODES.TAB_ATTACHED;

export function normalizePanelResidencyMode(value = DEFAULT_PANEL_RESIDENCY_MODE) {
  return value === PANEL_RESIDENCY_MODES.GLOBAL
    ? PANEL_RESIDENCY_MODES.GLOBAL
    : PANEL_RESIDENCY_MODES.TAB_ATTACHED;
}

function panelPagePath(defaultPath = 'sidepanel.html') {
  const clean = String(defaultPath || 'sidepanel.html').split(/[?#]/)[0].trim();
  return clean || 'sidepanel.html';
}

function finiteTabId(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

export function buildSidePanelPath({ mode = DEFAULT_PANEL_RESIDENCY_MODE, tabId = null, defaultPath = 'sidepanel.html' } = {}) {
  const normalized = normalizePanelResidencyMode(mode);
  const basePath = panelPagePath(defaultPath);
  if (normalized === PANEL_RESIDENCY_MODES.GLOBAL) return `${basePath}?panel=global`;
  const cleanTabId = finiteTabId(tabId);
  return cleanTabId
    ? `${basePath}?panel=tab&tabId=${encodeURIComponent(cleanTabId)}`
    : `${basePath}?panel=tab`;
}

export function parseSidePanelParams(search = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const panelMode = params.get('panel') === 'global'
    ? PANEL_RESIDENCY_MODES.GLOBAL
    : PANEL_RESIDENCY_MODES.TAB_ATTACHED;
  return {
    panelMode,
    tabId: finiteTabId(params.get('tabId')),
  };
}
