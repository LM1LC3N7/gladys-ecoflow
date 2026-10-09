import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURE,
  summarizeQuota,
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
    [FEATURE.CHARGING]: 1,
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

test('extractFeatureValues reports the discharge remaining time, but not the 5999 sentinel', () => {
  assert.equal(
    extractFeatureValues({ 'bms_emsStatus.dsgRemainTime': 190 })[FEATURE.DISCHARGE_REMAINING_TIME],
    190,
  );
  assert.equal(
    extractFeatureValues({ 'bms_emsStatus.dsgRemainTime': 5999 })[FEATURE.DISCHARGE_REMAINING_TIME],
    undefined,
  );
});

test('extractFeatureValues derives "charging" from the power balance', () => {
  const charging = (quota) => extractFeatureValues(quota)[FEATURE.CHARGING];
  assert.equal(charging({ 'inv.inputWatts': 300, 'pd.wattsOutSum': 50, 'pd.soc': 60 }), 1);
  assert.equal(charging({ 'inv.inputWatts': 300, 'pd.wattsOutSum': 50, 'pd.soc': 100 }), 0);
  assert.equal(charging({ 'mppt.inWatts': 5, 'pd.wattsOutSum': 0, 'pd.soc': 60 }), 0);
  assert.equal(charging({ 'inv.inputWatts': 0, 'pd.wattsOutSum': 120 }), 0);
  assert.equal(charging({ 'pd.soc': 60 }), undefined);
});

test('summarizeQuota detects the AC input from the voltage first, then the power', () => {
  assert.deepEqual(
    [
      summarizeQuota({ 'inv.acInVol': 230000, 'inv.inputWatts': 0 }).acInputPresent,
      summarizeQuota({ 'inv.acInVol': 230000 }).acInputSource,
    ],
    [true, 'voltage'],
  );
  assert.equal(summarizeQuota({ 'inv.acInVol': 0 }).acInputPresent, false);
  assert.deepEqual(
    [
      summarizeQuota({ 'inv.inputWatts': 120 }).acInputPresent,
      summarizeQuota({ 'inv.inputWatts': 120 }).acInputSource,
    ],
    [true, 'watts'],
  );
  assert.equal(summarizeQuota({}).acInputPresent, undefined);
});

test('summarizeQuota exposes the settings the widget shows', () => {
  const summary = summarizeQuota({
    'bms_emsStatus.maxChargeSoc': 90,
    'bms_emsStatus.minDsgSoc': 10,
    'pd.bpPowerSoc': 30,
    'pd.watchIsConfig': 1,
  });
  assert.equal(summary.chargeLimit, 90);
  assert.equal(summary.dischargeLimit, 10);
  assert.equal(summary.reserveLevel, 30);
  assert.equal(summary.reserveEnabled, 1);
  assert.equal(summary.batteryLevel, undefined);
});

test('the new features are read-only, with valid bounds', () => {
  for (const key of [FEATURE.DISCHARGE_REMAINING_TIME, FEATURE.CHARGING]) {
    const feature = buildFeatures('d').find((f) => f.external_id === featureExternalId('d', key));
    assert.equal(feature.read_only, true);
    assert.ok(feature.min < feature.max);
  }
});
