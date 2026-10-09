import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_TRIGGER, createEventState, detectEvents } from '../src/devices/events.js';
import { summarizeQuota } from '../src/ecoflow/quota.js';

const DEVICE = 'ecoflow_power_station:R331ABC';

function observe(state, { reachable = true, quota }) {
  return detectEvents(state, {
    externalId: DEVICE,
    reachable,
    summary: quota ? summarizeQuota(quota) : undefined,
  }).map((event) => event.key);
}

test('the first observation only seeds the state (no event on startup)', () => {
  const state = createEventState();
  assert.deepEqual(observe(state, { quota: { 'inv.acInVol': 0, 'pd.soc': 100 } }), []);
});

test('device_offline / device_online fire once per transition', () => {
  const state = createEventState();
  observe(state, { quota: { 'pd.soc': 50 } });
  assert.deepEqual(observe(state, { reachable: false }), [SCENE_TRIGGER.DEVICE_OFFLINE]);
  assert.deepEqual(observe(state, { reachable: false }), []);
  assert.deepEqual(observe(state, { quota: { 'pd.soc': 50 } }), [SCENE_TRIGGER.DEVICE_ONLINE]);
});

test('AC input from the voltage: lost and restored are reported on the first poll', () => {
  const state = createEventState();
  observe(state, { quota: { 'inv.acInVol': 230000 } });
  assert.deepEqual(observe(state, { quota: { 'inv.acInVol': 0 } }), [SCENE_TRIGGER.AC_INPUT_LOST]);
  assert.deepEqual(observe(state, { quota: { 'inv.acInVol': 0 } }), []);
  assert.deepEqual(observe(state, { quota: { 'inv.acInVol': 229000 } }), [
    SCENE_TRIGGER.AC_INPUT_RESTORED,
  ]);
});

test('AC input from the power only: a change must be seen on two polls in a row', () => {
  const state = createEventState();
  observe(state, { quota: { 'inv.inputWatts': 300 } });
  observe(state, { quota: { 'inv.inputWatts': 300 } });
  // One isolated 0 W reading (full battery, no load) is not an outage.
  assert.deepEqual(observe(state, { quota: { 'inv.inputWatts': 0 } }), []);
  assert.deepEqual(observe(state, { quota: { 'inv.inputWatts': 250 } }), []);
  assert.deepEqual(observe(state, { quota: { 'inv.inputWatts': 0 } }), []);
  assert.deepEqual(observe(state, { quota: { 'inv.inputWatts': 0 } }), [
    SCENE_TRIGGER.AC_INPUT_LOST,
  ]);
});

test('a failed poll changes nothing but reachability', () => {
  const state = createEventState();
  observe(state, { quota: { 'inv.acInVol': 230000, 'pd.soc': 40 } });
  assert.deepEqual(observe(state, { reachable: true }), []);
  assert.deepEqual(observe(state, { quota: { 'inv.acInVol': 230000, 'pd.soc': 40 } }), []);
});

test('charge_completed fires when the battery reaches the charge limit', () => {
  const state = createEventState();
  observe(state, { quota: { 'pd.soc': 78, 'bms_emsStatus.maxChargeSoc': 80 } });
  assert.deepEqual(observe(state, { quota: { 'pd.soc': 80, 'bms_emsStatus.maxChargeSoc': 80 } }), [
    SCENE_TRIGGER.CHARGE_COMPLETED,
  ]);
  assert.deepEqual(
    observe(state, { quota: { 'pd.soc': 80, 'bms_emsStatus.maxChargeSoc': 80 } }),
    [],
  );
});

test('charge_completed defaults the limit to 100 %', () => {
  const state = createEventState();
  observe(state, { quota: { 'pd.soc': 99 } });
  assert.deepEqual(observe(state, { quota: { 'pd.soc': 100 } }), [SCENE_TRIGGER.CHARGE_COMPLETED]);
});

test('event data is flat and carries the declared variables', () => {
  const state = createEventState();
  detectEvents(state, {
    externalId: DEVICE,
    reachable: true,
    summary: summarizeQuota({ 'inv.acInVol': 230000 }),
  });
  const [event] = detectEvents(state, {
    externalId: DEVICE,
    reachable: true,
    summary: summarizeQuota({ 'inv.acInVol': 0, 'pd.soc': 64, 'pd.wattsOutSum': 120 }),
  });
  assert.deepEqual(event.data, { device: DEVICE, battery_level: 64, output_watts: 120 });
});
