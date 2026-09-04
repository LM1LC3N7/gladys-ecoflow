// -----------------------------------------------------------------------------
// River 2 family command builders — transport-agnostic: each function
// validates `params` against @ecoflow-api/schemas' real, current zod schema
// (see the note on `schema.shape.params` below) and hands `{moduleType,
// operateType, params}` to whichever transport backs the device.
//
// A "transport" is anything exposing `sendCommand(sn, moduleType,
// operateType, params)` — src/ecoflow/client.js#createPublicTransport (a
// signed REST PUT) and src/ecoflow/privateClient.js#createPrivateTransport
// (an MQTT publish) both implement it, and the command shape sent is
// IDENTICAL either way: EcoFlow's own `{moduleType, operateType, params}`
// triple is transport-independent, only the envelope around it differs (see
// privateClient.js's header for how that was confirmed).
// -----------------------------------------------------------------------------

import {
  acOutCfgSchema,
  mpptCarSchema,
  chargeLimitSchema,
  dischargeLimitSchema,
  watthConfigSchema,
} from '@ecoflow-api/schemas';

/**
 * Validates only `schema.shape.params`, NOT the schema's full payload shape:
 * every one of these schemas' top-level `sn` field is
 * river2ProSerialNumberSchema (`R621...`-only, see @ecoflow-api/schemas'
 * river2Pro/setCommands/shared.ts), a Pro-specific guard that has nothing to
 * do with the actual wire format — validating the full payload against it
 * would reject a perfectly valid plain River 2 or River 2 Max serial number.
 * The `params` sub-schema is the part that actually varies per command and
 * is worth validating client-side; moduleType/operateType are already the
 * exact literals this module hardcodes per call site below.
 */
async function sendCommand(transport, sn, moduleType, operateType, params, schema) {
  schema.shape.params.parse(params);
  return transport.sendCommand(sn, moduleType, operateType, params);
}

/**
 * AC output: on/off, X-Boost, voltage and frequency all travel together in
 * one `acOutCfg` command (confirmed against @ecoflow-api/schemas' acOutCfgSchema
 * — unlike the reverse-engineered private *device* protocol, this schema
 * requires real integers for every field, no "leave as-is" sentinel).
 * `outVoltage`/`outFreq` should be the device's own last-reported
 * `mppt.cfgAcOutVol`/`mppt.cfgAcOutFreq` whenever known — see
 * src/devices/device.js#acOutCfgParams for the fallback used before the
 * first quota poll completes.
 */
export function setAcOutput(transport, sn, { enabled, xboost, outVoltage, outFreq }) {
  return sendCommand(
    transport,
    sn,
    5,
    'acOutCfg',
    { enabled, xboost, out_voltage: outVoltage, out_freq: outFreq },
    acOutCfgSchema,
  );
}

/** 12V DC (car) output on/off. */
export function setDcOutput(transport, sn, enabled) {
  return sendCommand(transport, sn, 5, 'mpptCar', { enabled }, mpptCarSchema);
}

/** Max charge level (0-100%). */
export function setChargeLimit(transport, sn, maxChgSoc) {
  return sendCommand(transport, sn, 2, 'upsConfig', { maxChgSoc }, chargeLimitSchema);
}

/** Min discharge level / battery backup reserve floor (0-100%). */
export function setDischargeLimit(transport, sn, minDsgSoc) {
  return sendCommand(transport, sn, 2, 'dsgCfg', { minDsgSoc }, dischargeLimitSchema);
}

/**
 * Backup reserve (energy management) on/off. minDsgSoc/minChgSoc are fixed at
 * 0 here (Discharge/Charge limit above own those settings independently) —
 * matches the shape watthConfigSchema requires; only `isConfig` (on/off) and
 * `bpPowerSoc` (the reserve level) are meaningfully controlled through this
 * command in this integration.
 */
export function setBackupReserve(transport, sn, { isConfig, bpPowerSoc }) {
  return sendCommand(
    transport,
    sn,
    1,
    'watthConfig',
    { isConfig, bpPowerSoc, minDsgSoc: 0, minChgSoc: 0 },
    watthConfigSchema,
  );
}
