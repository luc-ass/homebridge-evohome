# Changelog

## Unreleased

### Fixed

- **A failed startup is retried instead of being final.** Discovery ran exactly
  once. If the first request failed — a Raspberry Pi whose network is not up yet
  when Homebridge starts, a Honeywell outage of a few seconds — the plugin
  stayed dead until somebody restarted Homebridge by hand, while the log
  promised it would pick up again on its own. It now retries with the same
  growing delay the poller uses, and gives up only on an error that will not
  fix itself, such as a wrong password. What the log says about the kept
  accessories is also correct now: they keep answering with their last known
  values, they are not marked unavailable. ([#214](../../issues/214))

## 1.0.0-beta.2

### Fixed

- **A battery no longer reads as empty.** `beta.1` published the battery status
  with `StatusLowBattery` alone, on the grounds that the API reports no charge
  percentage and an invented one would be worse than none. It is not: a client
  renders the missing `BatteryLevel` as 0 %, so every zone showed "0 %, Charged"
  in the Homebridge UI while the batteries were fine. The level now carries the
  two values the API actually supports — 100 % while nothing is reported, 10 %
  once Evohome reports a low battery — and the charging state says "not
  chargeable". ([#205](../../issues/205))

## 1.0.0-beta.1

### Added

- **Faults and battery status reach HomeKit.** A zone or the hot water reporting
  `TempZoneActuatorLowBattery` now shows a low battery on that accessory, and
  any other fault — a lost radio link, a defective sensor — shows as a fault
  (`StatusFault`). Until now `activeFaults` was read from the API and then only
  written to the log, where nobody looks. A low battery is deliberately _not_
  treated as a fault: the valve still measures and still heats. No charge
  percentage is reported, because the API does not provide one.
- **Every location is named at startup.** An account with several homes now
  sees all of them with their IDs, not only the one that was picked. Until now
  the ID needed for `locationId` appeared nowhere at all.
  ([#205](../../issues/205))
- **Gateways and controllers the plugin does not read are named in the log.**
  It uses `gateways[0].temperatureControlSystems[0]`, exactly as 0.11.2 did, and
  said nothing about the rest — a zone or a hot water tank on a second
  controller simply did not exist. A location that reports more than one of
  either now warns, so the cause is one line in the log rather than a support
  thread. Reading them is still not implemented; no response with a second
  gateway has ever been available. ([#205](../../issues/205))

### Fixed

- **Two platform blocks on one bridge no longer delete each other's
  accessories.** Homebridge hands the cached accessories to only one platform
  instance of a given name, so with two `Evohome` blocks the instance that
  received the cache retired the other one's accessories on every start.
  Accessories now record which location they belong to and are left alone by a
  block that does not own them, and the log says that each block needs its own
  child bridge. ([#205](../../issues/205))
- **A fault that was already present when Homebridge started was never logged.**
  The check compared against the previous status, which does not exist on the
  first update, so a flat battery at start stayed silent forever. Faults are now
  logged when they appear and when they clear.

## 1.0.0-beta.0

A rewrite for **Homebridge 2**. The plugin is now TypeScript, ships as an ES
module and has **no runtime dependencies**.

### ⚠️ Breaking changes

- **Homebridge 2.0.0 and Node.js 22, 24 or 26 are required.** Homebridge 1.x is
  no longer supported; stay on `0.11.2` if you need it.
- **Accessories are recreated once.** They appear in the default room and must
  be moved back; scenes and automations need to be recreated. Their identity now
  comes from the Evohome zone ID instead of the position in Honeywell's
  response, so this is the last time it happens. ([#61](../../issues/61))
- **`childBridge` removed.** It only suppressed an error path. A dynamic
  platform keeps its accessories on failure, so this is no longer needed. The
  option is ignored with a note in the log.
- **`temperatureUnit` removed.** HomeKit takes the display unit from the iOS
  device; the option never affected the display.
- **A temperature set in HomeKit now keeps the end time of a running override**
  by default. Set `"setpointMode": "untilNextSwitchpoint"` for the old
  behaviour. ([#149](../../issues/149))
- **Domestic hot water no longer records a history graph.** 0.11.2 logged a
  hard-coded target of 60 °C that had nothing to do with the actual system.
- **The Eve characteristics `Program Command` and `Program Data` were dropped.**
  Neither was implemented; `Program Data` returned a fixed hex blob unrelated to
  the real schedule.

### Fixed

- **Plugin crashed on startup under Homebridge 2** with
  `TypeError: Class constructor Characteristic cannot be invoked without 'new'`.
  The custom Eve characteristics are now ES classes and read `Formats`, `Units`
  and `Perms` from `api.hap`. ([#205](../../issues/205), groundwork by
  [@MGMsystems](https://github.com/MGMsystems) in [#207](../../pull/207))
- **Accessories lost their room, scenes and automations** seemingly at random,
  because identity was derived from an array index. ([#61](../../issues/61))
- **Rising CPU usage over time.** The guard against overlapping status requests
  was reset before the request finished, so polls could stack up. There is now
  one timer and one request per cycle instead of four timers and three requests.
  ([#172](../../issues/172))
- **`characteristic was supplied illegal value: number 5 exceeded minimum of 10`.**
  Turning a zone off wrote a fixed 5 °C regardless of the zone's minimum. Off is
  now expressed through the HomeKit state, and every setpoint is clamped to the
  zone's own limits. ([#94](../../issues/94))
- **`characteristic value expected valid finite number and received "NaN"`.** A
  zone with an empty battery reports no temperature; that value was passed
  straight to HomeKit. ([#94](../../issues/94))
- **Hot water scenes failed with "Error Action Set Failed"** after about 15
  seconds. The success path never answered HomeKit. ([#180](../../issues/180))
- **`Failed to load Hot Water: TypeError: Cannot read properties of undefined`**
  in a loop. The hot water poller called a callback that did not exist, and API
  error bodies were parsed as if they were valid responses.
  ([#205](../../issues/205))
- **The plugin stayed dead until restart when a token refresh failed.** Sessions
  are now refreshed on demand, re-authenticated when the refresh token expires,
  and retried with a growing delay. ([#136](../../issues/136))
- **Schedules were misread across midnight and depended on the order of days in
  the response.** The next switchpoint is now computed in seconds since midnight
  using the location's UTC offset, with tests across day and week boundaries.
- **`temperatureAboveAsOff` had no effect** — the option was never passed to the
  accessory.
- **A zone's model was overwritten on every read** because of an assignment used
  where a comparison was meant.
- **Username and password were kept in a module-level map** that was never read
  and never cleared.

### Added

- `setpointMode` — choose how long a temperature change applies.
  ([#149](../../issues/149))
- `locationId` — address a home by its stable ID instead of by index.
- `pollIntervalSeconds` — configurable, with a 60 second floor to stay clear of
  Honeywell's rate limit.
- `logTemperatureChanges` — log room temperature changes with direction.
  ([#146](../../issues/146), suggested by
  [@PuzzledUser](https://github.com/PuzzledUser) in [#204](../../pull/204))
- `history` — turn the Eve graphs off. `fakegato-history` is then never
  imported, which also avoids the `googleapis` load that broke startup on Hoobs.
  ([#166](../../issues/166))
- Zones that disappear from Honeywell are now removed from HomeKit; new zones
  are added automatically.
- Switches are only created for system modes the system actually supports.
- Active faults such as a low battery are reported in the log.

### Changed

- `request`, `q`, `lodash` and `moment` are gone — all four were deprecated or
  used for a handful of one-liners. The plugin now uses the built-in `fetch`.
- Sessions are cached in the Homebridge storage directory, so a restart does not
  trigger a new login.
- Schedules are cached for an hour instead of being fetched on every change.
- API responses are validated at the boundary. A malformed response now produces
  `Unexpected API response at "<path>"` instead of a `TypeError` somewhere else
  entirely.
- Repeated failures are logged once rather than on every attempt.
  ([#153](../../issues/153))
- `fakegato-history` moved to `optionalDependencies`; `npm install --omit=optional`
  installs without it.

### Known limitations

- Thermostats appear under "Humidity" in the Home app. This follows from the
  HomeKit thermostat service and cannot be changed by a plugin.
  ([#130](../../issues/130))
- Around a daylight-saving change a switchpoint may be off by an hour, because
  the API only reports Windows time zone identifiers.
- The domestic hot water path could not be verified against a real system during
  development. Reports welcome.

## 0.11.2 and earlier

See the [releases page](../../releases).
