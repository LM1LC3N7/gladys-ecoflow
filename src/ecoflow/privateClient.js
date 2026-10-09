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
import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'ecoflow-private' });

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
 * The private-API transport: `{ connect(), getQuota(sn), sendCommand(sn,
 * moduleType, operateType, params), disconnect() }` — same shape client.js's
 * createPublicTransport() exposes (minus listDevices(), see this file's
 * header), so src/devices/ needn't know which one backs a given device.
 *
 * Session rules:
 *   - one login + MQTT connection at a time: concurrent callers share the
 *     same in-flight connection attempt instead of each opening their own;
 *   - a session whose client is no longer connected is ended BEFORE a fresh
 *     one is opened, so a network blip never leaves an orphan client
 *     reconnecting in the background;
 *   - concurrent quota requests for the same device all resolve on the same
 *     `get_reply` (the topic carries no request id to tell them apart);
 *   - once disconnect() ran, the transport is closed for good: a transport
 *     replaced after a configuration change can never log back in with the
 *     old credentials.
 */
export function createPrivateTransport(
  config,
  { fetchImpl = fetch, mqttConnect = mqtt.connectAsync } = {},
) {
  let session = null;
  let connecting = null;
  let closed = false;

  function failPending(s, error) {
    for (const waiters of s.pending.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
      }
    }
    s.pending.clear();
  }

  async function endSession(s) {
    failPending(s, new Error('EcoFlow MQTT session closed'));
    await s.client.endAsync(true).catch(() => {});
  }

  async function openSession() {
    if (session) {
      const stale = session;
      session = null;
      await endSession(stale);
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
    const pending = new Map(); // sn -> [{ resolve, reject, timer }]
    const opened = { userId, client, pending };
    if (closed) {
      await endSession(opened);
      throw new Error('EcoFlow private transport is closed');
    }
    client.on('error', (err) => logger.warn(`EcoFlow MQTT error: ${err.message}`));
    client.on('offline', () => logger.debug('EcoFlow MQTT connection lost, reconnecting'));
    client.on('message', (topic, payload) => {
      const sn = snFromGetReplyTopic(topic, userId);
      const waiters = sn && pending.get(sn);
      if (!waiters) {
        return;
      }
      pending.delete(sn);
      let quota;
      try {
        const data = JSON.parse(payload.toString('utf8'));
        quota = data?.operateType === 'latestQuotas' ? (data.data?.quotaMap ?? {}) : {};
      } catch (err) {
        for (const waiter of waiters) {
          clearTimeout(waiter.timer);
          waiter.reject(err);
        }
        return;
      }
      for (const waiter of waiters) {
        clearTimeout(waiter.timer);
        waiter.resolve(quota);
      }
    });
    session = opened;
    return opened;
  }

  async function ensureSession() {
    if (closed) {
      throw new Error('EcoFlow private transport is closed');
    }
    if (session?.client?.connected) {
      return session;
    }
    if (!connecting) {
      connecting = openSession().finally(() => {
        connecting = null;
      });
    }
    return connecting;
  }

  /** Log in and open the MQTT session now (instead of on first use), to report credential errors early. */
  async function connect() {
    await ensureSession();
  }

  /** The full quota snapshot for one device: publish a `latestQuotas` request, await its reply. */
  async function getQuota(sn) {
    const s = await ensureSession();
    const topics = buildTopics(s.userId, sn);
    await s.client.subscribeAsync(topics.getReply, { qos: 1 });

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      waiter.timer = setTimeout(() => {
        const waiters = s.pending.get(sn) ?? [];
        const remaining = waiters.filter((w) => w !== waiter);
        if (remaining.length > 0) {
          s.pending.set(sn, remaining);
        } else {
          s.pending.delete(sn);
        }
        reject(new Error(`Timed out waiting for a quota reply from ${sn}`));
      }, QUOTA_REPLY_TIMEOUT_MS);
      const waiters = s.pending.get(sn);
      if (waiters) {
        // A request for this device is already on the wire: share its reply.
        waiters.push(waiter);
        return;
      }
      s.pending.set(sn, [waiter]);

      const message = buildEnvelope({
        version: '1.1',
        moduleType: 0,
        operateType: 'latestQuotas',
        params: {},
      });
      s.client.publishAsync(topics.get, JSON.stringify(message), { qos: 1 }).catch((err) => {
        const failed = s.pending.get(sn) ?? [];
        s.pending.delete(sn);
        for (const w of failed) {
          clearTimeout(w.timer);
          w.reject(err);
        }
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
    closed = true;
    const inFlight = connecting;
    if (inFlight) {
      await inFlight.catch(() => {});
    }
    if (session) {
      const s = session;
      session = null;
      await endSession(s);
    }
  }

  return { connect, getQuota, sendCommand, disconnect };
}

// Test-only: reset the module-local envelope id counter so a test asserting
// on exact ids isn't order-dependent on other test files. Not used by
// production code.
export function __resetEnvelopeIdForTesting() {
  nextEnvelopeId = 100000;
}
