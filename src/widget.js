// -----------------------------------------------------------------------------
// PURE: the "EcoFlow power station" dashboard widget content (manifest
// `widgets[].key = power_station`, Gladys >= 5.1), in the core's declarative
// vocabulary — the core renders it (theme, dark mode, mobile layout), the
// integration only describes it.
//
// Content budget (enforced by the core, checked in tests with the SDK's own
// validateWidgetContent): 8 components at most. This widget spends them as:
//   1 caption      what the station is doing ("On battery · 3 h 10 left")
//   4 tiles        battery gauge, AC input, solar input, total output — all
//                  device-bound, so they follow the published states live
//   1 status list  outputs, reserve, charge/discharge limits, method — the
//                  numeric settings that are not device features (see
//                  src/ecoflow/quota.js's header)
//   2 buttons      AC / DC output toggles (device-bound: they go through
//                  onSetValue like the dashboard switches), or a single
//                  "Retry" action while the unit is unreachable
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { FEATURE, featureExternalId, summarizeQuota } from './ecoflow/quota.js';
import { METHOD } from './devices/device.js';

export const WIDGET_KEY = 'power_station';
export const WIDGET_ACTION_REFRESH = 'refresh';

function translator(language) {
  const french = String(language ?? '')
    .toLowerCase()
    .startsWith('fr');
  return (en, fr) => (french ? fr : en);
}

/** 190 -> "3 h 10", 45 -> "45 min". */
export function formatDuration(minutes) {
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${String(rest).padStart(2, '0')}`;
}

function onOff(t, value) {
  if (value === undefined) {
    return { value: '—', color: WIDGET_COLORS.NEUTRAL };
  }
  return value
    ? { value: t('On', 'Activée'), color: WIDGET_COLORS.SUCCESS }
    : { value: t('Off', 'Coupée'), color: WIDGET_COLORS.NEUTRAL };
}

function percent(value) {
  return value === undefined ? '—' : `${value} %`;
}

function caption(t, { reachable, hasData, summary }) {
  if (!reachable) {
    return t('Offline — not answering', 'Hors ligne — ne répond pas');
  }
  if (!hasData) {
    return t('Waiting for the first data…', 'En attente des premières données…');
  }
  const input = (summary.acInputWatts ?? 0) + (summary.solarInputWatts ?? 0);
  if (summary.charging) {
    return t(`Charging · ${input} W in`, `En charge · ${input} W entrants`);
  }
  if (summary.remainingMinutes !== undefined && (summary.outputWatts ?? 0) > 0) {
    const left = formatDuration(summary.remainingMinutes);
    return t(`On battery · ${left} left`, `Sur batterie · ${left} restantes`);
  }
  if (summary.acInputPresent) {
    return t('Plugged in · standby', 'Branchée · en veille');
  }
  return t('Standby', 'En veille');
}

function message(t, text) {
  return { type: 'text', variant: 'caption', text: t(...text) };
}

/**
 * @param {object} options
 * @param {string} [options.externalId] the device chosen in the widget settings
 * @param {object} [options.entry]      its registry entry (src/devices/device.js)
 * @param {string} [options.deviceName]
 * @param {boolean} [options.reachable]
 * @param {string} [options.language]
 * @param {number} [options.ttlSeconds]
 */
export function buildWidgetContent({
  externalId,
  entry,
  deviceName,
  reachable = true,
  language,
  ttlSeconds = 60,
}) {
  const t = translator(language);
  const ttl = Math.min(3600, Math.max(10, Math.round(ttlSeconds)));

  if (!externalId) {
    return {
      ttl_seconds: ttl,
      components: [
        message(t, [
          'Choose a power station in this widget settings.',
          'Choisissez une station dans les réglages du widget.',
        ]),
      ],
    };
  }
  if (!entry) {
    return {
      ttl_seconds: ttl,
      components: [
        message(t, [
          'This power station is not configured anymore.',
          "Cette station n'est plus configurée dans l'intégration.",
        ]),
      ],
    };
  }

  const quota = entry.lastQuota ?? {};
  const hasData = Object.keys(quota).length > 0;
  const summary = summarizeQuota(quota);
  const feature = (key) => featureExternalId(externalId, key);

  const ac = onOff(t, summary.acEnabled);
  const dc = onOff(t, summary.dcEnabled);
  const xboost = onOff(t, summary.xboostEnabled);
  const reserve = onOff(t, summary.reserveEnabled);
  if (summary.reserveEnabled && summary.reserveLevel !== undefined) {
    reserve.value = `${reserve.value} · ${summary.reserveLevel} %`;
  }

  const components = [
    {
      type: 'text',
      variant: 'caption',
      text: truncate(
        `${deviceName ? `${deviceName} — ` : ''}${caption(t, { reachable, hasData, summary })}`,
        80,
      ),
    },
    {
      type: 'gauge',
      label: t('Battery', 'Batterie'),
      device_feature: feature(FEATURE.BATTERY_LEVEL),
    },
    {
      type: 'value',
      label: t('AC input', 'Entrée secteur'),
      icon: 'zap',
      device_feature: feature(FEATURE.AC_CHARGE_POWER),
    },
    {
      type: 'value',
      label: t('Solar input', 'Entrée solaire'),
      icon: 'sun',
      device_feature: feature(FEATURE.SOLAR_INPUT_POWER),
    },
    {
      type: 'value',
      label: t('Output', 'Sortie'),
      icon: 'power',
      device_feature: feature(FEATURE.TOTAL_OUTPUT_POWER),
    },
    {
      type: 'status',
      items: [
        { label: t('AC output', 'Sortie AC'), ...ac },
        { label: t('DC (car) output', 'Sortie DC (12 V)'), ...dc },
        { label: 'X-Boost', ...xboost },
        { label: t('Backup reserve', 'Réserve de secours'), ...reserve },
        {
          label: t('Charge limit', 'Limite de charge'),
          value: percent(summary.chargeLimit),
          color: WIDGET_COLORS.INFO,
        },
        {
          label: t('Discharge limit', 'Limite de décharge'),
          value: percent(summary.dischargeLimit),
          color: WIDGET_COLORS.INFO,
        },
        {
          label: t('Connection', 'Connexion'),
          value:
            entry.method === METHOD.SIMPLE
              ? t('Simple login (unofficial)', 'Connexion simple (non officielle)')
              : t('Official API', 'API officielle'),
          color: reachable ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.DANGER,
        },
      ],
    },
  ];

  if (!reachable) {
    components.push({
      type: 'button',
      label: t('Retry now', 'Réessayer'),
      icon: 'refresh-cw',
      style: 'primary',
      action: { key: WIDGET_ACTION_REFRESH },
    });
  } else if (hasData) {
    const toggle = (key, current, labels) => ({
      type: 'button',
      label: current ? t(...labels.off) : t(...labels.on),
      icon: 'power',
      style: current ? 'secondary' : 'primary',
      device_feature: feature(key),
      value: current ? 0 : 1,
    });
    components.push(
      toggle(FEATURE.AC_OUTPUT_ENABLED, summary.acEnabled, {
        on: ['Turn AC on', 'Activer AC'],
        off: ['Turn AC off', 'Couper AC'],
      }),
      toggle(FEATURE.DC_OUTPUT_ENABLED, summary.dcEnabled, {
        on: ['Turn DC on', 'Activer DC'],
        off: ['Turn DC off', 'Couper DC'],
      }),
    );
  }

  return { ttl_seconds: ttl, components };
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
