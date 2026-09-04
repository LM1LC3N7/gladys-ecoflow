// -----------------------------------------------------------------------------
// Transport for the official EcoFlow Open Platform REST API (the primary,
// recommended onboarding method — see src/ecoflow/privateClient.js for the
// simpler-but-unofficial alternative this integration also offers).
//
// Request signing lives in src/ecoflow/signing.js, hand-written on top of
// Node's built-in `node:crypto`+`fetch` rather than `@ecoflow-api/rest-client`
// — see that file's header for why (a broken import in the published 0.6.0
// build makes the package crash on load for every consumer). Every request/
// response shape, though, still comes straight from `@ecoflow-api/schemas`
// (MIT, github.com/rustyy/ecoflow-api) — that package has no such bug (pure
// zod, no cross-package import) and is exactly the "reuse an existing
// library" piece that matters here: the confirmed, typed wire format for the
// whole River 2 family. Command *shapes* (`{moduleType, operateType,
// params}`) live in src/ecoflow/commands.js, shared with the private/MQTT
// transport — this file only implements how to deliver one.
//
// River 2 (non-Pro) has no dedicated class in @ecoflow-api/rest-client
// (only Delta2/DeltaPro/DeltaPro3/Glacier/PowerStream/SmartHomePanel/
// SmartPlug/River2Pro do — it would have fallen back to a generic
// UnknownDevice). The whole River 2 family (River 2, River 2 Max, River 2
// Pro) shares the same PD/MPPT/BMS module architecture though (confirmed
// against both @ecoflow-api/schemas' river2Pro schemas AND tolwi/hassio-
// ecoflow-cloud's internal/river2.py, river2_max.py, river2_pro.py all
// sharing one sensor/command map), so this module reuses the river2Pro
// schemas — correct for the whole family, not just the Pro model.
// -----------------------------------------------------------------------------

import { randomInt } from 'node:crypto';
import {
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

async function request(
  credentials,
  apiHost,
  method,
  path,
  { query, body, fetchImpl = fetch } = {},
) {
  const nonce = String(randomInt(10000, 1000000));
  const timestamp = String(Date.now());
  const signature = computeSignature(credentials, { nonce, timestamp, data: query ?? body });

  const url = new URL(path, apiHost);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetchImpl(url, {
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
 * Everything below needs — deliberately the same tiny shape
 * `@ecoflow-api/rest-client`'s RestClient exposes (getDevicesPlain/
 * getDevicePropertiesPlain/setCommandPlain), so a future fixed release of
 * that package could be swapped back in here without touching any other
 * file. Not exported: nothing outside this module needs this shape
 * specifically, only the higher-level transport createPublicTransport()
 * builds on top of it — see test/client.test.js for how this is tested (a
 * fake `fetchImpl`, not a fake of this object).
 */
function createEcoflowClient(config, fetchImpl) {
  const credentials = { accessKey: config.access_key, secretKey: config.secret_key };
  const apiHost = config.api_host;

  return {
    async getDevicesPlain() {
      const json = await request(credentials, apiHost, 'GET', ENDPOINTS.deviceList, { fetchImpl });
      return deviceListResponseSchema.parse(json);
    },
    async getDevicePropertiesPlain(sn) {
      const json = await request(credentials, apiHost, 'GET', ENDPOINTS.deviceQuota, {
        query: { sn },
        fetchImpl,
      });
      return quotaAllResponseSchema.parse(json);
    },
    async setCommandPlain(payload) {
      const json = await request(credentials, apiHost, 'PUT', ENDPOINTS.setCmd, {
        body: payload,
        fetchImpl,
      });
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

/**
 * The Open Platform transport: `{ listDevices(), getQuota(sn),
 * sendCommand(sn, moduleType, operateType, params) }`. `listDevices()` is
 * only present here — the private/MQTT transport (privateClient.js) has no
 * equivalent, EcoFlow's app-facing API has no "list my devices" endpoint.
 */
export function createPublicTransport(config, { fetchImpl = fetch } = {}) {
  const client = createEcoflowClient(config, fetchImpl);

  return {
    /** Every device bound to this EcoFlow account: `{ sn, name, online }[]`. */
    async listDevices() {
      const response = await client.getDevicesPlain();
      return response.data.map((device) => ({
        sn: device.sn,
        name: device.deviceName || device.productName || device.sn,
        online: device.online === 1,
      }));
    },

    /** The full quota (telemetry) snapshot for one device, as a flat dotted-key object. */
    async getQuota(sn) {
      const response = await client.getDevicePropertiesPlain(sn);
      return response.data || {};
    },

    async sendCommand(sn, moduleType, operateType, params) {
      const payload = { sn, id: nextId(), version: '1.0', moduleType, operateType, params };
      await client.setCommandPlain(payload);
    },
  };
}
