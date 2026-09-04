// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the
// code — the store indexer validates the manifest's own shape, but nothing
// there can know whether every declared action has a registered handler, or
// that the config defaults match what src/config.js actually accepts.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DEFAULT_CONFIG, VALID_API_HOSTS } from '../src/config.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

// Registered directly in index.js.
const HANDLED_ACTIONS = ['test_connection'];

test('name is 3-30 characters (manifest.schema.json)', () => {
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30, manifest.name);
});

test('description.en/fr are each 10-100 characters (manifest.schema.json)', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} is ${text.length} characters, must be 10-100: "${text}"`,
    );
  }
});

test('every manifest action has a registered handler', () => {
  for (const action of manifest.actions ?? []) {
    assert.ok(
      HANDLED_ACTIONS.includes(action.key),
      `manifest action "${action.key}" has no handler`,
    );
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the manifest carries the intro section');
  for (const section of sections) {
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('access_key/secret_key are secrets, and optional (either onboarding method can be used alone)', () => {
  for (const key of ['access_key', 'secret_key']) {
    const field = manifest.config_schema.find((f) => f.key === key);
    assert.equal(field.type, 'secret', `"${key}" must be a secret field`);
    assert.equal(field.required, false, `"${key}" must not be required`);
  }
});

test('private_username/private_password are secrets, and optional', () => {
  for (const key of ['private_username', 'private_password']) {
    const field = manifest.config_schema.find((f) => f.key === key);
    assert.equal(field.type, 'secret', `"${key}" must be a secret field`);
    assert.equal(field.required, false, `"${key}" must not be required`);
  }
});

test('private_device_sns is a plain, optional string field', () => {
  const field = manifest.config_schema.find((f) => f.key === 'private_device_sns');
  assert.equal(field.type, 'string');
  assert.equal(field.required, false);
});

test('the manifest carries both onboarding-method sections', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.equal(sections.length, 2);
  assert.deepEqual(
    sections.map((s) => s.key),
    ['intro', 'intro_private'],
  );
});

test('api_host options exactly match src/config.js#VALID_API_HOSTS', () => {
  const field = manifest.config_schema.find((f) => f.key === 'api_host');
  assert.deepEqual(
    field.options.map((o) => o.value),
    VALID_API_HOSTS,
  );
});

test('poll_interval_seconds bounds match src/config.js', () => {
  const field = manifest.config_schema.find((f) => f.key === 'poll_interval_seconds');
  assert.equal(field.min, 10);
  assert.equal(field.max, 3600);
});

test('the test_connection action uses the dynamic "devices" select, no static options', () => {
  const action = manifest.actions.find((a) => a.key === 'test_connection');
  const deviceField = action.fields.find((f) => f.key === 'device');
  assert.equal(deviceField.source, 'devices');
  assert.equal(deviceField.options, undefined);
});

test('transports declares cloud only — EcoFlow has no LAN-only control path for River 2', () => {
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('the manifest declares no network_discovery — EcoFlow devices are found via the cloud account, not the LAN', () => {
  assert.equal(manifest.network_discovery, undefined);
});
