# Bestandsaufnahme: homebridge-evohome 0.11.2

Stand: 2026-09-03, Basis-Commit `7a583c8` (master).
Dieses Dokument beschreibt den **Ist-Zustand** vor der Homebridge-2.0-Migration.
Der Plan für den Umbau liegt in [MIGRATION-HB2.md](MIGRATION-HB2.md).

> Seit Phase 0 liegt der hier beschriebene Code unter `legacy/index.cjs` und
> `legacy/evohome.cjs`. Alle Pfad- und Zeilenangaben in diesem Dokument beziehen
> sich weiterhin auf die ursprünglichen Namen `index.js` und `lib/evohome.js`.

---

## 1. Überblick

|               |                                                                |
| :------------ | :------------------------------------------------------------- |
| Paket         | `homebridge-evohome` 0.11.2                                    |
| Sprache       | JavaScript (CommonJS, ES5-Stil: `var`, `function`, Prototypen) |
| Plugin-Typ    | **Static Platform Plugin** (Plugin-API 1.0)                    |
| Plugin-Alias  | `Evohome`, `pluginType: platform`, `singular: false`           |
| Umfang        | 1.813 Zeilen (`index.js` 1.382, `lib/evohome.js` 431)          |
| Build-Schritt | keiner — die Quellen werden direkt publiziert                  |
| Tests         | keine                                                          |
| `engines`     | `node >=0.12.0`, `homebridge >=0.3.1`                          |

Backend ist die **Resideo/Honeywell TCC EMEA API** (`https://tccna.resideo.com/WebAPI/emea/api/v1`).
Das ist die inoffizielle App-API, nicht die dokumentierte Developer-API — Auth läuft über
ein fest im Code hinterlegtes OAuth-Client-Credential-Paar plus Username/Passwort des Nutzers.

## 2. Dateien

```
index.js              Platform + 3 Accessory-Klassen + Custom Characteristics
lib/evohome.js        HTTP-Client für die TCC-EMEA-API (Session, Modelle, Endpunkte)
config.schema.json    Config-UI-X-Formular
.eslintrc             verweist auf @typescript-eslint — Plugin ist nicht installiert, Config ist tot
.github/workflows/    codeql.yml, npm-publish.yml (Node 12, ruft nicht existentes `npm test`)
.github/dependabot.yml
assets/, README.md
```

## 3. Laufzeit-Ablauf

```
homebridge lädt index.js
  └─ module.exports(homebridge)
       ├─ definiert 3 Custom Characteristics (Eve: ValvePosition, ProgramCommand, ProgramData)
       └─ registerPlatform("homebridge-evohome", "Evohome", EvohomePlatform)

EvohomePlatform.accessories(callback)          ← einmalig beim Start
  └─ evohome.login(user, pass)                 POST /Auth/OAuth/Token
       └─ getUserInfo()                        GET  /userAccount
            └─ session.getLocations()          GET  /location/installationInfo
                 └─ session.getThermostats()   GET  /location/{id}/status
                      └─ session.getSystemModeStatus()   (identischer Call, zweites Mal)
                           ├─ pro Zone → EvohomeThermostatAccessory
                           ├─ 0–5 × EvohomeSwitchAccessory (Away/DayOff/HeatingOff/Eco/Custom)
                           ├─ falls dhw vorhanden → EvohomeDhwAccessory
                           ├─ callback(myAccessories)
                           ├─ setInterval(renewSession, expires_in-30 s)
                           └─ setInterval(periodicUpdate, 300 s)
```

Zusätzlich startet **jedes** Thermostat-Accessory im Konstruktor einen eigenen
`setInterval(periodicCheckSetTemperature, 5 s)`, das DHW-Accessory einen
`setInterval(periodicCheckStatus, 60 s)`.

## 4. API-Client (`lib/evohome.js`)

Promise-Bibliothek: **Q** (deprecated). HTTP: **request** (deprecated, unmaintained).
Jeder Call baut manuell ein `Q.defer()` um einen `request(...)`-Callback.

| Methode                                  | HTTP | Endpunkt                                                                  |
| :--------------------------------------- | :--- | :------------------------------------------------------------------------ |
| `login(user, pass)`                      | POST | `/Auth/OAuth/Token` (`grant_type=password`)                               |
| `getUserInfo()`                          | GET  | `/userAccount`                                                            |
| `Session._renew()`                       | POST | `/Auth/OAuth/Token` (`grant_type=refresh_token`)                          |
| `getLocations()`                         | GET  | `/location/installationInfo?includeTemperatureControlSystems=True`        |
| `getThermostats(locationId)`             | GET  | `/location/{id}/status?includeTemperatureControlSystems=True`             |
| `getSystemModeStatus(locationId)`        | GET  | _derselbe Endpunkt wie oben_                                              |
| `getHotWater(dhwId)`                     | GET  | `/domesticHotWater/{id}/status`                                           |
| `getSchedule(zoneId, isHotWater)`        | GET  | `/{temperatureZone\|domesticHotWater}/{id}/schedule`                      |
| `setHeatSetpoint(zoneId, temp, endtime)` | PUT  | `/temperatureZone/{id}/heatSetpoint`                                      |
| `setSystemMode(id, mode, isHotWater)`    | PUT  | `/temperatureControlSystem/{id}/mode` bzw. `/domesticHotWater/{id}/state` |

Datenmodelle als Konstruktorfunktionen: `Session`, `UserInfo`, `Location`, `Timezone`,
`Device`, `Thermostat`, `DHW`, `TemperatureStatus`, `SetpointStatus`, `DHWStatus`,
`Schedule`, `Switchpoint`, `SystemModeStatus`. Keine Response-Validierung — fehlende
Felder schlagen erst beim Zugriff als `TypeError` durch.

`setHeatSetpoint` kennt drei Modi:

- `endtime` gesetzt → `TemporaryOverride` bis Zeitpunkt
- `targetTemperature === 0` → `FollowSchedule` (Override aufheben)
- sonst → `PermanentOverride`

## 5. Accessories und HomeKit-Mapping

### EvohomeThermostatAccessory (pro Heizzone)

`uuid_base = systemId + ":" + deviceIndex` — **der Index im Array**, nicht die Zone-ID.

| Service              | Characteristic                       | Quelle / Logik                                                           |
| :------------------- | :----------------------------------- | :----------------------------------------------------------------------- |
| AccessoryInformation | Manufacturer/Model/Name/SerialNumber | `Honeywell`, `device.modelType`, `systemId-index`                        |
| Thermostat           | CurrentTemperature                   | `thermostat.temperatureStatus.temperature`, Props 1–50 °C                |
| Thermostat           | TargetTemperature                    | `setpointStatus.targetHeatTemperature`, Props aus `min/maxHeatSetpoint`  |
| Thermostat           | CurrentHeatingCoolingState           | `current < target ? HEAT : OFF`                                          |
| Thermostat           | TargetHeatingCoolingState            | `target <= 5 ? OFF : HEAT`; SET: OFF→5 °C permanent, AUTO→FollowSchedule |
| Thermostat           | TemperatureDisplayUnits              | nur aus Config, keine Persistenz                                         |
| Thermostat           | Eve ValvePosition (`E863F12E…`)      | `current < target ? 100 : 0` — synthetisch, keine echten Ventildaten     |
| Thermostat           | Eve ProgramCommand / ProgramData     | nicht implementiert, ProgramData liefert einen Hex-Konstanten-Blob       |
| FakeGatoHistory      | `thermo`, `storage: "fs"`            | Eintrag pro `periodicUpdate`                                             |

Unterstützte `modelType`: `HeatingZone`, `RoundWireless`, `RoundModulation`.
Zonen mit leerem Namen (typisch: Warmwasser) werden übersprungen.

### EvohomeSwitchAccessory (pro Systemmodus)

Switch mit `On` → `setSystemMode(systemId, mode|"Auto", false)`.
`uuid_base = systemId + ":" + systemMode`. 3 s nach dem Schalten wird
`platform.periodicUpdate()` erzwungen.

### EvohomeDhwAccessory (Warmwasser, falls `dhw` vorhanden)

TemperatureSensor (`setPrimaryService(true)`) + Switch + FakeGato.
Zieltemperatur ist im FakeGato-Log auf `60` hartkodiert (`// TODO, random value`).

## 6. Timer und Datenfluss

| Timer                         | Intervall              | Wirkung                                                                |
| :---------------------------- | :--------------------- | :--------------------------------------------------------------------- |
| `renewSession`                | `expires_in - 30 s`    | Token-Refresh                                                          |
| `periodicUpdate`              | 300 s                  | 3 API-Calls, aktualisiert **alle** Accessories + FakeGato              |
| `periodicCheckSetTemperature` | 5 s **× Anzahl Zonen** | prüft `targetTemperateToSet != -1`, dann Schedule-Call + Setpoint-Call |
| `periodicCheckStatus` (DHW)   | 60 s                   | 1 API-Call                                                             |

Schreibpfad einer Temperaturänderung: HomeKit `set` → nur `targetTemperateToSet = value`,
Callback sofort. Der 5-s-Timer holt danach den Schedule der Zone, berechnet mit
`getNextScheduledTime()` den nächsten Schaltpunkt und setzt einen `TemporaryOverride`
bis dahin. Das Zusammenfassen schneller Nachbar-Änderungen ist gewollt (Debounce),
die erzwungene Override-Dauer ist die Ursache von Issue #149.

## 7. Konfiguration

| Key                                                                               | Typ    | Default   | Bemerkung                                             |
| :-------------------------------------------------------------------------------- | :----- | :-------- | :---------------------------------------------------- |
| `name`                                                                            | string | `Evohome` |                                                       |
| `username` / `password`                                                           | string | –         | Klartext in `config.json`                             |
| `temperatureUnit`                                                                 | enum   | `Celsius` | rein kosmetisch                                       |
| `locationIndex`                                                                   | int    | `0`       | eine Location pro Platform-Block                      |
| `switchAway` / `switchDayOff` / `switchEco` / `switchHeatingOff` / `switchCustom` | bool   | `true`    | Vergleich ist `!= false`                              |
| `childBridge`                                                                     | bool   | `false`   | unterdrückt nur `callback([])` im Fehlerfall          |
| `temperatureAboveAsOff`                                                           | bool   | `false`   | wird nie an das Accessory durchgereicht → wirkungslos |

## 8. Abhängigkeiten

| Paket              | Version     | Status                                                                                                                        |
| :----------------- | :---------- | :---------------------------------------------------------------------------------------------------------------------------- |
| `request`          | `>=2.68.0`  | **deprecated**, seit 2020 unmaintained                                                                                        |
| `q`                | `~1.5.1`    | **deprecated**                                                                                                                |
| `lodash`           | `>=4.17.13` | nur für 5 × `_.map`                                                                                                           |
| `moment`           | `^2.18.1`   | nur für 3 × `moment().unix()`                                                                                                 |
| `fakegato-history` | `>=0.6.1`   | aktiv gepflegt, HB2-kompatibel (ES-Klassen, `homebridge.hap.Formats`) — zieht aber `googleapis` (~100 MB) und `debug@^2` nach |
| `prettier`         | 3.6.2 (dev) | einziges Dev-Tool                                                                                                             |

Es gibt keine `package-lock.json` (in `4445b3f` entfernt) und keine `npm scripts`.

## 9. CI/CD

- `codeql.yml` — CodeQL-Scan auf push/PR/wöchentlich.
- `npm-publish.yml` — bei Release: `actions/setup-node` mit **`node-version: 12`**,
  `npm install`, `npm test` (kein `test`-Script vorhanden → Schritt schlägt fehl),
  danach `JS-DevTools/npm-publish@v3`.
- Dependabot täglich für npm und GitHub Actions.

## 10. Offene PRs im Repo

| PR                           | Inhalt                                                                                              | Relevanz für die Migration      |
| :--------------------------- | :-------------------------------------------------------------------------------------------------- | :------------------------------ |
| #207                         | HB2-Fix: Custom Characteristics als ES-Klassen, `hap.Formats/Units/Perms`, `Buffer.from`, NaN-Guard | hoch — löst #205                |
| #204                         | Fehler abfangen bei Honeywell-Ausfällen, Temperatur-Logging                                         | hoch — löst #153/#146 teilweise |
| #203, #198, #197, #196, #195 | Dependabot                                                                                          | niedrig                         |
