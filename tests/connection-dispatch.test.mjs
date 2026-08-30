import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONNECTION_ACTIONS,
  connectionActionForSettings,
} from '../extension/lib/connection-dispatch.mjs';
import { CONNECTION_TRANSPORTS } from '../extension/lib/connection-modes.mjs';

test('Cloud always dispatches to active-tab ticket attach, never Local API', () => {
  assert.equal(connectionActionForSettings({
    connectionSchemaVersion: 1,
    connectionMode: 'cloud',
    connectionTransport: CONNECTION_TRANSPORTS.CLOUD_TICKET_WS,
    gatewayUrl: 'http://127.0.0.1:8642',
    apiKey: 'legacy-key-that-must-be-ignored',
  }), CONNECTION_ACTIONS.CLOUD_ACTIVE_TAB_ATTACH);
});

test('Local and both Remote transports remain explicit', () => {
  assert.equal(connectionActionForSettings({ connectionMode: 'local' }), CONNECTION_ACTIONS.LOCAL_API_PAIR_OR_CONNECT);
  assert.equal(connectionActionForSettings({
    connectionSchemaVersion: 1,
    connectionMode: 'remote',
    connectionTransport: CONNECTION_TRANSPORTS.REMOTE_API,
  }), CONNECTION_ACTIONS.REMOTE_API_CONNECT);
  assert.equal(connectionActionForSettings({
    connectionSchemaVersion: 1,
    connectionMode: 'remote',
    connectionTransport: CONNECTION_TRANSPORTS.REMOTE_DASHBOARD,
  }), CONNECTION_ACTIONS.REMOTE_DASHBOARD_ATTACH);
});
