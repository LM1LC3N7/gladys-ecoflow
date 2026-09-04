# EcoFlow

Monitor and control your EcoFlow River 2 (and the wider River 2 family: River
2 Max, River 2 Pro) directly in Gladys, through EcoFlow's cloud — the same
one the EcoFlow app itself uses.

**Important: EcoFlow devices have no LAN-only control path.** Even a device
that only ever sits on your own WiFi is controlled through EcoFlow's cloud,
both by the official app and by this integration — confirmed against
EcoFlow's own support stance (local control without internet is not
currently supported for this product line; the one exception in EcoFlow's
whole catalog is the unrelated EZ1 sprinkler-timer-sized unit). Your device
does need internet access on your network for this integration to work.

## Two ways to connect

- **Method 1 — Official Open Platform (recommended)**: a free developer
  account and an Access Key/Secret Key pair. Documented, and every device on
  the account is discovered automatically. The only downside is EcoFlow's
  own approval, which can take about a week.
- **Method 2 — Simple login (unofficial, optional)**: the same email and
  password you use to sign in to the EcoFlow app — no developer account, no
  waiting. This uses EcoFlow's internal app endpoints rather than the
  documented API, so it can change or break without notice, and there is no
  device auto-discovery: you type in each device's serial number by hand.

Both can be configured at once — a device is looked up through whichever
method its serial number is entered under (Method 2's field), or through
Method 1's account otherwise.

## What you get

One Gladys device is created per EcoFlow device, however it was found.
Every device exposes:

- **Battery level** (%)
- **AC charging power** (W) — power coming in through the AC input
- **Total output power** (W) — power leaving the unit across every output combined
- **AC output power** (W)
- **Solar input power** (W) — from a connected solar panel, if any
- **AC output** (on/off)
- **X-Boost** (on/off) — lets the AC output power higher-draw appliances at
  the cost of a less clean sine wave
- **DC (car) output** (on/off)
- **Backup reserve** (on/off)

## Configuration

**Method 1 (recommended):**

1. Create a free developer account and an Access Key/Secret Key pair at the
   [EcoFlow Open Platform](https://developer-eu.ecoflow.com/) (Europe) or
   [developer.ecoflow.com](https://developer.ecoflow.com/) (global) —
   approval can take about a week.
2. Open the **Configuration** tab of the integration and enter your Access
   Key and Secret Key, and pick the matching region.
3. Save: every device on your EcoFlow account appears in the **Discovery**
   tab.

**Method 2 (simple, unofficial):**

1. Open the **Configuration** tab and enter your EcoFlow account email and
   password (the same ones the app uses).
2. Enter each device's serial number (comma-separated if more than one) —
   find it in the EcoFlow app under Settings > Device Info, or printed on
   the unit itself.
3. Save: the device(s) appear in the **Discovery** tab.

## Actions

- **Test connection** — re-polls a specific device right now and reports its
  battery level and AC output power, or the exact API error if it fails.

## Possible follow-ups

Deliberately out of scope for now, listed here rather than silently left out:

- **Real-time MQTT push** instead of polling, for Method 1 — the private
  method (Method 2) already talks MQTT, but Method 1's real-time push topic
  has a message shape that needs confirming against a real account before it
  can replace the current poll loop.
- **Numeric charge/discharge-limit and backup-reserve-level** settings (the
  percentages the EcoFlow app lets you set) — Gladys' `battery-storage`
  device-feature category has no "target level" type distinct from the
  battery-level sensor itself, so this needs either a Gladys core addition or
  a deliberate (and clearly documented) reuse of an existing type.

## Tested and confirmed

Honest status, so it's clear what "it works" actually rests on — **no
EcoFlow account (developer or app) and no physical River 2 unit were
available while writing this integration.**

- The REST API (device list, quota snapshot, set command) and its HMAC-SHA256
  request signing (Method 1) are hand-written and cross-confirmed against two
  independent, live-used implementations read directly: the Home Assistant
  community integration
  [`tolwi/hassio-ecoflow-cloud`](https://github.com/tolwi/hassio-ecoflow-cloud)'s
  own `api/public_api.py`, and [`rustyy/ecoflow-api`](https://github.com/rustyy/ecoflow-api)'s
  `SignatureBuilder`/`RestClient` source — not executed as a dependency (see
  the README), but read to confirm the algorithm and endpoints.
- The simple login + MQTT path (Method 2) is likewise cross-confirmed against
  `tolwi/hassio-ecoflow-cloud`'s `api/private_api.py` and
  `devices/__init__.py` (the `latestQuotas` request/reply and the
  `{moduleType, operateType, params}` command shape are IDENTICAL to
  Method 1's — only the transport envelope differs).
- The River 2 family's quota field names (`pd.soc`, `inv.outputWatts`,
  `mppt.inWatts`...) and set-command shapes (`acOutCfg`, `mpptCar`,
  `upsConfig`, `dsgCfg`, `watthConfig`) are validated at runtime against
  [`@ecoflow-api/schemas`](https://www.npmjs.com/package/@ecoflow-api/schemas)'
  own zod schemas — real, current schemas published by that project, not a
  hand-copied snapshot.
- **A real bug was found and worked around**: the published
  `@ecoflow-api/rest-client@0.6.0` package crashes on import for every
  consumer (a broken internal path that can never resolve). This integration
  does not depend on it — the REST/signing layer is hand-written instead,
  confirmed to load and run correctly by this repository's own test suite.
- What is **not** independently confirmed: an actual login against a real
  EcoFlow account (either method), the exact `out_voltage`/`out_freq` values
  a real River 2 reports for `mppt.cfgAcOutVol`/`mppt.cfgAcOutFreq` (used to
  fill in the AC output command alongside whichever field you actually
  toggle), and the device's real reported serial number prefix (a
  placeholder was used in tests). Run this integration with `LOG_LEVEL=debug`
  against your own River 2 and open an issue if something behaves
  unexpectedly.

## Troubleshooting

Check the integration logs from the Gladys UI (or `docker logs` on the host)
with `LOG_LEVEL=debug` for the full detail of every request made to EcoFlow,
through either method.
