// -----------------------------------------------------------------------------
// Integration configuration.
//
// EcoFlow devices (River 2 included) have no LAN-only control path: unlike a
// Tuya/Zigbee device, there is no local server on the device itself — control
// and telemetry always go through EcoFlow's cloud, even for a device that
// only ever sits on your own WiFi (confirmed against EcoFlow's own "local
// control without internet is not currently supported" stance and the
// community integrations built on the same Open Platform API; the one
// exception across EcoFlow's whole catalog is the EZ1, not River 2). So the
// only thing to configure here is access to that cloud API: an accessKey/
// secretKey pair from https://developer-eu.ecoflow.com (EU) or
// https://developer.ecoflow.com (global) — free, but EcoFlow's own approval
// can take about a week.
// -----------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  access_key: '',
  secret_key: '',
  api_host: 'https://api-e.ecoflow.com',
  poll_interval_seconds: 30,
};

const POLL_MIN = 10;
const POLL_MAX = 3600;
export const VALID_API_HOSTS = ['https://api-e.ecoflow.com', 'https://api-a.ecoflow.com'];

function toBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function normalizeConfig(raw = {}) {
  const apiHost = VALID_API_HOSTS.includes(raw.api_host) ? raw.api_host : DEFAULT_CONFIG.api_host;

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    api_host: apiHost,
    access_key: String(raw.access_key ?? '').trim(),
    secret_key: String(raw.secret_key ?? '').trim(),
    poll_interval_seconds: toBoundedNumber(
      raw.poll_interval_seconds,
      DEFAULT_CONFIG.poll_interval_seconds,
      POLL_MIN,
      POLL_MAX,
    ),
  };
}

/** Whether enough is configured to reach the EcoFlow API at all. */
export function isConfigured(config) {
  return Boolean(config.access_key && config.secret_key);
}
