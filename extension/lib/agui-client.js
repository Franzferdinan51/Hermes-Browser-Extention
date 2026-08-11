/**
 * AG-UI protocol client (vanilla JS, no dependencies).
 *
 * Implements the Agent-User Interaction Protocol client side per
 * https://github.com/ag-ui-protocol/ag-ui (MIT) — the wire format consumed
 * by the protocol's HTTP agent endpoints.
 *
 * Transport: POST {RunAgentInput} -> `Accept: text/event-stream`, then parse
 * the SSE frames. Each `data:` frame is one AG-UI event object:
 *   { type, threadId, runId, ... }
 *
 * This module is loaded in BOTH the service worker (background) and content
 * scripts. It must not reference `chrome.*` so it stays portable.
 */

export const EventType = Object.freeze({
  RUN_STARTED: 'RUN_STARTED',
  RUN_FINISHED: 'RUN_FINISHED',
  RUN_ERROR: 'RUN_ERROR',
  STEP_STARTED: 'STEP_STARTED',
  STEP_FINISHED: 'STEP_FINISHED',
  TEXT_MESSAGE_START: 'TEXT_MESSAGE_START',
  TEXT_MESSAGE_CONTENT: 'TEXT_MESSAGE_CONTENT',
  TEXT_MESSAGE_END: 'TEXT_MESSAGE_END',
  TEXT_MESSAGE_CHUNK: 'TEXT_MESSAGE_CHUNK',
  TOOL_CALL_START: 'TOOL_CALL_START',
  TOOL_CALL_ARGS: 'TOOL_CALL_ARGS',
  TOOL_CALL_END: 'TOOL_CALL_END',
  TOOL_CALL_CHUNK: 'TOOL_CALL_CHUNK',
  STATE_SNAPSHOT: 'STATE_SNAPSHOT',
  STATE_DELTA: 'STATE_DELTA',
  MESSAGES_SNAPSHOT: 'MESSAGES_SNAPSHOT',
  RAW: 'RAW',
  CUSTOM: 'CUSTOM'
});

/** Simple event emitter used by AgentClient. */
export class Emitter {
  constructor() { this._h = new Map(); }
  on(type, fn) {
    if (!this._h.has(type)) this._h.set(type, new Set());
    this._h.get(type).add(fn);
    return () => this._h.get(type)?.delete(fn);
  }
  emit(type, event) {
    (this._h.get(type) ?? []).forEach((fn) => { try { fn(event); } catch (e) { console.error('AGUI emitter handler error', e); } });
  }
  removeAll() { this._h.clear(); }
}

/** Tiny URI-safe id generator (no crypto so it works in any context). */
function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * AGUIClient — connects to an AG-UI compatible agent endpoint (local Hermes
 * bridge or BrowserOS) and streams events.
 *
 * @param {Object} opts
 *   @param {string}   opts.url         - agent endpoint (http://127.0.0.1:8965/agent)
 *   @param {Object}   opts.headers     - extra headers (cookie etc.)
 *   @param {Function} opts.onEvent     - called for every protocol event
 */
export class AGUIClient extends Emitter {
  constructor(opts = {}) {
    super();
    this.url = opts.url || 'http://127.0.0.1:8965/agent';
    this.headers = opts.headers || {};
    this.onEvent = opts.onEvent || null;
    this.abort = null;
    this.busy = false;
  }

  /**
   * Run the agent. Accepts a partial RunAgentInput; fills thread/run id when
   * absent. Resolves with the aggregated result; streams events to onEvent /
   * emitted events in the meantime.
   */
  async runAgent(input = {}) {
    const runId = input.runId || uid('run_');
    const threadId = input.threadId || uid('thread_');
    const body = { ...input, runId, threadId };

    // Reset per-run streamed message/tool buffers (top-level; the caller may
    // also re-enter on retry).
    const ctrl = new AbortController();
    this.abort = ctrl;
    this.busy = true;

    const messageBuf = new Map();   // messageId -> {role, text}
    const toolBuf = new Map();      // toolCallId -> {name, args}
    const state = { messages: [] };

    const dispatch = (evt) => {
      // Normalize the event once; keep a run-local accumulator.
      if (evt.type === EventType.TEXT_MESSAGE_START || evt.type === EventType.TEXT_MESSAGE_CHUNK) {
        const id = evt.messageId || evt.type + uid();
        const buf = messageBuf.get(id) || { role: evt.role || 'assistant', text: '' };
        messageBuf.set(id, buf);
        evt.messageId = id;
      } else if (evt.type === EventType.TEXT_MESSAGE_CONTENT) {
        const id = evt.messageId || 'fallback';
        const buf = messageBuf.get(id) || { role: 'assistant', text: '' };
        buf.text += evt.delta || '';
        messageBuf.set(id, buf);
        evt.message = buf.text; // convenience: running full text
      } else if (evt.type === EventType.TOOL_CALL_START || evt.type === EventType.TOOL_CALL_CHUNK) {
        const id = evt.toolCallId || uid('tool_');
        const buf = toolBuf.get(id) || { name: evt.name || evt.toolName || '', args: '' };
        toolBuf.set(id, buf);
        evt.toolCallId = id;
      } else if (evt.type === EventType.TOOL_CALL_ARGS) {
        const id = evt.toolCallId || 'fallback';
        const buf = toolBuf.get(id) || { name: '', args: '' };
        buf.args += evt.delta || '';
        toolBuf.set(id, buf);
        evt.args = buf.args;
      } else if (evt.type === EventType.MESSAGES_SNAPSHOT || evt.type === EventType.STATE_SNAPSHOT) {
        if (Array.isArray(evt.state)) state.messages = evt.state;
        else if (evt.messages) state.messages = evt.messages;
      }

      if (this.onEvent) { try { this.onEvent(evt); } catch (e) { console.error('onEvent handler failed', e); } }
      this.emit(evt.type, evt);
      this.emit('event', evt);
    };

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.headers
        },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`AG-UI endpoint HTTP ${res.status}: ${txt.slice(0, 300)}`);
      }
      if (!res.body) throw new Error('AG-UI endpoint returned no body stream');

      await this._readSSE(res.body, dispatch);

      const result = { messages: [...messageBuf.values()], tools: [...toolBuf.values()], state };
      this.emit('complete', result);
      return result;
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }

  abortRun() { if (this.abort) this.abort.abort(); }

  /**
   * Incremental SSE decoder. Handles both the standard `data:`/`event:` lines
   * and the AG-UI convention where every frame carries one JSON event.
   * Frames can be separated by '\n\n' or '\r\n\r\n'.
   */
  async _readSSE(body, dispatch) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const processFrame = async (frame) => {
      let eventName = 'message';
      const dataLines = [];
      for (const rawLine of frame.split('\n')) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        // ignore comment lines and others
      }
      const dataStr = dataLines.join('\n');
      if (!dataStr) return;
      if (dataStr === '[DONE]') return;

      let evt;
      try { evt = JSON.parse(dataStr); }
      catch (e) { console.warn('AGUI: skipping non-JSON SSE frame', dataStr.slice(0, 120)); return; }

      // Allow `event:` frames or AG-UI typed payloads; unify to a BaseEvent.
      if (evt && typeof evt === 'object' && 'type' in evt) dispatch(evt);
      else if (evt && typeof evt === 'object' && eventName !== 'message') {
        dispatch({ type: eventName, ...evt });
      } else if (evt) {
        dispatch({ type: EventType.CUSTOM, ...evt });
      }
    };

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
          if (frame.trim()) await processFrame(frame);
        }
      }
    } finally {
      // flush any trailing frame
      if (buf.trim()) await processFrame(buf);
    }
  }
}

/**
 * AGUIBridgeClient — a higher-level convenience wrapper that speaks to the
 * Hermes bridge's JSON-SSE endpoint and manages thread continuity + a page
 * context attachment. Exposes the same event surface as AGUIClient.
 */
export class HermesBridgeClient extends AGUIClient {
  constructor(opts = {}) {
    super(opts);
    this.threadId = opts.threadId || null;
    this.agentId = opts.agentId || 'hermes';
  }

  /** Attach current page context to the next run (editable by caller). */
  setPageSnapshot(snapshot) {
    this.pageSnapshot = snapshot; // {url, title, dom, state}
  }

  async chat(userText, extra = {}) {
    const input = {
      agentId: this.agentId,
      threadId: this.threadId,
      messages: [
        ...(this.pageSnapshot ? [{
          role: 'user',
          content: `<page-context>\n${this.pageSnapshot.title}\n${this.pageSnapshot.url}\n\n${this.pageSnapshot.dom}\n</page-context>`
        }] : []),
        { role: 'user', content: userText }
      ],
      ...extra
    };
    const result = await this.runAgent(input);
    if (result.state && result.state.threadId) this.threadId = result.state.threadId;
    return result;
  }
}