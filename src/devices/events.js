// -----------------------------------------------------------------------------
// PURE: scene trigger detection — one event per TRANSITION, never one per
// poll (Gladys doctrine: "state vs event"; thresholds like "battery < 20 %"
// stay on the core's standard device-state triggers on the features).
//
// Keys declared in the manifest `scene_triggers` (keys are forever — never
// rename one):
//   - device_offline / device_online   the unit stopped / started answering
//   - ac_input_lost / ac_input_restored the wall socket went dead / came back
//                                       (power outage on a unit used as UPS)
//   - charge_completed                 the battery reached its charge limit
//
// The first observation of a device only seeds the state: restarting the
// integration must never fire "restored" or "online" for a state that never
// changed.
// -----------------------------------------------------------------------------

export const SCENE_TRIGGER = {
  DEVICE_OFFLINE: 'device_offline',
  DEVICE_ONLINE: 'device_online',
  AC_INPUT_LOST: 'ac_input_lost',
  AC_INPUT_RESTORED: 'ac_input_restored',
  CHARGE_COMPLETED: 'charge_completed',
};

// Consecutive identical observations needed before an AC input change is
// believed: one when the unit reports its input voltage (unambiguous), two
// when only the input power is known (a full, unloaded battery draws ~0 W
// from a live socket for a moment).
const CONFIRMATIONS = { voltage: 1, watts: 2 };

export function createEventState() {
  return {
    reachable: undefined,
    acInput: { confirmed: undefined, pending: undefined, count: 0 },
    batteryLevel: undefined,
  };
}

function eventData(externalId, summary) {
  return {
    device: externalId,
    battery_level: summary?.batteryLevel ?? null,
    output_watts: summary?.outputWatts ?? null,
  };
}

/**
 * Feed one observation of a device and get the events it triggers.
 *
 * @param {object} state      mutable per-device state from createEventState()
 * @param {object} observation `{ externalId, reachable, summary }` where
 *   `summary` (src/ecoflow/quota.js#summarizeQuota) is undefined when the
 *   poll failed
 * @returns {{ key: string, data: object }[]}
 */
export function detectEvents(state, { externalId, reachable, summary }) {
  const events = [];

  if (state.reachable !== undefined && state.reachable !== reachable) {
    events.push({
      key: reachable ? SCENE_TRIGGER.DEVICE_ONLINE : SCENE_TRIGGER.DEVICE_OFFLINE,
      data: eventData(externalId, summary),
    });
  }
  state.reachable = reachable;

  if (!summary) {
    return events;
  }

  const { acInputPresent, acInputSource } = summary;
  const ac = state.acInput;
  if (acInputPresent === undefined) {
    ac.pending = undefined;
    ac.count = 0;
  } else if (acInputPresent === ac.confirmed) {
    ac.pending = undefined;
    ac.count = 0;
  } else {
    if (ac.pending === acInputPresent) {
      ac.count += 1;
    } else {
      ac.pending = acInputPresent;
      ac.count = 1;
    }
    if (ac.count >= CONFIRMATIONS[acInputSource]) {
      if (ac.confirmed !== undefined) {
        events.push({
          key: acInputPresent ? SCENE_TRIGGER.AC_INPUT_RESTORED : SCENE_TRIGGER.AC_INPUT_LOST,
          data: eventData(externalId, summary),
        });
      }
      ac.confirmed = acInputPresent;
      ac.pending = undefined;
      ac.count = 0;
    }
  }

  const level = summary.batteryLevel;
  if (level !== undefined) {
    const limit = summary.chargeLimit ?? 100;
    if (state.batteryLevel !== undefined && state.batteryLevel < limit && level >= limit) {
      events.push({ key: SCENE_TRIGGER.CHARGE_COMPLETED, data: eventData(externalId, summary) });
    }
    state.batteryLevel = level;
  }

  return events;
}
