function validCreatedTab(tab) {
  return tab && Number.isInteger(Number(tab.id)) && Number(tab.id) >= 0;
}

export async function openHermesFullView({ url, tabsApi, runtimeApi, windowOpen } = {}) {
  const target = String(url || '').trim();
  if (!target) throw new Error('Hermes Web URL is required.');
  const errors = [];

  if (typeof tabsApi?.create === 'function') {
    try {
      const tab = await tabsApi.create({ url: target, active: true });
      if (validCreatedTab(tab)) return { ok: true, method: 'tabs', tabId: Number(tab.id) };
      errors.push('tabs.create returned no tab id');
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  if (typeof runtimeApi?.sendMessage === 'function') {
    try {
      const response = await runtimeApi.sendMessage({ type: 'HERMES_OPEN_FULL_VIEW', url: target });
      if (response?.ok) return { ok: true, method: 'background' };
      errors.push(response?.reason || 'background worker rejected the request');
    } catch (error) {
      errors.push(error?.message || String(error));
    }
  }

  if (typeof windowOpen === 'function') {
    const opened = windowOpen(target, '_blank', 'noopener,noreferrer');
    if (opened) return { ok: true, method: 'window' };
    errors.push('window.open was blocked');
  }

  throw new Error(`Could not open Hermes Web: ${errors.join('; ') || 'no supported tab opener'}`);
}
