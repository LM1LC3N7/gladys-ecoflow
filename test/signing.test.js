// -----------------------------------------------------------------------------
// Golden-value tests for src/ecoflow/signing.js: each expected signature is
// computed independently with Node's own `crypto.createHmac` against a
// hand-built message string (not by calling computeSignature() a second
// time), so a bug in message construction (wrong sort order, a missing
// flatten step, an extra "&") fails loudly here instead of only against a
// real EcoFlow account.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { flattenObject, computeSignature } from '../src/ecoflow/signing.js';

const credentials = { accessKey: 'myAccessKey', secretKey: 'mySecretKey' };
const nonce = '12345';
const timestamp = '1700000000000';

function expectedSignature(message) {
  return createHmac('sha256', credentials.secretKey).update(message).digest('hex');
}

test('flattenObject flattens nested objects to dotted keys', () => {
  assert.deepEqual(flattenObject({ params: { enabled: 1, out_voltage: 0 } }), {
    'params.enabled': 1,
    'params.out_voltage': 0,
  });
});

test('flattenObject leaves a flat object untouched', () => {
  assert.deepEqual(flattenObject({ sn: 'ABC123', moduleType: 5 }), {
    sn: 'ABC123',
    moduleType: 5,
  });
});

test('computeSignature with no data: just accessKey/nonce/timestamp', () => {
  const signature = computeSignature(credentials, { nonce, timestamp });
  assert.equal(
    signature,
    expectedSignature('accessKey=myAccessKey&nonce=12345&timestamp=1700000000000'),
  );
});

test('computeSignature with flat query params, sorted', () => {
  // Deliberately out of order in the input to prove sorting actually happens.
  const signature = computeSignature(credentials, { nonce, timestamp, data: { sn: 'ABC123' } });
  assert.equal(
    signature,
    expectedSignature('sn=ABC123&accessKey=myAccessKey&nonce=12345&timestamp=1700000000000'),
  );
});

test('computeSignature flattens a nested body before sorting', () => {
  const data = {
    sn: 'ABC123',
    id: 1,
    version: '1.0',
    moduleType: 5,
    operateType: 'mpptCar',
    params: { enabled: 1 },
  };
  const signature = computeSignature(credentials, { nonce, timestamp, data });
  assert.equal(
    signature,
    expectedSignature(
      'id=1&moduleType=5&operateType=mpptCar&params.enabled=1&sn=ABC123&version=1.0&accessKey=myAccessKey&nonce=12345&timestamp=1700000000000',
    ),
  );
});

test('computeSignature treats an empty data object like no data at all', () => {
  assert.equal(
    computeSignature(credentials, { nonce, timestamp, data: {} }),
    computeSignature(credentials, { nonce, timestamp }),
  );
});
