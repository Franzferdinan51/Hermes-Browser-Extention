# Hermes Browser Companion

Connect **Hermes Agent** (Nous Research) to your Chrome browser over the **AG-UI protocol** — so your agent can read whatever page you're on, stream polished responses, expose its tool activity, and act on the live tab.

Scaffolded from / inspired by:
- **Hermes Agent** — https://github.com/NousResearch/hermes-agent (MIT)
- **AG-UI** (Agent-User Interaction Protocol) — https://github.com/ag-ui-protocol/ag-ui (MIT)
- **BrowserOS** — https://github.com/browseros-ai/BrowserOS (AGPL-3.0; architecture/UX ideas reviewed, no BrowserOS source copied)

---

## What it does

- **Reads the page** — a content script turns any page's DOM into an agent-readable snapshot (text, headings, links, forms, inputs, an accessibility-style tree with stable `eN` refs, and an interaction map with current values), which is attached to your messages as AG-UI `context`.
- **Talks to Hermes** — a tiny local Node bridge (`bridge/`) exposes Hermes as an AG-UI-compatible agent endpoint (`POST /agent` -> `text/event-stream`). It logs into Hermes's WebUI REST API and streams responses as AG-UI protocol events (`RUN_STARTED`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `CUSTOM`, `RUN_FINISHED`).
- **Preserves the real user turn** — the bridge sends page context, conversation roles, **and the current user request** to Hermes. This sounds obvious, but it is a critical contract: the agent should never receive a page dump + tool instructions while losing the actual question.
- **Acts on the page** — Hermes browser calls are mirrored to the extension over WebSocket and executed against the active tab. Each request carries a unique `requestId`, so multiple browser actions cannot steal one another's replies.
- **Understands Hermes refs** — page controls accept both `e12` and the Hermes-native `@e12` form.
- **Shows useful agent state without leaking hidden reasoning** — the panel receives lifecycle states such as `Thinking…`, `Reasoning…`, and `Using browser_click…`, but raw private reasoning text is not rendered.
- **Renders responses cleanly** — the side panel supports lightweight headings, lists, quotes, code blocks, inline code, links, response copy controls, and collapsible tool cards with arguments/results.
- **Streams in real time** — a docked **side panel** renders live AG-UI events. A toolbar **popup** gives quick chat + connection status. An **options** page wires the bridge URL, Hermes model, and workspace with a live health check.

## Architecture

```
┌──────────────────────────── Chrome Extension (MV3) ────────────────────────────┐
│  popup / options / side-panel UI                                              │
│        │                                                                      │
│  background (service worker)  ←  AGUIClient (lib/agui-client.js)              │
│        │            │                                                         │
│        │  chrome.tabs sendMessage       correlated WebSocket browser actions  │
│        ▼            ▼                                                         │
│  content script ──> page-reader.js (DOM + accessibility snapshot)             │
│               └──> page-actor.js  (click/type/scroll/wait/hover/select/etc.)  │
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

The bridge auto-loads Hermes's WebUI password from `~/.hermes/.hermes-webui.env`, so you usually don't need to configure anything. If Hermes's WebUI was updated while running, restart it first (`hermes restart` / relaunch the app) — otherwise `chat/start` can return a stale-runtime error.

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
- Tool activity appears as collapsible cards; Hermes lifecycle state appears in the composer status area.
- The toolbar **popup** is a quick chat + status surface.

## Endpoints (bridge)

| Method | Path           | Purpose                                                   |
|--------|----------------|-----------------------------------------------------------|
| POST   | `/agent`       | AG-UI agent endpoint (`Accept: text/event-stream`)        |
| GET    | `/healthz`     | Liveness + Hermes reachability + pending browser actions  |
| GET    | `/v1/models`   | Searchable configured Hermes model inventory              |
| WS     | `/ws`          | Correlated browser-tool handoff channel                   |
| POST   | `/tool-result` | Alternative result channel keyed by `requestId`           |

## Browser tools

The bridge recognizes Hermes browser/page/DOM tools and maps them onto the live tab. Generic tools such as `web_search` are intentionally **not** treated as DOM actions.

Supported browser-companion actions include:

- `browser_snapshot()` — fresh DOM/accessibility snapshot + interactive refs
- `browser_read(selector?)` / extract-text style calls — read page or element text/value
- `browser_grep(pattern)` — search visible page text / refs without dumping the whole page
- `browser_click(@e12 | e12 | selector | visible text)` — click a referenced element
- `browser_type(...)` / fill / set-value calls — enter text
- `browser_scroll(direction, amount)` — vertical or horizontal scroll
- `browser_hover(...)` — hover an element
- `browser_select_option(..., value)` — select a dropdown option
- `browser_press(key)` — keyboard input including modifier chords
- `browser_wait(ms | selector | text)` — fixed wait or mutation-driven wait for page content
- `browser_get_images()` — image metadata from the active page
- `browser_navigate(url)` — navigate the active tab to an HTTP(S) URL
- `browser_back()` / `browser_forward()` / `browser_reload()` — tab navigation controls

The control loop follows the useful **snapshot → act → verify** pattern used by strong agentic browsers. BrowserOS also inspired the emphasis on fewer, more purposeful browser calls and wait-for-condition behavior; because BrowserOS is AGPL-3.0, those concepts were reimplemented here rather than copying its source.

## Security notes

- **Local-only by default.** The bridge binds to `127.0.0.1`. The extension talks to it over HTTP/WS.
- **No secrets copied.** The bridge reads Hermes's password from its existing env file and never prints it. The extension stores only a bridge URL and optional auth token.
- **Navigation is restricted to HTTP(S).** `javascript:`, `data:`, browser-internal, and other non-web schemes are rejected by the service worker's native navigation path.
- **Generic web tools are not DOM tools.** The bridge only mirrors explicit browser/page/DOM tool namespaces, reducing accidental action routing.
- Disable **"Allow Hermes to interact with the page"** in options for read-only mode.

## Tests

GitHub Actions runs bridge, DOM, and JavaScript syntax checks on every push to `main` and on pull requests.

```bash
# Bridge AG-UI translation (self-contained; uses a fake Hermes; no live runtime)
cd bridge && npm install && npm test          # expect: 17 passed, 0 failed

# Page reader + actor against a real DOM fixture (jsdom)
cd test && npm install && npm test            # expect: 21 passed, 0 failed
```

The bridge test specifically checks that the current user message reaches Hermes, raw reasoning text is not leaked, context/metering events survive translation, and browser calls fail fast when no extension is attached.

## License

MIT. Portions adapt patterns from Hermes Agent and the AG-UI protocol; see their repositories for their MIT licenses. BrowserOS is reviewed only as an architectural reference and no BrowserOS source is included.