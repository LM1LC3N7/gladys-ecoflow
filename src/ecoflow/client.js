// -----------------------------------------------------------------------------
// Client for the official EcoFlow Open Platform REST API.
//
// Request signing lives in src/ecoflow/signing.js, hand-written on top of
// Node's built-in `node:crypto`+`fetch` rather than `@ecoflow-api/rest-client`
// — see that file's header for why (a broken import in the published 0.6.0
// build makes the package crash on load for every consumer). Every request/
// response and command SHAPE, though, still comes straight from
// `@ecoflow-api/schemas` (MIT, github.com/rustyy/ecoflow-api) — that package
// has no such bug (pure zod, no cross-package import) and is exactly the
// "reuse an existing library" piece that matters here: the confirmed, typed
// wire format for the whole River 2 family.
//
// River 2 (non-Pro) has no dedicated class in @ecoflow-api/rest-client
// (only Delta2/DeltaPro/DeltaPro3/Glacier/PowerStream/SmartHomePanel/
// SmartPlug/River2Pro do — it would have fallen back to a generic
// UnknownDevice). The whole River 2 family (River 2, River 2 Max, River 2
// Pro) shares the same PD/MPPT/BMS module architecture though (confirmed
// against both @ecoflow-api/schemas' river2Pro schemas AND tolwi/hassio-
// ecoflow-cloud's internal/river2.py, river2_max.py, river2_pro.py all
// sharing one sensor/command map), so this module reuses the river2Pro
// command schemas for validation — correct for the whole family, not just
// the Pro model.
//
// Why REST-only, no MQTT, for v0.1: EcoFlow's Open Platform also offers
// real-time MQTT push (a /certification endpoint hands back broker
// credentials), but the exact shape of a *push* message on the
// `/open/.../quota` topic (grouped by module, needing a further
// un-flattening step) could not be verified against a real device in this
// environment — see the README's "Tested and confirmed" section. Polling
// device/quota/all on a timer (src/devices/index.js) is slower but its
// response shape is exactly what river2ProQuotaAllSchema documents, so it
// is the correct place to start; MQTT push is a natural fast-follow (see
// the README's "Possible follow-ups").
// -----------------------------------------------------------------------------

import { randomInt } from 'node:crypto';
import {
  acOutCfgSchema,
  mpptCarSchema,
  chargeLimitSchema,
  dischargeLimitSchema,
  watthConfigSchema,
  deviceListResponseSchema,
  quotaAllResponseSchema,
  setCommandResponseSchema,
  errorResponseSchema,
} from '@ecoflow-api/schemas';
import { computeSignature } from './signing.js';

const ENDPOINTS = {
  deviceList: '/iot-open/sign/device/list',
  deviceQuota: '/iot-open/sign/device/quota/all',
  setCmd: '/iot-open/sign/device/quota',
};

async function request(credentials, apiHost, method, path, { query, body } = {}) {
  const nonce = String(randomInt(10000, 1000000));
  const timestamp = String(Date.now());
  const signature = computeSignature(credentials, { nonce, timestamp, data: query ?? body });

  const url = new URL(path, apiHost);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method,
    headers: {
      accessKey: credentials.accessKey,
      nonce,
      timestamp,
      sign: signature,
      'Content-Type': 'application/json;charset=UTF-8',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = await response.json();
  if (response.status !== 200) {
    throw new Error(
      `EcoFlow API request failed with HTTP ${response.status}: ${JSON.stringify(json)}`,
    );
  }
  const parsedError = errorResponseSchema.safeParse(json);
  if (parsedError.success) {
    throw new Error(`code: ${parsedError.data.code} | message: ${parsedError.data.message}`);
  }
  return json;
}

/**
 * Everything src/ecoflow/client.js's own functions below need — deliberately
 * the same tiny shape @ecoflow-api/rest-client's RestClient exposes
 * (getDevicesPlain/getDevicePropertiesPlain/setCommandPlain), so a future
 * fixed release of that package could be swapped back in here without
 * touching any other file (or a test — test-fixtures/fakeEcoflowClient.js
 * mocks the exact same three methods).
 */
export function createEcoflowClient(config) {
  const credentials = { accessKey: config.access_key, secretKey: config.secret_key };
  const apiHost = config.api_host;

  return {
    async getDevicesPlain() {
      const json = await request(credentials, apiHost, 'GET', ENDPOINTS.deviceList);
      return deviceListResponseSchema.parse(json);
    },
    async getDevicePropertiesPlain(sn) {
      const json = await request(credentials, apiHost, 'GET', ENDPOINTS.deviceQuota, {
        query: { sn },
      });
      return quotaAllResponseSchema.parse(json);
    },
    async setCommandPlain(payload) {
      const json = await request(credentials, apiHost, 'PUT', ENDPOINTS.setCmd, { body: payload });
      return setCommandResponseSchema.parse(json);
    },
  };
}

// EcoFlow's `id` field is an opaque per-request integer the API does not
// otherwise interpret (confirmed: River2Pro.ts in @ecoflow-api/rest-client
// hardcodes the same literal 123456789 for every request) — a process-local
// counter is enough, no need for it to be globally unique.
let nextCommandId = 100000;
function nextId() {
  nextCommandId += 1;
  return nextCommandId;
}

/** Every device bound to this EcoFlow account: `{ sn, name, online }[]`. */
export async function listDevices(client) {
  const response = await client.getDevicesPlain();
  return response.data.map((device) => ({
    sn: device.sn,
    name: device.deviceName || device.productName || device.sn,
    online: device.online === 1,
  }));
}

/** The full quota (telemetry) snapshot for one device, as a flat dotted-key object. */
export async function getQuota(client, sn) {
  const response = await client.getDevicePropertiesPlain(sn);
  return response.data || {};
}

/**
 * Validates only `schema.shape.params`, NOT the full `schema.parse(payload)`:
 * every one of these schemas' top-level `sn` field is
 * river2ProSerialNumberSchema (`R621...`-only, see @ecoflow-api/schemas'
 * river2Pro/setCommands/shared.ts), a Pro-specific guard that has nothing to
 * do with the actual wire format — validating the full payload against it
 * would reject a perfectly valid plain River 2 or River 2 Max serial number.
 * The `params` sub-schema is the part that actually varies per command and
 * is worth validating client-side; moduleType/operateType are already the
 * exact literals this module hardcodes per call site below.
 */
async function sendCommand(client, sn, moduleType, operateType, params, schema) {
  schema.shape.params.parse(params);
  const payload = { sn, id: nextId(), version: '1.0', moduleType, operateType, params };
  return client.setCommandPlain(payload);
}

/**
 * AC output: on/off, X-Boost, voltage and frequency all travel together in
 * one `acOutCfg` command (confirmed against @ecoflow-api/schemas' acOutCfgSchema
 * — unlike the reverse-engineered private API, the public API's schema
 * requires real integers for every field, no "leave as-is" sentinel).
 * `outVoltage`/`outFreq` should be the device's own last-reported
 * `mppt.cfgAcOutVol`/`mppt.cfgAcOutFreq` whenever known — see
 * src/devices/device.js#acOutCfgParams for the fallback used before the
 * first quota poll completes.
 */
export function setAcOutput(client, sn, { enabled, xboost, outVoltage, outFreq }) {
  return sendCommand(
    client,
    sn,
    5,
    'acOutCfg',
    { enabled, xboost, out_voltage: outVoltage, out_freq: outFreq },
    acOutCfgSchema,
  );
}

/** 12V DC (car) output on/off. */
export function setDcOutput(client, sn, enabled) {
  return sendCommand(client, sn, 5, 'mpptCar', { enabled }, mpptCarSchema);
}

/** Max charge level (0-100%). */
export function setChargeLimit(client, sn, maxChgSoc) {
  return sendCommand(client, sn, 2, 'upsConfig', { maxChgSoc }, chargeLimitSchema);
}

/** Min discharge level / battery backup reserve floor (0-100%). */
export function setDischargeLimit(client, sn, minDsgSoc) {
  return sendCommand(client, sn, 2, 'dsgCfg', { minDsgSoc }, dischargeLimitSchema);
}

/**
 * Backup reserve (energy management) on/off. minDsgSoc/minChgSoc are fixed at
 * 0 here (Discharge/Charge limit above own those settings independently) —
 * matches the shape watthConfigSchema requires; only `isConfig` (on/off) and
 * `bpPowerSoc` (the reserve level) are meaningfully controlled through this
 * command in this integration.
 */
export function setBackupReserve(client, sn, { isConfig, bpPowerSoc }) {
  return sendCommand(
    client,
    sn,
    1,
    'watthConfig',
    { isConfig, bpPowerSoc, minDsgSoc: 0, minChgSoc: 0 },
    watthConfigSchema,
  );
}
