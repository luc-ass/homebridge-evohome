# Testing

Three levels, from fast to realistic.

## 1. Static checks and unit tests

```sh
npm run check      # lint + typecheck + tests
npm run test:watch # tests in watch mode
npm run build      # output to dist/
```

`npm run check` is exactly what CI runs on Node 22, 24 and 26, and what runs
before every `npm publish` (`prepublishOnly`).

The lint configuration deliberately enforces a few rules that guard against
specific bugs found in 0.11.2 — see the comments in `eslint.config.js` and the
checklist in
[MIGRATION-HB2.md](MIGRATION-HB2.md#51-checklist-nothing-is-lost-in-the-rewrite):

| Rule                                   | Guards against                      |
| :------------------------------------- | :---------------------------------- |
| `no-cond-assign: always`               | `if ((this.model = "HeatingZone"))` |
| `max-depth`, `max-nested-callbacks`    | callback pyramids ten levels deep   |
| `no-restricted-syntax` on `getValue`   | removed in HAP 2.x                  |
| `no-restricted-syntax` on `new Buffer` | deprecated since Node 6             |
| `no-floating-promises`                 | swallowed errors                    |

## 2. A local Homebridge 2 instance

Homebridge 2.4.0 is a devDependency of this repo — you need neither a global
installation nor Docker.

```sh
mkdir -p test-instance/data
cp test-instance/config.example.json test-instance/data/config.json
$EDITOR test-instance/data/config.json      # enter your credentials
npm run dev                                 # builds and starts Homebridge
```

`npm run dev` is equivalent to:

```sh
npm run build && homebridge -U ./test-instance/data -P . --strict-plugin-resolution -I
```

| Flag                         | Meaning                                                                                                                                                        |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-U ./test-instance/data`    | Storage path: config, pairing data and the accessory cache end up there (gitignored, contains credentials)                                                     |
| `-P .`                       | Loads the plugin from the repository root; Homebridge recognises from `package.json` that the path is itself a plugin                                          |
| `--strict-plugin-resolution` | Loads **only** from `-P`, not additionally from the global `node_modules` — otherwise locally installed third-party plugins and their errors end up in the log |
| `-I`                         | Insecure mode, required for access through the Homebridge UI                                                                                                   |

`npm run dev:debug` adds `-D` for the `log.debug` output.

### Testing with the Homebridge UI

`--strict-plugin-resolution` loads **only** the plugin from `-P`, which means no
Homebridge UI either. To check the form generated from `config.schema.json` in a
browser, use `npm run dev:ui`, which omits the flag.

```sh
npm install -g homebridge-config-ui-x
npm run dev:ui        # http://localhost:8581
```

In exchange, Homebridge loads every globally installed plugin again. If older
plugins are installed there that do not support the current Node version, their
stack traces fill the log — none of which has anything to do with this plugin.
For everyday development `npm run dev` is therefore the quieter choice.

**What you should see** once real credentials are in place:

```
[Evohome] Initializing Evohome platform...
[Evohome] Location "Home" with 6 zone(s).
[Evohome] New accessory: Living Room Thermostat
[Evohome] New accessory: Bathroom Thermostat
[Evohome] New accessory: Evohome Hot Water
[Evohome] New accessory: Evohome Away Mode
...
```

That proves the ESM build loads under Homebridge 2.x — precisely where 0.11.2
failed with
`TypeError: Class constructor Characteristic cannot be invoked without 'new'`
(issue #205).

Worth checking afterwards:

| Check                                | Expectation                                                                                                                |
| :----------------------------------- | :------------------------------------------------------------------------------------------------------------------------- |
| Restart Homebridge                   | Accessories come from the cache, `New accessory` does **not** appear again, room assignment in the Home app survives (#61) |
| Change a temperature in the Home app | A log line `… target temperature 21 °C, until HH:MM UTC (…)` — the reason shows which `setpointMode` rule applied (#149)   |
| Set a thermostat to off              | The target goes to the zone minimum, **not** to a fixed 5 °C, and no `illegal value` warning appears (#94)                 |
| Switch hot water                     | Answers immediately rather than after ~15s (#180)                                                                          |
| Leave it running for a few hours     | Constant CPU load, one status request per interval (#172)                                                                  |

If a zone was added or removed at Honeywell in the meantime, the log reports
`New accessory:` or `Removed accessory:` — every other accessory keeps its
identity.

### Symptom: "No plugin was found for the platform"

Homebridge cannot find the plugin. Usual causes:

- `npm run build` was not run. Without `dist/index.js` the directory is not a
  loadable plugin as far as Homebridge is concerned.
- Homebridge was started without `-P` and only searches the global
  `node_modules`.
- An **older global installation** of `homebridge-evohome` shadows the local
  directory. Without `--strict-plugin-resolution` the log says so explicitly
  (`skipping plugin found at ... since we already loaded the same plugin
from ...`); with the flag it cannot happen.

### Testing on a production-like system

The same applies on a Raspberry Pi or in a container: check out the repository,
run `npm ci && npm run build`, then start Homebridge with `-P /path/to/repo`. On
the official Docker image the way in is the startup script in the Homebridge UI
settings — there is **no** environment variable for this.

## 3. Fixtures from a real account

API responses are stored as fixtures in `test/fixtures/` so that device types no
developer happens to own can be covered (DHW, `RoundWireless`,
`RoundModulation`, underfloor heating zones).

**Anonymise before committing:** replace `locationId`, `systemId`, `zoneId`,
`userId`, addresses and names. IDs must stay consistent within a fixture,
otherwise the mapping tests have nothing to match.
