/**
 * hermes.mjs — client for the Hermes Agent API server used by the bridge.
 *
 * The bridge talks to the Hermes API server (gateway/platforms/api_server.py),
 * which exposes OpenAI-compatible and Hermes-native session/chat endpoints.
 * That server is started by `hermes gateway` when `API_SERVER_ENABLED=true`
 * is set in `~/.hermes/.env`. Auth is `Authorization: Bearer <API_SERVER_KEY>`.
 *
 * Chat pattern:
 *   1. POST /api/sessions                          -> {session: {id: ...}}
 *   2. POST /api/sessions/{id}/chat/stream         -> SSE (assistant.delta, tool.started, ...)
 *
 * The same client also reads Hermes-native dashboard metadata (toolsets,
 * skills, sessions list) from the same API server via the /api/credentials/pool
 * and /api/tools/toolsets endpoints. No separate dashboard session token is
 * needed because every endpoint behind the API server shares the same Bearer
 * key.
 */
import { EventEmitter } from 'node:events';

export class HermesClient extends EventEmitter {
  /** @param {Object} cfg {baseUrl, apiKey, password, model, modelProvider, workspace} */
  constructor(cfg = {}) {
    super();
    // Default points at the API server (port 8642). Falls back to 8787 for
    // backwards compatibility with older env that didn't enable API_SERVER.
    this.baseUrl = (cfg.baseUrl || process.env.HERMES_API_URL
      || 'http://127.0.0.1:8642').replace(/\/+$/, '');
    // Bearer key. Either provided directly or picked up from API_SERVER_KEY.
    this.apiKey = cfg.apiKey || process.env.HERMES_API_KEY || process.env.API_SERVER_KEY || '';
    // Legacy fields kept for backwards-compat with old env files.
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

  /**
   * Authenticated JSON request to the Hermes API server.
   * Retries once after a 401/403 — that usually means the cached key drifted
   * (the server restarted with a new key, or we got one from env that no
   * longer matches). We can't refresh on our own, so just surface the error.
   */
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

  async _ensureSession({ attached = false } = {}) {
    if (this._sessionId) return this._sessionId;
    const data = await this.requestJson('/api/sessions', {
      method: 'POST',
      body: {
        model: this.model,
        provider: this.modelProvider,
        workspace: this.workspace || undefined
        // Attached companion chats already have the live Chrome tab. Enabling
        // Hermes' native browser / browser-use toolsets here launches a second
        // browser (or fails those tools) while the companion is already acting.
      }
    });
    const sessionId = (data?.session?.id) || data?.session_id || data?.id;
    if (!sessionId) throw new Error('Hermes session create returned no id');
    this._sessionId = sessionId;
    return sessionId;
  }

  /**
   * Start a turn and open the Hermes SSE stream.
   * @param {string} message
   * @param {Object} extra {workspace?, model?, modelProvider?, sessionId?}
   */
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

    const body = {
      message,
      model,
      provider: modelProvider,
      workspace: extra.workspace || this.workspace || undefined
    };

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
      // Session evaporated between _ensureSession and start — drop and retry.
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
    // The API server doesn't expose a per-stream cancel endpoint; sessions
    // are aborted by deleting them or by sending another prompt with the
    // `require_model_lock` flag. Best-effort: no-op.
    this._streamId = null;
    return false;
  }

  resetSession() { this._sessionId = null; this._streamId = null; }
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
