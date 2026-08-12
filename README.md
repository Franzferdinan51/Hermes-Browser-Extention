# Hermes Browser Companion

A Chrome/Chromium side-panel companion for **Nous Research Hermes Agent**. It sends current-page context to Hermes over a local AG-UI bridge, streams the answer back into the browser, exposes Hermes tool activity, and can mirror a safe subset of Hermes browser actions into the active tab.

**Current release: 0.3.2**

Sources and design references:

- **Hermes Agent** — MIT — authoritative runtime/tool behavior
- **AG-UI** — MIT — agent ↔ UI event protocol
- **Hermes Browser Extension** (`abundantbeing/hermes-browser-extension`) — MIT — useful runtime-event, recovery, capability, and companion-plugin patterns
- **BrowserOS** (`browseros-ai/BrowserOS`) — AGPL-3.0 — architectural ideas only; **no BrowserOS source code is copied into this MIT project**

## What 0.3.2 adds

Independently implemented from the **public BrowserOS MCP catalog** (docs.browseros.com). BrowserOS is AGPL-3.0; **no BrowserOS source was copied**.

- Full **tab** control: list/create/close/switch/duplicate/pin/mute/move
- Full **window** control: list/create/close/focus/update
- Full **tab group** control: list/create/update/ungroup/close
- **Bookmarks**: list/search/create/update/remove
- **History**: search/recent/delete url or range
- **Downloads**: list plus start/cancel/show a URL
- **Cookies** for a chosen http(s) URL (current tab by default)
- **Page extract**: markdown, links, HTML, CSS/text DOM search
- **Console** capture and **dialog** accept/dismiss policy in the page
- **Zoom** get/set/reset
- Public catalog aliases such as `take_snapshot`, `new_page`, `get_page_content`, and `get_bookmarks` resolve to the same companion actions

## What 0.3.1 fixes

- Conversation threads now persist from `RUN_STARTED`, so later turns keep the same Hermes session and verified active-tab results.
- **New conversation** starts a new Hermes session instead of silently continuing the previous one.
- Tool cards open as soon as Hermes starts a tool, so companion results are not dropped when they arrive mid-stream.
- Object-shaped Hermes model entries keep a qualified `@provider:id` instead of being overwritten by the raw model id.
- Off-viewport controls are included in page snapshots, and `javascript:` navigation is rejected.
- Content scripts no longer inject page-reader/actor into the page’s main world (that caused CSP noise and leaked helpers onto `window`).
- Hermes login reads `Set-Cookie` via `getSetCookie()`, so a multi-cookie login response still yields `hermes_session`.

## What 0.3.0 adds

- **Hermes-native runtime inspector** — the side panel reads Hermes's real `/api/tools/toolsets` and `/api/skills` data through `GET /v1/runtime`. Expand **Hermes runtime** to see enabled toolsets, tool counts, configured/unconfigured status, enabled skills, provenance, and partial runtime errors.
- **Better agent responses** — streamed text is reconciled into a richer final response with headings, lists, blockquotes, code blocks, inline code, safe HTTP(S) links, and a copy button.
- **Real tool timeline** — multiple tool calls are tracked independently by `toolCallId`; tool arguments/results live in collapsible cards instead of one mutable global tool box.
- **Useful live status without hidden reasoning** — `Thinking…`, `Reasoning…`, `Using <tool>…`, context usage, and metering are surfaced as lifecycle metadata. Raw private reasoning text is not rendered.
- **Fixed critical prompt bug** — the current user message is now always included in the Hermes turn alongside page context/history.
- **Hermes refs work correctly** — both `e12` and native-style `@e12` references resolve against `data-hermes-ref` elements.
- **Correlated active-tab actions** — browser-action requests carry a unique `requestId` and `toolCallId`, so concurrent actions cannot consume one another's result.
- **No accidental `web_search` DOM execution** — only an explicit allowlist of compatible Hermes `browser_*` tools can be mirrored into the active tab.
- **More capable page actor** — robust click/type/key/scroll/read/grep/hover/select/wait/image/snapshot helpers plus BrowserOS-inspired `check`, `uncheck`, `clear`, multi-field `fill`, coordinate click/type/hover, drag, diff, read-only evaluate, tabs, windows, and native navigation helpers.
- **Reliable page context fallback** — if a content script is unavailable on a newly opened or restricted-compatible page, the service worker uses an `activeTab`-authorized inline snapshot fallback and still sends visible text, accessibility, and interactive refs to Hermes.
- **BrowserOS parity note** — the expanded action names and concepts are mapped from the public BrowserOS MCP catalog (`tabs`, `snapshot`, `act`, `read`, `grep`, `diff`, `wait`, `evaluate`, `windows`, etc.) without copying BrowserOS source; this extension remains independently implemented and MIT-licensed.
- **Bridge hardening** — loopback-only bind, extension-origin checks, optional HTTP + WebSocket token auth, HTTP(S)-only navigation, and constant-time token comparison.
- **CI** — bridge self-test, jsdom page-actor tests, and syntax checks on push/PR, plus manual `workflow_dispatch`.

## Architecture

```text
┌──────────────────────── Chrome Extension (MV3) ────────────────────────┐
│ side panel / popup / options                                           │
│              │                                                         │
│       background service worker                                        │
│        │          │                    │                                │
│        │          │                    └── GET /v1/runtime              │
│        │          └── AG-UI POST /agent                                │
│        │                                                               │
│        └── active-tab content scripts                                  │
│             ├── page-reader.js  → DOM/accessibility snapshot           │
│             └── page-actor.js   → compatible mirrored actions          │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ HTTP/SSE + authenticated WS
                               ▼
                    ┌────────────────────────┐
                    │ bridge/server.mjs      │
                    │ AG-UI ↔ Hermes adapter │
                    └────────────┬───────────┘
                                 │ authenticated Hermes WebUI API
                                 ▼
                           Hermes Agent
```

The extension does **not** replace Hermes's own tool runtime. Hermes remains the source of truth for tool execution. The active-tab bridge mirrors only the core browser calls it can faithfully represent in the user's current tab.

## Quick start

### 1. Start Hermes and the bridge

```bash
cd bridge
npm install
npm start
```

The bridge listens on `http://127.0.0.1:8965` and auto-loads Hermes's WebUI password from `~/.hermes/.hermes-webui.env` when available.

Optional hardening:

```bash
BRIDGE_AUTH_TOKEN="use-a-long-random-local-token" npm start
```

If you set `BRIDGE_AUTH_TOKEN`, paste the same value into the extension's **Bridge auth token** setting. It protects both HTTP and WebSocket bridge traffic. Do **not** reuse an OpenAI/Nous/provider API key as this token.

### 2. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `extension/` directory.
5. Pin the Hermes icon if desired.

### 3. Open the side panel

Click the Hermes extension icon. The panel will:

- discover configured Hermes models,
- load the real Hermes toolset/skill inventory,
- attach a fresh page snapshot when **attach page** is enabled,
- stream Hermes text/tool activity,
- show connection/runtime state,
- mirror compatible browser actions into the active tab when page acting is enabled.

## Hermes runtime inspector

`GET /v1/runtime` is intentionally **read-only**. It proxies Hermes's own runtime metadata instead of keeping a second hard-coded capability list.

The panel shows:

- enabled toolsets,
- number of tools in each enabled toolset,
- whether a toolset still needs configuration,
- enabled skills,
- skill provenance/usage where Hermes reports it,
- partial errors if an older Hermes build lacks one of the metadata routes.

This is fail-soft: chat/model use can continue even if toolset or skill metadata is unavailable.

## Hermes browser tools

The bridge prompt is aligned to Hermes's current **core browser toolset**:

```text
browser_navigate
browser_snapshot
browser_click
browser_type
browser_scroll
browser_back
browser_press
browser_get_images
browser_console
browser_vision
```

The extension mirrors this compatible subset into the active tab:

```text
browser_navigate
browser_snapshot
browser_click
browser_type
browser_scroll
browser_back
browser_press
browser_get_images
```

`browser_vision` stays Hermes-native. The companion now implements a page-side `browser_console` hook (recent `console.*` and error events) instead of pretending to be Hermes's own console backend.

The page actor also contains local compatibility helpers such as read/grep/hover/select/wait/forward/reload plus page extract. Those helpers support extension internals and catalog-inspired tooling.

Generic web tools such as `web_search` and `web_extract` are never treated as active-tab DOM commands.

## BrowserOS ideas incorporated

BrowserOS has several strong browser-agent patterns. Because BrowserOS is AGPL-3.0, the project only uses the **ideas**, reimplemented independently:

- favor fewer, purposeful browser actions,
- stable element references,
- bounded tool outputs,
- wait-for-condition behavior instead of arbitrary sleeps where possible,
- explicit page/action ownership,
- action lifecycle + result correlation,
- snapshot → act → verify as the mental model,
- a compact chrome-control catalog (tabs, windows, groups, bookmarks, history, downloads, cookies, extract).

No BrowserOS source file was cherry-picked or copied. Hidden/background pages, print-to-PDF, and BrowserOS's 40+ app integrations stay out of this MIT extension.

## Bridge endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/agent` | AG-UI SSE agent endpoint |
| `GET` | `/healthz` | bridge/Hermes health, WS clients, pending actions |
| `GET` | `/v1/models` | configured Hermes model inventory |
| `GET` | `/v1/runtime` | Hermes-native toolset + skill inventory |
| `WS` | `/ws` | correlated active-tab action handoff |
| `POST` | `/tool-result` | alternate correlated action-result channel |

## Security model

- The bridge binds to **`127.0.0.1` only**.
- Browser-origin HTTP/WS traffic is accepted only from extension origins; requests with an unrelated web origin are rejected.
- `BRIDGE_AUTH_TOKEN` can protect every bridge HTTP route and the WS upgrade.
- The extension sends its token in the HTTP `Authorization` header and the browser WS handshake query because browser `WebSocket` cannot set an Authorization header.
- Hermes's WebUI password is used by the local bridge only and is never sent to the extension UI.
- Active-tab native navigation accepts `http:` and `https:` URLs only.
- `web_search`/other generic tools cannot fall through into DOM execution.
- Disable **Allow Hermes to interact with the page** for read-only page context.

## Tests

Bridge test:

```bash
cd bridge
npm ci
npm test
# expected contract: 31 passed, 0 failed
```

The fake-Hermes test covers bridge auth, hostile-origin rejection, model discovery, toolset/skill discovery, AG-UI events, raw-reasoning suppression, browser-vs-web tool routing, prompt/user-turn preservation, and the current Hermes browser-tool contract.

Page reader/actor test:

```bash
cd test
npm ci
npm test
# expected contract: 34 passed, 0 failed
```

GitHub Actions runs both suites plus `node --check` over the extension modules. The workflow also supports a manual run from the Actions tab.

## Important current limitation

The active-tab WebSocket path is a **mirror/companion surface**, not a replacement for Hermes's internal browser backend. A deeper native integration should use a Hermes companion plugin with owner-scoped Browser Context Protocol data so Hermes can request current-tab context as a first-class tool. That integration is being kept separate until the BCP/session ownership contract can be wired correctly rather than shipping a fake or unsafe implementation.

## License

MIT. Hermes/AG-UI-derived patterns retain their respective MIT lineage. BrowserOS is referenced only for architecture/UX ideas; no AGPL BrowserOS source is included.