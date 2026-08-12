/**
 * Chrome-native companion tools.
 *
 * Independently implemented from the public BrowserOS MCP *capability catalog*
 * (tab/window/group/bookmark/history/download/cookie/console/dialog names).
 * No BrowserOS source is copied.
 */

function httpUrl(value, base) {
  try {
    const url = new URL(String(value || '').trim(), base || undefined);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function tabSummary(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: !!tab.active,
    pinned: !!tab.pinned,
    highlighted: !!tab.highlighted,
    muted: !!tab.mutedInfo?.muted,
    discarded: !!tab.discarded,
    groupId: tab.groupId,
    title: tab.title || '',
    url: tab.url || '',
    status: tab.status || ''
  };
}

function windowSummary(win) {
  return {
    id: win.id,
    focused: !!win.focused,
    state: win.state || '',
    type: win.type || '',
    incognito: !!win.incognito,
    tabs: Array.isArray(win.tabs) ? win.tabs.map(tabSummary) : undefined
  };
}

function flattenBookmarks(nodes, out = [], limit = 250) {
  for (const node of nodes || []) {
    if (out.length >= limit) break;
    out.push({
      id: node.id,
      title: node.title || '',
      url: node.url || '',
      parentId: node.parentId || '',
      folder: !node.url,
      dateAdded: node.dateAdded || 0
    });
    if (node.children?.length) flattenBookmarks(node.children, out, limit);
  }
  return out;
}

function verb(params, fallback = 'list') {
  return String(params.action || params.op || params.command || fallback).toLowerCase().replace(/-/g, '_');
}

function targetTabId(params, fallbackId) {
  const id = params.tabId ?? params.id ?? params.pageId ?? fallbackId;
  const n = Number(id);
  return Number.isInteger(n) ? n : fallbackId;
}

async function runInMainWorld(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func,
    args
  });
  return results?.[0]?.result;
}

function installPageHooks(policy = {}) {
  const g = globalThis.__HERMES_PAGE_HOOKS__ ||= {
    logs: [],
    policy: 'observe',
    promptText: '',
    lastDialog: null,
    installed: false
  };
  if (policy.policy) g.policy = String(policy.policy);
  if (policy.promptText != null) g.promptText = String(policy.promptText);
  if (g.installed) return { ok: true, installed: true, policy: g.policy };
  const pushLog = (level, args) => {
    const text = args.map((value) => {
      try { return typeof value === 'string' ? value : JSON.stringify(value); }
      catch { return String(value); }
    }).join(' ');
    g.logs.push({ level, text: text.slice(0, 2000), at: Date.now() });
    if (g.logs.length > 200) g.logs.splice(0, g.logs.length - 200);
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { pushLog(level, args); return original(...args); };
  }
  addEventListener('error', (event) => pushLog('error', [event.message]));
  addEventListener('unhandledrejection', (event) => pushLog('error', [String(event.reason)]));
  const wrap = (name) => {
    const original = window[name].bind(window);
    window[name] = (message, def) => {
      g.lastDialog = { type: name, message: String(message ?? ''), at: Date.now() };
      if (g.policy === 'accept') return name === 'confirm' ? true : name === 'prompt' ? g.promptText : undefined;
      if (g.policy === 'dismiss') return name === 'confirm' ? false : name === 'prompt' ? null : undefined;
      return name === 'prompt' ? original(message, def) : original(message);
    };
  };
  wrap('alert');
  wrap('confirm');
  wrap('prompt');
  g.installed = true;
  return { ok: true, installed: true, policy: g.policy };
}

function readPageHooks(query = {}) {
  const g = globalThis.__HERMES_PAGE_HOOKS__;
  if (!g) return { ok: true, value: { logs: [], lastDialog: null, policy: 'observe', count: 0 } };
  const level = String(query.level || '').toLowerCase();
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 200);
  const logs = (g.logs || []).filter((row) => !level || row.level === level).slice(-limit);
  return { ok: true, value: { logs, lastDialog: g.lastDialog, policy: g.policy, count: (g.logs || []).length } };
}

async function handleTabs(params, tabId) {
  const action = verb(params, 'list');
  const id = targetTabId(params, tabId);
  switch (action) {
    case 'list':
    case 'query':
    case 'pages': {
      const query = {};
      if (params.windowId != null) query.windowId = Number(params.windowId);
      if (params.active != null) query.active = Boolean(params.active);
      if (params.pinned != null) query.pinned = Boolean(params.pinned);
      if (params.currentWindow != null) query.currentWindow = Boolean(params.currentWindow);
      const tabs = await chrome.tabs.query(query);
      const needle = String(params.query || params.text || '').toLowerCase();
      const filtered = needle
        ? tabs.filter((tab) => `${tab.title || ''} ${tab.url || ''}`.toLowerCase().includes(needle))
        : tabs;
      return { ok: true, value: filtered.slice(0, 200).map(tabSummary), count: filtered.length };
    }
    case 'get':
    case 'get_active':
    case 'active': {
      const tab = await chrome.tabs.get(id);
      return { ok: true, value: tabSummary(tab) };
    }
    case 'create':
    case 'new':
    case 'new_page':
    case 'open': {
      const url = params.url ? httpUrl(params.url) : 'about:blank';
      if (params.url && !url) return { ok: false, error: 'New tab requires a valid http(s) URL' };
      let windowId = params.windowId != null ? Number(params.windowId) : undefined;
      const openerTabId = params.openerTabId != null ? Number(params.openerTabId) : (id != null ? Number(id) : undefined);
      if (windowId == null && openerTabId != null) {
        const opener = await chrome.tabs.get(openerTabId).catch(() => null);
        if (opener?.windowId != null) windowId = opener.windowId;
      }
      const created = await chrome.tabs.create({
        url,
        windowId,
        openerTabId: openerTabId != null && Number.isFinite(openerTabId) ? openerTabId : undefined,
        active: params.active !== false,
        index: params.index != null ? Number(params.index) : undefined,
        pinned: !!params.pinned
      });
      return { ok: true, value: tabSummary(created) };
    }
    case 'close':
    case 'close_page': {
      const ids = Array.isArray(params.tabIds) ? params.tabIds.map(Number) : [id];
      await chrome.tabs.remove(ids);
      return { ok: true, value: `closed ${ids.join(', ')}` };
    }
    case 'switch':
    case 'show':
    case 'select':
    case 'activate': {
      const tab = await chrome.tabs.update(id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      return { ok: true, value: tabSummary(tab) };
    }
    case 'duplicate': {
      const tab = await chrome.tabs.duplicate(id);
      return { ok: true, value: tabSummary(tab) };
    }
    case 'reload': {
      await chrome.tabs.reload(id, { bypassCache: !!params.bypassCache });
      return { ok: true, value: `reloaded ${id}` };
    }
    case 'pin':
      return { ok: true, value: tabSummary(await chrome.tabs.update(id, { pinned: true })) };
    case 'unpin':
      return { ok: true, value: tabSummary(await chrome.tabs.update(id, { pinned: false })) };
    case 'mute':
      return { ok: true, value: tabSummary(await chrome.tabs.update(id, { muted: true })) };
    case 'unmute':
      return { ok: true, value: tabSummary(await chrome.tabs.update(id, { muted: false })) };
    case 'move': {
      const tab = await chrome.tabs.move(id, {
        index: params.index == null ? -1 : Number(params.index),
        windowId: params.windowId != null ? Number(params.windowId) : undefined
      });
      return { ok: true, value: Array.isArray(tab) ? tab.map(tabSummary) : tabSummary(tab) };
    }
    case 'highlight': {
      const tab = await chrome.tabs.get(id);
      await chrome.tabs.highlight({ windowId: tab.windowId, tabs: Array.isArray(params.indexes) ? params.indexes : [tab.index] });
      return { ok: true, value: tabSummary(tab) };
    }
    default:
      return { ok: false, error: `Unknown tabs action: ${action}` };
  }
}

async function handleWindows(params, tabId) {
  const action = verb(params, 'list');
  const current = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const id = Number(params.windowId ?? params.id ?? current?.windowId);
  switch (action) {
    case 'list': {
      const windows = await chrome.windows.getAll({ populate: !!params.populate });
      return { ok: true, value: windows.map(windowSummary) };
    }
    case 'get': {
      const win = await chrome.windows.get(id, { populate: !!params.populate });
      return { ok: true, value: windowSummary(win) };
    }
    case 'create':
    case 'new': {
      const url = params.url ? httpUrl(params.url) : undefined;
      if (params.url && !url) return { ok: false, error: 'New window requires a valid http(s) URL' };
      const win = await chrome.windows.create({
        url,
        focused: params.focused !== false,
        type: params.type || 'normal',
        state: params.state || undefined,
        width: params.width != null ? Number(params.width) : undefined,
        height: params.height != null ? Number(params.height) : undefined
      });
      return { ok: true, value: windowSummary(win) };
    }
    case 'close':
      await chrome.windows.remove(id);
      return { ok: true, value: `closed window ${id}` };
    case 'focus':
    case 'activate': {
      const win = await chrome.windows.update(id, { focused: true });
      return { ok: true, value: windowSummary(win) };
    }
    case 'update': {
      const patch = {};
      for (const key of ['state', 'width', 'height', 'left', 'top', 'focused', 'drawAttention']) {
        if (params[key] != null) patch[key] = params[key];
      }
      const win = await chrome.windows.update(id, patch);
      return { ok: true, value: windowSummary(win) };
    }
    default:
      return { ok: false, error: `Unknown windows action: ${action}` };
  }
}

async function handleTabGroups(params, tabId) {
  if (!chrome.tabGroups?.query) return { ok: false, error: 'tabGroups API is unavailable in this browser' };
  const action = verb(params, 'list');
  const groupId = params.groupId ?? params.id;
  switch (action) {
    case 'list': {
      const groups = await chrome.tabGroups.query(params.windowId != null ? { windowId: Number(params.windowId) } : {});
      return {
        ok: true,
        value: groups.map((group) => ({
          id: group.id,
          title: group.title || '',
          color: group.color || '',
          collapsed: !!group.collapsed,
          windowId: group.windowId
        }))
      };
    }
    case 'create':
    case 'group': {
      const ids = Array.isArray(params.tabIds) ? params.tabIds.map(Number) : [Number(params.tabId ?? tabId)];
      const createdId = await chrome.tabs.group({ tabIds: ids, groupId: groupId != null ? Number(groupId) : undefined });
      if (params.title || params.color || params.collapsed != null) {
        await chrome.tabGroups.update(createdId, {
          title: params.title,
          color: params.color,
          collapsed: params.collapsed
        });
      }
      return { ok: true, value: { groupId: createdId, tabIds: ids } };
    }
    case 'update': {
      const group = await chrome.tabGroups.update(Number(groupId), {
        title: params.title,
        color: params.color,
        collapsed: params.collapsed
      });
      return { ok: true, value: group };
    }
    case 'ungroup': {
      const ids = Array.isArray(params.tabIds)
        ? params.tabIds.map(Number)
        : (await chrome.tabs.query({ groupId: Number(groupId) })).map((tab) => tab.id);
      await chrome.tabs.ungroup(ids);
      return { ok: true, value: `ungrouped ${ids.length} tabs` };
    }
    case 'close': {
      const tabs = await chrome.tabs.query({ groupId: Number(groupId) });
      if (tabs.length) await chrome.tabs.remove(tabs.map((tab) => tab.id));
      return { ok: true, value: `closed group ${groupId}` };
    }
    case 'move': {
      await chrome.tabGroups.move(Number(groupId), {
        index: params.index == null ? -1 : Number(params.index),
        windowId: params.windowId != null ? Number(params.windowId) : undefined
      });
      return { ok: true, value: `moved group ${groupId}` };
    }
    default:
      return { ok: false, error: `Unknown tab_groups action: ${action}` };
  }
}

async function handleBookmarks(params) {
  if (!chrome.bookmarks) return { ok: false, error: 'bookmarks permission is not granted' };
  const action = verb(params, params.query ? 'search' : 'list');
  switch (action) {
    case 'list':
    case 'tree': {
      const tree = await chrome.bookmarks.getTree();
      const rows = flattenBookmarks(tree);
      return { ok: true, value: rows, count: rows.length };
    }
    case 'search': {
      const rows = await chrome.bookmarks.search(String(params.query || params.text || params.url || ''));
      return { ok: true, value: flattenBookmarks(rows), count: rows.length };
    }
    case 'get': {
      const rows = await chrome.bookmarks.get(String(params.id));
      return { ok: true, value: flattenBookmarks(rows) };
    }
    case 'create': {
      if (!params.title && !params.url) return { ok: false, error: 'create bookmark requires title or url' };
      const url = params.url ? httpUrl(params.url) : undefined;
      if (params.url && !url) return { ok: false, error: 'bookmark url must be http(s)' };
      const created = await chrome.bookmarks.create({
        parentId: params.parentId ? String(params.parentId) : undefined,
        title: params.title || url,
        url
      });
      return { ok: true, value: created };
    }
    case 'update': {
      const updated = await chrome.bookmarks.update(String(params.id), {
        title: params.title,
        url: params.url ? httpUrl(params.url) || params.url : undefined
      });
      return { ok: true, value: updated };
    }
    case 'remove':
    case 'delete': {
      if (params.folder) await chrome.bookmarks.removeTree(String(params.id));
      else await chrome.bookmarks.remove(String(params.id));
      return { ok: true, value: `removed bookmark ${params.id}` };
    }
    default:
      return { ok: false, error: `Unknown bookmarks action: ${action}` };
  }
}

async function handleHistory(params) {
  if (!chrome.history?.search) return { ok: false, error: 'history permission is not granted' };
  const action = verb(params, 'search');
  const mapItem = (item) => ({
    id: item.id,
    title: item.title || '',
    url: item.url || '',
    lastVisitTime: item.lastVisitTime || 0,
    visitCount: item.visitCount || 0
  });
  switch (action) {
    case 'search':
    case 'list': {
      const items = await chrome.history.search({
        text: params.text || params.query || '',
        startTime: params.startTime,
        endTime: params.endTime,
        maxResults: Math.min(Number(params.limit) || 50, 200)
      });
      return { ok: true, value: items.map(mapItem) };
    }
    case 'recent': {
      const items = await chrome.history.search({
        text: '',
        startTime: params.startTime || Date.now() - 7 * 24 * 60 * 60 * 1000,
        maxResults: Math.min(Number(params.limit) || 50, 200)
      });
      return { ok: true, value: items.map(mapItem) };
    }
    case 'delete_url':
    case 'delete': {
      const url = httpUrl(params.url);
      if (!url) return { ok: false, error: 'delete_url requires an http(s) url' };
      await chrome.history.deleteUrl({ url });
      return { ok: true, value: `deleted ${url}` };
    }
    case 'delete_range': {
      if (params.startTime == null || params.endTime == null) {
        return { ok: false, error: 'delete_range requires startTime and endTime' };
      }
      await chrome.history.deleteRange({ startTime: Number(params.startTime), endTime: Number(params.endTime) });
      return { ok: true, value: 'deleted history range' };
    }
    default:
      return { ok: false, error: `Unknown history action: ${action}` };
  }
}

async function handleDownloads(params) {
  if (!chrome.downloads?.search) return { ok: false, error: 'downloads permission is not granted' };
  const action = verb(params, params.url ? 'start' : 'list');
  const mapItem = (item) => ({
    id: item.id,
    filename: item.filename || '',
    url: item.url || '',
    state: item.state || '',
    bytesReceived: item.bytesReceived || 0,
    totalBytes: item.totalBytes || 0,
    exists: item.exists
  });
  switch (action) {
    case 'list':
    case 'search': {
      const items = await chrome.downloads.search({
        query: params.query ? [String(params.query)] : undefined,
        limit: Math.min(Number(params.limit) || 50, 200)
      });
      return { ok: true, value: items.map(mapItem) };
    }
    case 'start':
    case 'download': {
      const url = httpUrl(params.url);
      if (!url) return { ok: false, error: 'download requires a valid http(s) URL' };
      const id = await chrome.downloads.download({ url, filename: params.filename || undefined });
      return { ok: true, value: { id, url } };
    }
    case 'cancel':
      await chrome.downloads.cancel(Number(params.id));
      return { ok: true, value: `cancelled ${params.id}` };
    case 'pause':
      await chrome.downloads.pause(Number(params.id));
      return { ok: true, value: `paused ${params.id}` };
    case 'resume':
      await chrome.downloads.resume(Number(params.id));
      return { ok: true, value: `resumed ${params.id}` };
    case 'show':
      chrome.downloads.show(Number(params.id));
      return { ok: true, value: `revealed ${params.id}` };
    case 'open':
      return { ok: false, error: 'Opening downloaded files is disabled; use show to reveal in the folder' };
    default:
      return { ok: false, error: `Unknown downloads action: ${action}` };
  }
}

async function handleCookies(params, tabId) {
  const action = verb(params, 'list');
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  const url = httpUrl(params.url, tab?.url) || tab?.url || '';
  if (!chrome.cookies) {
    return { ok: false, error: 'cookies permission is not granted' };
  }
  switch (action) {
    case 'list': {
      if (!url && !params.domain) return { ok: false, error: 'cookies list requires url or domain' };
      const cookies = await chrome.cookies.getAll({
        url: params.domain ? undefined : url,
        domain: params.domain || undefined,
        name: params.name || undefined
      });
      return {
        ok: true,
        value: cookies.slice(0, 200).map((cookie) => ({
          name: cookie.name,
          domain: cookie.domain,
          path: cookie.path,
          secure: !!cookie.secure,
          httpOnly: !!cookie.httpOnly,
          session: !!cookie.session,
          expirationDate: cookie.expirationDate,
          value: params.includeValues === false ? undefined : cookie.value
        })),
        count: cookies.length
      };
    }
    case 'get': {
      if (!url || !params.name) return { ok: false, error: 'cookies get requires url and name' };
      const cookie = await chrome.cookies.get({ url, name: String(params.name) });
      return { ok: true, value: cookie };
    }
    case 'set': {
      if (!url || !params.name) return { ok: false, error: 'cookies set requires url and name' };
      const cookie = await chrome.cookies.set({
        url,
        name: String(params.name),
        value: String(params.value ?? ''),
        path: params.path,
        domain: params.domain,
        secure: params.secure,
        httpOnly: params.httpOnly,
        expirationDate: params.expirationDate
      });
      return { ok: true, value: cookie };
    }
    case 'remove':
    case 'delete': {
      if (!url || !params.name) return { ok: false, error: 'cookies remove requires url and name' };
      const removed = await chrome.cookies.remove({ url, name: String(params.name) });
      return { ok: true, value: removed };
    }
    default:
      return { ok: false, error: `Unknown cookies action: ${action}` };
  }
}

async function handleConsole(params, tabId) {
  await runInMainWorld(tabId, installPageHooks, [{}]);
  return runInMainWorld(tabId, readPageHooks, [params]);
}

async function handleDialog(params, tabId) {
  const policy = String(params.action || params.policy || 'status').toLowerCase();
  if (policy === 'accept' || policy === 'dismiss' || policy === 'observe') {
    await runInMainWorld(tabId, installPageHooks, [{ policy, promptText: params.text ?? params.promptText ?? '' }]);
  } else {
    await runInMainWorld(tabId, installPageHooks, [{}]);
  }
  return runInMainWorld(tabId, readPageHooks, [{}]);
}

async function handleSessions(params) {
  if (!chrome.sessions?.getRecentlyClosed) return { ok: false, error: 'sessions permission is not granted' };
  const action = verb(params, params.sessionId ? 'restore' : 'list');
  if (action === 'restore') {
    const restored = await chrome.sessions.restore(params.sessionId ? String(params.sessionId) : undefined);
    return { ok: true, value: restored };
  }
  const items = await chrome.sessions.getRecentlyClosed({ maxResults: Math.min(Number(params.limit) || 25, 25) });
  return {
    ok: true,
    value: items.map((item) => ({
      lastModified: item.lastModified,
      tab: item.tab ? { id: item.tab.sessionId, title: item.tab.title || '', url: item.tab.url || '' } : undefined,
      window: item.window ? { id: item.window.sessionId, tabs: (item.window.tabs || []).length } : undefined
    }))
  };
}

async function handleTopSites() {
  if (!chrome.topSites?.get) return { ok: false, error: 'topSites permission is not granted' };
  const sites = await chrome.topSites.get();
  return { ok: true, value: sites.slice(0, 20).map((site) => ({ title: site.title || '', url: site.url || '' })) };
}

async function handleDiscard(params, tabId) {
  const id = targetTabId(params, tabId);
  if (typeof chrome.tabs.discard !== 'function') return { ok: false, error: 'tabs.discard is unavailable' };
  const tab = await chrome.tabs.discard(id);
  return { ok: true, value: tab ? tabSummary(tab) : { id } };
}

async function handleViewport(params, tabId) {
  const action = verb(params, params.width != null || params.height != null ? 'set' : 'get');
  const tab = tabId != null ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab?.windowId) return null;
  if (action === 'set') {
    const patch = {};
    if (params.width != null) patch.width = Number(params.width);
    if (params.height != null) patch.height = Number(params.height);
    if (!Object.keys(patch).length) return { ok: false, error: 'viewport set requires width or height' };
    const win = await chrome.windows.update(tab.windowId, patch);
    return { ok: true, value: { width: win.width, height: win.height, state: win.state } };
  }
  const win = await chrome.windows.get(tab.windowId);
  return { ok: true, value: { width: win.width, height: win.height, state: win.state } };
}

async function handleZoom(params, tabId) {
  const action = verb(params, params.factor != null || params.zoom != null ? 'set' : 'get');
  const id = targetTabId(params, tabId);
  if (action === 'get') {
    const factor = await chrome.tabs.getZoom(id);
    return { ok: true, value: { tabId: id, factor } };
  }
  if (action === 'set') {
    const factor = Number(params.factor ?? params.zoom);
    if (!Number.isFinite(factor) || factor <= 0) return { ok: false, error: 'zoom set requires a positive factor' };
    await chrome.tabs.setZoom(id, factor);
    return { ok: true, value: { tabId: id, factor } };
  }
  if (action === 'reset') {
    await chrome.tabs.setZoom(id, 0);
    return { ok: true, value: { tabId: id, factor: 'reset' } };
  }
  return { ok: false, error: `Unknown zoom action: ${action}` };
}

export async function runChromeTool(name, params = {}, tabId = null) {
  try {
    switch (name) {
      case 'tabs':
      case 'pages':
        return await handleTabs(params, tabId);
      case 'windows':
        return await handleWindows(params, tabId);
      case 'tab_groups':
      case 'tab-groups':
      case 'tabgroups':
        return await handleTabGroups(params, tabId);
      case 'bookmarks':
        return await handleBookmarks(params);
      case 'history':
        return await handleHistory(params);
      case 'downloads':
      case 'download':
        return await handleDownloads(params);
      case 'cookies':
        return await handleCookies(params, tabId);
      case 'console':
        return await handleConsole(params, tabId);
      case 'dialog':
      case 'handle_dialog':
        return await handleDialog(params, tabId);
      case 'zoom':
        return await handleZoom(params, tabId);
      case 'viewport':
        return await handleViewport(params, tabId);
      case 'sessions':
        return await handleSessions(params);
      case 'top_sites':
      case 'topsites':
        return await handleTopSites();
      case 'discard':
        return await handleDiscard(params, tabId);
      default:
        return null;
    }
  } catch (error) {
    return { ok: false, error: `${name} failed: ${error.message}` };
  }
}
