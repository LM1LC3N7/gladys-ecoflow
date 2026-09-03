// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
// Same shape as the sibling integrations' own test-fixtures/fakeGladys.js —
// lets us test the pure "wiring" logic (discovery payloads, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const connectionStatuses = [];
  const discoveredDevices = [];

  return {
    published,
    connectionStatuses,
    discoveredDevices,

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

    async publishDiscoveredDevices(devices) {
      discoveredDevices.length = 0;
      discoveredDevices.push(...devices);
    },

    async getDevices() {
      return discoveredDevices;
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },
  };
}
