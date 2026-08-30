import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PANEL_RESIDENCY_MODE,
  PANEL_RESIDENCY_MODES,
  buildSidePanelPath,
  normalizePanelResidencyMode,
  parseSidePanelParams,
} from '../extension/lib/panel-residency.mjs';

test('normalizePanelResidencyMode defaults to tab-attached', () => {
  assert.equal(DEFAULT_PANEL_RESIDENCY_MODE, PANEL_RESIDENCY_MODES.TAB_ATTACHED);
  assert.equal(normalizePanelResidencyMode(), PANEL_RESIDENCY_MODES.TAB_ATTACHED);
  assert.equal(normalizePanelResidencyMode('tab-attached'), PANEL_RESIDENCY_MODES.TAB_ATTACHED);
  assert.equal(normalizePanelResidencyMode('global'), PANEL_RESIDENCY_MODES.GLOBAL);
  assert.equal(normalizePanelResidencyMode('bad'), PANEL_RESIDENCY_MODES.TAB_ATTACHED);
});

test('buildSidePanelPath includes tab id for tab-attached panels', () => {
  assert.equal(
    buildSidePanelPath({ mode: 'tab-attached', tabId: 42 }),
    'sidepanel.html?panel=tab&tabId=42',
  );
});

test('buildSidePanelPath returns global path for legacy panels', () => {
  assert.equal(buildSidePanelPath({ mode: 'global', tabId: 42 }), 'sidepanel.html?panel=global');
});

test('buildSidePanelPath preserves manifest side panel base paths for root loads', () => {
  assert.equal(
    buildSidePanelPath({ mode: 'tab-attached', tabId: 42, defaultPath: 'extension/sidepanel.html' }),
    'extension/sidepanel.html?panel=tab&tabId=42',
  );
  assert.equal(
    buildSidePanelPath({ mode: 'global', defaultPath: 'extension/sidepanel.html?old=1' }),
    'extension/sidepanel.html?panel=global',
  );
});

test('parseSidePanelParams recovers panel mode and tab id', () => {
  assert.deepEqual(parseSidePanelParams('?panel=tab&tabId=123'), {
    panelMode: PANEL_RESIDENCY_MODES.TAB_ATTACHED,
    tabId: 123,
  });
  assert.deepEqual(parseSidePanelParams('?panel=global'), {
    panelMode: PANEL_RESIDENCY_MODES.GLOBAL,
    tabId: null,
  });
});
