// -----------------------------------------------------------------------------
// Scene actions declared in the manifest `scene_actions` (Gladys >= 5.1):
// the numeric settings of the River 2 family, which have no matching device
// feature type in Gladys' taxonomy (see src/ecoflow/quota.js's header), plus
// an on-demand refresh whose outputs feed the following steps of a scene.
//
// The core resolves and validates `fields` before calling a handler; every
// value is still re-checked here (and by @ecoflow-api/schemas in
// src/ecoflow/commands.js) since a wrong value would reach a real unit.
// Keys are forever: never rename one, a renamed key breaks every scene using it.
// -----------------------------------------------------------------------------

import {
  setAcCharging,
  setBackupReserve,
  setChargeLimit,
  setDischargeLimit,
} from './ecoflow/commands.js';
import { summarizeQuota } from './ecoflow/quota.js';
import { getRegisteredDevice, refreshQuota } from './devices/device.js';

export const SCENE_ACTION = {
  SET_CHARGE_LIMIT: 'set_charge_limit',
  SET_DISCHARGE_LIMIT: 'set_discharge_limit',
  SET_BACKUP_RESERVE: 'set_backup_reserve',
  SET_AC_CHARGING: 'set_ac_charging',
  REFRESH: 'refresh',
};

// Bounds shared with the manifest (test/manifest.test.js checks they match).
export const BOUNDS = {
  chargeLimit: { min: 50, max: 100 },
  dischargeLimit: { min: 0, max: 30 },
  reserveLevel: { min: 5, max: 100 },
  acChargingWatts: { min: 100, max: 1200 },
};

function entryFor(fields) {
  const entry = getRegisteredDevice(fields.device);
  if (!entry) {
    throw new Error(`EcoFlow device ${fields.device} is not known — run a Discovery scan first`);
  }
  return entry;
}

function boundedInteger(value, { min, max }, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max} (got ${value})`);
  }
  return number;
}

function toBoolean(value) {
  return value === true || value === 1 || value === 'true' || value === '1';
}

/**
 * @param {object} deps
 * @param {(externalId: string) => void} deps.afterCommand called once a
 *   command was accepted, to schedule a confirming re-poll and refresh the
 *   dashboard widget (src/app.js)
 * @param {(externalId: string, quota: object) => Promise<void>} deps.applyFreshQuota
 *   publishes a freshly fetched quota (src/app.js)
 * @returns {Record<string, (fields: object) => Promise<object | undefined>>}
 */
export function createSceneActionHandlers({ afterCommand, applyFreshQuota }) {
  return {
    async [SCENE_ACTION.SET_CHARGE_LIMIT](fields) {
      const entry = entryFor(fields);
      const percent = boundedInteger(fields.max_percent, BOUNDS.chargeLimit, 'max_percent');
      await setChargeLimit(entry.transport, entry.sn, percent);
      afterCommand(fields.device);
      return undefined;
    },

    async [SCENE_ACTION.SET_DISCHARGE_LIMIT](fields) {
      const entry = entryFor(fields);
      const percent = boundedInteger(fields.min_percent, BOUNDS.dischargeLimit, 'min_percent');
      await setDischargeLimit(entry.transport, entry.sn, percent);
      afterCommand(fields.device);
      return undefined;
    },

    async [SCENE_ACTION.SET_BACKUP_RESERVE](fields) {
      const entry = entryFor(fields);
      let level;
      if (fields.level === undefined || fields.level === null || fields.level === '') {
        const quota =
          entry.lastQuota['pd.bpPowerSoc'] === undefined
            ? await refreshQuota(entry)
            : entry.lastQuota;
        level = quota['pd.bpPowerSoc'];
        if (level === undefined) {
          throw new Error(
            `${entry.sn} has not reported its reserve level yet — set "level" explicitly`,
          );
        }
      } else {
        level = boundedInteger(fields.level, BOUNDS.reserveLevel, 'level');
      }
      await setBackupReserve(entry.transport, entry.sn, {
        isConfig: toBoolean(fields.enabled) ? 1 : 0,
        bpPowerSoc: level,
      });
      afterCommand(fields.device);
      return undefined;
    },

    async [SCENE_ACTION.SET_AC_CHARGING](fields) {
      const entry = entryFor(fields);
      const watts = boundedInteger(fields.watts, BOUNDS.acChargingWatts, 'watts');
      await setAcCharging(entry.transport, entry.sn, {
        chgWatts: watts,
        paused: toBoolean(fields.paused),
      });
      afterCommand(fields.device);
      return undefined;
    },

    async [SCENE_ACTION.REFRESH](fields) {
      const entry = entryFor(fields);
      const quota = await refreshQuota(entry);
      await applyFreshQuota(fields.device, quota);
      const summary = summarizeQuota(quota);
      const outputs = {
        battery_level: summary.batteryLevel,
        remaining_minutes: summary.remainingMinutes,
        input_watts:
          summary.acInputWatts === undefined && summary.solarInputWatts === undefined
            ? undefined
            : (summary.acInputWatts ?? 0) + (summary.solarInputWatts ?? 0),
        output_watts: summary.outputWatts,
        charging: summary.charging === undefined ? undefined : summary.charging === 1,
      };
      // Outputs are scalars only: drop what the unit did not report.
      return Object.fromEntries(Object.entries(outputs).filter(([, v]) => v !== undefined));
    },
  };
}
