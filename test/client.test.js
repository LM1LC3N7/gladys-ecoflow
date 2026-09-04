// -----------------------------------------------------------------------------
// These tests exercise the REAL createPublicTransport() against a fake
// `fetchImpl` (no network access, no real EcoFlow account) — this is the
// signing + request-building logic itself, not a mock of it, so a bug in URL
// construction, query params, or the request body would fail here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicTransport } from '../src/ecoflow/client.js';

const config = {
  access_key: 'myAccessKey',
  secret_key: 'mySecretKey',
  api_host: 'https://api-e.ecoflow.com',
};

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: url instanceof URL ? url : new URL(url), init });
    return handler(calls.at(-1));
  };
  fn.calls = calls;
  return fn;
}

test('listDevices() GETs the device list and maps the response', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(200, {
      code: '0',
      message: 'Success',
      data: [
        { sn: 'R331ABC', deviceName: 'Garage River 2', online: 1 },
        { sn: 'R331DEF', online: 0 },
      ],
    }),
  );
  const transport = createPublicTransport(config, { fetchImpl });

  const devices = await transport.listDevices();

  assert.deepEqual(devices, [
    { sn: 'R331ABC', name: 'Garage River 2', online: true },
    { sn: 'R331DEF', name: 'R331DEF', online: false },
  ]);
  assert.equal(fetchImpl.calls[0].url.pathname, '/iot-open/sign/device/list');
  assert.equal(fetchImpl.calls[0].init.method, 'GET');
  assert.equal(fetchImpl.calls[0].init.headers.accessKey, 'myAccessKey');
  assert.ok(fetchImpl.calls[0].init.headers.sign);
});

test('getQuota() GETs the quota-all endpoint with the sn as a query param', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(200, { code: '0', message: 'Success', data: { 'pd.soc': 77 } }),
  );
  const transport = createPublicTransport(config, { fetchImpl });

  const quota = await transport.getQuota('R331ABC');

  assert.deepEqual(quota, { 'pd.soc': 77 });
  assert.equal(fetchImpl.calls[0].url.pathname, '/iot-open/sign/device/quota/all');
  assert.equal(fetchImpl.calls[0].url.searchParams.get('sn'), 'R331ABC');
});

test('getQuota() returns {} when the response carries no data', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { code: '0', message: 'Success' }));
  const transport = createPublicTransport(config, { fetchImpl });

  assert.deepEqual(await transport.getQuota('R331ABC'), {});
});

test('sendCommand() PUTs the exact {sn, id, version, moduleType, operateType, params} shape', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(200, { code: '0', message: 'Success', eagleEyeTraceId: 't', tid: 't' }),
  );
  const transport = createPublicTransport(config, { fetchImpl });

  await transport.sendCommand('R331ABC', 5, 'mpptCar', { enabled: 1 });

  const { url, init } = fetchImpl.calls[0];
  assert.equal(url.pathname, '/iot-open/sign/device/quota');
  assert.equal(init.method, 'PUT');
  const body = JSON.parse(init.body);
  assert.equal(body.sn, 'R331ABC');
  assert.equal(body.version, '1.0');
  assert.equal(body.moduleType, 5);
  assert.equal(body.operateType, 'mpptCar');
  assert.deepEqual(body.params, { enabled: 1 });
  assert.equal(typeof body.id, 'number');
});

test('every sent command gets its own incrementing id', async () => {
  const fetchImpl = fakeFetch(() =>
    jsonResponse(200, { code: '0', message: 'Success', eagleEyeTraceId: 't', tid: 't' }),
  );
  const transport = createPublicTransport(config, { fetchImpl });

  await transport.sendCommand('R331ABC', 5, 'mpptCar', { enabled: 1 });
  await transport.sendCommand('R331ABC', 5, 'mpptCar', { enabled: 0 });

  const id1 = JSON.parse(fetchImpl.calls[0].init.body).id;
  const id2 = JSON.parse(fetchImpl.calls[1].init.body).id;
  assert.notEqual(id1, id2);
});

test('an EcoFlow error response (HTTP 200, code != "0") throws with the code and message', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(200, { code: '8513', message: 'invalid sign' }));
  const transport = createPublicTransport(config, { fetchImpl });

  await assert.rejects(() => transport.listDevices(), /code: 8513 \| message: invalid sign/);
});

test('a non-200 HTTP status throws with the status code', async () => {
  const fetchImpl = fakeFetch(() => jsonResponse(500, { message: 'server error' }));
  const transport = createPublicTransport(config, { fetchImpl });

  await assert.rejects(() => transport.listDevices(), /HTTP 500/);
});
