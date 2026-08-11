# Hermes Browser Companion

Connect **Hermes Agent** (Nous Research) to your Chrome browser over the **AG-UI protocol** — so your agent can read whatever page you're on and act on it.

Scaffolded from / inspired by:
- **Hermes Agent** — https://github.com/NousResearch/hermes-agent (MIT)
- **AG-UI** (Agent-User Interaction Protocol) — https://github.com/ag-ui-protocol/ag-ui (MIT)
- **BrowserOS** — https://github.com/browseros-ai/BrowserOS (AGPL-3.0; ideas reviewed, no BrowserOS source copied)

---

## What it does

- **Reads the page** — a content script turns any page's DOM into an agent-readable snapshot (text, headings, links, forms, inputs, an accessibility-style tree with stable `eN` refs, and an interaction map with current values), which is attached to your messages as AG-UI `context`.
- **Talks to Hermes** — a tiny local Node bridge (`bridge/`) exposes Hermes as an AG-UI-compatible agent endpoint (`POST /agent` -> `text/event-stream`). It logs into Hermes's WebUI REST API and streams responses as AG-UI protocol events (`RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `RUN_FINISHED`).
- **Acts on the page** — when Hermes emits a browser tool call (click / fill / type / scroll / read / navigate), the bridge forwards it to the extension over WebSocket, the extension executes it against the active tab via a page-actor module, and the result is fed back to Hermes for its next step.
- **Streams in real time** — a docked **side panel** renders the live AG-UI event stream (streaming text + tool timeline). A toolbar **popup** gives quick chat + connection status. An **options** page wires the bridge URL, Hermes model, and workspace with a live health check.

## Architecture

```
┌──────────────────────────── Chrome Extension (MV3) ────────────────────────────┐
│  popup / options / side-panel UI                                              │
│        │                                                                      │
│  background (service worker)  ←  AGUIClient (lib/agui-client.js)              │
│        │            │                                                         │
│        │  chrome.tabs sendMessage            WebSocket (browser-action)       │
│        ▼            ▼                                                         │
│  content script ──> page-reader.js (read DOM snapshot)                        │
│               └──> page-actor.js  (click / fill / type / scroll / read)       │
└───────────────────────────────────────────────────────────────────────────────┘
                               │  POST /agent (AG-UI SSE) + WS tool handoff
                               ▼
                    ┌──────────────────────────┐
                    │  bridge/server.mjs (Node) │  ← AG-UI <-> Hermes adapter
                    └────────────┬─────────────┘
                                 │  Hermes WebUI REST (login → chat/start → chat/stream)
                                 ▼
                          Hermes Agent (:8787)
```

## Quick start

### 1. Start the bridge

```bash
cd bridge
npm install
npm start          # listens on http://127.0.0.1:8965
```

The bridge auto-loads Hermes's WebUI password from `~/.hermes/.hermes-webui.env`, so you usually don't need to configure anything. If Hermes's WebUI was updated while running, restart it first (`hermes restart` / relaunch the app) — otherwise `chat/start` returns a `409 agent_runtime_stale`.

### 2. Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked** and select the `extension/` folder
4. Pin the Hermes toolbar icon

### 3. Connect (options page)

- Click the Hermes icon → **Options**, or right-click → Options.
- **Test connection** — verifies the bridge and Hermes are reachable (shows Hermes URL + WS clients).
- Default bridge URL is `http://127.0.0.1:8965`. Adjust model / provider / workspace if needed.

### 4. Use it

- Click the toolbar icon to open the **side panel** (`chrome.sidePanel`).
- The panel auto-attaches a page snapshot (`attach page` checkbox). Type a message — Hermes answers and can drive the page.
- The toolbar **popup** is a quick chat + status surface.

## Endpoints (bridge)

| Method | Path          | Purpose                                             |
|--------|---------------|-----------------------------------------------------|
| POST   | `/agent`      | AG-UI agent endpoint (`Accept: text/event-stream`) |
| GET    | `/healthz`    | Liveness + Hermes reachability                      |
| WS     | `/ws`         | Browser-tool handoff channel                        |
| POST   | `/tool-result`| Push a browser tool result back to a pending turn   |

## Tool calls Hermes can use

The bridge injects these into Hermes's context and forwards them to the page:

- `browser_read_page` — snapshot the current page
- `browser_click(selector)` — click an element (by selector or visible text)
- `browser_fill(selector, value)` / `browser_type(selector, text)` — enter text
- `browser_scroll(direction, amount)` — scroll
- `browser_extract(selector, prop)` — read a value or text
- `browser_grep(pattern, over, limit)` — search visible content or the accessibility refs without dumping the full page
- `browser_navigate(url)` — go to a URL

The page-control loop follows BrowserOS's useful **snapshot → act → verify** pattern: refs are used for actions, and page mutations require a fresh snapshot.

## Security notes

- **Local-only by default.** The bridge binds to `127.0.0.1`. The extension only talks to it over HTTP/WS.
- **No secrets copied.** The bridge reads Hermes's password from its existing env file and never prints it. The extension stores only a non-secret bridge URL and optional auth token (for remote bridges).
- Disable **"Allow Hermes to interact with the page"** in options for read-only mode.

## Tests

```bash
# Bridge AG-UI translation (self-contained; uses a fake Hermes; no live runtime)
cd bridge && node self-test.mjs            # expect: 8 passed, 0 failed

# Page reader + actor against a real DOM fixture (jsdom)
cd test && npm install && npm test          # expect: 14 passed, 0 failed
```

## License

MIT. Portions adapt patterns from Hermes Agent and the AG-UI protocol; see their repositories for their MIT licenses.