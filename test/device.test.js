import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeTransport } from '../test-fixtures/fakeTransport.js';
import { FEATURE, featureExternalId } from '../src/ecoflow/quota.js';
import {
  DEVICE_TYPE,
  buildDiscoveredDevice,
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
  applyQuota(gladys, { external_id: externalId }, { 'mppt.cfgAcEnabled': 1 });

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
