// -----------------------------------------------------------------------------
// PURE: EcoFlow River 2 (family) quota <-> Gladys features. No I/O.
//
// Every quota key read here is confirmed present in @ecoflow-api/schemas'
// river2ProQuotaAllSchema (github.com/rustyy/ecoflow-api, MIT) — the whole
// River 2 family (River 2, River 2 Max, River 2 Pro) shares the same
// PD/MPPT/BMS module layout, cross-checked against tolwi/hassio-ecoflow-
// cloud's own internal River2/River2Max/River2Pro mapping (all three share
// one sensor table). See src/ecoflow/client.js's header comment for the full
// reasoning on why this integration talks to the family generically instead
// of only the (schema-typed) Pro model.
//
// Deliberately v0.1-conservative: only fields with a clean, unambiguous fit
// in Gladys' device-feature taxonomy are mapped. Notably NOT included yet:
// numeric charge/discharge-limit and backup-reserve-level (percentages the
// EcoFlow app lets you set) — BATTERY_STORAGE has no "target level" type
// distinct from BATTERY_LEVEL (unlike e.g. THERMOSTAT's TARGET_TEMPERATURE
// vs a plain temperature sensor), and repurposing a sensor type as a
// settable target would be exactly the kind of taxonomy misuse the SDK's own
// category comments warn against. See the README's "Possible follow-ups".
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const FEATURE = {
  BATTERY_LEVEL: 'battery_level',
  AC_CHARGE_POWER: 'ac_charge_power',
  TOTAL_OUTPUT_POWER: 'total_output_power',
  AC_OUTPUT_POWER: 'ac_output_power',
  SOLAR_INPUT_POWER: 'solar_input_power',
  AC_OUTPUT_ENABLED: 'ac_output_enabled',
  XBOOST_ENABLED: 'xboost_enabled',
  DC_OUTPUT_ENABLED: 'dc_output_enabled',
  BACKUP_RESERVE_ENABLED: 'backup_reserve_enabled',
};

// Generous upper bound covering the whole River 2 family's peak output
// (River 2: 300W, River 2 Max: 500W, River 2 Pro: 800W, X-Boost surge
// higher still) — see the family-wide reasoning above for why one static
// feature list is used for all three rather than a per-model one.
const MAX_WATTS = 1000;

export function featureExternalId(deviceExternalId, key) {
  return `${deviceExternalId}:${key}`;
}

function powerSensor(deviceExternalId, key, name, category, type) {
  return {
    name,
    external_id: featureExternalId(deviceExternalId, key),
    category,
    type,
    unit: DEVICE_FEATURE_UNITS.WATT,
    min: 0,
    max: MAX_WATTS,
    read_only: true,
    has_feedback: false,
    keep_history: true,
  };
}

function binarySwitch(deviceExternalId, key, name, { keepHistory = true } = {}) {
  return {
    name,
    external_id: featureExternalId(deviceExternalId, key),
    category: DEVICE_FEATURE_CATEGORIES.SWITCH,
    type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
    min: 0,
    max: 1,
    read_only: false,
    has_feedback: true,
    keep_history: keepHistory,
  };
}

export function buildFeatures(deviceExternalId) {
  return [
    {
      name: 'Battery level',
      external_id: featureExternalId(deviceExternalId, FEATURE.BATTERY_LEVEL),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      type: DEVICE_FEATURE_TYPES.BATTERY_STORAGE.BATTERY_LEVEL,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      min: 0,
      max: 100,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    powerSensor(
      deviceExternalId,
      FEATURE.AC_CHARGE_POWER,
      'AC charging power',
      DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      DEVICE_FEATURE_TYPES.BATTERY_STORAGE.CHARGE_POWER,
    ),
    powerSensor(
      deviceExternalId,
      FEATURE.TOTAL_OUTPUT_POWER,
      'Total output power',
      DEVICE_FEATURE_CATEGORIES.BATTERY_STORAGE,
      DEVICE_FEATURE_TYPES.BATTERY_STORAGE.DISCHARGE_POWER,
    ),
    powerSensor(
      deviceExternalId,
      FEATURE.AC_OUTPUT_POWER,
      'AC output power',
      DEVICE_FEATURE_CATEGORIES.HOME_OUTPUT_SENSOR,
      DEVICE_FEATURE_TYPES.HOME_OUTPUT_SENSOR.POWER,
    ),
    powerSensor(
      deviceExternalId,
      FEATURE.SOLAR_INPUT_POWER,
      'Solar input power',
      DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
      DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.POWER,
    ),
    binarySwitch(deviceExternalId, FEATURE.AC_OUTPUT_ENABLED, 'AC output'),
    binarySwitch(deviceExternalId, FEATURE.XBOOST_ENABLED, 'X-Boost', { keepHistory: false }),
    binarySwitch(deviceExternalId, FEATURE.DC_OUTPUT_ENABLED, 'DC (car) output'),
    binarySwitch(deviceExternalId, FEATURE.BACKUP_RESERVE_ENABLED, 'Backup reserve', {
      keepHistory: false,
    }),
  ];
}

/**
 * quota (flat dotted-key dict from getDevicePropertiesPlain) -> { featureKey: value }.
 * Only emits a key when the source field is actually present — a stale/empty
 * quota snapshot must never push a false "0" over a real last-known value.
 */
export function extractFeatureValues(quota) {
  const values = {};
  const set = (key, quotaKey) => {
    const raw = quota[quotaKey];
    if (raw !== undefined && raw !== null) {
      values[key] = raw;
    }
  };
  set(FEATURE.BATTERY_LEVEL, 'pd.soc');
  set(FEATURE.AC_CHARGE_POWER, 'inv.inputWatts');
  set(FEATURE.TOTAL_OUTPUT_POWER, 'pd.wattsOutSum');
  set(FEATURE.AC_OUTPUT_POWER, 'inv.outputWatts');
  set(FEATURE.SOLAR_INPUT_POWER, 'mppt.inWatts');
  set(FEATURE.AC_OUTPUT_ENABLED, 'mppt.cfgAcEnabled');
  set(FEATURE.XBOOST_ENABLED, 'mppt.cfgAcXboost');
  set(FEATURE.DC_OUTPUT_ENABLED, 'pd.carState');
  set(FEATURE.BACKUP_RESERVE_ENABLED, 'pd.watchIsConfig');
  return values;
}
