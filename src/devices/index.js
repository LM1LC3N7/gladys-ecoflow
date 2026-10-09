// -----------------------------------------------------------------------------
// Device discovery + the polling loop that keeps every Gladys-created
// device's state current — there is no persistent session to hold open (see
// src/devices/device.js's header), so "connection composition" here is just:
// know which transport (public REST or private MQTT) and serial number back
// each Gladys device, and re-poll it.
//
// Two independent device sources feed the same registry: the official
// account's own device list (EcoflowDeviceRegistry, auto-discovered) and the
// private/simple method's manually-entered serial numbers
// (buildPrivateDiscoveredDevices) — see src/config.js's header for the two
// methods. Both produce the exact same discovery payload shape, and
// reconcileConnections() below is what decides which transport backs an
// already-created device.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  METHOD,
  buildDiscoveredDevice,
  registerDevice,
  applyQuota,
  deviceSnOf,
  registeredDevices,
  recordPollSuccess,
  recordPollFailure,
} from './device.js';

const logger = createLogger({ name: 'discovery' });

/** Every EcoFlow device bound to the official (public API) account, refreshed on demand. */
export class EcoflowDeviceRegistry {
  constructor(transport) {
    this.transport = transport;
    this.known = new Map(); // sn -> { sn, name, online }
  }

  async refresh() {
    const devices = await this.transport.listDevices();
    this.known = new Map(devices.map((device) => [device.sn, device]));
    return this.values();
  }

  values() {
    return [...this.known.values()];
  }
}

export function buildDiscoveredDevices(gladys, registry) {
  return registry.values().map((device) => buildDiscoveredDevice(gladys, device));
}

/** Discovery payloads for the private/simple method's manually-entered serial numbers. */
export function buildPrivateDiscoveredDevices(gladys, privateDeviceSns) {
  return privateDeviceSns.map((sn) => buildDiscoveredDevice(gladys, { sn }));
}

/**
 * Which transport backs a given serial number: a serial number present in
 * `privateDeviceSns` is always treated as a private-method device, even if
 * it also happens to appear on the public account's device list.
 */
export function transportForSn(sn, { publicTransport, privateTransport, privateDeviceSns }) {
  return privateDeviceSns.includes(sn) ? privateTransport : publicTransport;
}

/** Which onboarding method backs a given serial number (same rule as transportForSn()). */
export function methodForSn(sn, { privateDeviceSns }) {
  return privateDeviceSns.includes(sn) ? METHOD.SIMPLE : METHOD.OFFICIAL;
}

/**
 * Register every device Gladys already created (from a previous run, before
 * this process's own onDeviceCreated ever fired) so onSetValue() and the poll
 * loop below know its EcoFlow serial number AND which transport backs it.
 * `onlineBySn` carries the official account's online flags, when known.
 */
export async function reconcileConnections(gladys, transports, { onlineBySn = new Map() } = {}) {
  const devices = await gladys.getDevices();
  for (const device of devices) {
    const sn = deviceSnOf(device);
    if (!sn) {
      continue;
    }
    const transport = transportForSn(sn, transports);
    if (transport) {
      const entry = registerDevice(device.external_id, sn, transport, {
        method: methodForSn(sn, transports),
      });
      entry.health.online = onlineBySn.get(sn);
    }
  }
}

/**
 * Poll every currently-registered device's quota once and publish the
 * values that changed — iterates the local registry (populated by
 * reconcileConnections() and onDeviceCreated), not gladys.getDevices()
 * again, so a poll tick costs one EcoFlow call per device and no round-trip
 * to the Gladys hub itself. Returns one result per device, used by
 * src/app.js for the transport badges, scene triggers and widget refresh.
 */
export async function pollOnce(gladys) {
  const results = [];
  for (const { externalId, entry } of registeredDevices()) {
    const previousQuota = entry.lastQuota;
    try {
      const quota = await entry.transport.getQuota(entry.sn);
      recordPollSuccess(entry);
      await applyQuota(gladys, { external_id: externalId }, quota);
      results.push({ externalId, entry, ok: true, previousQuota, quota });
    } catch (err) {
      recordPollFailure(entry, err);
      logger.error(`Quota poll failed for ${externalId} (${entry.sn}): ${err.message}`);
      results.push({ externalId, entry, ok: false, previousQuota, error: err });
    }
  }
  return results;
}
