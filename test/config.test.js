import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, VALID_API_HOSTS, normalizeConfig, isConfigured } from '../src/config.js';

test('normalizeConfig fills in defaults for an empty config', () => {
  const config = normalizeConfig();
  assert.equal(config.access_key, '');
  assert.equal(config.secret_key, '');
  assert.equal(config.api_host, DEFAULT_CONFIG.api_host);
  assert.equal(config.poll_interval_seconds, DEFAULT_CONFIG.poll_interval_seconds);
});

test('normalizeConfig trims access_key/secret_key', () => {
  const config = normalizeConfig({ access_key: '  abc  ', secret_key: ' def ' });
  assert.equal(config.access_key, 'abc');
  assert.equal(config.secret_key, 'def');
});

test('normalizeConfig rejects an unknown api_host', () => {
  const config = normalizeConfig({ api_host: 'https://evil.example.com' });
  assert.equal(config.api_host, DEFAULT_CONFIG.api_host);
});

test('normalizeConfig accepts every documented api_host', () => {
  for (const host of VALID_API_HOSTS) {
    assert.equal(normalizeConfig({ api_host: host }).api_host, host);
  }
});

test('normalizeConfig clamps poll_interval_seconds to [10, 3600]', () => {
  assert.equal(normalizeConfig({ poll_interval_seconds: 1 }).poll_interval_seconds, 30);
  assert.equal(normalizeConfig({ poll_interval_seconds: 999999 }).poll_interval_seconds, 30);
  assert.equal(normalizeConfig({ poll_interval_seconds: 60 }).poll_interval_seconds, 60);
});

test('isConfigured requires both access_key and secret_key', () => {
  assert.equal(isConfigured(normalizeConfig()), false);
  assert.equal(isConfigured(normalizeConfig({ access_key: 'a' })), false);
  assert.equal(isConfigured(normalizeConfig({ access_key: 'a', secret_key: 'b' })), true);
});
