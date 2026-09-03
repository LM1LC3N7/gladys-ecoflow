import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE,
  buildFeatures,
  extractFeatureValues,
  featureExternalId,
} from '../src/ecoflow/quota.js';

test('buildFeatures declares one feature per FEATURE key, all under the device external_id', () => {
  const features = buildFeatures('ecoflow_power_station:ABC123');
  const keys = Object.values(FEATURE);
  assert.equal(features.length, keys.length);
  for (const key of keys) {
    const feature = features.find(
      (f) => f.external_id === featureExternalId('ecoflow_power_station:ABC123', key),
    );
    assert.ok(feature, `missing feature for ${key}`);
  }
});

test('every feature has non-null min/max (Gladys rejects a null bound)', () => {
  for (const feature of buildFeatures('ecoflow_power_station:ABC123')) {
    assert.notEqual(feature.min, null, feature.name);
    assert.notEqual(feature.max, null, feature.name);
    assert.notEqual(feature.min, undefined, feature.name);
    assert.notEqual(feature.max, undefined, feature.name);
  }
});

test('the four switches are read_only:false, everything else is read_only:true', () => {
  const writable = [
    FEATURE.AC_OUTPUT_ENABLED,
    FEATURE.XBOOST_ENABLED,
    FEATURE.DC_OUTPUT_ENABLED,
    FEATURE.BACKUP_RESERVE_ENABLED,
  ].map((key) => featureExternalId('ecoflow_power_station:ABC123', key));

  for (const feature of buildFeatures('ecoflow_power_station:ABC123')) {
    assert.equal(feature.read_only, !writable.includes(feature.external_id), feature.name);
  }
});

test('extractFeatureValues reads the confirmed river2ProQuotaAllSchema dotted keys', () => {
  const values = extractFeatureValues({
    'pd.soc': 87,
    'inv.inputWatts': 120,
    'pd.wattsOutSum': 45,
    'inv.outputWatts': 30,
    'mppt.inWatts': 15,
    'mppt.cfgAcEnabled': 1,
    'mppt.cfgAcXboost': 0,
    'pd.carState': 1,
    'pd.watchIsConfig': 0,
  });

  assert.deepEqual(values, {
    [FEATURE.BATTERY_LEVEL]: 87,
    [FEATURE.AC_CHARGE_POWER]: 120,
    [FEATURE.TOTAL_OUTPUT_POWER]: 45,
    [FEATURE.AC_OUTPUT_POWER]: 30,
    [FEATURE.SOLAR_INPUT_POWER]: 15,
    [FEATURE.AC_OUTPUT_ENABLED]: 1,
    [FEATURE.XBOOST_ENABLED]: 0,
    [FEATURE.DC_OUTPUT_ENABLED]: 1,
    [FEATURE.BACKUP_RESERVE_ENABLED]: 0,
  });
});

test('extractFeatureValues omits a key entirely when the quota does not report it', () => {
  const values = extractFeatureValues({ 'pd.soc': 50 });
  assert.deepEqual(values, { [FEATURE.BATTERY_LEVEL]: 50 });
});

test('extractFeatureValues never publishes a false 0 for a missing field', () => {
  const values = extractFeatureValues({});
  assert.deepEqual(values, {});
});
