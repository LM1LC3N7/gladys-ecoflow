// -----------------------------------------------------------------------------
// Minimal stand-in for a `{ listDevices(), getQuota(sn), sendCommand(sn,
// moduleType, operateType, params) }` transport — the shape both
// createPublicTransport() (src/ecoflow/client.js) and
// createPrivateTransport() (src/ecoflow/privateClient.js) implement, plus
// the private transport's connect()/disconnect(), so this one fake
// exercises src/devices/, src/app.js and src/ecoflow/commands.js regardless
// of which real transport a device would actually use.
// -----------------------------------------------------------------------------

export function createFakeTransport({
  devices = [],
  quotaBySn = {},
  connectError,
  listError,
  quotaError,
} = {}) {
  const sentCommands = [];
  const calls = { listDevices: 0, getQuota: 0, connect: 0, disconnect: 0 };

  return {
    sentCommands,
    calls,
    quotaBySn,

    async listDevices() {
      calls.listDevices += 1;
      if (listError) {
        throw listError;
      }
      return devices;
    },

    async getQuota(sn) {
      calls.getQuota += 1;
      if (quotaError) {
        throw quotaError;
      }
      return quotaBySn[sn] ?? {};
    },

    async sendCommand(sn, moduleType, operateType, params) {
      sentCommands.push({ sn, moduleType, operateType, params });
    },

    async connect() {
      calls.connect += 1;
      if (connectError) {
        throw connectError;
      }
    },

    async disconnect() {
      calls.disconnect += 1;
    },
  };
}
