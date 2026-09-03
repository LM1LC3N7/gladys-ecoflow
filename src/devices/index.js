// -----------------------------------------------------------------------------
// Device discovery + the polling loop that keeps every Gladys-created
// device's state current — there is no persistent session to hold open (see
// src/devices/device.js's header), so "connection composition" here is just:
// know which EcoFlow serial number backs each Gladys device, and re-poll it.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { listDevices, getQuota } from '../ecoflow/client.js';
import {
  buildDiscoveredDevice,
  registerDevice,
  applyQuota,
  deviceSnOf,
  registeredDevices,
} from './device.js';

const logger = createLogger({ name: 'discovery' });

/** Every EcoFlow device bound to this account, refreshed on demand. */
export class EcoflowDeviceRegistry {
  constructor(client) {
    this.client = client;
    this.known = new Map(); // sn -> { sn, name, online }
  }

  async refresh() {
    const devices = await listDevices(this.client);
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

/**
 * (Re)register every device Gladys already created (from a previous run,
 * before this process's own onDeviceCreated ever fired) so onSetValue() and
 * the poll loop below know its EcoFlow serial number. Idempotent —
 * registerDevice() only fills in a registry entry that isn't there yet.
 */
export async function reconcileConnections(gladys) {
  const devices = await gladys.getDevices();
  for (const device of devices) {
    const sn = deviceSnOf(device);
    if (sn) {
      registerDevice(device.external_id, sn);
    }
  }
}

/**
 * Poll every currently-registered device's quota once and publish fresh
 * state — iterates the local registry (populated by reconcileConnections()
 * and onDeviceCreated), not gladys.getDevices() again, so a poll tick costs
 * one EcoFlow API call per device and no round-trip to the Gladys hub itself.
 */
export async function pollOnce(gladys, client) {
  for (const { externalId, sn } of registeredDevices()) {
    try {
      const quota = await getQuota(client, sn);
      applyQuota(gladys, { external_id: externalId }, quota);
    } catch (err) {
      logger.error(`Quota poll failed for ${externalId} (${sn}): ${err.message}`);
    }
  }
}
