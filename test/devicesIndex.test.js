import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeTransport } from '../test-fixtures/fakeTransport.js';
import { FEATURE, featureExternalId } from '../src/ecoflow/quota.js';
import {
  DEVICE_TYPE,
  METHOD,
  getRegisteredDevice,
  registerDevice,
  __clearConnectionsForTesting,
} from '../src/devices/device.js';
import {
  EcoflowDeviceRegistry,
  buildDiscoveredDevices,
  buildPrivateDiscoveredDevices,
  reconcileConnections,
  transportForSn,
  methodForSn,
  pollOnce,
} from '../src/devices/index.js';

beforeEach(() => {
  __clearConnectionsForTesting();
});

test('EcoflowDeviceRegistry.refresh() lists every device bound to the account', async () => {
  const transport = createFakeTransport({
    devices: [{ sn: 'R331ABC', name: 'Garage', online: true }],
  });
  const registry = new EcoflowDeviceRegistry(transport);

  const devices = await registry.refresh();
  assert.deepEqual(devices, [{ sn: 'R331ABC', name: 'Garage', online: true }]);
  assert.deepEqual(registry.values(), devices);
});

test('buildDiscoveredDevices builds one discovery payload per known device', async () => {
  const gladys = createFakeGladys();
  const transport = createFakeTransport({
    devices: [
      { sn: 'R331ABC', name: 'Garage', online: true },
      { sn: 'R331DEF', name: 'Camping', online: true },
    ],
  });
  const registry = new EcoflowDeviceRegistry(transport);
  await registry.refresh();

  const discovered = buildDiscoveredDevices(gladys, registry);
  assert.equal(discovered.length, 2);
  assert.deepEqual(discovered.map((d) => d.name).sort(), ['Camping', 'Garage']);
});

test('buildPrivateDiscoveredDevices builds one discovery payload per manually-entered serial number', () => {
  const gladys = createFakeGladys();
  const discovered = buildPrivateDiscoveredDevices(gladys, ['R331ABC', 'R331DEF']);
  assert.equal(discovered.length, 2);
  assert.deepEqual(
    discovered.map((d) => d.external_id).sort(),
    [`${DEVICE_TYPE}:R331ABC`, `${DEVICE_TYPE}:R331DEF`].sort(),
  );
});

test('transportForSn routes a private-listed serial number to the private transport, everything else to public', () => {
  const publicTransport = createFakeTransport();
  const privateTransport = createFakeTransport();
  const transports = { publicTransport, privateTransport, privateDeviceSns: ['R331PRIVATE'] };

  assert.equal(transportForSn('R331PRIVATE', transports), privateTransport);
  assert.equal(transportForSn('R331PUBLIC', transports), publicTransport);
});

test('reconcileConnections registers every device Gladys already created, routed to the right transport', async () => {
  const gladys = createFakeGladys();
  await gladys.publishDiscoveredDevices([
    { external_id: `${DEVICE_TYPE}:R331PUB`, params: [{ name: 'ECOFLOW_SN', value: 'R331PUB' }] },
    { external_id: `${DEVICE_TYPE}:R331PRIV`, params: [{ name: 'ECOFLOW_SN', value: 'R331PRIV' }] },
  ]);

  const publicTransport = createFakeTransport({ quotaBySn: { R331PUB: { 'pd.soc': 33 } } });
  const privateTransport = createFakeTransport({ quotaBySn: { R331PRIV: { 'pd.soc': 55 } } });

  await reconcileConnections(gladys, {
    publicTransport,
    privateTransport,
    privateDeviceSns: ['R331PRIV'],
  });
  // Registration is exercised indirectly here: pollOnce() below only finds a
  // device to poll (and via the right transport) if reconcileConnections()
  // actually registered it correctly.
  await pollOnce(gladys);

  assert.deepEqual(gladys.published.map((p) => p.state).sort(), [33, 55]);
});

test('pollOnce polls every registered device and keeps going after one fails', async () => {
  const gladys = createFakeGladys();
  const okTransport = createFakeTransport({ quotaBySn: { SN_OK: { 'pd.soc': 99 } } });
  const badTransport = {
    async getQuota() {
      throw new Error('boom');
    },
  };
  registerDevice(`${DEVICE_TYPE}:OK`, 'SN_OK', okTransport);
  registerDevice(`${DEVICE_TYPE}:BAD`, 'SN_BAD', badTransport);

  await pollOnce(gladys);

  assert.deepEqual(gladys.published, [
    {
      featureExternalId: featureExternalId(`${DEVICE_TYPE}:OK`, FEATURE.BATTERY_LEVEL),
      state: 99,
    },
  ]);
});

test('methodForSn mirrors transportForSn', () => {
  const transports = { privateDeviceSns: ['R331PRIVATE'] };
  assert.equal(methodForSn('R331PRIVATE', transports), METHOD.SIMPLE);
  assert.equal(methodForSn('R331PUBLIC', transports), METHOD.OFFICIAL);
});

test('reconcileConnections records the method and the official online flag', async () => {
  const gladys = createFakeGladys();
  await gladys.publishDiscoveredDevices([
    { external_id: `${DEVICE_TYPE}:R331PUB`, params: [{ name: 'ECOFLOW_SN', value: 'R331PUB' }] },
  ]);
  await reconcileConnections(
    gladys,
    { publicTransport: createFakeTransport(), privateTransport: null, privateDeviceSns: [] },
    { onlineBySn: new Map([['R331PUB', false]]) },
  );
  const entry = getRegisteredDevice(`${DEVICE_TYPE}:R331PUB`);
  assert.equal(entry.method, METHOD.OFFICIAL);
  assert.equal(entry.health.online, false);
});

test('pollOnce returns one result per device and tracks consecutive failures', async () => {
  const gladys = createFakeGladys();
  const failing = {
    async getQuota() {
      throw new Error('boom');
    },
  };
  registerDevice(`${DEVICE_TYPE}:BAD`, 'SN_BAD', failing);

  const [first] = await pollOnce(gladys);
  await pollOnce(gladys);

  assert.equal(first.ok, false);
  assert.equal(first.error.message, 'boom');
  assert.equal(getRegisteredDevice(`${DEVICE_TYPE}:BAD`).health.failures, 2);
});
