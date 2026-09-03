// -----------------------------------------------------------------------------
// EcoFlow Open Platform request signing (HMAC-SHA256).
//
// Hand-written on top of Node's built-in `node:crypto`, NOT
// `@ecoflow-api/rest-client`: that package's published 0.6.0 build contains a
// broken internal import (`require("@ecoflow-api/schemas/src/river2Pro/
// setCommands/bms")` — a deep source-path require that can never resolve
// against the published, dist-only `@ecoflow-api/schemas` package) which
// throws at module load for every consumer, unconditionally — confirmed by
// this repo's own test suite failing on nothing more than importing
// `RestClient`. `@ecoflow-api/schemas` itself (pure zod schemas, no such
// import) is unaffected and still used throughout src/ecoflow/client.js for
// validating every request/response shape — see that file's header, and
// gladys-lubluelu-vaccum's own src/tuya/cloud.js for the same reasoning
// applied to a different cloud API ("small and specific enough... pulling in
// a full SDK wasn't worth it" — here it flipped from "wasn't worth it" to
// "wasn't usable").
//
// The algorithm below is cross-confirmed against two independent, live-used
// implementations, read directly (not executed, to sidestep the broken
// build above): tolwi/hassio-ecoflow-cloud's api/public_api.py (the Home
// Assistant EcoFlow integration, MIT, thousands of real users) and
// rustyy/ecoflow-api's own SignatureBuilder/flattenObject source:
//   1. flatten the data being signed (GET: its query params; PUT: its JSON
//      body, nested objects flattened to dotted keys, e.g. `params.enabled`);
//   2. sort the flattened keys, join as "key=value" pairs with "&";
//   3. append "accessKey=<accessKey>&nonce=<nonce>&timestamp=<timestamp>"
//      (prefixed with "&" only when step 1-2 produced anything);
//   4. HMAC-SHA256 the result with the secretKey, hex digest.
// -----------------------------------------------------------------------------

import { createHmac } from 'node:crypto';

/**
 * Nested-object -> flat `{ "a.b": 1 }`-style key/value pairs. This
 * integration's own request bodies (see src/ecoflow/client.js) never contain
 * arrays, so unlike the reference implementations this does not special-case
 * them — a plain object flatten is enough and stays simple.
 */
export function flattenObject(obj, parentKey = '') {
  const flattened = {};
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const propName = parentKey ? `${parentKey}.${key}` : key;
    if (value !== null && typeof value === 'object') {
      Object.assign(flattened, flattenObject(value, propName));
    } else {
      flattened[propName] = value;
    }
  }
  return flattened;
}

function buildDataString(data) {
  const flattened = flattenObject(data ?? {});
  return Object.keys(flattened)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => `${key}=${flattened[key]}`)
    .join('&');
}

/**
 * @param {{accessKey: string, secretKey: string}} credentials
 * @param {{nonce: string, timestamp: string, data?: object}} request `data`
 *   is the query params (GET) or JSON body (PUT) being sent, if any.
 * @returns {string} the hex-encoded HMAC-SHA256 signature for the `sign` header.
 */
export function computeSignature({ accessKey, secretKey }, { nonce, timestamp, data }) {
  const dataString = buildDataString(data);
  const suffix = `accessKey=${accessKey}&nonce=${nonce}&timestamp=${timestamp}`;
  const message = dataString ? `${dataString}&${suffix}` : suffix;
  return createHmac('sha256', secretKey).update(message).digest('hex');
}
