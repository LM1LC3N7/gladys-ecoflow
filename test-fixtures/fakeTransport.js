// -----------------------------------------------------------------------------
// Minimal stand-in for a `{ listDevices(), getQuota(sn), sendCommand(sn,
// moduleType, operateType, params) }` transport — the shape both
// createPublicTransport() (src/ecoflow/client.js) and
// createPrivateTransport() (src/ecoflow/privateClient.js) implement, so this
// one fake exercises src/devices/ and src/ecoflow/commands.js regardless of
// which real transport a device would actually use.
// -----------------------------------------------------------------------------

export function createFakeTransport({ devices = [], quotaBySn = {} } = {}) {
  const sentCommands = [];

  return {
    sentCommands,

    async listDevices() {
      return devices;
    },

    async getQuota(sn) {
      return quotaBySn[sn] ?? {};
    },

    async sendCommand(sn, moduleType, operateType, params) {
      sentCommands.push({ sn, moduleType, operateType, params });
    },
  };
}
