import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { buildWidgetContent, formatDuration, WIDGET_ACTION_REFRESH } from '../src/widget.js';
import { FEATURE, featureExternalId } from '../src/ecoflow/quota.js';

const DEVICE = 'ecoflow_power_station:R331ABC';
const QUOTA = {
  'pd.soc': 80,
  'inv.inputWatts': 0,
  'mppt.inWatts': 0,
  'pd.wattsOutSum': 120,
  'bms_emsStatus.dsgRemainTime': 190,
  'mppt.cfgAcEnabled': 1,
  'mppt.cfgAcXboost': 0,
  'pd.carState': 0,
  'pd.watchIsConfig': 1,
  'pd.bpPowerSoc': 30,
  'bms_emsStatus.maxChargeSoc': 100,
  'bms_emsStatus.minDsgSoc': 5,
};

function content(options) {
  return buildWidgetContent({
    externalId: DEVICE,
    entry: { method: 'official', lastQuota: QUOTA },
    ...options,
  });
}

test('every widget state fits the core vocabulary and content budget (rendered exactly as sent)', () => {
  const cases = [
    content({ language: 'fr', deviceName: 'Garage' }),
    content({ language: 'en', reachable: false }),
    buildWidgetContent({ externalId: DEVICE, entry: { method: 'simple', lastQuota: {} } }),
    buildWidgetContent({ externalId: DEVICE }),
    buildWidgetContent({}),
  ];
  for (const c of cases) {
    assert.deepEqual(validateWidgetContent(c), []);
    assert.ok(c.components.length <= 8);
  }
});

test('the caption says what the station is doing, in the user language', () => {
  assert.equal(
    content({ language: 'fr', deviceName: 'Garage' }).components[0].text,
    'Garage — Sur batterie · 3 h 10 restantes',
  );
  assert.equal(content({ language: 'en' }).components[0].text, 'On battery · 3 h 10 left');
  const charging = buildWidgetContent({
    externalId: DEVICE,
    entry: {
      method: 'official',
      lastQuota: { 'pd.soc': 40, 'inv.inputWatts': 300, 'pd.wattsOutSum': 0 },
    },
    language: 'en',
  });
  assert.equal(charging.components[0].text, 'Charging · 300 W in');
});

test('tiles are bound to the device features so they update live', () => {
  const bound = content({})
    .components.filter((c) => c.device_feature)
    .map((c) => c.device_feature);
  assert.ok(bound.includes(featureExternalId(DEVICE, FEATURE.BATTERY_LEVEL)));
  assert.ok(bound.includes(featureExternalId(DEVICE, FEATURE.TOTAL_OUTPUT_POWER)));
});

test('toggle buttons send the opposite of the current state through the device feature', () => {
  const buttons = content({ language: 'en' }).components.filter((c) => c.type === 'button');
  const ac = buttons.find(
    (b) => b.device_feature === featureExternalId(DEVICE, FEATURE.AC_OUTPUT_ENABLED),
  );
  const dc = buttons.find(
    (b) => b.device_feature === featureExternalId(DEVICE, FEATURE.DC_OUTPUT_ENABLED),
  );
  assert.deepEqual([ac.value, ac.label], [0, 'Turn AC off']);
  assert.deepEqual([dc.value, dc.label], [1, 'Turn DC on']);
});

test('an unreachable station offers a retry action instead of the toggles', () => {
  const buttons = content({ reachable: false }).components.filter((c) => c.type === 'button');
  assert.deepEqual(
    buttons.map((b) => b.action?.key),
    [WIDGET_ACTION_REFRESH],
  );
});

test('the status list shows the settings that are not device features', () => {
  const status = content({ language: 'fr' }).components.find((c) => c.type === 'status');
  const byLabel = Object.fromEntries(status.items.map((i) => [i.label, i.value]));
  assert.equal(byLabel['Réserve de secours'], 'Activée · 30 %');
  assert.equal(byLabel['Limite de charge'], '100 %');
  assert.equal(byLabel['Limite de décharge'], '5 %');
});

test('ttl_seconds follows the poll interval, within the core bounds', () => {
  assert.equal(content({ ttlSeconds: 30 }).ttl_seconds, 30);
  assert.equal(content({ ttlSeconds: 5 }).ttl_seconds, 10);
  assert.equal(content({ ttlSeconds: 9999 }).ttl_seconds, 3600);
});

test('formatDuration', () => {
  assert.equal(formatDuration(45), '45 min');
  assert.equal(formatDuration(120), '2 h');
  assert.equal(formatDuration(190), '3 h 10');
  assert.equal(formatDuration(65), '1 h 05');
});
