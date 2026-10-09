// -----------------------------------------------------------------------------
// src/app.js against a fake SDK client and fake transports: configuration
// changes, connection status, poll scheduling, reconnection, commands,
// scene events and the dashboard widget — the orchestration index.js used to
// hold untested.
// -----------------------------------------------------------------------------

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '../test-fixtures/fakeGladys.js';
import { createFakeTransport } from '../test-fixtures/fakeTransport.js';
import { createApp } from '../src/app.js';
import {
  DEVICE_TYPE,
  getRegisteredDevice,
  __clearConnectionsForTesting,
} from '../src/devices/device.js';
import { FEATURE, featureExternalId } from '../src/ecoflow/quota.js';
import { WIDGET_KEY } from '../src/widget.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const SN = 'R331ZEB4HFJC1234';
const DEVICE = `${DEVICE_TYPE}:${SN}`;
const createdDevice = {
  external_id: DEVICE,
  name: 'Garage',
  params: [{ name: 'ECOFLOW_SN', value: SN }],
};

const PRIVATE_CONFIG = {
  private_username: 'alice@example.com',
  private_password: 'hunter2',
  private_device_sns: SN,
};
const PUBLIC_CONFIG = { access_key: 'ak', secret_key: 'sk' };

function createFakeTimers() {
  const intervals = new Set();
  const timeouts = [];
  return {
    intervals,
    timeouts,
    setInterval(fn, ms) {
      const handle = { fn, ms };
      intervals.add(handle);
      return handle;
    },
    clearInterval(handle) {
      intervals.delete(handle);
    },
    setTimeout(fn) {
      timeouts.push(fn);
      return fn;
    },
    clearTimeout(fn) {
      const i = timeouts.indexOf(fn);
      if (i >= 0) {
        timeouts.splice(i, 1);
      }
    },
    async runTimeouts() {
      for (const fn of timeouts.splice(0)) {
        await fn();
      }
    },
  };
}

function setup({ config = {}, devices = [createdDevice], privateOptions, publicOptions } = {}) {
  const gladys = createFakeGladys({ config, devices });
  const timers = createFakeTimers();
  const created = { private: [], public: [] };
  const app = createApp(gladys, {
    timers,
    createPrivateTransport: (cfg) => {
      const transport = createFakeTransport({
        quotaBySn: { [SN]: { 'pd.soc': 50 } },
        ...(typeof privateOptions === 'function' ? privateOptions(cfg) : privateOptions),
      });
      created.private.push({ config: cfg, transport });
      return transport;
    },
    createPublicTransport: (cfg) => {
      const transport = createFakeTransport({
        devices: [{ sn: SN, name: 'Garage', online: true }],
        quotaBySn: { [SN]: { 'pd.soc': 70 } },
        ...publicOptions,
      });
      created.public.push({ config: cfg, transport });
      return transport;
    },
  });
  return { gladys, timers, created, app };
}

beforeEach(() => {
  __clearConnectionsForTesting();
});

test('every manifest action, scene action and widget has a registered handler', () => {
  const { gladys } = setup();
  for (const action of manifest.actions) {
    assert.ok(gladys.handlers.actions[action.key], `action ${action.key}`);
  }
  for (const action of manifest.scene_actions) {
    assert.ok(gladys.handlers.sceneActions[action.key], `scene action ${action.key}`);
  }
  for (const widget of manifest.widgets) {
    assert.ok(gladys.handlers.widgetGet[widget.key], `widget ${widget.key}`);
    assert.ok(gladys.handlers.widgetAction[widget.key], `widget action ${widget.key}`);
  }
});

test('startup with the simple method logs in eagerly and reports it', async () => {
  const { gladys, created } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');

  assert.equal(created.private[0].transport.calls.connect, 1);
  const status = gladys.connectionStatuses.at(-1);
  assert.equal(status.connected, true);
  assert.match(status.message.en, /Simple login: connected \(1 serial number\)/);
  assert.equal(gladys.published.at(-1).state, 50);
});

test('a refused simple login is reported as disconnected, with the reason', async () => {
  const { gladys } = setup({
    config: PRIVATE_CONFIG,
    privateOptions: { connectError: new Error('code: 1 | message: incorrect password') },
  });
  await gladys.emit('connected');

  const status = gladys.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(status.message.en, /Simple login failed: .*incorrect password/);
});

test('an official account with no device says so instead of "unreachable"', async () => {
  const { gladys } = setup({ config: PUBLIC_CONFIG, publicOptions: { devices: [] } });
  await gladys.emit('connected');

  const status = gladys.connectionStatuses.at(-1);
  assert.equal(status.connected, false);
  assert.match(status.message.en, /no device is bound to this developer account/);
});

test('new credentials apply to already-created devices immediately', async () => {
  const { gladys, created } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');
  const [first] = created.private;

  await gladys.handlers.configUpdated({ ...PRIVATE_CONFIG, private_password: 'new-password' });

  const second = created.private[1];
  assert.equal(second.config.private_password, 'new-password');
  assert.equal(first.transport.calls.disconnect, 1, 'the old session is closed');
  assert.equal(getRegisteredDevice(DEVICE).transport, second.transport);
  assert.ok(second.transport.calls.getQuota >= 1, 'the device is polled with the new credentials');
});

test('moving a serial number from the simple method to the official one re-routes the device', async () => {
  const { gladys, created } = setup({ config: { ...PRIVATE_CONFIG, ...PUBLIC_CONFIG } });
  await gladys.emit('connected');
  assert.equal(getRegisteredDevice(DEVICE).transport, created.private[0].transport);

  await gladys.handlers.configUpdated({ ...PUBLIC_CONFIG });

  assert.equal(getRegisteredDevice(DEVICE).transport, created.public.at(-1).transport);
});

test('erasing every credential stops polling and closes the EcoFlow session', async () => {
  const { gladys, timers, created, app } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');
  assert.equal(app.isPollScheduled(), true);

  await gladys.handlers.configUpdated({});

  assert.equal(app.isPollScheduled(), false);
  assert.equal(timers.intervals.size, 0);
  assert.equal(created.private[0].transport.calls.disconnect, 1);
  assert.equal(getRegisteredDevice(DEVICE), undefined);
  assert.equal(gladys.connectionStatuses.at(-1).connected, false);

  const quotaCalls = created.private[0].transport.calls.getQuota;
  await app.pollNow();
  assert.equal(created.private[0].transport.calls.getQuota, quotaCalls, 'no more EcoFlow calls');
});

test('concurrent polls share the one in flight', async () => {
  const { gladys, created, app } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');
  const transport = created.private[0].transport;
  const before = transport.calls.getQuota;

  await Promise.all([app.pollNow(), app.pollNow(), app.pollNow()]);

  assert.equal(transport.calls.getQuota, before + 1);
});

test('a Gladys reconnection with an unchanged configuration re-sends states without re-login', async () => {
  const { gladys, created } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');
  const published = gladys.published.length;

  await gladys.emit('connected');

  assert.equal(created.private.length, 1, 'no new transport');
  assert.equal(created.private[0].transport.calls.connect, 1, 'no new login');
  assert.ok(gladys.published.length > published, 'states re-sent after the reconnection');
});

test('a command is reflected at once, then confirmed by a re-poll', async () => {
  const { gladys, timers, created } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');
  const transport = created.private[0].transport;
  const featureId = featureExternalId(DEVICE, FEATURE.DC_OUTPUT_ENABLED);

  await gladys.handlers.setValue({ external_id: DEVICE }, { external_id: featureId }, 1);

  assert.deepEqual(gladys.published.at(-1), { featureExternalId: featureId, state: 1 });
  assert.ok(gladys.widgetRefreshes.includes(WIDGET_KEY));
  const quotaCalls = transport.calls.getQuota;
  await timers.runTimeouts();
  assert.equal(transport.calls.getQuota, quotaCalls + 1);
});

test('wall power loss fires a scene event, and failing polls show in the transport badge', async () => {
  const { gladys, created, app } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');
  const transport = created.private[0].transport;

  transport.quotaBySn[SN] = { 'inv.acInVol': 230000, 'pd.soc': 80 };
  await app.pollNow();
  transport.quotaBySn[SN] = { 'inv.acInVol': 0, 'pd.soc': 80, 'pd.wattsOutSum': 90 };
  await app.pollNow();

  assert.deepEqual(gladys.sceneEvents, [
    { key: 'ac_input_lost', data: { device: DEVICE, battery_level: 80, output_watts: 90 } },
  ]);
  assert.equal(gladys.transports.at(-1).transport, DEVICE_TRANSPORTS.CLOUD);

  transport.getQuota = async () => {
    throw new Error('Timed out');
  };
  await app.pollNow();
  await app.pollNow();
  await app.pollNow();

  assert.equal(gladys.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
  assert.equal(gladys.sceneEvents.at(-1).key, 'device_offline');
});

test('the official account offline flag shows as unreachable', async () => {
  const { gladys } = setup({
    config: PUBLIC_CONFIG,
    publicOptions: { devices: [{ sn: SN, name: 'Garage', online: false }] },
  });
  await gladys.emit('connected');
  assert.equal(gladys.transports.at(-1).transport, DEVICE_TRANSPORTS.UNREACHABLE);
});

test('the widget renders the chosen station, and its retry action re-polls', async () => {
  const { gladys, created } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');

  const content = await gladys.handlers.widgetGet[WIDGET_KEY]({
    settings: { device: DEVICE },
    language: 'en',
    units: 'metric',
  });
  assert.match(content.components[0].text, /^Garage — /);

  const quotaCalls = created.private[0].transport.calls.getQuota;
  const toast = await gladys.handlers.widgetAction[WIDGET_KEY](
    'refresh',
    {},
    {
      settings: { device: DEVICE },
    },
  );
  assert.equal(created.private[0].transport.calls.getQuota, quotaCalls + 1);
  assert.equal(toast.en, 'Power station reached');
});

test('scene actions reach the device through its transport', async () => {
  const { gladys, created } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');

  await gladys.handlers.sceneActions.set_charge_limit({ device: DEVICE, max_percent: 90 });

  assert.deepEqual(created.private[0].transport.sentCommands.at(-1).params, { maxChgSoc: 90 });
});

test('shutdown stops the timers and closes the session', async () => {
  const { gladys, timers, created, app } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');
  await gladys.handlers.setValue(
    { external_id: DEVICE },
    { external_id: featureExternalId(DEVICE, FEATURE.DC_OUTPUT_ENABLED) },
    0,
  );

  await app.shutdown();

  assert.equal(timers.intervals.size, 0);
  assert.equal(timers.timeouts.length, 0);
  assert.equal(created.private[0].transport.calls.disconnect, 1);
});

test('a device created from Discovery is registered on the right transport and polled', async () => {
  const { gladys, created } = setup({ config: PRIVATE_CONFIG, devices: [] });
  await gladys.emit('connected');
  assert.equal(getRegisteredDevice(DEVICE), undefined);

  await gladys.handlers.deviceCreated(createdDevice);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(getRegisteredDevice(DEVICE).transport, created.private[0].transport);
  assert.equal(gladys.published.at(-1).state, 50);

  await gladys.handlers.deviceDeleted(createdDevice);
  assert.equal(getRegisteredDevice(DEVICE), undefined);
});

test('a device created without a known serial number or transport is ignored', async () => {
  const { gladys } = setup({ config: PRIVATE_CONFIG, devices: [] });
  await gladys.emit('connected');

  await gladys.handlers.deviceCreated({ external_id: 'x', params: [] });
  await gladys.handlers.deviceCreated({
    external_id: `${DEVICE_TYPE}:OTHER`,
    params: [{ name: 'ECOFLOW_SN', value: 'OTHER' }],
  });

  assert.equal(getRegisteredDevice('x'), undefined);
  assert.equal(getRegisteredDevice(`${DEVICE_TYPE}:OTHER`), undefined);
});

test('a configuration changed while Gladys was unreachable is applied on reconnection', async () => {
  const { gladys, created } = setup({ config: PRIVATE_CONFIG });
  await gladys.emit('connected');

  gladys.config = { ...PRIVATE_CONFIG, private_password: 'changed' };
  await gladys.emit('connected');

  assert.equal(created.private.length, 2);
  assert.equal(created.private[1].config.private_password, 'changed');
});

test('a Discovery scan publishes every configured device once', async () => {
  const { gladys } = setup({ config: { ...PRIVATE_CONFIG, ...PUBLIC_CONFIG }, devices: [] });
  await gladys.emit('connected');
  assert.equal(gladys.discoveredDevices.length, 0, 'startup does not force a discovery');

  await gladys.handlers.scanRequest();

  assert.deepEqual(
    gladys.discoveredDevices.map((d) => d.external_id),
    [DEVICE],
  );
});
