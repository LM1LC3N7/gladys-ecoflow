// -----------------------------------------------------------------------------
// Device type: EcoFlow River 2 (family) portable power station.
//
// Unlike a local-network device, there is no persistent session to hold open
// here — every read is a REST poll and every write is a REST PUT (see
// src/ecoflow/client.js). This module owns:
//   - buildDiscoveredDevice() — the discovery payload for one EcoFlow-account
//     device;
//   - a small registry of `external_id -> { sn, lastQuota }`, kept current by
//     src/devices/index.js's poll loop (applyQuota()) and used here to fill
//     in the fields EcoFlow's `acOutCfg` command requires alongside whichever
//     one the user actually toggled (see onSetValue());
//   - onSetValue() / runTestConnectionAction().
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  FEATURE,
  featureExternalId,
  buildFeatures,
  extractFeatureValues,
} from '../ecoflow/quota.js';
import { getQuota, setAcOutput, setDcOutput, setBackupReserve } from '../ecoflow/client.js';

export const DEVICE_TYPE = 'ecoflow_power_station';

const logger = createLogger({ name: DEVICE_TYPE });

// external_id -> { sn, lastQuota: object }
const connections = new Map();

export function deviceSnOf(device) {
  return (device.params ?? []).find((p) => p.name === 'ECOFLOW_SN')?.value;
}

/** Build the discovery payload for one device known through the EcoFlow account. */
export function buildDiscoveredDevice(gladys, { sn, name }) {
  const ids = gladys.externalIds(DEVICE_TYPE, sn);
  return {
    name: name || `EcoFlow (${sn})`,
    external_id: ids.device,
    params: [{ name: 'ECOFLOW_SN', value: sn }],
    features: buildFeatures(ids.device),
  };
}

/** Register (or reuse) the registry entry for one Gladys-created device. */
export function registerDevice(externalId, sn) {
  if (!connections.has(externalId)) {
    connections.set(externalId, { sn, lastQuota: {} });
  }
  return connections.get(externalId);
}

export function unregisterDevice(externalId) {
  connections.delete(externalId);
}

export function registeredDevices() {
  return [...connections.entries()].map(([externalId, entry]) => ({ externalId, ...entry }));
}

/** Publish a fresh quota snapshot for one device, and cache it for onSetValue()/test_connection. */
export function applyQuota(gladys, device, quota) {
  const entry = connections.get(device.external_id);
  if (entry) {
    entry.lastQuota = quota;
  }
  const values = extractFeatureValues(quota);
  for (const [key, value] of Object.entries(values)) {
    const id = featureExternalId(device.external_id, key);
    gladys
      .publishState(id, value)
      .catch((err) => logger.error(`publishState failed for ${id}: ${err.message}`));
  }
}

/**
 * AC output enable/X-Boost travel together in EcoFlow's `acOutCfg` command
 * (see src/ecoflow/client.js#setAcOutput) — this fills in the two fields the
 * caller isn't setting from the device's last-known quota, falling back to a
 * safe default (AC off, 50Hz — EcoFlow's `out_freq` is a region code, 1=50Hz
 * 2=60Hz, not a literal frequency) before the first quota poll has completed.
 */
function acOutCfgParams(quota, overrides) {
  return {
    enabled: quota['mppt.cfgAcEnabled'] ?? 0,
    xboost: quota['mppt.cfgAcXboost'] ?? 0,
    outVoltage: quota['mppt.cfgAcOutVol'] ?? 0,
    outFreq: quota['mppt.cfgAcOutFreq'] ?? 1,
    ...overrides,
  };
}

/** Dispatch a user command (`onSetValue`) to the right EcoFlow API call. */
export async function onSetValue(gladys, client, { device, feature, value }) {
  const entry = connections.get(device.external_id);
  if (!entry) {
    throw new Error(`${device.external_id} is not known`);
  }

  const key = feature.external_id.slice(device.external_id.length + 1);
  const quota = entry.lastQuota;
  const enabled = value ? 1 : 0;

  if (key === FEATURE.AC_OUTPUT_ENABLED) {
    await setAcOutput(client, entry.sn, acOutCfgParams(quota, { enabled }));
  } else if (key === FEATURE.XBOOST_ENABLED) {
    await setAcOutput(client, entry.sn, acOutCfgParams(quota, { xboost: enabled }));
  } else if (key === FEATURE.DC_OUTPUT_ENABLED) {
    await setDcOutput(client, entry.sn, enabled);
  } else if (key === FEATURE.BACKUP_RESERVE_ENABLED) {
    await setBackupReserve(client, entry.sn, {
      isConfig: enabled,
      bpPowerSoc: quota['pd.bpPowerSoc'] ?? 50,
    });
  } else {
    throw new Error(`Feature "${key}" is not controllable`);
  }
}

/** `test_connection` manifest action: re-poll this device's quota right now. */
export async function runTestConnectionAction(gladys, client, { fields }) {
  const entry = connections.get(fields.device);
  if (!entry) {
    return {
      en: 'This device is not known yet. Run a Discovery scan first.',
      fr: "Cet appareil n'est pas encore connu. Lancez d'abord une découverte.",
    };
  }

  try {
    const quota = await getQuota(client, entry.sn);
    entry.lastQuota = quota;
    const soc = quota['pd.soc'];
    const acOut = quota['inv.outputWatts'];
    return {
      en: `Reached the EcoFlow Cloud API for ${entry.sn}. Battery: ${soc ?? '?'}%, AC output: ${acOut ?? '?'}W.`,
      fr: `API Cloud EcoFlow jointe pour ${entry.sn}. Batterie : ${soc ?? '?'}%, sortie AC : ${acOut ?? '?'}W.`,
    };
  } catch (err) {
    return {
      en: `Could not reach the EcoFlow Cloud API for ${entry.sn}: ${err.message}`,
      fr: `Impossible de joindre l'API Cloud EcoFlow pour ${entry.sn} : ${err.message}`,
    };
  }
}

/** Test-only hook: inject a registry entry directly. Not used by production code. */
export function __setConnectionForTesting(externalId, entry) {
  connections.set(externalId, entry);
}

/** Test-only hook: drop every registered device between tests. */
export function __clearConnectionsForTesting() {
  connections.clear();
}
