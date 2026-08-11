/**
 * hermes.mjs — client for the Hermes WebUI REST API used by the bridge.
 *
 * Pattern (proven in DuckChat's proxy.mjs):
 *   1. POST /api/auth/login {password} -> Set-Cookie: hermes_session=<v>
 *   2. POST /api/session/new -> {session: {session_id}}
 *   3. POST /api/chat/start  -> {stream_id}
 *   4. GET  /api/chat/stream?stream_id=<id> -> SSE (typed `event:` frames)
 *
 * Event frames on the SSE stream (non-exhaustive, tolerant parser):
 *   event: context_status | metering | reasoning | token | done | complete
 *   data: {text: "chunk"}  for token/reasoning
 *   Tool calls arrive as `tool_call`-style frames carrying a JSON payload with
 *   tool name + args. We parse defensively and surface them as AG-UI tool events.
 */
import { EventEmitter } from 'node:events';

export class HermesClient extends EventEmitter {
  /**
   * @param {Object} cfg {baseUrl, password, model, modelProvider, workspace}
   */
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

  async _login() {
    if (this._cookie && this._cookieExpiry > Date.now() + 60_000) return this._cookie;
    const r = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.password })
    });
    if (!r.ok) throw new Error(`Hermes login: HTTP ${r.status}`);
    const sc = r.headers.get('set-cookie') || '';
    const m = sc.match(/(?:^|,\s*)(?:[^;]+;\s*)?hermes_session(?:_at)?=([^;]+)/);
    if (!m) throw new Error('Hermes login OK but no hermes_session cookie');
    this._cookie = `hermes_session=${m[1]}`;
    this._cookieExpiry = Date.now() + 25 * 60_000;
    return this._cookie;
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
        model_provider: this.modelProvider
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
   * Start a turn and open the SSE stream. Returns a Web ReadableStream whose
   * parsed SSE frames are delivered as events to this emitter and to the
   * `onFrame` callback. Caller decides when to stop reading.
   *
   * @param {string} message  the user turn text
   * @param {Object} extra    {workspace?, model?, modelProvider?}
   * @returns {{stream: ReadableStream, done: Promise<string>}}
   */
  async chatStream(message, extra = {}) {
    const cookie = await this._login();
    let sessionId = extra.sessionId || this._sessionId;
    if (!sessionId) sessionId = await this._ensureSession();
    this._sessionId = sessionId;

    const body = {
      session_id: sessionId,
      message,
      model: extra.model || this.model,
      model_provider: extra.modelProvider || this.modelProvider,
      workspace: extra.workspace || this.workspace || undefined
    };
    const start = await fetch(`${this.baseUrl}/api/chat/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify(body)
    });
    if (!start.ok) {
      const t = await start.text().catch(() => '');
      throw new Error(`Hermes chat/start: HTTP ${start.status} ${t.slice(0, 200)}`);
    }
    const j = await start.json().catch(() => ({}));
    if (!j.stream_id) throw new Error('Hermes chat/start returned no stream_id');
    const stream_id = j.stream_id;

    const res = await fetch(`${this.baseUrl}/api/chat/stream?stream_id=${encodeURIComponent(stream_id)}`, {
      headers: { Cookie: cookie, Accept: 'text/event-stream' }
    });
    if (!res.ok || !res.body) throw new Error(`Hermes chat/stream: HTTP ${res.status}`);
    return { stream: res.body, sessionId, stream_id };
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
        const sep = buf[idx + 1] === '\n' && buf[idx] === '\r' ? 4 : 2;
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
  if (data && data !== '[DONE]') { try { parsed = JSON.parse(data); } catch {} }
  return { event, raw: frame, data: parsed, final: data === '[DONE]' };
}