// -----------------------------------------------------------------------------
// Entry point of the Gladys external integration for EcoFlow power stations
// (River 2 family). Wires the SDK to src/ecoflow/ (the two onboarding
// methods — see src/config.js's header) and src/devices/ (discovery + the
// device registry) — holds no EcoFlow protocol knowledge itself.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import {
  normalizeConfig,
  isConfigured,
  isPublicConfigured,
  isPrivateConfigured,
} from './src/config.js';
import { createPublicTransport } from './src/ecoflow/client.js';
import { createPrivateTransport } from './src/ecoflow/privateClient.js';
import {
  EcoflowDeviceRegistry,
  buildDiscoveredDevices,
  buildPrivateDiscoveredDevices,
  reconcileConnections,
  transportForSn,
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
let publicTransport = null;
let privateTransport = null;
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
    pollOnce(gladys).catch((err) => logger.error(`Scheduled EcoFlow poll failed: ${err.message}`));
  }, config.poll_interval_seconds * 1000);
}

/**
 * (Re)build whichever transports are configured, re-list the official
 * account's devices, reconcile the registry, and take one immediate quota
 * poll — called on connect, on a Discovery scan, and on every config change
 * (fresh credentials are only actually tried here). The two methods are
 * independent: a failure fetching the official account's device list is
 * logged but does not stop a configured private/simple method from working,
 * and vice-versa.
 */
async function refreshAndReconcile({ forceDiscovery }) {
  if (!isConfigured(config)) {
    await gladys.publishDiscoveredDevices([]);
    await gladys.setConnectionStatus(false, {
      en: 'Configure at least one method in the Configuration screen: an EcoFlow Access Key/Secret Key, or your EcoFlow account email/password plus a device serial number.',
      fr: "Configurez au moins une méthode dans l'écran de configuration : une Access Key/Secret Key EcoFlow, ou votre email/mot de passe de compte EcoFlow avec un numéro de série d'appareil.",
    });
    return;
  }

  publicTransport = isPublicConfigured(config) ? createPublicTransport(config) : null;
  await privateTransport?.disconnect().catch(() => {});
  privateTransport = isPrivateConfigured(config) ? createPrivateTransport(config) : null;
  registry = publicTransport ? new EcoflowDeviceRegistry(publicTransport) : null;

  const discovered = [];
  if (registry) {
    try {
      await registry.refresh();
      discovered.push(...buildDiscoveredDevices(gladys, registry));
    } catch (err) {
      logger.error(`EcoFlow official-account device list failed: ${err.message}`);
    }
  }
  if (privateTransport) {
    discovered.push(...buildPrivateDiscoveredDevices(gladys, config.privateDeviceSns));
  }

  await reconcileConnections(gladys, {
    publicTransport,
    privateTransport,
    privateDeviceSns: config.privateDeviceSns,
  });

  if (forceDiscovery) {
    await gladys.publishDiscoveredDevices(discovered);
  }

  await pollOnce(gladys);

  const publicReady = Boolean(registry?.values().length);
  const anyMethodReady = publicReady || Boolean(privateTransport);
  if (anyMethodReady) {
    await gladys.setConnectionStatus(true);
  } else {
    await gladys.setConnectionStatus(false, {
      en: 'Could not reach the EcoFlow Cloud API. Check your credentials and the integration logs.',
      fr: "Impossible de joindre l'API Cloud EcoFlow. Vérifiez vos identifiants et les logs de l'intégration.",
    });
  }
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info(
    'onScanRequest -> listing every configured device (official account + private method)',
  );
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
  await dispatchSetValue(gladys, { device, feature, value });
});

// --- Manifest action: test the connection -------------------------------------
gladys.onAction('test_connection', (fields) => runTestConnectionAction(gladys, { fields }));

// --- Device lifecycle ----------------------------------------------------------
gladys.onDeviceCreated(async (device) => {
  const sn = deviceSnOf(device);
  if (!sn) {
    logger.warn(`Device created (${device.external_id}) but no EcoFlow serial number param found`);
    return;
  }
  const transport = transportForSn(sn, {
    publicTransport,
    privateTransport,
    privateDeviceSns: config.privateDeviceSns,
  });
  if (!transport) {
    logger.warn(
      `Device created (${device.external_id}, ${sn}) but no transport is configured for it`,
    );
    return;
  }
  logger.info(`Device created -> registering ${device.external_id} (${sn})`);
  registerDevice(device.external_id, sn, transport);
  pollOnce(gladys).catch((err) => logger.error(`Initial poll failed: ${err.message}`));
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
  // Nothing to tear down for the public transport: every call is a one-shot
  // REST request. The private transport's MQTT session is left connected
  // too — it is independent of the Gladys WebSocket, same reasoning.
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stopPollTimer();
  await privateTransport?.disconnect().catch(() => {});
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the EcoFlow integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
