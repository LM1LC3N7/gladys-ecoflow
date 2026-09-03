// -----------------------------------------------------------------------------
// These tests exercise src/ecoflow/client.js against a fake RestClient
// (test-fixtures/fakeEcoflowClient.js) — no network access needed — and, for
// the set* commands, additionally re-validate the `params` sent against
// @ecoflow-api/schemas' OWN zod schemas for the River 2 Pro command shapes
// (`.shape.params`, not the full schema — every one of these schemas' `sn`
// field is Pro-only (`R621...`), which a plain River 2's serial number would
// correctly fail; see src/ecoflow/client.js#sendCommand for the full
// reasoning). That check is deliberate: if a future @ecoflow-api/schemas
// release changes the required params shape (a field renamed, a new one
// required), this test fails on the real, current schema rather than on a
// stale copy of it — exactly the kind of drift a mocked test suite would
// otherwise miss (see .github/workflows/dependabot-auto-merge.yml's header
// for why that gap keeps @ecoflow-api/* out of auto-merge).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acOutCfgSchema,
  mpptCarSchema,
  chargeLimitSchema,
  dischargeLimitSchema,
  watthConfigSchema,
} from '@ecoflow-api/schemas';
import { createFakeEcoflowClient } from '../test-fixtures/fakeEcoflowClient.js';
import {
  listDevices,
  getQuota,
  setAcOutput,
  setDcOutput,
  setChargeLimit,
  setDischargeLimit,
  setBackupReserve,
} from '../src/ecoflow/client.js';

test('listDevices maps the raw device list to { sn, name, online }', async () => {
  const client = createFakeEcoflowClient({
    devices: [
      { sn: 'R331ABC', deviceName: 'Garage River 2', online: 1 },
      { sn: 'R331DEF', online: 0 },
    ],
  });

  const devices = await listDevices(client);
  assert.deepEqual(devices, [
    { sn: 'R331ABC', name: 'Garage River 2', online: true },
    { sn: 'R331DEF', name: 'R331DEF', online: false },
  ]);
});

test('getQuota returns the raw flat quota dict for one serial number', async () => {
  const client = createFakeEcoflowClient({ quotaBySn: { R331ABC: { 'pd.soc': 42 } } });
  assert.deepEqual(await getQuota(client, 'R331ABC'), { 'pd.soc': 42 });
});

test('getQuota returns {} for a device with no cached quota yet', async () => {
  const client = createFakeEcoflowClient();
  assert.deepEqual(await getQuota(client, 'UNKNOWN'), {});
});

test('setAcOutput sends a valid acOutCfg command (moduleType 5)', async () => {
  const client = createFakeEcoflowClient();
  await setAcOutput(client, 'R331ABC', { enabled: 1, xboost: 0, outVoltage: 0, outFreq: 1 });

  assert.equal(client.sentCommands.length, 1);
  const payload = client.sentCommands[0];
  assert.equal(payload.sn, 'R331ABC');
  assert.equal(payload.moduleType, 5);
  assert.equal(payload.operateType, 'acOutCfg');
  assert.deepEqual(payload.params, { enabled: 1, xboost: 0, out_voltage: 0, out_freq: 1 });
  assert.doesNotThrow(() => acOutCfgSchema.shape.params.parse(payload.params));
});

test('setDcOutput sends a valid mpptCar command (moduleType 5)', async () => {
  const client = createFakeEcoflowClient();
  await setDcOutput(client, 'R331ABC', 1);

  const payload = client.sentCommands[0];
  assert.equal(payload.moduleType, 5);
  assert.equal(payload.operateType, 'mpptCar');
  assert.deepEqual(payload.params, { enabled: 1 });
  assert.doesNotThrow(() => mpptCarSchema.shape.params.parse(payload.params));
});

test('setChargeLimit sends a valid upsConfig command (moduleType 2)', async () => {
  const client = createFakeEcoflowClient();
  await setChargeLimit(client, 'R331ABC', 80);

  const payload = client.sentCommands[0];
  assert.equal(payload.moduleType, 2);
  assert.equal(payload.operateType, 'upsConfig');
  assert.deepEqual(payload.params, { maxChgSoc: 80 });
  assert.doesNotThrow(() => chargeLimitSchema.shape.params.parse(payload.params));
});

test('setDischargeLimit sends a valid dsgCfg command (moduleType 2)', async () => {
  const client = createFakeEcoflowClient();
  await setDischargeLimit(client, 'R331ABC', 10);

  const payload = client.sentCommands[0];
  assert.equal(payload.moduleType, 2);
  assert.equal(payload.operateType, 'dsgCfg');
  assert.deepEqual(payload.params, { minDsgSoc: 10 });
  assert.doesNotThrow(() => dischargeLimitSchema.shape.params.parse(payload.params));
});

test('setBackupReserve sends a valid watthConfig command (moduleType 1)', async () => {
  const client = createFakeEcoflowClient();
  await setBackupReserve(client, 'R331ABC', { isConfig: 1, bpPowerSoc: 60 });

  const payload = client.sentCommands[0];
  assert.equal(payload.moduleType, 1);
  assert.equal(payload.operateType, 'watthConfig');
  assert.deepEqual(payload.params, { isConfig: 1, bpPowerSoc: 60, minDsgSoc: 0, minChgSoc: 0 });
  assert.doesNotThrow(() => watthConfigSchema.shape.params.parse(payload.params));
});

test('every sent command gets its own incrementing id', async () => {
  const client = createFakeEcoflowClient();
  await setDcOutput(client, 'R331ABC', 1);
  await setDcOutput(client, 'R331ABC', 0);
  assert.notEqual(client.sentCommands[0].id, client.sentCommands[1].id);
});
