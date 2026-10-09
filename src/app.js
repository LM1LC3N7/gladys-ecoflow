// -----------------------------------------------------------------------------
// The integration's orchestration, wired to a `gladys` SDK client — kept out
// of index.js so it can be tested against a fake client (test/app.test.js).
//
// Lifecycle rules:
//   - every configuration change REBUILDS the transports and the device
//     registry from scratch: new credentials, another region or a serial
//     number moved to the other method apply immediately, and erasing the
//     credentials stops every EcoFlow call (no poll keeps running with them);
//   - polls never overlap: a tick, a command's confirming re-poll and a
//     Discovery scan all share the one poll in flight;
//   - the connection status reports each method separately, after actually
//     trying it (the simple method logs in eagerly instead of on first use);
//   - a Gladys reconnection with an unchanged configuration only re-publishes
//     the current states — no EcoFlow re-login.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import {
  normalizeConfig,
  isConfigured,
  isPublicConfigured,
  isPrivateConfigured,
  invalidDeviceSns,
} from './config.js';
import { createPublicTransport as defaultCreatePublicTransport } from './ecoflow/client.js';
import { createPrivateTransport as defaultCreatePrivateTransport } from './ecoflow/privateClient.js';
import { summarizeQuota } from './ecoflow/quota.js';
import {
  EcoflowDeviceRegistry,
  buildDiscoveredDevices,
  buildPrivateDiscoveredDevices,
  reconcileConnections,
  transportForSn,
  methodForSn,
  pollOnce,
} from './devices/index.js';
import {
  METHOD,
  registerDevice,
  unregisterDevice,
  deviceSnOf,
  clearRegisteredDevices,
  getRegisteredDevice,
  registeredDevices,
  resetPublishedCache,
  publishTransportBadges,
  applyQuota,
  isReachable,
  recordPollSuccess,
  onSetValue as dispatchSetValue,
  runTestConnectionAction,
  runDiagnosticsAction,
} from './devices/device.js';
import { createEventState, detectEvents } from './devices/events.js';
import { createSceneActionHandlers } from './sceneActions.js';
import { WIDGET_KEY, WIDGET_ACTION_REFRESH, buildWidgetContent } from './widget.js';

/** Delay before re-polling a device after a command, to confirm its effect. */
export const REPOLL_DELAY_MS = 3000;

/** How often the official account's device list (online flags) is re-read. */
export const DEVICE_LIST_REFRESH_MS = 5 * 60 * 1000;

function plural(count, word) {
  return `${count} ${word}${count > 1 ? 's' : ''}`;
}

export function createApp(
  gladys,
  {
    createPublicTransport = defaultCreatePublicTransport,
    createPrivateTransport = defaultCreatePrivateTransport,
    timers = globalThis,
    now = () => Date.now(),
    repollDelayMs = REPOLL_DELAY_MS,
    logger = createLogger({ name: 'ecoflow' }),
  } = {},
) {
  let config = normalizeConfig();
  let configKey;
  let initialized = false;
  let publicTransport = null;
  let privateTransport = null;
  let deviceListRefreshedAt = 0;
  let pollTimer = null;
  let pollInFlight = null;
  const repollTimers = new Set();
  const eventStates = new Map(); // external_id -> events.js state
  const widgetSignatures = new Map(); // external_id -> what the widget shows

  function stopPollTimer() {
    if (pollTimer) {
      timers.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePollTimer() {
    stopPollTimer();
    pollTimer = timers.setInterval(() => {
      pollNow().catch((err) => logger.error(`Scheduled EcoFlow poll failed: ${err.message}`));
    }, config.poll_interval_seconds * 1000);
  }

  function refreshWidget() {
    try {
      gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh not requested: ${err.message}`);
    }
  }

  function transports() {
    return { publicTransport, privateTransport, privateDeviceSns: config.privateDeviceSns };
  }

  /** Re-read the official account's online flags, at most every DEVICE_LIST_REFRESH_MS. */
  async function refreshOnlineFlags({ force = false } = {}) {
    if (!publicTransport || (!force && now() - deviceListRefreshedAt < DEVICE_LIST_REFRESH_MS)) {
      return undefined;
    }
    deviceListRefreshedAt = now();
    const devices = await publicTransport.listDevices();
    const onlineBySn = new Map(devices.map((device) => [device.sn, device.online]));
    for (const { entry } of registeredDevices()) {
      if (entry.method === METHOD.OFFICIAL) {
        entry.health.online = onlineBySn.get(entry.sn);
      }
    }
    return devices;
  }

  async function publishEvent({ key, data }) {
    try {
      await gladys.publishSceneEvent(key, data);
      logger.info(`Scene event ${key} sent: ${JSON.stringify(data)}`);
    } catch (err) {
      logger.warn(
        `publishSceneEvent(${key}) failed: ${err.message} — data: ${JSON.stringify(data)}`,
      );
    }
  }

  /** Transport badges, scene events and widget refresh, after one poll. */
  async function processPollResults(results) {
    let widgetChanged = false;
    for (const { externalId, entry, ok, quota } of results) {
      const summary = ok ? summarizeQuota(quota) : undefined;
      const reachable = isReachable(entry);
      if (!eventStates.has(externalId)) {
        eventStates.set(externalId, createEventState());
      }
      for (const event of detectEvents(eventStates.get(externalId), {
        externalId,
        reachable,
        summary,
      })) {
        await publishEvent(event);
      }

      const shown = summarizeQuota(entry.lastQuota);
      const signature = JSON.stringify({
        reachable,
        charging: shown.charging,
        acInput: shown.acInputPresent,
        ac: shown.acEnabled,
        dc: shown.dcEnabled,
        xboost: shown.xboostEnabled,
        reserve: [shown.reserveEnabled, shown.reserveLevel],
        limits: [shown.chargeLimit, shown.dischargeLimit],
      });
      if (widgetSignatures.get(externalId) !== signature) {
        widgetSignatures.set(externalId, signature);
        widgetChanged = true;
      }
    }
    await publishTransportBadges(gladys);
    if (widgetChanged) {
      refreshWidget();
    }
  }

  /**
   * Poll every registered device once — or join the poll already in flight.
   * `fresh: true` waits for that in-flight poll then starts a new one (the
   * registry was just rebuilt, the old poll iterated the previous one).
   */
  async function pollNow({ fresh = false } = {}) {
    if (fresh && pollInFlight) {
      await pollInFlight.catch(() => {});
    }
    if (!pollInFlight) {
      pollInFlight = (async () => {
        await refreshOnlineFlags().catch((err) =>
          logger.warn(`EcoFlow device list refresh failed: ${err.message}`),
        );
        await processPollResults(await pollOnce(gladys));
      })().finally(() => {
        pollInFlight = null;
      });
    }
    return pollInFlight;
  }

  /** After an accepted command: refresh the widget now, confirm with a re-poll shortly after. */
  function afterCommand() {
    refreshWidget();
    const timer = timers.setTimeout(() => {
      repollTimers.delete(timer);
      pollNow()
        .then(refreshWidget)
        .catch((err) => logger.error(`Confirming re-poll failed: ${err.message}`));
    }, repollDelayMs);
    repollTimers.add(timer);
  }

  async function tearDownTransports() {
    const previousPrivateTransport = privateTransport;
    publicTransport = null;
    privateTransport = null;
    clearRegisteredDevices();
    eventStates.clear();
    widgetSignatures.clear();
    await previousPrivateTransport?.disconnect().catch(() => {});
  }

  /**
   * (Re)build whichever transports are configured, re-list the official
   * account's devices, rebuild the registry, take one immediate poll and
   * report each method's outcome in the connection status — called on
   * connect, on a Discovery scan and on every configuration change. The two
   * methods are independent: one failing never stops the other.
   */
  async function refreshAndReconcile({ forceDiscovery }) {
    await tearDownTransports();

    if (!isConfigured(config)) {
      stopPollTimer();
      await gladys.publishDiscoveredDevices([]);
      await gladys.setConnectionStatus(false, {
        en: 'Configure at least one method in the Configuration screen: an EcoFlow Access Key/Secret Key, or your EcoFlow account email/password plus a device serial number.',
        fr: "Configurez au moins une méthode dans l'écran de configuration : une Access Key/Secret Key EcoFlow, ou votre email/mot de passe de compte EcoFlow avec un numéro de série d'appareil.",
      });
      refreshWidget();
      return;
    }

    publicTransport = isPublicConfigured(config) ? createPublicTransport(config) : null;
    privateTransport = isPrivateConfigured(config) ? createPrivateTransport(config) : null;

    const discovered = [];
    const report = { en: [], fr: [] };
    let anyMethodReady = false;
    const onlineBySn = new Map();

    if (publicTransport) {
      try {
        const registry = new EcoflowDeviceRegistry(publicTransport);
        const devices = await registry.refresh();
        deviceListRefreshedAt = now();
        devices.forEach((device) => onlineBySn.set(device.sn, device.online));
        discovered.push(...buildDiscoveredDevices(gladys, registry));
        if (devices.length > 0) {
          anyMethodReady = true;
          report.en.push(`Official API: ${plural(devices.length, 'device')}`);
          report.fr.push(`API officielle : ${plural(devices.length, 'appareil')}`);
        } else {
          report.en.push('Official API reached, but no device is bound to this developer account');
          report.fr.push(
            "API officielle jointe, mais aucun appareil n'est lié à ce compte développeur",
          );
        }
      } catch (err) {
        logger.error(`EcoFlow official-account device list failed: ${err.message}`);
        report.en.push(`Official API failed: ${err.message}`);
        report.fr.push(`Échec de l'API officielle : ${err.message}`);
      }
    }

    if (privateTransport) {
      discovered.push(...buildPrivateDiscoveredDevices(gladys, config.privateDeviceSns));
      try {
        await privateTransport.connect();
        anyMethodReady = true;
        const count = config.privateDeviceSns.length;
        report.en.push(`Simple login: connected (${plural(count, 'serial number')})`);
        report.fr.push(`Connexion simple : connectée (${plural(count, 'numéro')} de série)`);
      } catch (err) {
        logger.error(`EcoFlow simple login failed: ${err.message}`);
        report.en.push(`Simple login failed: ${err.message}`);
        report.fr.push(`Échec de la connexion simple : ${err.message}`);
      }
      const invalid = invalidDeviceSns(config);
      if (invalid.length > 0) {
        report.en.push(`Serial number(s) that do not look valid: ${invalid.join(', ')}`);
        report.fr.push(`Numéro(s) de série qui semblent invalides : ${invalid.join(', ')}`);
      }
    }

    await reconcileConnections(gladys, transports(), { onlineBySn });

    if (forceDiscovery) {
      // A serial number listed for the simple method may also be on the
      // official account: publish it once (the simple method wins, as in
      // transportForSn()).
      const unique = new Map(discovered.map((device) => [device.external_id, device]));
      await gladys.publishDiscoveredDevices([...unique.values()]);
    }

    schedulePollTimer();
    await pollNow({ fresh: true });

    await gladys.setConnectionStatus(anyMethodReady, {
      en: report.en.join(' · '),
      fr: report.fr.join(' · '),
    });
    refreshWidget();
  }

  async function safely(label, fn) {
    try {
      await fn();
    } catch (err) {
      logger.error(`${label} failed`, err);
      await gladys
        .setConnectionStatus(false, {
          en: `${label} failed: ${err.message}`,
          fr: `Échec (${label}) : ${err.message}`,
        })
        .catch(() => {});
    }
  }

  // --- Discovery: Gladys asks for the list of devices ------------------------
  gladys.onScanRequest(async () => {
    logger.info(
      'onScanRequest -> listing every configured device (official account + simple login)',
    );
    await safely('Discovery', () => refreshAndReconcile({ forceDiscovery: true }));
  });

  // --- Command: the user acts on a controllable feature -----------------------
  gladys.onSetValue(async (device, feature, value) => {
    logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
    await dispatchSetValue(gladys, { device, feature, value });
    afterCommand(device.external_id);
  });

  // --- Manifest actions ---------------------------------------------------------
  gladys.onAction('test_connection', async (fields) => {
    const result = await runTestConnectionAction(gladys, { fields });
    await processPollResults([]);
    return result;
  });
  gladys.onAction('diagnostics', (fields) => runDiagnosticsAction(gladys, { fields }));

  // --- Scene actions (Gladys >= 5.1) --------------------------------------------
  const sceneActionHandlers = createSceneActionHandlers({
    afterCommand,
    async applyFreshQuota(externalId, quota) {
      const entry = getRegisteredDevice(externalId);
      if (entry) {
        recordPollSuccess(entry);
      }
      await applyQuota(gladys, { external_id: externalId }, quota);
      refreshWidget();
    },
  });
  for (const [key, handler] of Object.entries(sceneActionHandlers)) {
    gladys.onSceneAction(key, async (fields) => {
      logger.info(`Scene action ${key} <- ${fields.device}`);
      return handler(fields);
    });
  }

  // --- Dashboard widget (Gladys >= 5.1) -------------------------------------------
  gladys.onWidgetGet(WIDGET_KEY, async ({ settings, language }) => {
    const externalId = settings?.device;
    const entry = externalId ? getRegisteredDevice(externalId) : undefined;
    const device = (gladys.devices ?? []).find((d) => d.external_id === externalId);
    return buildWidgetContent({
      externalId,
      entry,
      deviceName: device?.name,
      reachable: entry ? isReachable(entry) : true,
      language,
      ttlSeconds: config.poll_interval_seconds,
    });
  });

  gladys.onWidgetAction(WIDGET_KEY, async (actionKey, _params, { settings }) => {
    if (actionKey !== WIDGET_ACTION_REFRESH) {
      throw new Error(`Unknown widget action "${actionKey}"`);
    }
    await pollNow();
    const entry = settings?.device ? getRegisteredDevice(settings.device) : undefined;
    return entry && isReachable(entry)
      ? { en: 'Power station reached', fr: 'Station jointe' }
      : { en: 'Still not answering', fr: 'Ne répond toujours pas' };
  });

  // --- Device lifecycle ----------------------------------------------------------
  gladys.onDeviceCreated(async (device) => {
    const sn = deviceSnOf(device);
    if (!sn) {
      logger.warn(
        `Device created (${device.external_id}) but no EcoFlow serial number param found`,
      );
      return;
    }
    const transport = transportForSn(sn, transports());
    if (!transport) {
      logger.warn(
        `Device created (${device.external_id}, ${sn}) but no transport is configured for it`,
      );
      return;
    }
    logger.info(`Device created -> registering ${device.external_id} (${sn})`);
    registerDevice(device.external_id, sn, transport, { method: methodForSn(sn, transports()) });
    await refreshOnlineFlags({ force: true }).catch(() => {});
    pollNow().catch((err) => logger.error(`Initial poll failed: ${err.message}`));
  });

  gladys.onDeviceDeleted(async (device) => {
    logger.info(`Device deleted -> forgetting ${device.external_id}`);
    unregisterDevice(device.external_id);
    eventStates.delete(device.external_id);
    widgetSignatures.delete(device.external_id);
  });

  // --- Configuration updated by the user -------------------------------------------
  gladys.onConfigUpdated(async (newConfig) => {
    logger.info('onConfigUpdated -> new configuration received');
    config = normalizeConfig(newConfig);
    configKey = JSON.stringify(newConfig ?? {});
    initialized = true;
    await safely('Refresh after the configuration update', () =>
      refreshAndReconcile({ forceDiscovery: true }),
    );
  });

  // --- Connection lifecycle -----------------------------------------------------------
  gladys.on('connected', async () => {
    await safely('Initialization', async () => {
      const raw = await gladys.getConfig();
      const key = JSON.stringify(raw ?? {});
      if (initialized && key === configKey) {
        // Same configuration: keep the EcoFlow sessions, only re-send what
        // Gladys may have missed while the connection was down.
        resetPublishedCache();
        await pollNow();
        return;
      }
      config = normalizeConfig(raw);
      configKey = key;
      initialized = true;
      await refreshAndReconcile({ forceDiscovery: false });
    });
  });

  // Nothing to do on 'disconnected': EcoFlow calls do not depend on the Gladys
  // WebSocket, and states published meanwhile are re-sent on reconnection.

  /** Stop timers and close the EcoFlow sessions (graceful shutdown). */
  async function shutdown() {
    stopPollTimer();
    for (const timer of repollTimers) {
      timers.clearTimeout(timer);
    }
    repollTimers.clear();
    await privateTransport?.disconnect().catch(() => {});
  }

  return {
    refreshAndReconcile,
    pollNow,
    shutdown,
    getConfig: () => config,
    isPollScheduled: () => pollTimer !== null,
  };
}
