import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeTransport } from '../test-fixtures/fakeTransport.js';
import { FEATURE, featureExternalId } from '../src/ecoflow/quota.js';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import {
  DEVICE_TYPE,
  METHOD,
  UNREACHABLE_AFTER_FAILURES,
  buildDiscoveredDevice,
  getRegisteredDevice,
  clearRegisteredDevices,
  resetPublishedCache,
  publishStatesInBatches,
  publishTransportBadges,
  transportEntryFor,
  recordPollFailure,
  recordPollSuccess,
  isReachable,
  formatDiagnostics,
  runDiagnosticsAction,
  deviceSnOf,
  registerDevice,
  unregisterDevice,
  applyQuota,
  onSetValue,
  runTestConnectionAction,
  __setConnectionForTesting,
  __clearConnectionsForTesting,
} from '../src/devices/device.js';

beforeEach(() => {
  __clearConnectionsForTesting();
});

test('buildDiscoveredDevice sets the ECOFLOW_SN param and a full feature list', () => {
  const gladys = createFakeGladys();
  const discovered = buildDiscoveredDevice(gladys, { sn: 'R331ABC', name: 'Garage River 2' });

  assert.equal(discovered.name, 'Garage River 2');
  assert.equal(discovered.external_id, `${DEVICE_TYPE}:R331ABC`);
  assert.deepEqual(discovered.params, [{ name: 'ECOFLOW_SN', value: 'R331ABC' }]);
  assert.ok(discovered.features.length > 0);
});

test('buildDiscoveredDevice falls back to "EcoFlow (<sn>)" when the account has no device name', () => {
  const gladys = createFakeGladys();
  const discovered = buildDiscoveredDevice(gladys, { sn: 'R331ABC' });
  assert.equal(discovered.name, 'EcoFlow (R331ABC)');
});

test('deviceSnOf reads the ECOFLOW_SN param back', () => {
  const device = { params: [{ name: 'ECOFLOW_SN', value: 'R331ABC' }] };
  assert.equal(deviceSnOf(device), 'R331ABC');
});

test('deviceSnOf returns undefined when the param is missing', () => {
  assert.equal(deviceSnOf({ params: [] }), undefined);
  assert.equal(deviceSnOf({}), undefined);
});

test('applyQuota publishes every value extractFeatureValues reports, under this device', async () => {
  const gladys = createFakeGladys();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', createFakeTransport());

  await applyQuota(gladys, { external_id: externalId }, { 'pd.soc': 77, 'pd.carState': 1 });

  assert.deepEqual(
    gladys.published.map((p) => p.featureExternalId).sort(),
    [
      featureExternalId(externalId, FEATURE.BATTERY_LEVEL),
      featureExternalId(externalId, FEATURE.DC_OUTPUT_ENABLED),
    ].sort(),
  );
});

test('onSetValue(AC_OUTPUT_ENABLED) sends acOutCfg, preserving last-known xboost/voltage/freq', async () => {
  const gladys = createFakeGladys();
  const transport = createFakeTransport();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', transport);
  applyQuota(
    gladys,
    { external_id: externalId },
    {
      'mppt.cfgAcEnabled': 0,
      'mppt.cfgAcXboost': 1,
      'mppt.cfgAcOutVol': 230,
      'mppt.cfgAcOutFreq': 1,
    },
  );

  await onSetValue(gladys, {
    device: { external_id: externalId },
    feature: { external_id: featureExternalId(externalId, FEATURE.AC_OUTPUT_ENABLED) },
    value: 1,
  });

  assert.equal(transport.sentCommands.length, 1);
  assert.deepEqual(transport.sentCommands[0].params, {
    enabled: 1,
    xboost: 1,
    out_voltage: 230,
    out_freq: 1,
  });
});

test('onSetValue(XBOOST_ENABLED) toggles xboost only, preserving AC enabled state', async () => {
  const gladys = createFakeGladys();
  const transport = createFakeTransport();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', transport);
  applyQuota(
    gladys,
    { external_id: externalId },
    {
      'mppt.cfgAcEnabled': 1,
      'mppt.cfgAcXboost': 1,
      'mppt.cfgAcOutVol': 230,
      'mppt.cfgAcOutFreq': 1,
    },
  );

  await onSetValue(gladys, {
    device: { external_id: externalId },
    feature: { external_id: featureExternalId(externalId, FEATURE.XBOOST_ENABLED) },
    value: 0,
  });

  assert.deepEqual(transport.sentCommands[0].params.enabled, 1);
  assert.deepEqual(transport.sentCommands[0].params.xboost, 0);
});

test('onSetValue(DC_OUTPUT_ENABLED) sends mpptCar', async () => {
  const transport = createFakeTransport();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', transport);

  await onSetValue(createFakeGladys(), {
    device: { external_id: externalId },
    feature: { external_id: featureExternalId(externalId, FEATURE.DC_OUTPUT_ENABLED) },
    value: 1,
  });

  assert.equal(transport.sentCommands[0].operateType, 'mpptCar');
  assert.deepEqual(transport.sentCommands[0].params, { enabled: 1 });
});

test('onSetValue(BACKUP_RESERVE_ENABLED) sends watthConfig with the last-known reserve level', async () => {
  const gladys = createFakeGladys();
  const transport = createFakeTransport();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', transport);
  applyQuota(gladys, { external_id: externalId }, { 'pd.bpPowerSoc': 40 });

  await onSetValue(gladys, {
    device: { external_id: externalId },
    feature: { external_id: featureExternalId(externalId, FEATURE.BACKUP_RESERVE_ENABLED) },
    value: 1,
  });

  assert.deepEqual(transport.sentCommands[0].params, {
    isConfig: 1,
    bpPowerSoc: 40,
    minDsgSoc: 0,
    minChgSoc: 0,
  });
});

test('onSetValue throws for an unregistered device', async () => {
  await assert.rejects(
    () =>
      onSetValue(createFakeGladys(), {
        device: { external_id: 'ecoflow_power_station:UNKNOWN' },
        feature: { external_id: 'ecoflow_power_station:UNKNOWN:ac_output_enabled' },
        value: 1,
      }),
    /not known/,
  );
});

test('onSetValue throws for a non-controllable feature', async () => {
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', createFakeTransport());

  await assert.rejects(
    () =>
      onSetValue(createFakeGladys(), {
        device: { external_id: externalId },
        feature: { external_id: featureExternalId(externalId, FEATURE.BATTERY_LEVEL) },
        value: 1,
      }),
    /not controllable/,
  );
});

test('unregisterDevice makes onSetValue reject again', async () => {
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', createFakeTransport());
  unregisterDevice(externalId);

  await assert.rejects(() =>
    onSetValue(createFakeGladys(), {
      device: { external_id: externalId },
      feature: { external_id: featureExternalId(externalId, FEATURE.AC_OUTPUT_ENABLED) },
      value: 1,
    }),
  );
});

test('runTestConnectionAction reports an unknown device without calling the API', async () => {
  const result = await runTestConnectionAction(createFakeGladys(), {
    fields: { device: 'ecoflow_power_station:UNKNOWN' },
  });
  assert.match(result.en, /not known/);
});

test('runTestConnectionAction re-polls and reports battery/AC output', async () => {
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  const transport = createFakeTransport({
    quotaBySn: { R331ABC: { 'pd.soc': 91, 'inv.outputWatts': 120 } },
  });
  __setConnectionForTesting(externalId, { sn: 'R331ABC', transport, lastQuota: {} });

  const result = await runTestConnectionAction(createFakeGladys(), {
    fields: { device: externalId },
  });

  assert.match(result.en, /91%/);
  assert.match(result.en, /120W/);
});

test('runTestConnectionAction reports the EcoFlow error message on failure', async () => {
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  const transport = {
    async getQuota() {
      throw new Error('code: 1 | message: invalid sign');
    },
  };
  __setConnectionForTesting(externalId, { sn: 'R331ABC', transport, lastQuota: {} });

  const result = await runTestConnectionAction(createFakeGladys(), {
    fields: { device: externalId },
  });
  assert.match(result.en, /invalid sign/);
});

const AC_QUOTA = {
  'mppt.cfgAcEnabled': 0,
  'mppt.cfgAcXboost': 0,
  'mppt.cfgAcOutVol': 230000,
  'mppt.cfgAcOutFreq': 1,
};

test('registerDevice keeps an entry backed by the same transport, replaces it otherwise', () => {
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  const oldTransport = createFakeTransport();
  const first = registerDevice(externalId, 'R331ABC', oldTransport);
  first.lastQuota = { 'pd.soc': 10 };

  assert.equal(registerDevice(externalId, 'R331ABC', oldTransport), first);

  const newTransport = createFakeTransport();
  const replaced = registerDevice(externalId, 'R331ABC', newTransport, { method: METHOD.SIMPLE });
  assert.notEqual(replaced, first);
  assert.equal(getRegisteredDevice(externalId).transport, newTransport);
  assert.equal(replaced.method, METHOD.SIMPLE);
  assert.deepEqual(replaced.lastQuota, {});
});

test('clearRegisteredDevices forgets every device', () => {
  registerDevice(`${DEVICE_TYPE}:A`, 'A', createFakeTransport());
  clearRegisteredDevices();
  assert.equal(getRegisteredDevice(`${DEVICE_TYPE}:A`), undefined);
});

test('applyQuota only publishes values that changed since the last publish', async () => {
  const gladys = createFakeGladys();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', createFakeTransport());

  await applyQuota(gladys, { external_id: externalId }, { 'pd.soc': 50, 'pd.carState': 1 });
  await applyQuota(gladys, { external_id: externalId }, { 'pd.soc': 51, 'pd.carState': 1 });

  assert.deepEqual(
    gladys.published.map((p) => p.state),
    [50, 1, 51],
  );

  resetPublishedCache();
  await applyQuota(gladys, { external_id: externalId }, { 'pd.soc': 51, 'pd.carState': 1 });
  assert.equal(gladys.published.length, 5, 'everything is re-sent after a cache reset');
});

test('applyQuota retries a value on the next poll when publishing failed', async () => {
  const gladys = createFakeGladys();
  let fail = true;
  gladys.publishStates = async (states) => {
    if (fail) {
      throw new Error('429');
    }
    gladys.published.push(...states);
  };
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', createFakeTransport());

  await applyQuota(gladys, { external_id: externalId }, { 'pd.soc': 50 });
  fail = false;
  await applyQuota(gladys, { external_id: externalId }, { 'pd.soc': 50 });

  assert.equal(gladys.published.length, 1);
});

test('publishStatesInBatches sends at most 100 states per request', async () => {
  const batches = [];
  const gladys = { publishStates: async (states) => batches.push(states.length) };
  const states = Array.from({ length: 250 }, (_, i) => ({
    device_feature_external_id: `f${i}`,
    state: i,
  }));

  await publishStatesInBatches(gladys, states);

  assert.deepEqual(batches, [100, 100, 50]);
});

test('onSetValue(AC) re-fetches the quota first when the AC settings are not known yet', async () => {
  const transport = createFakeTransport({ quotaBySn: { R331ABC: AC_QUOTA } });
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', transport);

  await onSetValue(createFakeGladys(), {
    device: { external_id: externalId },
    feature: { external_id: featureExternalId(externalId, FEATURE.AC_OUTPUT_ENABLED) },
    value: 1,
  });

  assert.equal(transport.calls.getQuota, 1);
  assert.deepEqual(transport.sentCommands[0].params, {
    enabled: 1,
    xboost: 0,
    out_voltage: 230000,
    out_freq: 1,
  });
});

test('onSetValue(AC) refuses to send made-up voltage/frequency values', async () => {
  const transport = createFakeTransport({ quotaBySn: { R331ABC: { 'pd.soc': 50 } } });
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', transport);

  await assert.rejects(
    () =>
      onSetValue(createFakeGladys(), {
        device: { external_id: externalId },
        feature: { external_id: featureExternalId(externalId, FEATURE.AC_OUTPUT_ENABLED) },
        value: 1,
      }),
    /has not reported .*command not sent/,
  );
  assert.equal(transport.sentCommands.length, 0);
});

test('onSetValue(BACKUP_RESERVE_ENABLED) refuses to overwrite an unknown reserve level', async () => {
  const transport = createFakeTransport();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', transport);

  await assert.rejects(() =>
    onSetValue(createFakeGladys(), {
      device: { external_id: externalId },
      feature: { external_id: featureExternalId(externalId, FEATURE.BACKUP_RESERVE_ENABLED) },
      value: 1,
    }),
  );
  assert.equal(transport.sentCommands.length, 0);
});

test('onSetValue publishes the accepted value right away (no bouncing switch)', async () => {
  const gladys = createFakeGladys();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(externalId, 'R331ABC', createFakeTransport());
  const featureId = featureExternalId(externalId, FEATURE.DC_OUTPUT_ENABLED);

  await onSetValue(gladys, {
    device: { external_id: externalId },
    feature: { external_id: featureId },
    value: 1,
  });

  assert.deepEqual(gladys.published, [{ featureExternalId: featureId, state: 1 }]);
  assert.equal(getRegisteredDevice(externalId).lastQuota['pd.carState'], 1);
});

test('transportEntryFor: cloud, then degraded, then unreachable as refreshes keep failing', () => {
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  const entry = registerDevice(externalId, 'R331ABC', createFakeTransport());

  assert.deepEqual(transportEntryFor(externalId, entry), {
    external_id: externalId,
    transport: DEVICE_TRANSPORTS.CLOUD,
  });

  recordPollFailure(entry, new Error('timeout'));
  const degraded = transportEntryFor(externalId, entry);
  assert.equal(degraded.transport, DEVICE_TRANSPORTS.CLOUD);
  assert.equal(degraded.degraded, true);
  assert.match(degraded.message.en, /timeout/);
  assert.ok(isReachable(entry));

  for (let i = 1; i < UNREACHABLE_AFTER_FAILURES; i += 1) {
    recordPollFailure(entry, new Error('timeout'));
  }
  assert.equal(transportEntryFor(externalId, entry).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(isReachable(entry), false);

  recordPollSuccess(entry);
  assert.equal(transportEntryFor(externalId, entry).degraded, undefined);
});

test('transportEntryFor: unreachable when the official account reports the unit offline', () => {
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  const entry = registerDevice(externalId, 'R331ABC', createFakeTransport());
  entry.health.online = false;

  const badge = transportEntryFor(externalId, entry);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.ok(badge.message.en.length <= 200);
  assert.ok(badge.message.fr.length <= 200);
});

test('publishTransportBadges only re-publishes a badge that changed', async () => {
  const gladys = createFakeGladys();
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  const entry = registerDevice(externalId, 'R331ABC', createFakeTransport());

  await publishTransportBadges(gladys);
  await publishTransportBadges(gladys);
  assert.equal(gladys.transports.length, 1);

  recordPollFailure(entry, new Error('boom'));
  await publishTransportBadges(gladys);
  assert.equal(gladys.transports.length, 2);
  assert.equal(gladys.transports[1].degraded, true);
});

test('formatDiagnostics lists every key, sorted, with identifying values redacted', () => {
  const lines = formatDiagnostics({
    'pd.soc': 80,
    'pd.sn': 'R331ABC',
    'pd.wifiName': 'home',
    'inv.cfg': { a: 1 },
  });
  assert.deepEqual(lines, [
    'inv.cfg={"a":1}',
    'pd.sn=<redacted>',
    'pd.soc=80',
    'pd.wifiName=<redacted>',
  ]);
});

test('runDiagnosticsAction reports the telemetry keys of one device', async () => {
  const externalId = `${DEVICE_TYPE}:R331ABC`;
  registerDevice(
    externalId,
    'R331ABC',
    createFakeTransport({ quotaBySn: { R331ABC: { 'pd.soc': 80, 'inv.acInVol': 230000 } } }),
  );

  const result = await runDiagnosticsAction(createFakeGladys(), { fields: { device: externalId } });

  assert.match(result.en, /^2 keys/);
  assert.match(result.en, /inv\.acInVol=230000/);
  assert.match(result.fr, /pd\.soc=80/);
});

test('runDiagnosticsAction reports an unknown device', async () => {
  const result = await runDiagnosticsAction(createFakeGladys(), {
    fields: { device: `${DEVICE_TYPE}:UNKNOWN` },
  });
  assert.match(result.en, /not known/);
});
