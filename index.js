// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration for EcoFlow power stations
// (River 2 family). Wires the SDK to src/ecoflow/ (the REST API client) and
// src/devices/ (discovery + the device registry) — holds no EcoFlow protocol
// knowledge itself.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, isConfigured } from './src/config.js';
import { createEcoflowClient } from './src/ecoflow/client.js';
import {
  EcoflowDeviceRegistry,
  buildDiscoveredDevices,
  reconcileConnections,
  pollOnce,
} from './src/devices/index.js';
import {
  registerDevice,
  unregisterDevice,
  deviceSnOf,
  onSetValue as dispatchSetValue,
  runTestConnectionAction,
} from './src/devices/device.js';

const gladys = new GladysIntegration();

let config = normalizeConfig();
let client = null;
let registry = null;
let pollTimer = null;

function stopPollTimer() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function schedulePollTimer() {
  stopPollTimer();
  pollTimer = setInterval(() => {
    pollOnce(gladys, client).catch((err) =>
      logger.error(`Scheduled EcoFlow poll failed: ${err.message}`),
    );
  }, config.poll_interval_seconds * 1000);
}

/**
 * Re-list the EcoFlow account's devices, reconcile the registry, and take one
 * immediate quota poll — called on connect, on a Discovery scan, and on
 * every config change (a fresh accessKey/secretKey is only actually tried
 * here).
 */
async function refreshAndReconcile({ forceDiscovery }) {
  if (!isConfigured(config)) {
    await gladys.publishDiscoveredDevices([]);
    await gladys.setConnectionStatus(false, {
      en: 'Enter your EcoFlow accessKey/secretKey (from developer-eu.ecoflow.com or developer.ecoflow.com) in the Configuration screen.',
      fr: "Entrez votre accessKey/secretKey EcoFlow (depuis developer-eu.ecoflow.com ou developer.ecoflow.com) dans l'écran de configuration.",
    });
    return;
  }

  client = createEcoflowClient(config);
  registry = new EcoflowDeviceRegistry(client);

  try {
    await registry.refresh();
  } catch (err) {
    logger.error(`EcoFlow device list failed: ${err.message}`);
    await gladys.setConnectionStatus(false, {
      en: `Could not reach the EcoFlow Cloud API: ${err.message}`,
      fr: `Impossible de joindre l'API Cloud EcoFlow : ${err.message}`,
    });
    return;
  }

  await reconcileConnections(gladys);

  if (forceDiscovery) {
    await gladys.publishDiscoveredDevices(buildDiscoveredDevices(gladys, registry));
  }

  await pollOnce(gladys, client);
  await gladys.setConnectionStatus(true);
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> listing devices bound to the configured EcoFlow account');
  try {
    await refreshAndReconcile({ forceDiscovery: true });
  } catch (err) {
    logger.error('Discovery failed', err);
    await gladys.setConnectionStatus(false, {
      en: `Discovery failed: ${err.message}`,
      fr: `Échec de la découverte : ${err.message}`,
    });
  }
});

// --- Command: the user acts on a controllable feature -------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  if (!client) {
    throw new Error('Not connected to the EcoFlow Cloud API yet');
  }
  await dispatchSetValue(gladys, client, { device, feature, value });
});

// --- Manifest action: test the connection -------------------------------------
gladys.onAction('test_connection', (fields) => {
  if (!client) {
    return Promise.resolve({
      en: 'Not connected to the EcoFlow Cloud API yet.',
      fr: "Pas encore connecté à l'API Cloud EcoFlow.",
    });
  }
  return runTestConnectionAction(gladys, client, { fields });
});

// --- Device lifecycle ----------------------------------------------------------
gladys.onDeviceCreated(async (device) => {
  const sn = deviceSnOf(device);
  if (!sn) {
    logger.warn(`Device created (${device.external_id}) but no EcoFlow serial number param found`);
    return;
  }
  logger.info(`Device created -> registering ${device.external_id} (${sn})`);
  registerDevice(device.external_id, sn);
  if (client) {
    pollOnce(gladys, client).catch((err) => logger.error(`Initial poll failed: ${err.message}`));
  }
});

gladys.onDeviceDeleted(async (device) => {
  logger.info(`Device deleted -> forgetting ${device.external_id}`);
  unregisterDevice(device.external_id);
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  config = normalizeConfig(newConfig);
  try {
    await refreshAndReconcile({ forceDiscovery: true });
  } catch (err) {
    logger.error('Refresh after config update failed', err);
    await gladys.setConnectionStatus(false, {
      en: `Refresh failed: ${err.message}`,
      fr: `Échec du rafraîchissement : ${err.message}`,
    });
  }
  schedulePollTimer();
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    await refreshAndReconcile({ forceDiscovery: false });
    schedulePollTimer();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

gladys.on('disconnected', () => {
  // Nothing to tear down: every EcoFlow call is a one-shot REST request, not
  // a persistent session independent of the Gladys WebSocket.
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown((signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopPollTimer();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the EcoFlow integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
