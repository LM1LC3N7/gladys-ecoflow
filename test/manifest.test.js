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
import { SCENE_ACTION, BOUNDS } from '../src/sceneActions.js';
import { SCENE_TRIGGER } from '../src/devices/events.js';
import { WIDGET_KEY } from '../src/widget.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

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

// Handler registration for every action/scene action/widget key is checked
// against the real src/app.js wiring in test/app.test.js.

test('gladys_version requires 5.1, the first core with widgets and scene declarations', () => {
  assert.equal(manifest.gladys_version, '>=5.1.0');
});

test('scene trigger keys match exactly the events src/devices/events.js fires', () => {
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(SCENE_TRIGGER).sort(),
  );
});

test('every scene trigger declares the variables carried by its event data', () => {
  for (const trigger of manifest.scene_triggers) {
    assert.deepEqual(
      trigger.variables.map((v) => v.key),
      ['battery_level', 'output_watts'],
    );
    const device = trigger.fields.find((f) => f.key === 'device');
    assert.equal(device.source, 'devices');
    assert.equal(device.required, false, 'an empty device filter means "any station"');
  }
});

test('scene action keys match the handlers of src/sceneActions.js', () => {
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key).sort(),
    Object.values(SCENE_ACTION).sort(),
  );
});

test('scene action numeric bounds match the ones enforced in code', () => {
  const field = (action, key) =>
    manifest.scene_actions.find((a) => a.key === action).fields.find((f) => f.key === key);
  const expect = (action, key, bounds) => {
    const f = field(action, key);
    assert.deepEqual({ min: f.min, max: f.max }, bounds, `${action}.${key}`);
  };
  expect(SCENE_ACTION.SET_CHARGE_LIMIT, 'max_percent', BOUNDS.chargeLimit);
  expect(SCENE_ACTION.SET_DISCHARGE_LIMIT, 'min_percent', BOUNDS.dischargeLimit);
  expect(SCENE_ACTION.SET_BACKUP_RESERVE, 'level', BOUNDS.reserveLevel);
  expect(SCENE_ACTION.SET_AC_CHARGING, 'watts', BOUNDS.acChargingWatts);
});

test('scene actions and triggers stay within the core limits', () => {
  assert.ok(manifest.scene_triggers.length <= 20);
  assert.ok(manifest.scene_actions.length <= 20);
  for (const declaration of [...manifest.scene_triggers, ...manifest.scene_actions]) {
    assert.ok(declaration.label.en, `${declaration.key} needs an English label`);
    assert.ok((declaration.fields ?? []).length <= 10);
    assert.ok((declaration.variables ?? []).length <= 20);
    assert.ok((declaration.outputs ?? []).length <= 20);
    if (declaration.timeout_seconds !== undefined) {
      assert.ok(declaration.timeout_seconds >= 5 && declaration.timeout_seconds <= 120);
    }
  }
});

test('the dashboard widget is declared with a device setting', () => {
  assert.equal(manifest.widgets.length, 1);
  const [widget] = manifest.widgets;
  assert.equal(widget.key, WIDGET_KEY);
  assert.match(widget.key, /^[a-z0-9_]{2,32}$/);
  assert.equal(widget.settings[0].source, 'devices');
  assert.ok(!widget.settings.some((s) => ['secret', 'oauth2', 'account_link'].includes(s.type)));
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

test('the actions use the dynamic "devices" select, no static options', () => {
  for (const action of manifest.actions) {
    const deviceField = action.fields.find((f) => f.key === 'device');
    assert.equal(deviceField.source, 'devices', action.key);
    assert.equal(deviceField.options, undefined, action.key);
  }
});

test('transports declares cloud only — EcoFlow has no LAN-only control path for River 2', () => {
  assert.deepEqual(manifest.transports, ['cloud']);
});

test('the manifest declares no network_discovery — EcoFlow devices are found via the cloud account, not the LAN', () => {
  assert.equal(manifest.network_discovery, undefined);
});
