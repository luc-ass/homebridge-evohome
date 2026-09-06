# Changelog

## 1.0.0

The first stable release after 0.11.2, and a rewrite for **Homebridge 2**: the
plugin is TypeScript now, ships as an ES module and has **no runtime
dependencies**. It contains everything from the pre-releases `1.0.0-beta.0`
through `1.0.0-beta.3`.

### ⚠️ Your accessories are recreated once — please read this first

On the first start with 1.0.0 every zone, the hot water and every mode switch
is added to HomeKit as a **new** accessory. What that means for you:

- They appear in the **default room** and have to be moved back.
- **Scenes and automations that use them stop working** and have to be created
  again. Write down what you have before updating — the Home app quietly drops
  an automation whose accessory is gone.
- Names given in the Home app fall back to the zone names from Evohome.
- Anything that addresses the accessories from outside — widgets, the Eve app,
  other apps — has to be pointed at them again, and the Eve history starts over.

Why: identity used to be derived from **the position of a zone in Honeywell's
response**. That order is not stable, so zones traded identities whenever
Honeywell reordered them, and rooms, scenes and automations followed the wrong
radiator or disappeared — the cause behind
[#61](../../issues/61). Identity now comes from the **Evohome zone ID**, which
never changes. This is therefore the **last** time it happens: updates,
restarts and reorderings keep everything in place from here on.

Coming from a `1.0.0-beta`, this is already behind you and nothing is
recreated again.

### ⚠️ Requirements

**Homebridge 2.0.0 or newer** and **Node.js 22, 24 or 26**. Homebridge 1.x is
no longer supported — stay on `0.11.2` if you need it.

### Options

#### New

- **`setpointMode`** — how long a temperature set in HomeKit applies:
  `keepExistingUntil` (default) keeps the end time of an override that is
  already running and changes only the temperature, `untilNextSwitchpoint` is
  the behaviour of 0.11.2, `permanent` holds until you pick "Auto".
  ([#149](../../issues/149))
- **`locationId`** — addresses a home by its stable ID instead of by index.
  Only needed with more than one home; every location is printed with its ID in
  the log at startup.
- **`pollIntervalSeconds`** — how often the status is read, 300 by default.
  Anything below 60 is raised to 60 to stay clear of Honeywell's rate limit.
- **`logTemperatureChanges`** — logs room temperature changes with their
  direction, off by default. ([#146](../../issues/146), suggested by
  [@PuzzledUser](https://github.com/PuzzledUser) in [#204](../../pull/204))
- **`history`** — turns the Eve graphs off. `fakegato-history` is then never
  imported, which also avoids the `googleapis` load that broke startup on
  Hoobs. ([#166](../../issues/166))

#### Removed

Both are ignored with a note in the log — the plugin starts normally with them
still in your `config.json`, and you can delete them at your leisure.

- **`childBridge`** — it only ever suppressed an error path. A dynamic platform
  keeps its accessories through a failure, so it is not needed any more. A
  child bridge set up in the Homebridge UI is unaffected and still recommended
  when you run two Evohome blocks.
- **`temperatureUnit`** — HomeKit takes the display unit from the iOS device;
  the option never changed anything.

#### Behaviour changed

- **`temperatureAboveAsOff` works now.** The option was never passed to the
  accessory in 0.11.2 and had no effect at all. If you have it switched on,
  expect to see zones show as "off" that used to show as heating.
- **A temperature set in HomeKit keeps the end time of a running override**
  instead of always running to the next switchpoint. Set
  `"setpointMode": "untilNextSwitchpoint"` for the old behaviour.
  ([#149](../../issues/149))
- **Hot water no longer records a history graph.** 0.11.2 logged a hard-coded
  target of 60 °C that had nothing to do with the actual system.
- **The Eve characteristics `Program Command` and `Program Data` are gone.**
  Neither was implemented; `Program Data` returned a fixed hex blob unrelated to
  any real schedule.

### Fixed

- **Plugin crashed on startup under Homebridge 2** with
  `TypeError: Class constructor Characteristic cannot be invoked without 'new'`.
  The custom Eve characteristics are ES classes now and read `Formats`, `Units`
  and `Perms` from `api.hap`. ([#205](../../issues/205), groundwork by
  [@MGMsystems](https://github.com/MGMsystems) in [#207](../../pull/207))
- **Accessories lost their room, scenes and automations** seemingly at random,
  because identity was derived from an array index. ([#61](../../issues/61))
- **Rising CPU usage over time.** The guard against overlapping status requests
  was reset before the request had finished, so polls stacked up. There is one
  timer and one request per cycle now instead of four timers and three
  requests. ([#172](../../issues/172))
- **`characteristic was supplied illegal value: number 5 exceeded minimum of 10`.**
  Turning a zone off wrote a fixed 5 °C regardless of the zone's minimum. Off
  goes through the HomeKit state now, and every setpoint is clamped to the
  zone's own limits. ([#94](../../issues/94))
- **`characteristic value expected valid finite number and received "NaN"`.** A
  zone with an empty battery reports no temperature; that value went straight
  to HomeKit. ([#94](../../issues/94))
- **Hot water scenes failed with "Error Action Set Failed"** after about 15
  seconds. The success path never answered HomeKit. ([#180](../../issues/180))
- **`Failed to load Hot Water: TypeError: Cannot read properties of undefined`**
  in a loop. The hot water poller called a callback that did not exist, and API
  error bodies were parsed as if they were valid responses.
  ([#205](../../issues/205))
- **The plugin stayed dead until restart when a token refresh failed.** Sessions
  are refreshed on demand now, re-authenticated when the refresh token has
  expired, and retried with a growing delay. ([#136](../../issues/136))
- **A failed startup is retried instead of being final.** Discovery ran exactly
  once. If the first request failed — a Raspberry Pi whose network is not up
  yet when Homebridge starts, a Honeywell outage of a few seconds — the plugin
  stayed dead until somebody restarted Homebridge by hand, while the log
  promised it would pick up on its own. It retries with the same growing delay
  the poller uses and gives up only on an error that will not fix itself, such
  as a wrong password. ([#214](../../issues/214))
- **A scene no longer cancels the system mode by accident.** Turning a mode
  switch off sent `SystemMode: Auto` whether or not that mode was the active
  one. HomeKit delivers a SET even when the value does not change, so a "Good
  night" scene that switches several modes off silently dropped the mode you
  were actually in. Only the active mode's switch returns the system to `Auto`.
  ([#215](../../issues/215))
- **A zone with an unknown model keeps its accessory.** A valve model the
  parser does not recognise is degraded rather than treated as an error, so a
  new model at Resideo cannot take the plugin down — but skipping the zone
  deleted its accessory on the next start, with its room, scenes and
  automations. It is kept and marked as faulty now.
  ([#216](../../issues/216))
- **The UTC offset follows the daylight-saving change.** It was read once at
  startup and the status carries no time zone at all, so from the March or
  October switch onwards every switchpoint and every override end time was 60
  minutes out until somebody restarted Homebridge. It is re-read once a day
  now. ([#217](../../issues/217))
- **A battery no longer reads as empty.** Publishing `StatusLowBattery` on its
  own left clients to invent the rest, and every zone showed "0 %, Charged"
  while its batteries were fine. `BatteryLevel` carries the two values the API
  actually supports — 100 % while nothing is reported, 10 % once Evohome
  reports a low battery — and the charging state says "not chargeable".
  ([#205](../../issues/205))
- **Eve is told when a valve opens or closes.** The valve position was only
  computed when something read it explicitly, so a subscriber never saw the
  change. ([#218](../../issues/218))
- **A 401 no longer throws away a session another request just obtained**, and
  a `Retry-After` from Honeywell is honoured instead of parsed and ignored —
  both of which used to add requests exactly when the account was closest to
  the rate limit. ([#218](../../issues/218))
- **Schedules were misread across midnight and depended on the order of days in
  the response.** The next switchpoint is computed in seconds since midnight
  using the location's UTC offset now, with tests across day and week
  boundaries.
- **A zone's model was overwritten on every read**, because an assignment was
  used where a comparison was meant.
- **Username and password were kept in a module-level map** that was never read
  and never cleared.
- **Two platform blocks on one bridge no longer delete each other's
  accessories.** Homebridge hands the cached accessories to only one platform
  instance of a given name, so with two `Evohome` blocks the instance that got
  the cache retired the other one's accessories on every start. Accessories
  record which location they belong to now and are left alone by a block that
  does not own them; the log says that each block needs its own child bridge.
- **A fault that was already present when Homebridge started was never logged.**
  The check compared against the previous status, which does not exist on the
  first update, so a flat battery at start stayed silent forever. Faults are
  logged when they appear and when they clear.

### Added

- **Faults and battery status reach HomeKit.** A zone or the hot water
  reporting `TempZoneActuatorLowBattery` shows a low battery on that accessory,
  and any other fault — a lost radio link, a defective sensor — shows as a
  fault (`StatusFault`). Until now `activeFaults` was read from the API and
  then only written to the log, where nobody looks. A low battery is
  deliberately _not_ treated as a fault: the valve still measures and still
  heats.
- **Every location is named at startup**, with its ID. An account with several
  homes saw only the one that was picked, and the ID needed for `locationId`
  appeared nowhere at all. ([#205](../../issues/205))
- **Gateways and controllers the plugin does not read are named in the log.**
  It uses `gateways[0].temperatureControlSystems[0]`, exactly as 0.11.2 did,
  and said nothing about the rest — a zone or a hot water tank on a second
  controller simply did not exist. A location reporting more than one of either
  warns now, so the cause is one line in the log rather than a support thread.
  Reading them is still not implemented. ([#205](../../issues/205))
- Zones that disappear from Honeywell are removed from HomeKit; new zones are
  added automatically.
- Switches are only created for the system modes your system actually supports.

### Changed

- `request`, `q`, `lodash` and `moment` are gone — all four were deprecated or
  used for a handful of one-liners. The plugin uses the built-in `fetch`.
- Sessions are cached in the Homebridge storage directory, so a restart does
  not trigger a new login.
- Schedules are cached for an hour instead of being fetched on every change.
- API responses are validated at the boundary. A malformed response produces
  `Unexpected API response at "<path>"` now, instead of a `TypeError` somewhere
  else entirely.
- Repeated failures are logged once rather than on every attempt.
  ([#153](../../issues/153))
- `fakegato-history` moved to `optionalDependencies`;
  `npm install --omit=optional` installs without it.

### Known limitations

- Thermostats appear under "Humidity" in the Home app. That follows from the
  HomeKit thermostat service and cannot be changed by a plugin.
  ([#130](../../issues/130))
- Only the first controller of the first gateway of a location is read, as in
  0.11.2. A second home needs a second platform block with its own
  `locationId`, in its own child bridge.
- Around a daylight-saving change a switchpoint can be off by an hour for up to
  a day, because the API only reports Windows time zone identifiers.

## 0.11.2 and earlier

See the [releases page](../../releases).
