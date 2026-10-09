// -----------------------------------------------------------------------------
// Device type: EcoFlow River 2 (family) portable power station.
//
// Unlike a local-network device, there is no persistent session to hold open
// here — every read/write goes through whichever transport backs this
// device: the official REST API (src/ecoflow/client.js) or the simple
// email/password + MQTT path (src/ecoflow/privateClient.js). Both expose the
// same `{ getQuota(sn), sendCommand(sn, moduleType, operateType, params) }`
// shape, so this module never branches on which one it's talking to — the
// registry just carries the right transport alongside each device's `sn`.
//
// This module owns:
//   - buildDiscoveredDevice() — the discovery payload for one device;
//   - the registry `external_id -> { sn, transport, method, lastQuota,
//     published, health }`, rebuilt by src/app.js on every configuration
//     change (registerDevice() replaces an entry whose transport changed);
//   - state publishing: batched (publishStates) and deduplicated, as the
//     host API rate-limits states to 300 per minute per integration;
//   - the per-device transport badge (transportEntryFor());
//   - onSetValue() / runTestConnectionAction() / runDiagnosticsAction().
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import {
  FEATURE,
  featureExternalId,
  buildFeatures,
  extractFeatureValues,
} from '../ecoflow/quota.js';
import { setAcOutput, setDcOutput, setBackupReserve } from '../ecoflow/commands.js';

export const DEVICE_TYPE = 'ecoflow_power_station';

/** Which onboarding method backs a device (see src/config.js). */
export const METHOD = { OFFICIAL: 'official', SIMPLE: 'simple' };

// Consecutive failed refreshes after which a device is shown as unreachable
// (fewer than that: "cloud, degraded" — one lost poll is not an outage).
export const UNREACHABLE_AFTER_FAILURES = 3;

const MAX_STATES_PER_REQUEST = 100;
const MAX_TRANSPORT_MESSAGE_LENGTH = 200;
const MAX_DIAGNOSTICS_LENGTH = 1500;

const logger = createLogger({ name: DEVICE_TYPE });

// external_id -> entry, see createEntry()
const connections = new Map();

function createEntry(sn, transport, method) {
  return {
    sn,
    transport,
    method,
    lastQuota: {},
    // feature external_id -> last value actually sent to Gladys (dedupe)
    published: new Map(),
    // `online` comes from the official device list (undefined = not reported)
    health: { failures: 0, lastError: undefined, online: undefined },
    // last transport badge published, to only re-publish on change
    lastTransportKey: undefined,
  };
}

export function deviceSnOf(device) {
  return (device.params ?? []).find((p) => p.name === 'ECOFLOW_SN')?.value;
}

/** Build the discovery payload for one device known through either onboarding method. */
export function buildDiscoveredDevice(gladys, { sn, name }) {
  const ids = gladys.externalIds(DEVICE_TYPE, sn);
  return {
    name: name || `EcoFlow (${sn})`,
    external_id: ids.device,
    params: [{ name: 'ECOFLOW_SN', value: sn }],
    features: buildFeatures(ids.device),
  };
}

/**
 * Register one Gladys-created device. An existing entry is kept (with its
 * cached quota and dedupe state) only when it is backed by the very same
 * transport and serial number — anything else (new credentials, another
 * region, the serial number moved to the other method) replaces it.
 */
export function registerDevice(externalId, sn, transport, { method = METHOD.OFFICIAL } = {}) {
  const existing = connections.get(externalId);
  if (existing && existing.transport === transport && existing.sn === sn) {
    existing.method = method;
    return existing;
  }
  const entry = createEntry(sn, transport, method);
  connections.set(externalId, entry);
  return entry;
}

export function unregisterDevice(externalId) {
  connections.delete(externalId);
}

/** Forget every registered device (configuration changed, or no method configured anymore). */
export function clearRegisteredDevices() {
  connections.clear();
}

export function getRegisteredDevice(externalId) {
  return connections.get(externalId);
}

/** Every registered device as `{ externalId, entry }` (the live entry, not a copy). */
export function registeredDevices() {
  return [...connections.entries()].map(([externalId, entry]) => ({ externalId, entry }));
}

/**
 * Forget what was already published (states and transport badges), so the
 * next poll re-sends everything — called when the Gladys connection comes
 * back, as states published while it was down were lost.
 */
export function resetPublishedCache() {
  for (const entry of connections.values()) {
    entry.published.clear();
    entry.lastTransportKey = undefined;
  }
}

/** Send states to Gladys in batches of at most 100 (host API limit). */
export async function publishStatesInBatches(gladys, states) {
  for (let i = 0; i < states.length; i += MAX_STATES_PER_REQUEST) {
    await gladys.publishStates(states.slice(i, i + MAX_STATES_PER_REQUEST));
  }
}

/**
 * Publish the values of one quota snapshot that changed since the last
 * publish, and cache the snapshot for onSetValue()/the widget/the triggers.
 * A publish failure is logged and forgotten from the dedupe cache, so the
 * value is retried on the next poll.
 */
export async function applyQuota(gladys, device, quota) {
  const entry = connections.get(device.external_id);
  if (entry) {
    entry.lastQuota = quota;
  }
  const states = [];
  for (const [key, value] of Object.entries(extractFeatureValues(quota))) {
    const id = featureExternalId(device.external_id, key);
    if (entry?.published.get(id) === value) {
      continue;
    }
    entry?.published.set(id, value);
    states.push({ device_feature_external_id: id, state: value });
  }
  if (states.length === 0) {
    return;
  }
  try {
    await publishStatesInBatches(gladys, states);
  } catch (err) {
    logger.error(`publishStates failed for ${device.external_id}: ${err.message}`);
    for (const { device_feature_external_id: id } of states) {
      entry?.published.delete(id);
    }
  }
}

/** Record the outcome of one refresh in the device health (drives the transport badge). */
export function recordPollSuccess(entry) {
  entry.health.failures = 0;
  entry.health.lastError = undefined;
}

export function recordPollFailure(entry, err) {
  entry.health.failures += 1;
  entry.health.lastError = err.message;
}

/** Whether the device currently answers (not offline in the cloud, not failing repeatedly). */
export function isReachable(entry) {
  return entry.health.online !== false && entry.health.failures < UNREACHABLE_AFTER_FAILURES;
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function message(en, fr) {
  return {
    en: truncate(en, MAX_TRANSPORT_MESSAGE_LENGTH),
    fr: truncate(fr, MAX_TRANSPORT_MESSAGE_LENGTH),
  };
}

/**
 * The transport badge entry for one device (publishTransports): EcoFlow is
 * cloud-only, so the nominal state is `cloud`; `unreachable` when the
 * official account reports the unit offline or it stopped answering;
 * `cloud` + `degraded` after a failed refresh that is not (yet) an outage.
 */
export function transportEntryFor(externalId, entry) {
  const { online, failures, lastError } = entry.health;
  if (online === false) {
    return {
      external_id: externalId,
      transport: DEVICE_TRANSPORTS.UNREACHABLE,
      message: message(
        'The EcoFlow cloud reports this unit offline (switched off or no Wi-Fi).',
        'Le cloud EcoFlow signale cet appareil hors ligne (éteint ou sans Wi-Fi).',
      ),
    };
  }
  if (failures >= UNREACHABLE_AFTER_FAILURES) {
    return {
      external_id: externalId,
      transport: DEVICE_TRANSPORTS.UNREACHABLE,
      message: message(
        `No answer for ${failures} refreshes: ${lastError}`,
        `Aucune réponse depuis ${failures} rafraîchissements : ${lastError}`,
      ),
    };
  }
  if (failures > 0) {
    return {
      external_id: externalId,
      transport: DEVICE_TRANSPORTS.CLOUD,
      degraded: true,
      message: message(
        `Last refresh failed: ${lastError}`,
        `Dernier rafraîchissement en échec : ${lastError}`,
      ),
    };
  }
  return { external_id: externalId, transport: DEVICE_TRANSPORTS.CLOUD };
}

/**
 * Publish the transport badge of every registered device whose badge
 * changed since the last publish. Best effort: a failure is logged and
 * retried on the next call.
 */
export async function publishTransportBadges(gladys) {
  const changed = [];
  for (const [externalId, entry] of connections.entries()) {
    const badge = transportEntryFor(externalId, entry);
    const key = JSON.stringify(badge);
    if (key !== entry.lastTransportKey) {
      changed.push({ entry, badge, key });
    }
  }
  if (changed.length === 0) {
    return;
  }
  try {
    for (let i = 0; i < changed.length; i += MAX_STATES_PER_REQUEST) {
      await gladys.publishTransports(
        changed.slice(i, i + MAX_STATES_PER_REQUEST).map(({ badge }) => badge),
      );
    }
    for (const { entry, key } of changed) {
      entry.lastTransportKey = key;
    }
  } catch (err) {
    logger.warn(`publishTransports failed: ${err.message}`);
  }
}

/** Fetch a fresh quota for one device right now, and cache it. */
export async function refreshQuota(entry) {
  const quota = await entry.transport.getQuota(entry.sn);
  entry.lastQuota = quota;
  return quota;
}

function hasKeys(quota, keys) {
  return keys.every((key) => quota[key] !== undefined && quota[key] !== null);
}

/**
 * The last-known quota, re-fetched first when it lacks one of `keys`: a
 * command that must echo the current value of other settings (acOutCfg,
 * watthConfig) is never sent with a made-up default.
 */
async function quotaWith(entry, keys) {
  if (hasKeys(entry.lastQuota, keys)) {
    return entry.lastQuota;
  }
  const quota = await refreshQuota(entry);
  if (!hasKeys(quota, keys)) {
    throw new Error(
      `${entry.sn} has not reported ${keys.join(', ')} yet — command not sent, try again in a few seconds`,
    );
  }
  return quota;
}

const AC_OUT_CFG_KEYS = [
  'mppt.cfgAcEnabled',
  'mppt.cfgAcXboost',
  'mppt.cfgAcOutVol',
  'mppt.cfgAcOutFreq',
];

/**
 * AC output enable/X-Boost travel together in EcoFlow's `acOutCfg` command
 * (see src/ecoflow/commands.js#setAcOutput) with the output voltage and
 * frequency, which must echo the device's own last-reported values
 * (`out_freq` is a region code, 1=50Hz 2=60Hz, not a literal frequency).
 */
function acOutCfgParams(quota, overrides) {
  return {
    enabled: quota['mppt.cfgAcEnabled'],
    xboost: quota['mppt.cfgAcXboost'],
    outVoltage: quota['mppt.cfgAcOutVol'],
    outFreq: quota['mppt.cfgAcOutFreq'],
    ...overrides,
  };
}

/** Dispatch a user command (`onSetValue`) to the device's own transport. */
export async function onSetValue(gladys, { device, feature, value }) {
  const entry = connections.get(device.external_id);
  if (!entry) {
    throw new Error(`${device.external_id} is not known`);
  }

  const key = feature.external_id.slice(device.external_id.length + 1);
  const enabled = value ? 1 : 0;

  if (key === FEATURE.AC_OUTPUT_ENABLED) {
    const quota = await quotaWith(entry, AC_OUT_CFG_KEYS);
    await setAcOutput(entry.transport, entry.sn, acOutCfgParams(quota, { enabled }));
    entry.lastQuota = { ...entry.lastQuota, 'mppt.cfgAcEnabled': enabled };
  } else if (key === FEATURE.XBOOST_ENABLED) {
    const quota = await quotaWith(entry, AC_OUT_CFG_KEYS);
    await setAcOutput(entry.transport, entry.sn, acOutCfgParams(quota, { xboost: enabled }));
    entry.lastQuota = { ...entry.lastQuota, 'mppt.cfgAcXboost': enabled };
  } else if (key === FEATURE.DC_OUTPUT_ENABLED) {
    await setDcOutput(entry.transport, entry.sn, enabled);
    entry.lastQuota = { ...entry.lastQuota, 'pd.carState': enabled };
  } else if (key === FEATURE.BACKUP_RESERVE_ENABLED) {
    const quota = await quotaWith(entry, ['pd.bpPowerSoc']);
    await setBackupReserve(entry.transport, entry.sn, {
      isConfig: enabled,
      bpPowerSoc: quota['pd.bpPowerSoc'],
    });
    entry.lastQuota = { ...entry.lastQuota, 'pd.watchIsConfig': enabled };
  } else {
    throw new Error(`Feature "${key}" is not controllable`);
  }

  // Reflect the accepted command right away instead of waiting for the next
  // poll (the switch would otherwise bounce back in the UI); the follow-up
  // re-poll scheduled by src/app.js confirms or corrects it.
  entry.published.set(feature.external_id, enabled);
  await gladys
    .publishStates([{ device_feature_external_id: feature.external_id, state: enabled }])
    .catch((err) => logger.warn(`Optimistic state publish failed: ${err.message}`));
}

/** `test_connection` manifest action: re-poll this device's quota right now. */
export async function runTestConnectionAction(gladys, { fields }) {
  const entry = connections.get(fields.device);
  if (!entry) {
    return {
      en: 'This device is not known yet. Run a Discovery scan first.',
      fr: "Cet appareil n'est pas encore connu. Lancez d'abord une découverte.",
    };
  }

  try {
    const quota = await refreshQuota(entry);
    recordPollSuccess(entry);
    await applyQuota(gladys, { external_id: fields.device }, quota);
    const soc = quota['pd.soc'];
    const acOut = quota['inv.outputWatts'];
    return {
      en: `Reached ${entry.sn}. Battery: ${soc ?? '?'}%, AC output: ${acOut ?? '?'}W.`,
      fr: `${entry.sn} joint. Batterie : ${soc ?? '?'}%, sortie AC : ${acOut ?? '?'}W.`,
    };
  } catch (err) {
    recordPollFailure(entry, err);
    return {
      en: `Could not reach ${entry.sn}: ${err.message}`,
      fr: `Impossible de joindre ${entry.sn} : ${err.message}`,
    };
  }
}

const REDACTED_KEY = /(^|\.)(sn|serial\w*|mac\w*|ssid|wifi\w*|ip\w*)$/i;

/**
 * Every quota key the device reports, as `key=value` lines with identifying
 * values (serial number, Wi-Fi, MAC, IP) redacted — what a user pastes into
 * a bug report to confirm the fields of a model or firmware.
 */
export function formatDiagnostics(quota) {
  return Object.keys(quota)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => {
      const raw = quota[key];
      const value = REDACTED_KEY.test(key)
        ? '<redacted>'
        : typeof raw === 'object' && raw !== null
          ? JSON.stringify(raw)
          : String(raw);
      return `${key}=${value}`;
    });
}

/** `diagnostics` manifest action: report the raw telemetry keys of one device. */
export async function runDiagnosticsAction(gladys, { fields }) {
  const entry = connections.get(fields.device);
  if (!entry) {
    return {
      en: 'This device is not known yet. Run a Discovery scan first.',
      fr: "Cet appareil n'est pas encore connu. Lancez d'abord une découverte.",
    };
  }
  const quota = await refreshQuota(entry);
  const lines = formatDiagnostics(quota);
  logger.info(`Diagnostics for ${fields.device} (${entry.method}):\n${lines.join('\n')}`);
  const body = truncate(lines.join(' | '), MAX_DIAGNOSTICS_LENGTH);
  return {
    en: `${lines.length} keys reported (full list in the integration logs): ${body}`,
    fr: `${lines.length} clés remontées (liste complète dans les logs de l'intégration) : ${body}`,
  };
}

/** Test-only hook: inject a registry entry directly. Not used by production code. */
export function __setConnectionForTesting(externalId, entry) {
  connections.set(externalId, { ...createEntry(entry.sn, entry.transport), ...entry });
}

/** Test-only hook: drop every registered device between tests. */
export function __clearConnectionsForTesting() {
  connections.clear();
}
