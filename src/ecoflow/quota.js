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
// Only fields with a clean, unambiguous fit in Gladys' device-feature
// taxonomy are mapped as features. The numeric settings (charge/discharge
// limit, backup-reserve level, AC charging power) are NOT features:
// BATTERY_STORAGE has no "target level" type distinct from BATTERY_LEVEL, so
// they are read through summarizeQuota() (shown by the dashboard widget, see
// src/widget.js) and written through scene actions (src/sceneActions.js).
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
  DISCHARGE_REMAINING_TIME: 'discharge_remaining_time',
  CHARGING: 'charging',
};

// EcoFlow reports 5999 minutes (~100 h) for "not discharging / unknown".
const REMAINING_TIME_SENTINEL = 5999;

// Net power into the battery above which it counts as charging, in W — a
// margin over the few watts of measurement noise an idle unit reports.
const CHARGING_THRESHOLD_WATTS = 10;

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
    {
      name: 'Discharge remaining time',
      external_id: featureExternalId(deviceExternalId, FEATURE.DISCHARGE_REMAINING_TIME),
      category: DEVICE_FEATURE_CATEGORIES.DURATION,
      type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
      unit: DEVICE_FEATURE_UNITS.MINUTES,
      min: 0,
      max: REMAINING_TIME_SENTINEL,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
    {
      name: 'Charging',
      external_id: featureExternalId(deviceExternalId, FEATURE.CHARGING),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.CHARGING,
      min: 0,
      max: 1,
      read_only: true,
      has_feedback: false,
      keep_history: true,
    },
  ];
}

function numberOrUndefined(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Remaining discharge time in minutes, or undefined while EcoFlow reports its sentinel. */
function remainingMinutes(quota) {
  const raw = numberOrUndefined(quota['bms_emsStatus.dsgRemainTime']);
  return raw !== undefined && raw >= 0 && raw < REMAINING_TIME_SENTINEL ? raw : undefined;
}

/**
 * Whether the battery is being charged, derived from the power balance
 * (AC + solar in, total out): EcoFlow's own charge-state flag is not in the
 * confirmed schema. Undefined when none of the power fields is reported.
 */
function isCharging(quota) {
  const acIn = numberOrUndefined(quota['inv.inputWatts']);
  const solarIn = numberOrUndefined(quota['mppt.inWatts']);
  const out = numberOrUndefined(quota['pd.wattsOutSum']);
  if (acIn === undefined && solarIn === undefined && out === undefined) {
    return undefined;
  }
  const soc = numberOrUndefined(quota['pd.soc']);
  const net = (acIn ?? 0) + (solarIn ?? 0) - (out ?? 0);
  return net > CHARGING_THRESHOLD_WATTS && (soc === undefined || soc < 100) ? 1 : 0;
}

/**
 * Whether the AC input (wall socket) is powered, and how sure we are:
 * `voltage` when the unit reports its AC input voltage (`inv.acInVol`, not
 * part of the confirmed schema but present on the real quota map), `watts`
 * when only the AC input power is known — a full battery with no load draws
 * ~0 W from a live socket, so callers debounce that weaker signal.
 */
function acInputState(quota) {
  const voltage = numberOrUndefined(quota['inv.acInVol']);
  if (voltage !== undefined) {
    // > 50 works whether the unit reports volts or millivolts.
    return { present: voltage > 50, source: 'voltage' };
  }
  const watts = numberOrUndefined(quota['inv.inputWatts']);
  if (watts !== undefined) {
    return { present: watts > 0, source: 'watts' };
  }
  return { present: undefined, source: undefined };
}

/**
 * Human-level summary of one quota snapshot, for the dashboard widget, the
 * scene triggers and the `refresh` scene action. Every field is undefined
 * when the quota does not report it.
 */
export function summarizeQuota(quota = {}) {
  const acInput = acInputState(quota);
  return {
    batteryLevel: numberOrUndefined(quota['pd.soc']),
    acInputWatts: numberOrUndefined(quota['inv.inputWatts']),
    solarInputWatts: numberOrUndefined(quota['mppt.inWatts']),
    outputWatts: numberOrUndefined(quota['pd.wattsOutSum']),
    remainingMinutes: remainingMinutes(quota),
    charging: isCharging(quota),
    acInputPresent: acInput.present,
    acInputSource: acInput.source,
    acEnabled: numberOrUndefined(quota['mppt.cfgAcEnabled']),
    xboostEnabled: numberOrUndefined(quota['mppt.cfgAcXboost']),
    dcEnabled: numberOrUndefined(quota['pd.carState']),
    reserveEnabled: numberOrUndefined(quota['pd.watchIsConfig']),
    reserveLevel: numberOrUndefined(quota['pd.bpPowerSoc']),
    chargeLimit: numberOrUndefined(quota['bms_emsStatus.maxChargeSoc']),
    dischargeLimit: numberOrUndefined(quota['bms_emsStatus.minDsgSoc']),
  };
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
  const remaining = remainingMinutes(quota);
  if (remaining !== undefined) {
    values[FEATURE.DISCHARGE_REMAINING_TIME] = remaining;
  }
  const charging = isCharging(quota);
  if (charging !== undefined) {
    values[FEATURE.CHARGING] = charging;
  }
  return values;
}
