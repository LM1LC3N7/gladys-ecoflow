// -----------------------------------------------------------------------------
// EcoFlow "private" login: the same email/password + MQTT path the EcoFlow
// mobile app itself uses — offered as a second, simpler onboarding method
// alongside the official Open Platform API (src/ecoflow/client.js): no
// developer account, no approval wait, just the same email/password used to
// sign in to the EcoFlow app. Reverse-engineered and confirmed against
// tolwi/hassio-ecoflow-cloud's api/private_api.py + api/__init__.py +
// devices/__init__.py (MIT, the Home Assistant EcoFlow integration) — read
// directly, not executed.
//
// Trade-offs, made explicit rather than hidden (see also docs/en.md/fr.md):
//   - UNOFFICIAL: these are EcoFlow's internal app endpoints, not the
//     documented Open Platform API. They can change without notice, and
//     nobody at EcoFlow supports this path.
//   - NO device discovery: even the app-facing private API has no "list my
//     devices" endpoint the reference implementation above uses — the user
//     enters each device's serial number by hand (config
//     `private_device_sns`, see src/config.js and src/devices/index.js).
//   - MQTT only, no REST snapshot: quota is fetched by publishing a
//     `latestQuotas` request to the device's own MQTT topic and awaiting the
//     reply on that SAME topic (already scoped by account+device, so no
//     request-id correlation is needed) — see requestQuota() below.
//
// The wire format past login is IDENTICAL to the public API for everything
// this integration cares about: the quota reply's `data.quotaMap` is the
// same flat dotted-key object `river2ProQuotaAllSchema` documents
// (src/ecoflow/quota.js is reused unchanged for both transports), and a
// command is the exact same `{moduleType, operateType, params}` triple
// src/ecoflow/commands.js already builds and validates — only the envelope
// around it differs: `{sn, id, version}` for a REST PUT (client.js) vs
// `{from, id, version}` published over MQTT (buildEnvelope() below).
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

const API_HOST = 'https://api.ecoflow.com';
const QUOTA_REPLY_TIMEOUT_MS = 10_000;

async function request(method, path, { token, body, fetchImpl = fetch } = {}) {
  const headers = { 'content-type': 'application/json', lang: 'en_US' };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetchImpl(`${API_HOST}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await response.json();
  if (String(json.message ?? '').toLowerCase() !== 'success') {
    throw new Error(`code: ${json.code} | message: ${json.message}`);
  }
  return json;
}

/** Log in with the same email/password the EcoFlow app uses. Returns `{ token, userId }`. */
export async function login(username, password, { fetchImpl = fetch } = {}) {
  const json = await request('POST', '/auth/login', {
    fetchImpl,
    body: {
      email: username,
      password: Buffer.from(password, 'utf8').toString('base64'),
      scene: 'IOT_APP',
      userType: 'ECOFLOW',
    },
  });
  return { token: json.data.token, userId: json.data.user.userId };
}

/** MQTT broker credentials for the logged-in account — same response shape as the public API's. */
export async function getMqttCredentials(token, { fetchImpl = fetch } = {}) {
  const json = await request('GET', '/iot-auth/app/certification', { token, fetchImpl });
  return {
    url: json.data.url,
    port: Number(json.data.port),
    username: json.data.certificateAccount,
    password: json.data.certificatePassword,
  };
}

/** The four `/app/...` topics EcoFlow's app-facing MQTT uses for one device. */
export function buildTopics(userId, sn) {
  const base = `/app/${userId}/${sn}/thing/property`;
  return { get: `${base}/get`, getReply: `${base}/get_reply`, set: `${base}/set` };
}

let nextEnvelopeId = 100000;
/** Wraps a `{moduleType, operateType, params}` (or `latestQuotas`) command for MQTT publish. */
export function buildEnvelope(command) {
  nextEnvelopeId += 1;
  return { from: 'Gladys', id: nextEnvelopeId, version: '1.0', ...command };
}

/** The `sn` a `.../thing/property/get_reply` topic belongs to, or undefined. */
export function snFromGetReplyTopic(topic, userId) {
  const match = new RegExp(`^/app/${userId}/([^/]+)/thing/property/get_reply$`).exec(topic);
  return match?.[1];
}

/**
 * The private-API transport: `{ getQuota(sn), sendCommand(sn, moduleType,
 * operateType, params), disconnect() }` — same shape client.js's
 * createPublicTransport() exposes (minus listDevices(), see this file's
 * header), so src/devices/ needn't know which one backs a given device.
 * Login + the MQTT connection are established lazily, on first use, and
 * reused across calls.
 */
export function createPrivateTransport(
  config,
  { fetchImpl = fetch, mqttConnect = mqtt.connectAsync } = {},
) {
  let session = null;

  async function ensureSession() {
    if (session?.client?.connected) {
      return session;
    }
    const { token, userId } = await login(config.private_username, config.private_password, {
      fetchImpl,
    });
    const creds = await getMqttCredentials(token, { fetchImpl });
    const clientId = `ANDROID_${randomUUID().replace(/-/g, '').toUpperCase()}_${userId}`;
    const client = await mqttConnect(`mqtts://${creds.url}:${creds.port}`, {
      username: creds.username,
      password: creds.password,
      clientId,
      clean: true,
      reconnectPeriod: 5000,
      connectTimeout: 15000,
    });
    const pending = new Map(); // sn -> { resolve, reject, timer }
    client.on('message', (topic, payload) => {
      const sn = snFromGetReplyTopic(topic, userId);
      const waiter = sn && pending.get(sn);
      if (!waiter) {
        return;
      }
      pending.delete(sn);
      clearTimeout(waiter.timer);
      try {
        const data = JSON.parse(payload.toString('utf8'));
        waiter.resolve(data?.operateType === 'latestQuotas' ? (data.data?.quotaMap ?? {}) : {});
      } catch (err) {
        waiter.reject(err);
      }
    });
    session = { userId, client, pending };
    return session;
  }

  /** The full quota snapshot for one device: publish a `latestQuotas` request, await its reply. */
  async function getQuota(sn) {
    const s = await ensureSession();
    const topics = buildTopics(s.userId, sn);
    await s.client.subscribeAsync(topics.getReply, { qos: 1 });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(sn);
        reject(new Error(`Timed out waiting for a quota reply from ${sn}`));
      }, QUOTA_REPLY_TIMEOUT_MS);
      s.pending.set(sn, { resolve, reject, timer });

      const message = buildEnvelope({
        version: '1.1',
        moduleType: 0,
        operateType: 'latestQuotas',
        params: {},
      });
      s.client.publishAsync(topics.get, JSON.stringify(message), { qos: 1 }).catch((err) => {
        clearTimeout(timer);
        s.pending.delete(sn);
        reject(err);
      });
    });
  }

  async function sendCommand(sn, moduleType, operateType, params) {
    const s = await ensureSession();
    const topics = buildTopics(s.userId, sn);
    const message = buildEnvelope({ moduleType, operateType, params });
    await s.client.publishAsync(topics.set, JSON.stringify(message), { qos: 1 });
  }

  async function disconnect() {
    if (session?.client) {
      await session.client.endAsync();
    }
    session = null;
  }

  return { getQuota, sendCommand, disconnect };
}

// Test-only: reset the module-local envelope id counter so a test asserting
// on exact ids isn't order-dependent on other test files. Not used by
// production code.
export function __resetEnvelopeIdForTesting() {
  nextEnvelopeId = 100000;
}
