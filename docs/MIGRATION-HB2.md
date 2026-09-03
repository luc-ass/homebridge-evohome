# Migration plan: homebridge-evohome → Homebridge 2.x

As of 2026-09-03 · branch `homebridge-v2` · starting point `7a583c8`
State before the rewrite: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. Target environment (verified, not from memory)

|                          | Value                               | Source                          |
| :----------------------- | :---------------------------------- | :------------------------------ |
| Homebridge               | 2.4.0 (latest)                      | `npm view homebridge`           |
| Node                     | `^22 \|\| ^24 \|\| ^26`             | `homebridge@2.4.0` engines      |
| HAP                      | `@homebridge/hap-nodejs` 2.2.x      | homebridge dependencies         |
| Homebridge module system | **ESM** (`"type": "module"`)        | `homebridge@2.4.0` package.json |
| Plugin loading           | `await import(pathToFileURL(main))` | `homebridge/dist/plugin.js:164` |

**Important:** Homebridge itself is ESM but loads plugins through a dynamic
`import()`. CommonJS plugins therefore keep working as long as they do not call
`require("homebridge")` — which this plugin never does. A rewrite is thus _not_
forced by the module system; it makes sense for other reasons (section 3).

The static platform API (`accessories(callback)` + `getServices()`) still exists
in 2.4.0 (`HomebridgeAPI.isStaticPlatformPlugin`, `bridgeService.js:499`). It is
nevertheless the root of several long-standing problems and should be abandoned.

## 2. What actually breaks under Homebridge 2

Verified against `@homebridge/hap-nodejs@2.2.3`:

| #   | Break                                                                                           | Location in the plugin                                          | Effect                                                                                                            |
| :-- | :---------------------------------------------------------------------------------------------- | :-------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------- |
| B1  | `Characteristic` is an ES class; `Characteristic.call(this, …)` + `util.inherits` is impossible | `index.js:29–69`                                                | **Crash at startup** — `TypeError: Class constructor Characteristic cannot be invoked without 'new'` (issue #205) |
| B2  | `Characteristic.Formats/Units/Perms` statics removed, now only `api.hap.Formats/Units/Perms`    | `index.js:36–38, 51, 63`                                        | access on `undefined`                                                                                             |
| B3  | `Characteristic.getValue()` removed                                                             | `index.js:498, 504`                                             | `TypeError` in every `periodicUpdate`                                                                             |
| B4  | Node floor of 22                                                                                | `engines.node: ">=0.12.0"`                                      | warning, misleading signal                                                                                        |
| B5  | `engines.homebridge` must include `^2`, otherwise no "HB2 ready" badge in the Homebridge UI     | `engines.homebridge: ">=0.3.1"`                                 | visibility and trust                                                                                              |
| B6  | Stricter value validation                                                                       | 5 °C with `minHeatSetpoint: 10`, `NaN` on an empty battery      | issue #94, warning spam                                                                                           |
| B7  | `new Buffer(...)`                                                                               | `index.js:1038`                                                 | deprecated, noisy on Node 22                                                                                      |
| B8  | `Accessory.setPrimaryService()` removed                                                         | the plugin uses `Service.setPrimaryService()` (`index.js:1277`) | **no problem**, correct variant                                                                                   |
| B9  | `BatteryService` removed                                                                        | not used                                                        | no problem                                                                                                        |

## 3. Weaknesses of the current state

Independent of HB2 — these points decide whether a rewrite is worth it.

### 3.1 Architecture

- **S1 — static platform ⇒ no persistent accessories.**
  Accessories are recreated on every start. If the `uuid_base` changes, HomeKit
  creates new devices: rooms, names, scenes and automations are gone. That is
  exactly what the README lists as a "known issue" (#61) and the reason the
  `childBridge` switch exists. On top of that `uuid_base` is
  `systemId + ":" + array index` — merely reordering or adding a zone at
  Honeywell shifts every ID.
  → Fix: `DynamicPlatformPlugin` with `configureAccessory()` plus a stable UUID
  derived from the `zoneId`.

- **S2 — the `childBridge` option is a workaround for missing error handling.**
  It only suppresses `callback([])` on failure. With a dynamic platform it
  disappears entirely.

- **S3 — callback pyramid.** `accessories()` and `periodicUpdate()` are nested up
  to ten levels deep (`index.js:106–360`, `385–677`), with `.bind(this)`, `that`
  aliases and a partly contradictory `this`. Practically not extensible.

### 3.2 Concrete bugs (verified in the code)

| ID      | Location                       | Defect                                                                                                                                                                                                                                                                                                                            |
| :------ | :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S4**  | `index.js:982`                 | `if ((this.model = "HeatingZone"))` — **assignment instead of comparison**. Every `getTargetTemperature` sets the model of every accessory to `"HeatingZone"`, overwriting `RoundWireless`/`RoundModulation`/`domesticHotWater` as well. The `else` branches at `:840`, `:947` and `:1016` are therefore effectively unreachable. |
| **S5**  | `index.js:390 vs. 677`         | `this.updating = true` sits at the top of `periodicUpdate`, `this.updating = false` **synchronously at the end of the function** — long before the promise chain has finished. The reentrancy guard has no effect; updates can overlap and stack up. A strong candidate for issue #172 (rising CPU load).                         |
| **S6**  | `index.js:90 vs. 956`          | `temperatureAboveAsOff` is set on the platform but never passed to the accessory. `that.temperatureAboveAsOff` is always `undefined` — **the feature does nothing**, although it is documented in the config schema and the README.                                                                                               |
| **S7**  | `index.js:1164, 1168–1187`     | `EvohomeDhwAccessory.periodicCheckStatus` is invoked by `setInterval` without arguments but calls `callback(err)` on failure → `TypeError: callback is not a function`. This explains the endless "Failed to load Hot Water" messages in the log (comment on #205).                                                               |
| **S8**  | `lib/evohome.js:138`           | `getHotWater` builds `new DHW(json)` without checking. If the API returns an error body, `json.temperatureStatus` is `undefined` → `Cannot read properties of undefined (reading 'temperature')`.                                                                                                                                 |
| **S9**  | `index.js:730–800`             | `getNextScheduledTime()`: `proceed` is not reset between weekdays, comparison happens on a localised `toLocaleTimeString()` string, and across midnight everything falls back to `"00:00:00"`. Hence the time zone warning in the README.                                                                                         |
| **S10** | `lib/evohome.js:21–33`         | `sessionCredentials` stores the username and **password in plain text** in a module-level map keyed by the bearer token. The map is **never read** and never cleared. Delete outright.                                                                                                                                            |
| **S11** | `index.js:322, 326, 724, 1164` | `setInterval` handles are never stored or cleared with `clearInterval`. With N zones, N timers run every 5s forever.                                                                                                                                                                                                              |
| **S12** | `lib/evohome.js:288–320`       | The token refresh runs on a `setInterval` using the _initial_ `expires_in`. If a refresh fails there is no retry and no re-login — the plugin is dead until restart (issue #136).                                                                                                                                                 |
| **S13** | `index.js:130–135`             | `getThermostats()` and `getSystemModeStatus()` call the **same** endpoint. Every poll makes three requests where one would do.                                                                                                                                                                                                    |

### 3.3 Dependencies and security

- **S14** — `request` has been deprecated and unmaintained since 2020, `q` is
  deprecated too. Node 22 has a global `fetch`; both can go. So can `lodash`
  (5 × `_.map`) and `moment` (3 × `.unix()`).
- **S15** — `fakegato-history` pulls in `googleapis` (~100 MB) and `debug@^2`.
  The `googleapis` import is exactly the failure in issue #166 (Hoobs). The
  Google Drive path is never used by this plugin (`storage: "fs"`).
- **S16** — no `package-lock.json`, and every runtime dependency is an open
  range (`>=`). A broken transitive update hits every user immediately.

### 3.4 Quality assurance

- **S17** — `.eslintrc` configures `@typescript-eslint` and `eslint-plugin-jest`;
  neither is installed, there are no `.ts` files and no `lint` script. The config
  never runs.
- **S18** — `npm-publish.yml` uses **Node 12** and calls `npm test` even though
  no `test` script exists. The release workflow cannot be relied upon.
- **S19** — no tests at all. There is no way to check a behavioural change
  without a real Evohome system — the main reason contributions feel so heavy
  here.

## 4. Target architecture

TypeScript, ESM, `DynamicPlatformPlugin`, Node ≥ 22, no runtime dependencies
except optionally FakeGato.

```
src/
  index.ts                  registerPlatform, default export
  settings.ts               PLATFORM_NAME, PLUGIN_NAME, defaults
  platform.ts               EvohomePlatform: configureAccessory, discovery, one poller
  config.ts                 config type + validation + migration of old keys
  api/
    client.ts               EvohomeClient: fetch, retry, backoff, rate limit handling
    auth.ts                 TokenStore: login, refresh, re-login, persistence
    types.ts                response types of the TCC EMEA API
    errors.ts               EvohomeAuthError | EvohomeApiError | EvohomeNetworkError
  accessories/
    thermostat.ts           ThermostatAccessory
    dhw.ts                  DomesticHotWaterAccessory
    systemMode.ts           SystemModeAccessory
  characteristics/eve.ts    Eve characteristics as ES classes
  util/schedule.ts          nextSwitchpoint() — testable, no HomeKit dependency
test/                       Vitest + recorded API fixtures
```

**Guiding decisions**

1. **One source of data.** A `PollingCoordinator` fetches `/location/{id}/status`
   exactly once per cycle and distributes the result to every handler (fixes
   S13). A single timer instead of N+2 (fixes S11), with a real `async` guard
   (fixes S5).
2. **Stable identity.** `api.hap.uuid.generate("evohome:" + zoneId)` instead of
   an array index. A one-off, documented migration for existing users
   (section 7).
3. **`onGet`/`onSet` instead of `.on("get"/"set")`.** Async handlers that return
   a value or throw a `HapStatusError`, rather than swallowing errors. Values
   come from the poller's cache — no API call in the HomeKit path.
4. **No lost callback errors.** Every API error is typed, logged and leads to a
   defined state (last known value), not to an abort.
5. **Login with backoff.** Exponential with a cap, so the rate limit is not hit
   (issue #136 asks for this explicitly).
6. **One platform instance = one location** (decision F5). `singular: false` and
   `locationIndex` stay; several systems on one account are usually different
   households and belong in separate config blocks, possibly in separate child
   bridges. `locationIndex` is complemented by `locationId` so that reordering at
   Honeywell does not shift the mapping.
7. **`Service.Thermostat` stays** (decision F4). The humidity tile from #130 is
   Home app behaviour and is documented as a limitation rather than worked
   around.
8. **Eve history is optional** (decision F3). `fakegato-history` moves to
   `optionalDependencies` and the `history` option (default `true`) turns it off.
   If the module is missing, the plugin runs without history instead of
   crashing.

## 5. Phased plan

With decision **F1 (go straight to 1.0.0)** the intermediate 0.12.0 release is
dropped. The existing code is no longer touched — every weakness found in
sections 2 and 3 must instead be demonstrably addressed in the new code.
Section 5.1 records that as a checklist so nothing is lost when the old code is
thrown away.

**A consequence accepted knowingly:** `master` stays broken for Homebridge 2
users until 1.0.0 is done (#205 has been open since May 2026). Mitigation:
publish betas from this branch early and often (`npm publish --tag beta`) and
point the testers in #205 at them — several users there run 12-zone systems and
have offered to help.

### Phase 0 — Foundation and toolchain (1.5 days)

- [x] Branch `homebridge-v2`
- [x] Survey and plan
- [x] TypeScript strict, `tsconfig.json`, build to `dist/`, `"type": "module"`
- [x] ESLint 9 flat config with `typescript-eslint` (replaces the dead
      `.eslintrc`) — S17
- [x] Vitest plus npm scripts: `build`, `lint`, `test`, `watch`, `check`
- [x] CI workflow: matrix Node 22/24/26, `lint` + `typecheck` + `test` +
      `build` — S19
- [x] `npm-publish.yml`: Node 22 instead of 12, `npm ci`, `npm run check`, build
      before publish, pre-releases automatically under the npm tag `beta` — S18
- [x] `package.json`: `files`, `engines` (F2), no runtime dependencies — B4/B5
- [x] Commit `package-lock.json` — S16
- [x] Legacy code moved to `legacy/*.cjs` (required by `"type": "module"`),
      excluded from build, lint and `files`
- [x] Platform skeleton: `EvohomePlatform implements DynamicPlatformPlugin` with
      `configureAccessory()` — loads under Homebridge 2.x, creates no accessories
      yet
- [x] Test instance: `npm run dev` starts Homebridge 2.4.0 from the
      devDependencies with `-P .` against the repo — verified, the plugin loads
      and registers the platform
- [x] Run with real credentials against a production Honeywell account: login,
      discovery and accessory creation work (2026-09-03)

### Phase 1 — API client (2–3 days)

- [x] `api/types.ts` as domain types, fixtures in `test/fixtures/`
- [x] `EvohomeClient` on `fetch` + `AbortSignal.timeout` —
      `request`/`q`/`lodash`/`moment` gone entirely, the package has no runtime
      dependencies left (S14)
- [x] Response validation at every boundary (`validate.ts`, `parse.ts`): every
      error names the path in the response instead of producing a bare
      `TypeError` — S8
- [x] `TokenStore`: on-demand refresh, re-login on a spent refresh token, giving
      up only on permanently bad credentials — #136, S12
- [x] Credentials in ES private fields, no global map, no password in
      `JSON.stringify(store)` — S10
- [x] `util/backoff.ts`: exponential with a cap and jitter — #136
- [x] `util/schedule.ts`: `nextSwitchpoint()` rewritten, with tests across day
      boundaries, the Sunday/Monday edge, ordering and DST — S9
- [x] One status call per cycle instead of three (S13) — done in the client, the
      poller follows in phase 2
- [x] 84 tests, coverage threshold in `vitest.config.ts` raised to 90/85
- [x] Partly confirmed against a real account (2026-09-03): the read path
      `/Auth/OAuth/Token`, `/userAccount`, `/location/installationInfo` and
      `/location/{id}/status` runs through without an `EvohomeResponseError`, so
      the field names in `parse.ts` are right for those four responses
- [x] Write path confirmed on a real system (2026-09-03): a temperature change
      from HomeKit reads `/temperatureZone/{id}/schedule`, writes
      `PUT …/heatSetpoint` and processes the acknowledgement — the `setpointMode`
      rule applies as intended (#149)
- [ ] **Open:** the hot water status (`dhw` in `/location/{id}/status` and
      `PUT /domesticHotWater/{id}/state`) is still unverified — only relevant for
      systems with domestic hot water

### Phase 2 — Dynamic platform and accessories (3–4 days)

- [x] `EvohomePlatform implements DynamicPlatformPlugin`, `configureAccessory()`,
      `didFinishLaunching` → discovery, `unregisterPlatformAccessories` for
      vanished zones — S1, #61
- [x] Stable UUIDs from `zoneId` / `dhwId` / `systemId+mode`
- [x] `PollingCoordinator`: one request per cycle, configurable interval, a real
      reentrancy guard, `clearTimeout` on shutdown — S5, S11, S13, #172
- [x] `characteristics/eve.ts`: `ValvePosition` as an ES class using
      `api.hap.Formats/Units/Perms` — B1, B2 (based on PR #207).
      `ProgramCommand`/`ProgramData` **deliberately dropped**, see below
- [x] `ThermostatAccessory`, `DomesticHotWaterAccessory`, `SystemModeAccessory`
      with `onGet`/`onSet`; `updateValue` instead of `getValue()` — B3
- [x] Setpoints clamped to `setpointCapabilities`, "off" expressed through
      `TargetHeatingCoolingState` rather than 5 °C — B6, #94
- [x] `new Buffer` disappears along with `ProgramData` — B7
- [x] `childBridge` removed, ignored with a note — S2
- [x] `config.ts`: validated configuration with warnings instead of `!= false`;
      `temperatureAboveAsOff` now actually works — S6 (pulled forward from
      phase 3)
- [x] Token persistence through `api.user.storagePath()` — carried over from
      phase 1
- [x] The write path no longer blocks: `scheduleRefresh()` instead of
      `await refresh(3000)`
- [x] Tests against the **real** `@homebridge/hap-nodejs` rather than a stub;
      140 tests, coverage 92 %
- [x] Verified: the plugin loads under Homebridge 2.4.0 and registers the
      platform

**Deliberate deviation:** `ProgramCommand` and `ProgramData` from 0.11.2 were not
carried over. Neither was ever implemented; `ProgramData` returned a hard-coded
hex blob unrelated to the actual schedule. Reporting a made-up program to the Eve
app is worse than not offering the characteristics at all. If wanted, they belong
with #54 in phase 4.

### Phase 3 — Behaviour and open issues (2–3 days)

- [x] `setpointMode` option: **`keepExistingUntil` (default)** |
      `untilNextSwitchpoint` | `permanent` — #149, analysis below
- [x] `logTemperatureChanges` option — #146 (based on PR #204)
- [x] `ScheduleCache`: schedules are cached instead of re-fetched on every
      temperature change
- [x] Off expressed through `TargetHeatingCoolingState` rather than 5 °C — #94
      _(phase 2)_
- [x] The DHW write path answers in _every_ branch — #180 _(phase 2)_
- [x] `temperatureAboveAsOff` evaluated in the handler — S6 _(phase 2)_
- [x] Model detection typed — S4 _(phase 1, `parse.ts`)_
- [x] Addressing by `locationId` in addition to `locationIndex` — F5 _(phase 2)_

#### Analysis of #149

The API has **no** "change the value, keep the end time" mode:
`PUT /temperatureZone/{id}/heatSetpoint` requires one of the three
`SetpointMode` values. The assumption in the issue that there is an endpoint for
setting the temperature alone does not hold.

It is solvable anyway, because `setpointStatus.until` reports the running end
time (checked against the schema definition in `evohome-async`: an ISO 8601
timestamp, present only for time-bounded modes). It is simply sent back on write.

Since HomeKit has no notion of "until", the rule is a configuration decision
rather than a per-interaction one. `keepExistingUntil` was chosen as the default:
it behaves exactly like 0.11.2 as long as no override is running, and fixes
precisely the reported case. "Off" always writes a permanent override regardless
— a zone that was switched off should not come back on at the next switchpoint.

### Phase 4 — Optional Eve history (0.5–1 day)

- [x] `fakegato-history` in `optionalDependencies`, `history` option (default
      `true`) — F3
- [x] Dynamic import with a fallback: if the module is missing, everything runs
      on without history instead of failing at startup
- [x] `history: false` does not load `fakegato-history` **at all** — and
      therefore not `googleapis` either, the actual trigger of #166
- [x] `history` option in the config schema
- [x] Effect on #166 documented in the README

**#166 in detail:** `fakegato-storage.js` unconditionally requires
`./lib/googleDrive` on line 11, and with it `googleapis` — even for
`storage: "fs"`, which is all this plugin uses. On Hoobs, startup failed on
exactly that import. `optionalDependencies` alone does not help, because npm
installs those by default; what matters is that the **import** depends on the
option. Affected users set `"history": false`; anyone who does not want the
dependency at all installs with `--omit=optional`.

**Deliberately not implemented:** hot water gets no history. 0.11.2 wrote a
hard-coded target of 60 °C for it (`// TODO, random value`); the EMEA API
reports no target temperature for DHW from which a meaningful curve could be
drawn. An invented line is worse than none — the same reasoning as for
`ProgramData` in phase 2. If wanted, the plain temperature curve without a target
could be added later.

### Phase 5 — Config, docs, release 1.0.0 (1–1.5 days)

- [x] `config.schema.json` v2: new options, `childBridge` and `temperatureUnit`
      gone, migration note in the header — **pulled forward from phase 5** so the
      new options can be exercised through the Homebridge UI. A test keeps the
      schema and `src/config.ts` in step: defaults, value lists and layout
      references must agree
- [x] Every user-facing text in English — log output, error messages, config
      schema, README and CHANGELOG. The user base is international and all issues
      are in English
- [x] Comments and test descriptions in English as well — contributors come from
      several countries, and the README points them at `docs/`
- [x] Gentle config migration: `childBridge` and `temperatureUnit` are ignored
      with a note, invalid values are reported together with the fallback used
- [x] README rewritten: requirements (HB 2.x, Node 22+), migration,
      `setpointMode` explained, known limitations including #130 as Home app
      behaviour (F4)
- [x] `CHANGELOG.md` with an explicit list of breaking changes
- [x] Credits for PR #207 (@MGMsystems) and PR #204 (@PuzzledUser) in the README
      and CHANGELOG
- [x] Version set to `1.0.0-beta.0`; the publish workflow releases pre-releases
      under the npm tag `beta` automatically
- [ ] **Open (maintainer's call):** trigger `npm publish` or a GitHub release,
      call for testers in #205, close PRs #207 and #204 with a pointer to how
      their work was used
- [ ] **Open:** have the hot water path confirmed by a beta tester with DHW
- [ ] 1.0.0

**Total effort estimate:** roughly 10.5–14 person-days.

### 5.1 Checklist: nothing is lost in the rewrite

Because the old code is no longer patched, every finding from sections 2 and 3
must be demonstrable in the new code. The target is a test in each case, or a
conscious decision not to carry something over.

| Finding       | Addressed in | Evidence                                                              |
| :------------ | :----------- | :-------------------------------------------------------------------- |
| B1, B2, B7    | phase 2      | the plugin starts under HB 2.4.0 without a `TypeError`                |
| B3            | phase 2      | no `getValue()` left in the code (lint rule)                          |
| B4, B5        | phase 0      | `engines` correct, HB2 badge in the Homebridge UI                     |
| B6            | phase 2 + 3  | unit test: setpoint below `minHeatSetpoint`, `NaN` input              |
| S1, S2        | phase 2      | restart test: room assignment survives                                |
| S3            | phase 1 + 2  | `async`/`await`, at most 3 levels of nesting (lint)                   |
| S4            | phase 3      | typed model enum, no `=` in conditions (lint `no-cond-assign`)        |
| S5, S11, S13  | phase 2      | one timer, one request per cycle; test for overlapping polls          |
| S6            | phase 3      | unit test for `temperatureAboveAsOff`                                 |
| S7, S8        | phase 1 + 2  | a fixture with an error body produces a logged error, not a crash     |
| S9            | phase 1      | tests across day boundaries, DST changes and time zones ≠ system time |
| S10           | phase 1      | no plain-text credentials outside the `TokenStore`                    |
| S12           | phase 1      | test: refresh fails → backoff → re-login                              |
| S14, S15, S16 | phase 0 + 4  | `npm ls` free of deprecated packages, lockfile present                |
| S17, S18, S19 | phase 0      | CI green on Node 22/24/26                                             |

## 6. Mapping of open issues

Phase numbers refer to the plan in section 5.

| Issue    | Title                                                                        | Assessment                                                                                                                                                                                                                                             | Phase           |
| :------- | :--------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------- |
| **#205** | `Class constructor Characteristic cannot be invoked without 'new'` under HB2 | **The blocker.** Caused by B1/B2/B3. PR #207 fixes B1/B2 in the old code; in the rewrite this is redone in `characteristics/eve.ts`. The DHW error in the same thread is S7/S8.                                                                        | 2               |
| **#208** | "Out of compliance" when pairing                                             | No evidence of a plugin cause; typical triggers are invalid characteristic values or service limits. B6 is a plausible candidate and is fixed anyway. Re-check with the reporter after the beta, otherwise refer to Homebridge.                        | 2, then observe |
| **#172** | Rising CPU load on a Pi                                                      | Most likely S5 (an ineffective `updating` guard) plus S11 (N timers). The `PollingCoordinator` fixes both structurally.                                                                                                                                | 2               |
| **#94**  | "Target Temperature: illegal value"                                          | B6: 5 °C as the off value with `minHeatSetpoint: 10`, plus `NaN` on an empty battery. Clamp values, express off through `TargetHeatingCoolingState`.                                                                                                   | 2 + 3           |
| **#136** | Automatic retry if login fails                                               | S12. A `TokenStore` with backoff.                                                                                                                                                                                                                      | 1               |
| **#149** | Temperature change overwrites an active override                             | Confirmed in the code: a `TemporaryOverride` until the next switchpoint is always forced. The API also supports `PermanentOverride` and `FollowSchedule`. → `setpointMode` option, which also covers @DenyTsjapanov's request for permanent setpoints. | 3               |
| **#146** | Report changes to the current temperature again                              | `logTemperatureChanges` option, based on PR #204.                                                                                                                                                                                                      | 3               |
| **#180** | Hot water scene fails (Controller for HomeKit)                               | "Error Action Set Failed" after ~15s is a HomeKit timeout. Cause: `setHotWaterStatus` **never** calls the callback on success (`index.js:1198–1265`). Structurally solved by `onSet`.                                                                  | 2 + 3           |
| **#130** | Thermostats show up as humidity sensors                                      | Home app behaviour: `Service.Thermostat` declares `CurrentRelativeHumidity` as optional. With decision **F4** it stays that way → document as a known limitation and close the issue with an explanation.                                              | 5 (docs)        |
| **#166** | Hoobs plugin does not start                                                  | The error comes from `googleapis` under `fakegato-history` (S15), not from the plugin code. Resolved once FakeGato is optional (F3).                                                                                                                   | 4               |
| **#83**  | Evohome security (Total Connect 2.0E)                                        | A different backend and a different product. Not part of this migration; should be a separate plugin.                                                                                                                                                  | out of scope    |
| **#54**  | Schedule support in FakeGato                                                 | Depends on the history decision. Only sensible after phase 4, and only when `history` is on.                                                                                                                                                           | after 4         |

Not from an issue but from the code: **#61** (accessories lose their room) is S1
and is structurally resolved by phase 2.

## 7. Migration for existing users

**Decided (F1): option A.** Moving to stable UUIDs is a one-off breaking change —
HomeKit sees new accessories, and room assignment and automations have to be set
up again. The break is accepted, released as major 1.0.0 and announced in the
README and in the config UI header. After that the identity is permanently
stable; exactly the point that is listed as a "known issue" in the README today.

A compatibility mode that kept the old `systemId:index` UUIDs was rejected: it
would preserve the unstable identity and double the testing effort.

What users have to do on upgrade belongs in the CHANGELOG and README like this:

1. Make sure Homebridge 2.x and Node 22+ are in place before updating.
2. After the update the accessories appear once in the default room and have to
   be reassigned; automations and scenes must be recreated.
3. Remove `childBridge` from the configuration (it is ignored, with a warning).

## 8. Risks

| Risk                                                                            | Effect                                                                                        | Mitigation                                                                                                                             |
| :------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| **No intermediate release** (a consequence of F1)                               | HB2 users stay blocked until 1.0.0 (#205 open since May 2026)                                 | Publish betas from this branch early (`--tag beta`) and link them in #205; prioritise phases 0–2, after which the plugin already works |
| No test system for every device type (DHW, RoundWireless, RoundModulation, UFH) | Regressions for users the maintainer cannot reproduce                                         | Fixtures from real responses; several users with 12-zone systems offered help in #205                                                  |
| The undocumented TCC EMEA API can change                                        | The plugin breaks without warning (as with the domain change `honeywell.com` → `resideo.com`) | Isolate API access; keep the base URL and endpoints configurable                                                                       |
| Rate limiting under a more aggressive retry                                     | The account is temporarily locked                                                             | Exponential backoff with a cap, enforce a minimum polling interval in the schema                                                       |
| Maintainer capacity (see the comment in #172)                                   | The rewrite stalls                                                                            | Phases can be completed individually; after phase 2 a working plugin exists that is usable as a beta                                   |

## 9. Decisions taken

All decided on 2026-09-03.

|        | Question                                      | Decision                                                    | Consequence                                                                                                                                                                                    |
| :----- | :-------------------------------------------- | :---------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** | Hotfix 0.12.0 first, or go straight to 1.0.0? | **straight to 1.0.0**                                       | No intermediate release; the old code is no longer patched. PRs #207/#204 serve as templates and are not merged. Checklist 5.1 safeguards the findings. Betas as compensation.                 |
| **F2** | Node floor?                                   | **`^22 \|\| ^24 \|\| ^26`** — identical to Homebridge 2.4.0 | No need to support Homebridge 1.x, `engines.homebridge: "^2.0.0"`. Allows `fetch`, `AbortSignal.timeout` and modern syntax without polyfills.                                                  |
| **F3** | Keep, replace or make FakeGato optional?      | **optional**                                                | `optionalDependencies` plus a `history` option (default `true`), dynamic import with a fallback. Defuses #166 and the `googleapis` weight.                                                     |
| **F4** | `Thermostat` or `HeaterCooler`?               | **`Thermostat`**                                            | #130 (the humidity tile) is documented as Home app behaviour and the issue is closed. No change to the service type.                                                                           |
| **F5** | Several locations in one instance?            | **keep the filter**                                         | Several systems on one account are usually different households. `singular: false` and `locationIndex` stay; `locationId` is supported in addition as a more stable way to address a location. |
