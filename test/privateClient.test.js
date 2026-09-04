// -----------------------------------------------------------------------------
// login()/getMqttCredentials() are tested against a fake `fetchImpl` (no
// network access, no real EcoFlow account). buildTopics()/buildEnvelope()/
// snFromGetReplyTopic() are pure and tested directly. createPrivateTransport()
// is tested against a fake MQTT client (a fake `mqttConnect`), exercising the
// real request/reply correlation logic (publish a `latestQuotas` get,
// resolve when the matching get_reply message arrives) without a real
// broker.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  login,
  getMqttCredentials,
  buildTopics,
  buildEnvelope,
  snFromGetReplyTopic,
  createPrivateTransport,
  __resetEnvelopeIdForTesting,
} from '../src/ecoflow/privateClient.js';

function jsonResponse(body) {
  return { json: async () => body };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return handler(calls.at(-1));
  };
  fn.calls = calls;
  return fn;
}

test('login() base64-encodes the password and posts the app-login payload', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      code: '0',
      message: 'success',
      data: { token: 'tok123', user: { userId: 'user-1', name: 'Alice' } },
    }),
  );

  const result = await login('alice@example.com', 'hunter2', { fetchImpl });

  assert.deepEqual(result, { token: 'tok123', userId: 'user-1' });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.ecoflow.com/auth/login');
  assert.equal(init.method, 'POST');
  const body = JSON.parse(init.body);
  assert.equal(body.email, 'alice@example.com');
  assert.equal(body.password, Buffer.from('hunter2').toString('base64'));
  assert.equal(body.scene, 'IOT_APP');
  assert.equal(body.userType, 'ECOFLOW');
});

test('login() throws with the code/message on a rejected login', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse({ code: '1', message: 'incorrect password' }));
  await assert.rejects(
    () => login('alice@example.com', 'wrong', { fetchImpl }),
    /code: 1 \| message: incorrect password/,
  );
});

test('getMqttCredentials() sends the Bearer token and parses port as a number', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse({
      code: '0',
      message: 'success',
      data: {
        url: 'mqtt.example.com',
        port: '8883',
        certificateAccount: 'acct',
        certificatePassword: 'pass',
      },
    }),
  );

  const creds = await getMqttCredentials('tok123', { fetchImpl });

  assert.deepEqual(creds, {
    url: 'mqtt.example.com',
    port: 8883,
    username: 'acct',
    password: 'pass',
  });
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://api.ecoflow.com/iot-auth/app/certification');
  assert.equal(init.headers.authorization, 'Bearer tok123');
});

test('buildTopics() builds the three app-facing topics for one device', () => {
  assert.deepEqual(buildTopics('user-1', 'R331ABC'), {
    get: '/app/user-1/R331ABC/thing/property/get',
    getReply: '/app/user-1/R331ABC/thing/property/get_reply',
    set: '/app/user-1/R331ABC/thing/property/set',
  });
});

test('buildEnvelope() wraps a command with from/id/version', () => {
  __resetEnvelopeIdForTesting();
  const envelope = buildEnvelope({ moduleType: 5, operateType: 'mpptCar', params: { enabled: 1 } });
  assert.equal(envelope.from, 'Gladys');
  assert.equal(envelope.version, '1.0');
  assert.equal(typeof envelope.id, 'number');
  assert.deepEqual(envelope.params, { enabled: 1 });
});

test('buildEnvelope() lets the command override version (latestQuotas uses 1.1)', () => {
  const envelope = buildEnvelope({ version: '1.1', moduleType: 0, operateType: 'latestQuotas' });
  assert.equal(envelope.version, '1.1');
});

test('buildEnvelope() gives every call its own incrementing id', () => {
  const a = buildEnvelope({});
  const b = buildEnvelope({});
  assert.notEqual(a.id, b.id);
});

test('snFromGetReplyTopic() extracts the sn, or undefined for an unrelated topic', () => {
  assert.equal(
    snFromGetReplyTopic('/app/user-1/R331ABC/thing/property/get_reply', 'user-1'),
    'R331ABC',
  );
  assert.equal(
    snFromGetReplyTopic('/app/user-1/R331ABC/thing/property/set_reply', 'user-1'),
    undefined,
  );
  assert.equal(
    snFromGetReplyTopic('/app/other-user/R331ABC/thing/property/get_reply', 'user-1'),
    undefined,
  );
});

function createFakeMqttClient() {
  let messageHandler = null;
  return {
    connected: true,
    published: [],
    subscribed: [],
    on(event, handler) {
      if (event === 'message') {
        messageHandler = handler;
      }
    },
    async subscribeAsync(topic) {
      this.subscribed.push(topic);
    },
    async publishAsync(topic, payload) {
      this.published.push({ topic, payload });
    },
    async endAsync() {
      this.connected = false;
    },
    emitMessage(topic, payloadObject) {
      messageHandler(topic, Buffer.from(JSON.stringify(payloadObject)));
    },
  };
}

function testConfig() {
  return { private_username: 'alice@example.com', private_password: 'hunter2' };
}

function testFetch() {
  return fakeFetch((call) => {
    if (String(call.url).endsWith('/auth/login')) {
      return jsonResponse({
        code: '0',
        message: 'success',
        data: { token: 'tok123', user: { userId: 'user-1' } },
      });
    }
    return jsonResponse({
      code: '0',
      message: 'success',
      data: {
        url: 'mqtt.example.com',
        port: '8883',
        certificateAccount: 'a',
        certificatePassword: 'b',
      },
    });
  });
}

test('createPrivateTransport().getQuota() publishes a latestQuotas request and resolves on the matching reply', async () => {
  const fakeClient = createFakeMqttClient();
  const mqttConnect = async () => fakeClient;
  const transport = createPrivateTransport(testConfig(), { fetchImpl: testFetch(), mqttConnect });

  const quotaPromise = transport.getQuota('R331ABC');
  // Let the async publish inside getQuota() actually run before we react to it.
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fakeClient.subscribed[0], '/app/user-1/R331ABC/thing/property/get_reply');
  const published = JSON.parse(fakeClient.published[0].payload);
  assert.equal(published.operateType, 'latestQuotas');
  assert.equal(fakeClient.published[0].topic, '/app/user-1/R331ABC/thing/property/get');

  fakeClient.emitMessage('/app/user-1/R331ABC/thing/property/get_reply', {
    operateType: 'latestQuotas',
    data: { online: 1, quotaMap: { 'pd.soc': 88 } },
  });

  assert.deepEqual(await quotaPromise, { 'pd.soc': 88 });
});

test('createPrivateTransport().getQuota() ignores a reply for a different device', async () => {
  const fakeClient = createFakeMqttClient();
  const mqttConnect = async () => fakeClient;
  const transport = createPrivateTransport(testConfig(), { fetchImpl: testFetch(), mqttConnect });

  const quotaPromise = transport.getQuota('R331ABC');
  await new Promise((resolve) => setImmediate(resolve));

  fakeClient.emitMessage('/app/user-1/R331OTHER/thing/property/get_reply', {
    operateType: 'latestQuotas',
    data: { quotaMap: { 'pd.soc': 1 } },
  });
  fakeClient.emitMessage('/app/user-1/R331ABC/thing/property/get_reply', {
    operateType: 'latestQuotas',
    data: { quotaMap: { 'pd.soc': 99 } },
  });

  assert.deepEqual(await quotaPromise, { 'pd.soc': 99 });
});

test('createPrivateTransport().sendCommand() publishes moduleType/operateType/params wrapped for MQTT', async () => {
  const fakeClient = createFakeMqttClient();
  const mqttConnect = async () => fakeClient;
  const transport = createPrivateTransport(testConfig(), { fetchImpl: testFetch(), mqttConnect });

  await transport.sendCommand('R331ABC', 5, 'mpptCar', { enabled: 1 });

  assert.equal(fakeClient.published[0].topic, '/app/user-1/R331ABC/thing/property/set');
  const message = JSON.parse(fakeClient.published[0].payload);
  assert.equal(message.moduleType, 5);
  assert.equal(message.operateType, 'mpptCar');
  assert.deepEqual(message.params, { enabled: 1 });
  assert.equal(message.from, 'Gladys');
});

test('createPrivateTransport() logs in and connects MQTT only once across calls', async () => {
  const fakeClient = createFakeMqttClient();
  let connectCount = 0;
  const mqttConnect = async () => {
    connectCount += 1;
    return fakeClient;
  };
  const transport = createPrivateTransport(testConfig(), { fetchImpl: testFetch(), mqttConnect });

  await transport.sendCommand('R331ABC', 5, 'mpptCar', { enabled: 1 });
  await transport.sendCommand('R331ABC', 5, 'mpptCar', { enabled: 0 });

  assert.equal(connectCount, 1);
});

test('createPrivateTransport().disconnect() ends the MQTT session', async () => {
  const fakeClient = createFakeMqttClient();
  const mqttConnect = async () => fakeClient;
  const transport = createPrivateTransport(testConfig(), { fetchImpl: testFetch(), mqttConnect });

  await transport.sendCommand('R331ABC', 5, 'mpptCar', { enabled: 1 });
  await transport.disconnect();

  assert.equal(fakeClient.connected, false);
});
