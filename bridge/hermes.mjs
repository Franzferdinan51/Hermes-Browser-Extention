/**
 * hermes.mjs — client for the Hermes Agent API server used by the bridge.
 */
import { EventEmitter } from 'node:events';

export class HermesClient extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.baseUrl = (cfg.baseUrl || process.env.HERMES_API_URL || 'http://127.0.0.1:8642').replace(/\/+$/, '');
    this.apiKey = cfg.apiKey || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || '';
    this.password = cfg.password || process.env.HERMES_WEBUI_PASSWORD || '';
    this.model = cfg.model || 'ornith-1.5-35b-a3b';
    this.modelProvider = cfg.modelProvider || 'lmstudio';
    this.workspace = cfg.workspace || '';
    this._sessionId = null;
    this._streamId = null;
  }

  _authHeaders(extra = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (this.apiKey) headers['Authorization'] = `Bearer ${this.apiKey}`;
    return headers;
  }

  async requestJson(apiPath, options = {}) {
    const path = String(apiPath || '').startsWith('/') ? String(apiPath) : `/${apiPath}`;
    const method = String(options.method || 'GET').toUpperCase();
    const headers = this._authHeaders({ ...(options.headers || {}) });
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) {
      const detail = typeof data === 'string' ? data : (data?.detail || data?.error?.message || data?.error || '');
      throw new Error(`Hermes ${method} ${path}: HTTP ${res.status}${detail ? ` ${String(detail).slice(0, 300)}` : ''}`);
    }
    return data;
  }

  async runtimeOverview() {
    const [toolsetsResult, skillsResult] = await Promise.allSettled([
      this.requestJson('/api/tools/toolsets'),
      this.requestJson('/api/skills')
    ]);
    const toolsets = toolsetsResult.status === 'fulfilled' && Array.isArray(toolsetsResult.value) ? toolsetsResult.value : [];
    const skills = skillsResult.status === 'fulfilled' && Array.isArray(skillsResult.value) ? skillsResult.value : [];
    const toolsetsUnavailable = toolsetsResult.status === 'rejected' && /HTTP 404\b/i.test(toolsetsResult.reason?.message || '');
    const effectiveToolsets = toolsetsUnavailable
      ? [{ name: 'browser', label: 'Browser Automation', description: 'Hermes-native browser tools mirrored by the companion when compatible.', enabled: true, configured: true, source: 'bridge-fallback', tools: ['browser_navigate','browser_snapshot','browser_click','browser_type','browser_scroll','browser_back','browser_press','browser_get_images','browser_vision','browser_console','browser_cdp','browser_dialog','browser_exec'] }]
      : toolsets;
    const enabledToolsets = effectiveToolsets.filter(r => r?.enabled !== false);
    const enabledSkills = skills.filter(r => r?.enabled !== false);
    const toolCount = enabledToolsets.reduce((s, r) => s + (Array.isArray(r?.tools) ? r.tools.length : 0), 0);
    const errors = [];
    if (toolsetsResult.status === 'rejected' && !toolsetsUnavailable) errors.push({ resource: 'toolsets', error: toolsetsResult.reason?.message });
    if (skillsResult.status === 'rejected') errors.push({ resource: 'skills', error: skillsResult.reason?.message });
    return {
      toolsets: effectiveToolsets,
      skills,
      summary: { toolsets: effectiveToolsets.length, enabledToolsets: enabledToolsets.length, tools: toolCount, skills: skills.length, enabledSkills: enabledSkills.length },
      errors
    };
  }

  async _ensureSession({ attached = false } = {}) {
    if (this._sessionId) return this._sessionId;
    const data = await this.requestJson('/api/sessions', {
      method: 'POST',
      body: { model: this.model, provider: this.modelProvider, workspace: this.workspace || undefined }
    });
    const sessionId = (data?.session?.id) || data?.session_id || data?.id;
    if (!sessionId) throw new Error('Hermes session create returned no id');
    this._sessionId = sessionId;
    return sessionId;
  }

  async chatStream(message, extra = {}) {
    let sessionId = extra.sessionId || null;
    if (!sessionId) {
      this.resetSession();
      sessionId = await this._ensureSession({ attached: Boolean(extra.attached) });
    }
    this._sessionId = sessionId;

    let modelProvider = extra.modelProvider || this.modelProvider;
    let model = extra.model || this.model;
    const qualified = String(model).match(/^@([^:]+):(.+)$/);
    if (qualified) {
      modelProvider = qualified[1];
      model = qualified[2];
    }

    const body = { message, model, provider: modelProvider, workspace: extra.workspace || this.workspace || undefined };
    const startChat = () => fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/chat/stream`,
      {
        method: 'POST',
        headers: this._authHeaders({ 'Content-Type': 'application/json', Accept: 'text/event-stream' }),
        body: JSON.stringify(body)
      }
    );

    const readError = async (response) => {
      const text = await response.text().catch(() => '');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { text, data };
    };

    let res = await startChat();
    if (res.status === 404 || (res.status === 409 && /session\s+not\s+found/i.test((await res.clone().text().catch(() => ''))))) {
      this.resetSession();
      sessionId = await this._ensureSession({ attached: Boolean(extra.attached) });
      body.session_id = sessionId;
      res = await startChat();
    }
    if (!res.ok || !res.body) {
      const errInfo = await readError(res);
      throw new Error(`Hermes chat/stream: HTTP ${res.status} ${errInfo.text.slice(0, 200)}`);
    }
    this._streamId = sessionId;
    return { stream: res.body, sessionId, stream_id: sessionId };
  }

  async cancelStream(streamId = this._streamId) {
    this._streamId = null;
    return false;
  }

  resetSession() { this._sessionId = null; this._streamId = null; }
}

export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.search(/\n\n|\r\n\r\n/)) >= 0) {
        const sep = buf.slice(idx, idx + 4).startsWith('\r\n\r\n') ? 4 : 2;
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + sep);
        if (frame.trim()) yield parseFrame(frame);
      }
    }
  } finally {
    if (buf.trim()) yield parseFrame(buf);
  }
}

function parseFrame(frame) {
  let event = 'message';
  const dataLines = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  const data = dataLines.join('\n');
  let parsed = null;
  if (data && data !== '[DONE]') {
    try { parsed = JSON.parse(data); } catch {}
  }
  return { event, raw: frame, data: parsed, final: data === '[DONE]' };
}
