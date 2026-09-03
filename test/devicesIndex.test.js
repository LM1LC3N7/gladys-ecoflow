import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeEcoflowClient } from '../test-fixtures/fakeEcoflowClient.js';
import { FEATURE, featureExternalId } from '../src/ecoflow/quota.js';
import {
  DEVICE_TYPE,
  registerDevice,
  __clearConnectionsForTesting,
} from '../src/devices/device.js';
import {
  EcoflowDeviceRegistry,
  buildDiscoveredDevices,
  reconcileConnections,
  pollOnce,
} from '../src/devices/index.js';

beforeEach(() => {
  __clearConnectionsForTesting();
});

test('EcoflowDeviceRegistry.refresh() lists every device bound to the account', async () => {
  const client = createFakeEcoflowClient({
    devices: [{ sn: 'R331ABC', deviceName: 'Garage', online: 1 }],
  });
  const registry = new EcoflowDeviceRegistry(client);

  const devices = await registry.refresh();
  assert.deepEqual(devices, [{ sn: 'R331ABC', name: 'Garage', online: true }]);
  assert.deepEqual(registry.values(), devices);
});

test('buildDiscoveredDevices builds one discovery payload per known device', async () => {
  const gladys = createFakeGladys();
  const client = createFakeEcoflowClient({
    devices: [
      { sn: 'R331ABC', deviceName: 'Garage', online: 1 },
      { sn: 'R331DEF', deviceName: 'Camping', online: 1 },
    ],
  });
  const registry = new EcoflowDeviceRegistry(client);
  await registry.refresh();

  const discovered = buildDiscoveredDevices(gladys, registry);
  assert.equal(discovered.length, 2);
  assert.deepEqual(discovered.map((d) => d.name).sort(), ['Camping', 'Garage']);
});

test('reconcileConnections registers every device Gladys already created', async () => {
  const gladys = createFakeGladys();
  await gladys.publishDiscoveredDevices([
    { external_id: `${DEVICE_TYPE}:R331ABC`, params: [{ name: 'ECOFLOW_SN', value: 'R331ABC' }] },
  ]);

  await reconcileConnections(gladys);
  // Registration is exercised indirectly here: pollOnce() below only finds a
  // device to poll if reconcileConnections() actually registered it.
  const client = createFakeEcoflowClient({ quotaBySn: { R331ABC: { 'pd.soc': 33 } } });
  await pollOnce(gladys, client);

  assert.deepEqual(gladys.published, [
    {
      featureExternalId: featureExternalId(`${DEVICE_TYPE}:R331ABC`, FEATURE.BATTERY_LEVEL),
      state: 33,
    },
  ]);
});

test('pollOnce polls every registered device and keeps going after one fails', async () => {
  const gladys = createFakeGladys();
  registerDevice(`${DEVICE_TYPE}:OK`, 'SN_OK');
  registerDevice(`${DEVICE_TYPE}:BAD`, 'SN_BAD');

  const client = {
    async getDevicePropertiesPlain(sn) {
      if (sn === 'SN_BAD') {
        throw new Error('boom');
      }
      return { code: '0', message: 'Success', data: { 'pd.soc': 99 } };
    },
  };

  await pollOnce(gladys, client);

  assert.deepEqual(gladys.published, [
    {
      featureExternalId: featureExternalId(`${DEVICE_TYPE}:OK`, FEATURE.BATTERY_LEVEL),
      state: 99,
    },
  ]);
});
