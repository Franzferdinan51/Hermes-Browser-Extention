# Hermes Browser Extension Upstream Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring the target repository up to the finished upstream Hermes Browser Extension feature set while retaining the existing bridge as a compatibility path.

**Architecture:** Use the upstream MV3 extension as the canonical browser client and build it through the upstream scripts. Keep the target bridge directory intact for existing AG-UI users, but make the extension’s manifest, service worker, side panel, content runtime, connection flows, safety controls, and tests come from the upstream implementation.

**Tech Stack:** Chrome/Firefox MV3 WebExtensions, vanilla JavaScript ES modules, Node.js 20+, npm, ESLint, jsdom/linkedom, Python unittest helpers.

**Spec:** `../upstream/README.md` and `../upstream/package.json`.

## Global Constraints

- Preserve the existing `bridge/` directory and its local API compatibility path.
- Do not copy BrowserOS source; only port the upstream Hermes extension implementation and its documented assets/tests.
- Keep credentials, websocket tickets, and page content out of logs and committed files.
- Verify syntax, tests, manifest/build output, and Git remote equality before claiming completion.

### Task 1: Port upstream extension and project tooling

**Files:** Add/modify upstream project files under `extension/`, `scripts/`, `tests/`, `package.json`, `package-lock.json`, locales, assets, docs, and CI configuration; preserve `bridge/`.

- [ ] Copy the upstream tracked files into the target, excluding `.git/` and `bridge/`, while retaining target-only bridge files.
- [ ] Confirm the resulting manifest points to the upstream side panel/background/content runtime and preserves no target-only privileged permissions accidentally.
- [ ] Install dependencies from the resulting root lockfile.

### Task 2: Verify browser/runtime behavior

**Files:** Test only; no source changes unless verification identifies a concrete failure.

- [ ] Run `npm run verify` from the target root.
- [ ] Run the retained bridge self-test from `bridge/`.
- [ ] Run package/build checks and inspect `dist/manifest.json` for a loadable extension.

### Task 3: Publish to main

**Files:** Git history and remote `main` only.

- [ ] Review the complete diff and ensure no credentials or unrelated workspace files are included.
- [ ] Commit the port with a descriptive message.
- [ ] Push `HEAD` to `origin/main`.
- [ ] Fetch and verify local `HEAD` equals `origin/main`.
