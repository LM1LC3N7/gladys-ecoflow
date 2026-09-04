// -----------------------------------------------------------------------------
// Integration configuration: two independent onboarding methods, either one
// (or both) usable at once — see src/devices/index.js for how they merge
// into the same device list.
//
//   - "Official" (recommended): the EcoFlow Open Platform API (accessKey/
//     secretKey from a free developer account) — see src/ecoflow/client.js.
//     Auto-discovers every device on the account, documented, but the
//     developer account needs EcoFlow's own approval first.
//   - "Simple" (unofficial): the same email/password the EcoFlow app itself
//     uses — see src/ecoflow/privateClient.js for the full trade-offs
//     (unofficial, no discovery, MQTT-only). Needs the device's serial
//     number(s) typed in by hand (private_device_sns).
//
// EcoFlow devices (River 2 included) have no LAN-only control path either
// way: unlike a Tuya/Zigbee device, there is no local server on the device
// itself — control and telemetry always go through EcoFlow's cloud, even for
// a device that only ever sits on your own WiFi (confirmed against EcoFlow's
// own "local control without internet is not currently supported" stance;
// the one exception across EcoFlow's whole catalog is the EZ1, not River 2).
// -----------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  access_key: '',
  secret_key: '',
  api_host: 'https://api-e.ecoflow.com',
  private_username: '',
  private_password: '',
  private_device_sns: '',
  poll_interval_seconds: 30,
};

const POLL_MIN = 10;
const POLL_MAX = 3600;
export const VALID_API_HOSTS = ['https://api-e.ecoflow.com', 'https://api-a.ecoflow.com'];

function toBoundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** Comma-separated list -> deduplicated, trimmed, non-empty values. */
function parseList(raw) {
  return [
    ...new Set(
      String(raw ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

export function normalizeConfig(raw = {}) {
  const apiHost = VALID_API_HOSTS.includes(raw.api_host) ? raw.api_host : DEFAULT_CONFIG.api_host;

  return {
    ...DEFAULT_CONFIG,
    ...raw,
    api_host: apiHost,
    access_key: String(raw.access_key ?? '').trim(),
    secret_key: String(raw.secret_key ?? '').trim(),
    private_username: String(raw.private_username ?? '').trim(),
    private_password: String(raw.private_password ?? ''),
    privateDeviceSns: parseList(raw.private_device_sns),
    poll_interval_seconds: toBoundedNumber(
      raw.poll_interval_seconds,
      DEFAULT_CONFIG.poll_interval_seconds,
      POLL_MIN,
      POLL_MAX,
    ),
  };
}

/** The official Open Platform method has what it needs to run. */
export function isPublicConfigured(config) {
  return Boolean(config.access_key && config.secret_key);
}

/** The simple email/password method has what it needs to run (at least one device SN entered). */
export function isPrivateConfigured(config) {
  return Boolean(
    config.private_username && config.private_password && config.privateDeviceSns.length > 0,
  );
}

/** Whether enough is configured to reach the EcoFlow API at all, through either method. */
export function isConfigured(config) {
  return isPublicConfigured(config) || isPrivateConfigured(config);
}
