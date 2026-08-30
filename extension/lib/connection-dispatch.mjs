import {
  CONNECTION_TRANSPORTS,
  migrateConnectionSettings,
} from './connection-modes.mjs';

export const CONNECTION_ACTIONS = Object.freeze({
  LOCAL_API_PAIR_OR_CONNECT: 'local-api-pair-or-connect',
  REMOTE_API_CONNECT: 'remote-api-connect',
  REMOTE_DASHBOARD_ATTACH: 'remote-dashboard-attach',
  CLOUD_ACTIVE_TAB_ATTACH: 'cloud-active-tab-attach',
});

export function connectionActionForSettings(input = {}) {
  const settings = migrateConnectionSettings(input);
  if (settings.connectionMode === 'cloud') return CONNECTION_ACTIONS.CLOUD_ACTIVE_TAB_ATTACH;
  if (settings.connectionMode === 'local') return CONNECTION_ACTIONS.LOCAL_API_PAIR_OR_CONNECT;
  if (settings.connectionTransport === CONNECTION_TRANSPORTS.REMOTE_API) {
    return CONNECTION_ACTIONS.REMOTE_API_CONNECT;
  }
  return CONNECTION_ACTIONS.REMOTE_DASHBOARD_ATTACH;
}
