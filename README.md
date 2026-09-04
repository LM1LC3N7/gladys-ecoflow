# gladys-ecoflow

External integration for [Gladys Assistant](https://gladysassistant.com) to monitor and control
EcoFlow portable power stations (River 2 family: River 2, River 2 Max, River 2 Pro), via two
independent onboarding methods (either one alone is enough — see `src/config.js`'s header):

1. **Official Open Platform API** (recommended) — a free developer Access Key/Secret Key, signed
   REST requests, auto-discovers every device on the account.
2. **Simple login** (unofficial, optional) — the same email/password the EcoFlow app itself uses,
   MQTT-based, no developer account or approval wait, but no device auto-discovery (the serial
   number is typed in by hand).

Built on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js), from
the official [`integration-template-js`](https://github.com/GladysAssistant/integration-template-js).

**No LAN-only control path exists for these devices, either way.** Unlike a Tuya/Zigbee device,
EcoFlow devices have no local server of their own — control and telemetry always go through
EcoFlow's cloud, even for a device that only ever sits on your own WiFi (confirmed against
EcoFlow's own support stance: the only exception across EcoFlow's whole catalog is the unrelated
EZ1). This integration is therefore cloud-only by necessity, not by choice — see `docs/en.md` for
the full reasoning and `gladys-assistant-integration.json`'s `transports: ["cloud"]`.

## What it does

- **Two transports behind one shared interface**: `{ getQuota(sn), sendCommand(sn, moduleType,
operateType, params) }`, implemented by `createPublicTransport()` (`src/ecoflow/client.js`, a
  signed REST request) and `createPrivateTransport()` (`src/ecoflow/privateClient.js`, an MQTT
  publish/subscribe round-trip). `src/devices/device.js` never branches on which one backs a given
  device — the registry just carries the right transport alongside each device's `sn`.
- **Polling, not push, for both**: a background timer (`poll_interval_seconds`, default 30s)
  re-fetches each device's full quota snapshot (a REST `GET` for Method 1, an MQTT
  `latestQuotas` request/reply round-trip for Method 2); a command's effect is reflected on the
  next poll tick, not instantly pushed back.
- **One Gladys device per EcoFlow device**, however it was found — auto-discovered via
  `GET /iot-open/sign/device/list` for Method 1, or from the manually-entered serial number list
  for Method 2.
- **A fixed feature set** (`src/ecoflow/quota.js`) for the whole River 2 family, reused unchanged
  by both transports (their quota reply shape is identical): battery level, AC charging power,
  total output power, AC output power, solar input power (read-only sensors), and AC output /
  X-Boost / DC output / backup reserve (binary switches). See that file's header for why this list
  is deliberately conservative for now.
- **Command shapes shared across both transports** (`src/ecoflow/commands.js`): EcoFlow's
  `{moduleType, operateType, params}` triple is transport-independent (confirmed by reading
  EcoFlow's private and public wire formats side by side) — each command validates `params`
  against `@ecoflow-api/schemas`' real, current zod schemas before handing it to whichever
  transport a device uses.
- **Hand-written REST client + signing** (`src/ecoflow/client.js`, `src/ecoflow/signing.js`): NOT
  built on `@ecoflow-api/rest-client` — that package's published `0.6.0` build crashes on import
  for every consumer (see "Dependencies" below).

## New to this codebase? Start here

An "external integration" is a small Node.js program Gladys runs as its own Docker container,
talking to the Gladys hub over one WebSocket (handled by the SDK). Recommended reading order:

1. [`src/ecoflow/signing.js`](./src/ecoflow/signing.js) — no I/O: the HMAC-SHA256 request signing
   for Method 1, cross-confirmed against two independent reference implementations (see its header).
2. [`src/ecoflow/client.js`](./src/ecoflow/client.js) — Method 1's REST transport (device list,
   quota snapshot, set command), built on that signing.
3. [`src/ecoflow/privateClient.js`](./src/ecoflow/privateClient.js) — Method 2's transport: login,
   MQTT connection, the `latestQuotas` request/reply round-trip, and publishing a command — read
   its header for the full trade-offs of this method and how the wire format was confirmed.
4. [`src/ecoflow/commands.js`](./src/ecoflow/commands.js) — the River 2 family's command builders,
   shared by both transports, each validated against `@ecoflow-api/schemas`.
5. [`src/ecoflow/quota.js`](./src/ecoflow/quota.js) — PURE: EcoFlow's flat dotted-key quota format
   <-> Gladys device features, reused unchanged by both transports.
6. [`src/devices/device.js`](./src/devices/device.js) — the glue: discovery payloads, the
   `external_id -> { sn, transport, lastQuota }` registry, `onSetValue`/`test_connection`.
7. [`src/devices/index.js`](./src/devices/index.js) — device-list refresh, manual-SN registration,
   and the poll loop; `transportForSn()` decides which method backs a given serial number.
8. [`src/config.js`](./src/config.js) — config defaults + normalization for both methods.
9. [`index.js`](./index.js) — the entry point: SDK bootstrap, building whichever transport(s) are
   configured, poll timer lifecycle, event wiring.

## Dependencies

| Package                                                                                              | Role                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`@gladysassistant/integration-sdk`](https://www.npmjs.com/package/@gladysassistant/integration-sdk) | Talking to the Gladys hub: auth, the WebSocket connection/reconnection, the event/method API.  |
| [`@ecoflow-api/schemas`](https://www.npmjs.com/package/@ecoflow-api/schemas)                         | Real, current zod schemas for the EcoFlow Open Platform's request/response and command shapes. |
| [`mqtt`](https://www.npmjs.com/package/mqtt)                                                         | MQTT.js — the standard Node MQTT client, used only by Method 2's transport (privateClient.js). |

Everything else — the REST client, HMAC-SHA256 request signing, the private-login MQTT
request/reply orchestration, config normalization — is hand-written on top of Node built-ins
(`node:crypto`, the global `fetch`), the same reasoning gladys-lubluelu-vaccum's own Tuya Cloud
client used ("small and specific enough... pulling in a full SDK wasn't worth it"), here amplified
by necessity for Method 1:

> **`@ecoflow-api/rest-client@0.6.0` is broken.** Its published bundle contains a stray
> `require("@ecoflow-api/schemas/src/river2Pro/setCommands/bms")` — a deep source-path import that
> can never resolve against the published, `dist`-only `@ecoflow-api/schemas` package. This throws
> at module load, unconditionally, for every consumer — confirmed by this repo's own test suite
> failing on nothing more than `import { RestClient } from '@ecoflow-api/rest-client'`. So this
> integration depends on `@ecoflow-api/schemas` directly (unaffected: pure zod, no such import) and
> re-implements the small REST/signing layer itself (`src/ecoflow/signing.js`,
> `src/ecoflow/client.js`), cross-checked against `@ecoflow-api/rest-client`'s own _source_ (read,
> not executed) and against `tolwi/hassio-ecoflow-cloud`'s `api/public_api.py`. The internal
> `createEcoflowClient()` helper it wraps returns the exact same 3-method shape
> (`getDevicesPlain`/`getDevicePropertiesPlain`/`setCommandPlain`) `RestClient` exposes, so a future
> fixed release could be swapped back in without touching any other file.

Also worth noting: every one of `@ecoflow-api/schemas`' River 2 command schemas gates its top-level
`sn` field on `river2ProSerialNumberSchema` (`R621...`-only) — a Pro-specific guard with nothing to
do with the actual wire format. `src/ecoflow/commands.js#sendCommand` validates only
`schema.shape.params` for exactly this reason; see that function's own comment.

Method 2's transport (`src/ecoflow/privateClient.js`) is cross-checked the same way, against
`tolwi/hassio-ecoflow-cloud`'s `api/private_api.py` and `devices/__init__.py` — see that file's
header for the exact endpoints/topics confirmed and the trade-offs this method carries.

Dev-only dependencies (never shipped in the Docker image): `eslint` + `@eslint/js` +
`eslint-config-prettier` + `globals` for linting, `prettier` for formatting. Testing uses no
library: `npm test` runs Node's own `node --test`.

## Keeping dependencies current (CI/CD)

Three independent [Dependabot](https://docs.github.com/en/code-security/dependabot) watchers
(`.github/dependabot.yml`): `npm` (this repo's packages), `docker` (the Dockerfile base image), and
`github-actions` (the workflows' own actions). Every PR Dependabot opens runs the full `ci.yml`
suite (lint, `node --test`, a real `docker build`).

**Auto-merge, low-risk patch bumps only** (`.github/workflows/dependabot-auto-merge.yml`): the
Dockerfile base image, the GitHub Actions, and npm **dev** dependencies auto-merge once CI is
green, for a PATCH-level bump only. Deliberately **never** auto-merged, at any semver level:
`@ecoflow-api/schemas`, `@gladysassistant/integration-sdk`, and `mqtt` — the first two are pre-1.0,
and this repo's own tests mock the EcoFlow client/MQTT broker entirely, so they cannot catch a real
behavior change in any of these packages the way a real-SDK smoke-import job could. A bad silent
bump here would mean sending a wrong command to a real power station — left for a human to review,
every time.

**Automatic releases** (`.github/workflows/auto-release.yml`): the moment a Dependabot PR actually
merges (auto or by hand), a patch release is cut and its multi-arch image published automatically
— no manual "Run workflow" click needed for the dependency-update path. `.github/workflows/release.yml`
is still there for a deliberate minor/major release, run by hand from the Actions tab.

## Project structure

```
.
├─ index.js                    # SDK bootstrap, transport wiring, poll timer lifecycle, event wiring
├─ src/
│  ├─ ecoflow/
│  │  ├─ signing.js            # PURE: HMAC-SHA256 request signing (Method 1)
│  │  ├─ client.js             # Method 1: official REST transport, @ecoflow-api/schemas-validated
│  │  ├─ privateClient.js      # Method 2: simple login + MQTT transport (unofficial, see its header)
│  │  ├─ commands.js           # River 2 family command builders, shared by both transports
│  │  └─ quota.js              # PURE: EcoFlow quota <-> Gladys features, shared by both transports
│  ├─ devices/
│  │  ├─ device.js             # discovery payloads, the sn/transport/lastQuota registry, actions
│  │  └─ index.js              # device-list refresh, manual-SN registration, the poll loop
│  └─ config.js                # config defaults + normalization for both methods
├─ test/                       # one *.test.js per src/ file above, node --test, no library
├─ test-fixtures/
│  ├─ fakeGladys.js            # minimal in-memory stand-in for the SDK client, used by tests
│  └─ fakeTransport.js         # minimal stand-in for the shared transport shape
├─ docs/
│  └─ en.md / fr.md            # END-USER documentation, re-hosted by Gladys itself in its UI
├─ gladys-assistant-integration.json  # the manifest: name, version, Docker image, config form, actions
├─ Dockerfile                  # single-stage: no local device protocol, no Python bridge needed
└─ cover.png                   # catalog cover
```

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="ecoflow" \
LOG_LEVEL=debug \
npm start
```

## Quality checks

```bash
npm run format:check   # Prettier
npm run format          # Prettier, write
npm run lint             # ESLint
npm test                 # node --test
```

`test/signing.test.js` is a genuine round-trip check: every expected signature is computed
independently with Node's own `crypto.createHmac` against a hand-built message string, not by
calling `computeSignature()` a second time. `test/client.test.js` exercises the real
`createPublicTransport()` against a fake `fetchImpl` (URL, headers, signed request bodies — not a
mock of the transport itself). `test/privateClient.test.js` does the same for Method 2's login/MQTT
credential fetch, plus the request/reply correlation logic against a fake MQTT client. `test/commands.test.js`
additionally re-validates every sent command's `params` against `@ecoflow-api/schemas`' own,
current zod schemas — real schema drift fails here, not just a stale copy of it.

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

## Publish

Add the GitHub topic `gladys-assistant-integration`, then **Actions → Release → Run workflow**
(bumps `package.json` + the manifest, tags, builds the multi-arch image) for a deliberate
minor/major release — patch releases from dependency updates ship on their own, see
"Keeping dependencies current" above. See the
[integration-template-js README](https://github.com/GladysAssistant/integration-template-js) for
the full publishing flow.

## Scope

Discovery (both methods), battery level, AC charging power, total output power, AC output power,
solar input power, and four binary switches (AC output, X-Boost, DC output, backup reserve) — built
once for the whole River 2 family rather than per-model, shared by both onboarding methods.
Deliberately out of scope for now: numeric charge/discharge-limit and backup-reserve-level
settings, and real-time MQTT push for Method 1 — see `docs/en.md`'s "Possible follow-ups" for why
and what each would need.

## Tested and confirmed

See `docs/en.md`'s own "Tested and confirmed" section for the full, honest breakdown — in short:
**no EcoFlow account (developer or app) and no physical River 2 unit were available while writing
this integration.** Both transports' wire formats are cross-confirmed against independent,
live-used reference implementations (read, not executed) and this repo's own test suite (80+
tests, all exercising real logic — no network, no live EcoFlow account, no real MQTT broker). What
genuinely isn't confirmed yet: behavior against a real account and a real device, through either
method. Please test with `LOG_LEVEL=debug` and open an issue for anything that looks off.

## License

Apache-2.0
