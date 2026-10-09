// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
// Records everything the integration publishes, and keeps every registered
// handler so a test can play Gladys' side (`gladys.handlers.setValue(...)`,
// `gladys.emit('connected')`...) without a running Gladys server.
// -----------------------------------------------------------------------------

export function createFakeGladys({ config = {}, devices = [] } = {}) {
  const published = [];
  const connectionStatuses = [];
  const discoveredDevices = [];
  const transports = [];
  const sceneEvents = [];
  const widgetRefreshes = [];
  const handlers = {
    actions: {},
    sceneActions: {},
    widgetGet: {},
    widgetAction: {},
    events: {},
  };

  return {
    published,
    connectionStatuses,
    discoveredDevices,
    transports,
    sceneEvents,
    widgetRefreshes,
    handlers,
    devices: [...devices],
    config,

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const { device_feature_external_id: featureExternalId, state } of states) {
        published.push({ featureExternalId, state });
      }
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async publishSceneEvent(key, data) {
      sceneEvents.push({ key, data });
    },

    requestWidgetRefresh(key) {
      widgetRefreshes.push(key);
    },

    async publishDiscoveredDevices(list) {
      discoveredDevices.length = 0;
      discoveredDevices.push(...list);
    },

    async getDevices() {
      return this.devices.length > 0 ? this.devices : discoveredDevices;
    },

    async getConfig() {
      return this.config;
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    onScanRequest(cb) {
      handlers.scanRequest = cb;
    },
    onSetValue(cb) {
      handlers.setValue = cb;
    },
    onAction(key, cb) {
      handlers.actions[key] = cb;
    },
    onSceneAction(key, cb) {
      handlers.sceneActions[key] = cb;
    },
    onWidgetGet(key, cb) {
      handlers.widgetGet[key] = cb;
    },
    onWidgetAction(key, cb) {
      handlers.widgetAction[key] = cb;
    },
    onDeviceCreated(cb) {
      handlers.deviceCreated = cb;
    },
    onDeviceDeleted(cb) {
      handlers.deviceDeleted = cb;
    },
    onConfigUpdated(cb) {
      handlers.configUpdated = cb;
    },
    on(event, cb) {
      handlers.events[event] = cb;
    },
    async emit(event) {
      await handlers.events[event]?.();
    },
  };
}
