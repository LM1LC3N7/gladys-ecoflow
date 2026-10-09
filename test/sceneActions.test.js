import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  acChargingSettingsSchema,
  chargeLimitSchema,
  watthConfigSchema,
} from '@ecoflow-api/schemas';
import { createFakeTransport } from '../test-fixtures/fakeTransport.js';
import {
  DEVICE_TYPE,
  registerDevice,
  __clearConnectionsForTesting,
} from '../src/devices/device.js';
import { SCENE_ACTION, createSceneActionHandlers } from '../src/sceneActions.js';

const DEVICE = `${DEVICE_TYPE}:R331ABC`;

let transport;
let commands;
let applied;
let handlers;

beforeEach(() => {
  __clearConnectionsForTesting();
  transport = createFakeTransport({
    quotaBySn: {
      R331ABC: {
        'pd.soc': 64,
        'inv.inputWatts': 200,
        'mppt.inWatts': 50,
        'pd.wattsOutSum': 30,
        'bms_emsStatus.dsgRemainTime': 5999,
        'pd.bpPowerSoc': 25,
      },
    },
  });
  registerDevice(DEVICE, 'R331ABC', transport);
  commands = [];
  applied = [];
  handlers = createSceneActionHandlers({
    afterCommand: (externalId) => commands.push(externalId),
    applyFreshQuota: async (externalId, quota) => applied.push({ externalId, quota }),
  });
});

test('set_charge_limit sends a valid upsConfig and schedules the confirmation', async () => {
  await handlers[SCENE_ACTION.SET_CHARGE_LIMIT]({ device: DEVICE, max_percent: 80 });
  const [command] = transport.sentCommands;
  assert.equal(command.operateType, 'upsConfig');
  chargeLimitSchema.shape.params.parse(command.params);
  assert.deepEqual(command.params, { maxChgSoc: 80 });
  assert.deepEqual(commands, [DEVICE]);
});

test('set_charge_limit rejects a value outside 50-100 without sending anything', async () => {
  await assert.rejects(() =>
    handlers[SCENE_ACTION.SET_CHARGE_LIMIT]({ device: DEVICE, max_percent: 20 }),
  );
  await assert.rejects(() =>
    handlers[SCENE_ACTION.SET_CHARGE_LIMIT]({ device: DEVICE, max_percent: 80.5 }),
  );
  assert.equal(transport.sentCommands.length, 0);
});

test('set_discharge_limit sends dsgCfg', async () => {
  await handlers[SCENE_ACTION.SET_DISCHARGE_LIMIT]({ device: DEVICE, min_percent: '10' });
  assert.deepEqual(transport.sentCommands[0].params, { minDsgSoc: 10 });
});

test('set_backup_reserve with an explicit level', async () => {
  await handlers[SCENE_ACTION.SET_BACKUP_RESERVE]({ device: DEVICE, enabled: true, level: 40 });
  const [command] = transport.sentCommands;
  watthConfigSchema.shape.params.parse(command.params);
  assert.equal(command.params.isConfig, 1);
  assert.equal(command.params.bpPowerSoc, 40);
});

test('set_backup_reserve without a level keeps the current one (fetched if unknown)', async () => {
  await handlers[SCENE_ACTION.SET_BACKUP_RESERVE]({ device: DEVICE, enabled: false });
  assert.equal(transport.calls.getQuota, 1);
  assert.deepEqual(
    [transport.sentCommands[0].params.isConfig, transport.sentCommands[0].params.bpPowerSoc],
    [0, 25],
  );
});

test('set_ac_charging sends acChgCfg with the power and the pause flag', async () => {
  await handlers[SCENE_ACTION.SET_AC_CHARGING]({ device: DEVICE, watts: 400, paused: true });
  const [command] = transport.sentCommands;
  acChargingSettingsSchema.shape.params.parse(command.params);
  assert.deepEqual([command.moduleType, command.operateType], [5, 'acChgCfg']);
  assert.deepEqual(command.params, { chgWatts: 400, chgPauseFlag: 1 });
});

test('refresh returns scalar outputs and publishes the fresh quota', async () => {
  const outputs = await handlers[SCENE_ACTION.REFRESH]({ device: DEVICE });
  assert.deepEqual(outputs, {
    battery_level: 64,
    input_watts: 250,
    output_watts: 30,
    charging: true,
  });
  assert.equal(applied[0].externalId, DEVICE);
});

test('an unknown device fails the action with an explicit message', async () => {
  await assert.rejects(
    () =>
      handlers[SCENE_ACTION.SET_CHARGE_LIMIT]({ device: `${DEVICE_TYPE}:NOPE`, max_percent: 80 }),
    /not known/,
  );
});
