/**
 * hermes.mjs — client for the Hermes WebUI REST API used by the bridge.
 *
 * Chat pattern:
 *   1. POST /api/auth/login {password} -> Set-Cookie: hermes_session=<v>
 *   2. POST /api/session/new -> {session: {session_id}}
 *   3. POST /api/chat/start  -> {stream_id}
 *   4. GET  /api/chat/stream?stream_id=<id> -> SSE (typed `event:` frames)
 *
 * The client also exposes requestJson() so the browser companion can read
 * Hermes-native dashboard metadata (toolsets, skills, etc.) without duplicating
 * Hermes configuration logic in the extension.
 */
import { EventEmitter } from 'node:events';

export class HermesClient extends EventEmitter {
  /** @param {Object} cfg {baseUrl, password, model, modelProvider, workspace} */
  constructor(cfg = {}) {
    super();
    this.baseUrl = (cfg.baseUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    this.password = cfg.password || '';
    this.model = cfg.model || 'qwen3.5-9b';
    this.modelProvider = cfg.modelProvider || 'lmstudio';
    this.workspace = cfg.workspace || '';
    this._cookie = null;
    this._cookieExpiry = 0;
    this._sessionId = null;
  }

  async _login(force = false) {
    if (!force && this._cookie && this._cookieExpiry > Date.now() + 60_000) return this._cookie;
    const r = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.password })
    });
    if (!r.ok) throw new Error(`Hermes login: HTTP ${r.status}`);
    const cookies = typeof r.headers.getSetCookie === 'function'
      ? r.headers.getSetCookie()
      : [r.headers.get('set-cookie') || ''];
    let session = '';
    for (const header of cookies) {
      const match = String(header || '').match(/(?:^|[,\s])hermes_session=([^;]+)/);
      if (match) {
        session = match[1];
        break;
      }
    }
    if (!session) throw new Error('Hermes login OK but no hermes_session cookie');
    this._cookie = `hermes_session=${session}`;
    this._cookieExpiry = Date.now() + 25 * 60_000;
    return this._cookie;
  }

  /**
   * Authenticated JSON request to the Hermes WebUI API.
   * Retries once after a 401/403 in case the cached Hermes session expired.
   */
  async requestJson(apiPath, options = {}) {
    const path = String(apiPath || '').startsWith('/') ? String(apiPath) : `/${apiPath}`;
    const method = String(options.method || 'GET').toUpperCase();
    const doRequest = async (forceLogin = false) => {
      const cookie = await this._login(forceLogin);
      const headers = {
        Accept: 'application/json',
        Cookie: cookie,
        ...(options.headers || {})
      };
      let body;
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      }
      return fetch(`${this.baseUrl}${path}`, { method, headers, body });
    };

    let res = await doRequest(false);
    if (res.status === 401 || res.status === 403) res = await doRequest(true);
    const text = await res.text().catch(() => '');
    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch { data = text; }
    }
    if (!res.ok) {
      const detail = typeof data === 'string'
        ? data
        : (data?.detail || data?.error?.message || data?.error || '');
      throw new Error(`Hermes ${method} ${path}: HTTP ${res.status}${detail ? ` ${String(detail).slice(0, 300)}` : ''}`);
    }
    return data;
  }

  async runtimeOverview() {
    const [toolsetsResult, skillsResult] = await Promise.allSettled([
      this.requestJson('/api/tools/toolsets'),
      this.requestJson('/api/skills')
    ]);

    const toolsets = toolsetsResult.status === 'fulfilled' && Array.isArray(toolsetsResult.value)
      ? toolsetsResult.value
      : [];
    const skills = skillsResult.status === 'fulfilled' && Array.isArray(skillsResult.value)
      ? skillsResult.value
      : [];
    const toolsetsUnavailable = toolsetsResult.status === 'rejected'
      && /HTTP 404\b/i.test(toolsetsResult.reason?.message || '');
    const effectiveToolsets = toolsetsUnavailable
      ? [{
          name: 'browser',
          label: 'Browser Automation',
          description: 'Hermes-native browser tools mirrored by the companion when compatible.',
          enabled: true,
          configured: true,
          source: 'bridge-fallback',
          tools: ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back', 'browser_press', 'browser_get_images', 'browser_vision', 'browser_console', 'browser_cdp', 'browser_dialog', 'browser_exec']
        }]
      : toolsets;
    const enabledToolsets = effectiveToolsets.filter((row) => row?.enabled !== false);
    const enabledSkills = skills.filter((row) => row?.enabled !== false);
    const toolCount = enabledToolsets.reduce((sum, row) => sum + (Array.isArray(row?.tools) ? row.tools.length : 0), 0);

    const errors = [];
    if (toolsetsResult.status === 'rejected' && !toolsetsUnavailable) errors.push({ resource: 'toolsets', error: toolsetsResult.reason?.message || String(toolsetsResult.reason) });
    if (skillsResult.status === 'rejected') errors.push({ resource: 'skills', error: skillsResult.reason?.message || String(skillsResult.reason) });

    return {
      toolsets: effectiveToolsets,
      skills,
      summary: {
        toolsets: effectiveToolsets.length,
        enabledToolsets: enabledToolsets.length,
        tools: toolCount,
        skills: skills.length,
        enabledSkills: enabledSkills.length
      },
      errors
    };
  }

  async _ensureSession() {
    const cookie = await this._login();
    if (this._sessionId) return this._sessionId;
    const r = await fetch(`${this.baseUrl}/api/session/new`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        workspace: this.workspace || undefined,
        model: this.model,
        model_provider: this.modelProvider,
        // Keep the existing session contract used by the companion. Runtime
        // toolset discovery is read-only and does not silently mutate it.
        enabled_toolsets: ['hermes-cli', 'browser']
      })
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error(`Hermes session/new: HTTP ${r.status} ${t.slice(0, 200)}`);
    }
    const data = await r.json();
    this._sessionId = (data.session && data.session.session_id) || data.session_id;
    if (!this._sessionId) throw new Error('Hermes session/new returned no session_id');
    return this._sessionId;
  }

  /**
   * Start a turn and open the Hermes SSE stream.
   * @param {string} message
   * @param {Object} extra {workspace?, model?, modelProvider?, sessionId?}
   */
  async chatStream(message, extra = {}) {
    const cookie = await this._login();
    // Only reuse a Hermes session when the caller mapped one to this thread.
    // Falling back to the singleton session made "New conversation" continue
    // the previous Hermes turn.
    let sessionId = extra.sessionId || null;
    if (!sessionId) {
      this.resetSession();
      sessionId = await this._ensureSession();
    }
    this._sessionId = sessionId;

    const modelProvider = extra.modelProvider || this.modelProvider;
    let model = extra.model || this.model;
    const qualified = String(model).match(/^@([^:]+):(.+)$/);
    if (qualified && (!modelProvider || qualified[1] === modelProvider)) model = qualified[2];
    const body = {
      session_id: sessionId,
      message,
      model,
      model_provider: modelProvider,
      workspace: extra.workspace || this.workspace || undefined
    };

    const startChat = async () => fetch(`${this.baseUrl}/api/chat/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await this._login() },
      body: JSON.stringify(body)
    });

    let start = await startChat();
    if (!start.ok) {
      const t = await start.text().catch(() => '');
      if ((start.status === 401 || start.status === 403)) {
        await this._login(true);
        start = await startChat();
        if (!start.ok) {
          const retryText = await start.text().catch(() => '');
          throw new Error(`Hermes chat/start: HTTP ${start.status} ${retryText.slice(0, 200)}`);
        }
      } else if (start.status === 404 && /session\s+not\s+found/i.test(t)) {
        this._sessionId = null;
        sessionId = await this._ensureSession();
        body.session_id = sessionId;
        start = await startChat();
        if (!start.ok) {
          const retryText = await start.text().catch(() => '');
          throw new Error(`Hermes chat/start: HTTP ${start.status} ${retryText.slice(0, 200)}`);
        }
      } else {
        throw new Error(`Hermes chat/start: HTTP ${start.status} ${t.slice(0, 200)}`);
      }
    }

    const j = await start.json().catch(() => ({}));
    if (!j.stream_id) throw new Error('Hermes chat/start returned no stream_id');
    const streamId = j.stream_id;

    let res = await fetch(`${this.baseUrl}/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, {
      headers: { Cookie: await this._login(), Accept: 'text/event-stream' }
    });
    if (res.status === 401 || res.status === 403) {
      const retryCookie = await this._login(true);
      res = await fetch(`${this.baseUrl}/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`, {
        headers: { Cookie: retryCookie, Accept: 'text/event-stream' }
      });
    }
    if (!res.ok || !res.body) throw new Error(`Hermes chat/stream: HTTP ${res.status}`);
    return { stream: res.body, sessionId, stream_id: streamId };
  }

  resetSession() { this._sessionId = null; }
}

/** Parse an SSE byte stream into an async iterator of {event, data} frames. */
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