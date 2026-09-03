# Survey: homebridge-evohome 0.11.2

As of 2026-09-03, base commit `7a583c8` (master).
This document describes the **state before** the Homebridge 2.0 migration.
The plan for the rewrite lives in [MIGRATION-HB2.md](MIGRATION-HB2.md).

> Since phase 0 the code described here lives in `legacy/index.cjs` and
> `legacy/evohome.cjs`. All paths and line numbers in this document still refer
> to the original names `index.js` and `lib/evohome.js`.

---

## 1. Overview

|              |                                                                 |
| :----------- | :-------------------------------------------------------------- |
| Package      | `homebridge-evohome` 0.11.2                                     |
| Language     | JavaScript (CommonJS, ES5 style: `var`, `function`, prototypes) |
| Plugin type  | **Static platform plugin** (plugin API 1.0)                     |
| Plugin alias | `Evohome`, `pluginType: platform`, `singular: false`            |
| Size         | 1,813 lines (`index.js` 1,382, `lib/evohome.js` 431)            |
| Build step   | none — the sources are published as-is                          |
| Tests        | none                                                            |
| `engines`    | `node >=0.12.0`, `homebridge >=0.3.1`                           |

The backend is the **Resideo/Honeywell TCC EMEA API**
(`https://tccna.resideo.com/WebAPI/emea/api/v1`). This is the unofficial app
API, not the documented developer API — authentication uses an OAuth client
credential pair hard-coded in the source plus the user's username and password.

## 2. Files

```
index.js              Platform + 3 accessory classes + custom characteristics
lib/evohome.js        HTTP client for the TCC EMEA API (session, models, endpoints)
config.schema.json    Homebridge UI form
.eslintrc             refers to @typescript-eslint, which is not installed; dead config
.github/workflows/    codeql.yml, npm-publish.yml (Node 12, calls a non-existent `npm test`)
.github/dependabot.yml
assets/, README.md
```

## 3. Runtime flow

```
homebridge loads index.js
  └─ module.exports(homebridge)
       ├─ defines 3 custom characteristics (Eve: ValvePosition, ProgramCommand, ProgramData)
       └─ registerPlatform("homebridge-evohome", "Evohome", EvohomePlatform)

EvohomePlatform.accessories(callback)          ← once, at startup
  └─ evohome.login(user, pass)                 POST /Auth/OAuth/Token
       └─ getUserInfo()                        GET  /userAccount
            └─ session.getLocations()          GET  /location/installationInfo
                 └─ session.getThermostats()   GET  /location/{id}/status
                      └─ session.getSystemModeStatus()   (the same call, a second time)
                           ├─ per zone → EvohomeThermostatAccessory
                           ├─ 0–5 × EvohomeSwitchAccessory (Away/DayOff/HeatingOff/Eco/Custom)
                           ├─ if dhw present → EvohomeDhwAccessory
                           ├─ callback(myAccessories)
                           ├─ setInterval(renewSession, expires_in-30s)
                           └─ setInterval(periodicUpdate, 300s)
```

On top of that **every** thermostat accessory starts its own
`setInterval(periodicCheckSetTemperature, 5s)` in its constructor, and the DHW
accessory a `setInterval(periodicCheckStatus, 60s)`.

## 4. API client (`lib/evohome.js`)

Promise library: **Q** (deprecated). HTTP: **request** (deprecated,
unmaintained). Every call wraps a `request(...)` callback in a hand-rolled
`Q.defer()`.

| Method                                   | HTTP | Endpoint                                                                |
| :--------------------------------------- | :--- | :---------------------------------------------------------------------- |
| `login(user, pass)`                      | POST | `/Auth/OAuth/Token` (`grant_type=password`)                             |
| `getUserInfo()`                          | GET  | `/userAccount`                                                          |
| `Session._renew()`                       | POST | `/Auth/OAuth/Token` (`grant_type=refresh_token`)                        |
| `getLocations()`                         | GET  | `/location/installationInfo?includeTemperatureControlSystems=True`      |
| `getThermostats(locationId)`             | GET  | `/location/{id}/status?includeTemperatureControlSystems=True`           |
| `getSystemModeStatus(locationId)`        | GET  | _the same endpoint as above_                                            |
| `getHotWater(dhwId)`                     | GET  | `/domesticHotWater/{id}/status`                                         |
| `getSchedule(zoneId, isHotWater)`        | GET  | `/{temperatureZone\|domesticHotWater}/{id}/schedule`                    |
| `setHeatSetpoint(zoneId, temp, endtime)` | PUT  | `/temperatureZone/{id}/heatSetpoint`                                    |
| `setSystemMode(id, mode, isHotWater)`    | PUT  | `/temperatureControlSystem/{id}/mode` or `/domesticHotWater/{id}/state` |

Data models are constructor functions: `Session`, `UserInfo`, `Location`,
`Timezone`, `Device`, `Thermostat`, `DHW`, `TemperatureStatus`,
`SetpointStatus`, `DHWStatus`, `Schedule`, `Switchpoint`, `SystemModeStatus`.
There is no response validation — a missing field only surfaces as a `TypeError`
at the point of access.

`setHeatSetpoint` knows three modes:

- `endtime` given → `TemporaryOverride` until that time
- `targetTemperature === 0` → `FollowSchedule` (cancel the override)
- otherwise → `PermanentOverride`

## 5. Accessories and HomeKit mapping

### EvohomeThermostatAccessory (per heating zone)

`uuid_base = systemId + ":" + deviceIndex` — **the index in the array**, not the
zone ID.

| Service              | Characteristic                       | Source / logic                                                           |
| :------------------- | :----------------------------------- | :----------------------------------------------------------------------- |
| AccessoryInformation | Manufacturer/Model/Name/SerialNumber | `Honeywell`, `device.modelType`, `systemId-index`                        |
| Thermostat           | CurrentTemperature                   | `thermostat.temperatureStatus.temperature`, props 1–50 °C                |
| Thermostat           | TargetTemperature                    | `setpointStatus.targetHeatTemperature`, props from `min/maxHeatSetpoint` |
| Thermostat           | CurrentHeatingCoolingState           | `current < target ? HEAT : OFF`                                          |
| Thermostat           | TargetHeatingCoolingState            | `target <= 5 ? OFF : HEAT`; SET: OFF→5 °C permanent, AUTO→FollowSchedule |
| Thermostat           | TemperatureDisplayUnits              | from config only, not persisted                                          |
| Thermostat           | Eve ValvePosition (`E863F12E…`)      | `current < target ? 100 : 0` — synthetic, no real valve data             |
| Thermostat           | Eve ProgramCommand / ProgramData     | not implemented; ProgramData returns a constant hex blob                 |
| FakeGatoHistory      | `thermo`, `storage: "fs"`            | one entry per `periodicUpdate`                                           |

Supported `modelType` values: `HeatingZone`, `RoundWireless`, `RoundModulation`.
Zones with an empty name (typically hot water) are skipped.

### EvohomeSwitchAccessory (per system mode)

A switch whose `On` maps to `setSystemMode(systemId, mode|"Auto", false)`.
`uuid_base = systemId + ":" + systemMode`. Three seconds after switching,
`platform.periodicUpdate()` is forced.

### EvohomeDhwAccessory (hot water, if `dhw` is present)

TemperatureSensor (`setPrimaryService(true)`) + Switch + FakeGato. The target
temperature in the FakeGato log is hard-coded to `60`
(`// TODO, random value`).

## 6. Timers and data flow

| Timer                         | Interval                 | Effect                                                                         |
| :---------------------------- | :----------------------- | :----------------------------------------------------------------------------- |
| `renewSession`                | `expires_in - 30s`       | token refresh                                                                  |
| `periodicUpdate`              | 300s                     | 3 API calls, updates **every** accessory plus FakeGato                         |
| `periodicCheckSetTemperature` | 5s **× number of zones** | checks `targetTemperateToSet != -1`, then a schedule call plus a setpoint call |
| `periodicCheckStatus` (DHW)   | 60s                      | 1 API call                                                                     |

Write path of a temperature change: HomeKit `set` only assigns
`targetTemperateToSet = value` and returns the callback immediately. The 5s timer
then fetches the zone's schedule, computes the next switchpoint with
`getNextScheduledTime()` and writes a `TemporaryOverride` up to that point.
Coalescing rapid successive changes is intentional (debounce); the forced
override duration is the cause of issue #149.

## 7. Configuration

| Key                                                                               | Type   | Default   | Note                                      |
| :-------------------------------------------------------------------------------- | :----- | :-------- | :---------------------------------------- |
| `name`                                                                            | string | `Evohome` |                                           |
| `username` / `password`                                                           | string | –         | plain text in `config.json`               |
| `temperatureUnit`                                                                 | enum   | `Celsius` | purely cosmetic                           |
| `locationIndex`                                                                   | int    | `0`       | one location per platform block           |
| `switchAway` / `switchDayOff` / `switchEco` / `switchHeatingOff` / `switchCustom` | bool   | `true`    | compared with `!= false`                  |
| `childBridge`                                                                     | bool   | `false`   | only suppresses `callback([])` on failure |
| `temperatureAboveAsOff`                                                           | bool   | `false`   | never passed to the accessory → no effect |

## 8. Dependencies

| Package            | Version     | Status                                                                                                                          |
| :----------------- | :---------- | :------------------------------------------------------------------------------------------------------------------------------ |
| `request`          | `>=2.68.0`  | **deprecated**, unmaintained since 2020                                                                                         |
| `q`                | `~1.5.1`    | **deprecated**                                                                                                                  |
| `lodash`           | `>=4.17.13` | used for 5 × `_.map` only                                                                                                       |
| `moment`           | `^2.18.1`   | used for 3 × `moment().unix()` only                                                                                             |
| `fakegato-history` | `>=0.6.1`   | actively maintained, HB2 compatible (ES classes, `homebridge.hap.Formats`) — but pulls in `googleapis` (~100 MB) and `debug@^2` |
| `prettier`         | 3.6.2 (dev) | the only dev tool                                                                                                               |

There is no `package-lock.json` (removed in `4445b3f`) and no npm scripts.

## 9. CI/CD

- `codeql.yml` — CodeQL scan on push, PR and weekly.
- `npm-publish.yml` — on release: `actions/setup-node` with
  **`node-version: 12`**, `npm install`, `npm test` (no `test` script exists, so
  the step fails), then `JS-DevTools/npm-publish@v3`.
- Dependabot daily for npm and GitHub Actions.

## 10. Open pull requests

| PR                           | Content                                                                                            | Relevance to the migration        |
| :--------------------------- | :------------------------------------------------------------------------------------------------- | :-------------------------------- |
| #207                         | HB2 fix: custom characteristics as ES classes, `hap.Formats/Units/Perms`, `Buffer.from`, NaN guard | high — fixes #205                 |
| #204                         | Trapping errors during Honeywell outages, temperature logging                                      | high — partly addresses #153/#146 |
| #203, #198, #197, #196, #195 | Dependabot                                                                                         | low                               |
