// -----------------------------------------------------------------------------
// Minimal stand-in for @ecoflow-api/rest-client's RestClient, for unit tests.
// Reproduces only the three methods src/ecoflow/client.js calls
// (getDevicesPlain, getDevicePropertiesPlain, setCommandPlain) — lets us test
// this integration's own logic without a real EcoFlow account or network
// access, and without mocking the library's internals.
// -----------------------------------------------------------------------------

export function createFakeEcoflowClient({ devices = [], quotaBySn = {} } = {}) {
  const sentCommands = [];

  return {
    sentCommands,

    async getDevicesPlain() {
      return { code: '0', message: 'Success', data: devices };
    },

    async getDevicePropertiesPlain(sn) {
      return { code: '0', message: 'Success', data: quotaBySn[sn] ?? {} };
    },

    async setCommandPlain(payload) {
      sentCommands.push(payload);
      return { code: '0', message: 'Success', eagleEyeTraceId: 'test', tid: 'test' };
    },
  };
}
