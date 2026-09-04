// -----------------------------------------------------------------------------
// These tests exercise src/ecoflow/commands.js against a fake transport
// (test-fixtures/fakeTransport.js) — no network access needed — and
// additionally re-validate the `params` sent against @ecoflow-api/schemas'
// OWN zod schemas for the River 2 Pro command shapes (`.shape.params`, not
// the full schema — every one of these schemas' `sn` field is Pro-only
// (`R621...`), which a plain River 2's serial number would correctly fail;
// see src/ecoflow/commands.js#sendCommand for the full reasoning). That
// check is deliberate: if a future @ecoflow-api/schemas release changes the
// required params shape (a field renamed, a new one required), this test
// fails on the real, current schema rather than on a stale copy of it.
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
import { createFakeTransport } from '../test-fixtures/fakeTransport.js';
import {
  setAcOutput,
  setDcOutput,
  setChargeLimit,
  setDischargeLimit,
  setBackupReserve,
} from '../src/ecoflow/commands.js';

test('setAcOutput sends a valid acOutCfg command (moduleType 5)', async () => {
  const transport = createFakeTransport();
  await setAcOutput(transport, 'R331ABC', { enabled: 1, xboost: 0, outVoltage: 0, outFreq: 1 });

  assert.equal(transport.sentCommands.length, 1);
  const command = transport.sentCommands[0];
  assert.equal(command.sn, 'R331ABC');
  assert.equal(command.moduleType, 5);
  assert.equal(command.operateType, 'acOutCfg');
  assert.deepEqual(command.params, { enabled: 1, xboost: 0, out_voltage: 0, out_freq: 1 });
  assert.doesNotThrow(() => acOutCfgSchema.shape.params.parse(command.params));
});

test('setDcOutput sends a valid mpptCar command (moduleType 5)', async () => {
  const transport = createFakeTransport();
  await setDcOutput(transport, 'R331ABC', 1);

  const command = transport.sentCommands[0];
  assert.equal(command.moduleType, 5);
  assert.equal(command.operateType, 'mpptCar');
  assert.deepEqual(command.params, { enabled: 1 });
  assert.doesNotThrow(() => mpptCarSchema.shape.params.parse(command.params));
});

test('setChargeLimit sends a valid upsConfig command (moduleType 2)', async () => {
  const transport = createFakeTransport();
  await setChargeLimit(transport, 'R331ABC', 80);

  const command = transport.sentCommands[0];
  assert.equal(command.moduleType, 2);
  assert.equal(command.operateType, 'upsConfig');
  assert.deepEqual(command.params, { maxChgSoc: 80 });
  assert.doesNotThrow(() => chargeLimitSchema.shape.params.parse(command.params));
});

test('setDischargeLimit sends a valid dsgCfg command (moduleType 2)', async () => {
  const transport = createFakeTransport();
  await setDischargeLimit(transport, 'R331ABC', 10);

  const command = transport.sentCommands[0];
  assert.equal(command.moduleType, 2);
  assert.equal(command.operateType, 'dsgCfg');
  assert.deepEqual(command.params, { minDsgSoc: 10 });
  assert.doesNotThrow(() => dischargeLimitSchema.shape.params.parse(command.params));
});

test('setBackupReserve sends a valid watthConfig command (moduleType 1)', async () => {
  const transport = createFakeTransport();
  await setBackupReserve(transport, 'R331ABC', { isConfig: 1, bpPowerSoc: 60 });

  const command = transport.sentCommands[0];
  assert.equal(command.moduleType, 1);
  assert.equal(command.operateType, 'watthConfig');
  assert.deepEqual(command.params, { isConfig: 1, bpPowerSoc: 60, minDsgSoc: 0, minChgSoc: 0 });
  assert.doesNotThrow(() => watthConfigSchema.shape.params.parse(command.params));
});

test('an invalid params value throws locally instead of reaching the transport', async () => {
  const transport = createFakeTransport();
  await assert.rejects(() => setChargeLimit(transport, 'R331ABC', 150)); // > 100, out of bounds
  assert.equal(transport.sentCommands.length, 0);
});
