# Migrationsplan: homebridge-evohome → Homebridge 2.x

Stand: 2026-09-03 · Branch `homebridge-v2` · Ausgangsbasis `7a583c8`
Ist-Zustand: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. Zielumgebung (verifiziert, nicht aus dem Gedächtnis)

|                        | Wert                                | Quelle                          |
| :--------------------- | :---------------------------------- | :------------------------------ |
| Homebridge             | 2.4.0 (latest)                      | `npm view homebridge`           |
| Node                   | `^22 \|\| ^24 \|\| ^26`             | `homebridge@2.4.0` engines      |
| HAP                    | `@homebridge/hap-nodejs` 2.2.x      | homebridge dependencies         |
| Modulsystem homebridge | **ESM** (`"type": "module"`)        | `homebridge@2.4.0` package.json |
| Plugin-Laden           | `await import(pathToFileURL(main))` | `homebridge/dist/plugin.js:164` |

**Wichtig:** Homebridge selbst ist ESM, lädt Plugins aber per dynamischem `import()`.
CommonJS-Plugins funktionieren dadurch weiterhin, solange sie nicht `require("homebridge")`
aufrufen — was dieses Plugin nie tut. Ein Rewrite ist also _nicht_ durch das Modulsystem
erzwungen; er ist aus anderen Gründen sinnvoll (Abschnitt 3).

Die Static-Platform-API (`accessories(callback)` + `getServices()`) existiert in 2.4.0
weiterhin (`HomebridgeAPI.isStaticPlatformPlugin`, `bridgeService.js:499`). Sie ist aber
die Ursache mehrerer Dauerprobleme und sollte trotzdem aufgegeben werden.

## 2. Was unter Homebridge 2 konkret bricht

Verifiziert gegen `@homebridge/hap-nodejs@2.2.3`:

| #   | Bruch                                                                                               | Fundstelle im Plugin                                         | Wirkung                                                                                                             |
| :-- | :-------------------------------------------------------------------------------------------------- | :----------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| B1  | `Characteristic` ist eine ES-Klasse; `Characteristic.call(this, …)` + `util.inherits` ist unmöglich | `index.js:29–69`                                             | **Absturz beim Start** — `TypeError: Class constructor Characteristic cannot be invoked without 'new'` (Issue #205) |
| B2  | `Characteristic.Formats/Units/Perms` als Statics entfernt, nur noch `api.hap.Formats/Units/Perms`   | `index.js:36–38, 51, 63`                                     | `undefined`-Zugriff                                                                                                 |
| B3  | `Characteristic.getValue()` entfernt                                                                | `index.js:498, 504`                                          | `TypeError` in jedem `periodicUpdate`                                                                               |
| B4  | Node-Floor 22                                                                                       | `engines.node: ">=0.12.0"`                                   | Warnung, falsche Signalisierung                                                                                     |
| B5  | `engines.homebridge` muss `^2` einschließen, sonst kein „HB2-ready"-Badge in Config UI X            | `engines.homebridge: ">=0.3.1"`                              | Sichtbarkeit/Vertrauen                                                                                              |
| B6  | Strengere Wertevalidierung                                                                          | 5 °C bei `minHeatSetpoint: 10`, `NaN` bei leerer Batterie    | Issue #94, Warn-Spam                                                                                                |
| B7  | `new Buffer(...)`                                                                                   | `index.js:1038`                                              | Deprecation, in Node 22 laut                                                                                        |
| B8  | `Accessory.setPrimaryService()` entfernt                                                            | Plugin nutzt `Service.setPrimaryService()` (`index.js:1277`) | **kein Problem**, korrekte Variante                                                                                 |
| B9  | `BatteryService` entfernt                                                                           | nicht genutzt                                                | kein Problem                                                                                                        |

## 3. Schwachstellen des Ist-Standes

Unabhängig von HB2 — diese Punkte bestimmen, ob sich ein Rewrite lohnt.

### 3.1 Architektur

- **S1 — Static Platform ⇒ keine persistenten Accessories.**
  Accessories werden bei jedem Start neu erzeugt. Ändert sich die `uuid_base`, legt
  HomeKit neue Geräte an: Räume, Namen, Szenen und Automationen sind weg. Genau das
  steht als „Known Issue" im README (#61) und ist der Grund für den `childBridge`-Schalter.
  `uuid_base` ist zudem `systemId + ":" + Array-Index` — schon ein Umsortieren oder
  Hinzufügen einer Zone bei Honeywell verschiebt alle IDs.
  → Lösung: `DynamicPlatformPlugin` mit `configureAccessory()` + stabiler UUID aus `zoneId`.

- **S2 — `childBridge`-Config ist ein Workaround für fehlende Fehlerbehandlung.**
  Der Schalter unterdrückt lediglich `callback([])` im Fehlerfall. Mit einer dynamischen
  Platform entfällt er ersatzlos.

- **S3 — Callback-Pyramide.** `accessories()` und `periodicUpdate()` sind bis zu zehn
  Ebenen tief verschachtelt (`index.js:106–360`, `385–677`), mit `.bind(this)`,
  `that`-Aliasen und teils widersprüchlichem `this`. Praktisch nicht erweiterbar.

### 3.2 Konkrete Bugs (im Code verifiziert)

| ID      | Fundstelle                     | Defekt                                                                                                                                                                                                                                                                                                                        |
| :------ | :----------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S4**  | `index.js:982`                 | `if ((this.model = "HeatingZone"))` — **Zuweisung statt Vergleich**. Setzt bei jedem `getTargetTemperature` das Modell jedes Accessories auf `"HeatingZone"`, überschreibt also auch `RoundWireless`/`RoundModulation`/`domesticHotWater`. Die `else`-Zweige an `:840`, `:947`, `:1016` werden dadurch faktisch nie erreicht. |
| **S5**  | `index.js:390 vs. 677`         | `this.updating = true` steht im Kopf von `periodicUpdate`, `this.updating = false` **synchron am Ende der Funktion** — also lange bevor die Promise-Kette fertig ist. Das Reentrancy-Guard wirkt nicht; Updates können sich überlappen und stapeln. Heißer Kandidat für Issue #172 (CPU-Anstieg).                             |
| **S6**  | `index.js:90 vs. 956`          | `temperatureAboveAsOff` wird auf der Platform gesetzt, aber nie an das Accessory übergeben. `that.temperatureAboveAsOff` ist immer `undefined` — **das Feature ist wirkungslos**, obwohl es in Config-Schema und README dokumentiert ist.                                                                                     |
| **S7**  | `index.js:1164, 1168–1187`     | `EvohomeDhwAccessory.periodicCheckStatus` wird per `setInterval` ohne Argument aufgerufen, ruft im Fehlerfall aber `callback(err)` → `TypeError: callback is not a function`. Erklärt das „Failed to load Hot Water"-Dauerfeuer im Log (Kommentar zu #205).                                                                   |
| **S8**  | `lib/evohome.js:138`           | `getHotWater` baut `new DHW(json)` ohne Prüfung. Liefert die API einen Fehlerkörper, ist `json.temperatureStatus` `undefined` → `Cannot read properties of undefined (reading 'temperature')`.                                                                                                                                |
| **S9**  | `index.js:730–800`             | `getNextScheduledTime()`: `proceed` wird zwischen den Wochentagen nicht zurückgesetzt, verglichen wird per lokalisiertem `toLocaleTimeString()`-String, und über Mitternacht fällt alles auf `"00:00:00"` zurück. Daher die README-Warnung zur Zeitzone.                                                                      |
| **S10** | `lib/evohome.js:21–33`         | `sessionCredentials` speichert Benutzername + **Passwort im Klartext** in einer Modul-globalen Map, keyed auf das Bearer-Token. Die Map wird **nirgends gelesen** und nie geleert. Ersatzlos löschen.                                                                                                                         |
| **S11** | `index.js:322, 326, 724, 1164` | `setInterval`-Handles werden nie gespeichert oder mit `clearInterval` abgeräumt. Bei N Zonen laufen N Timer à 5 s dauerhaft.                                                                                                                                                                                                  |
| **S12** | `lib/evohome.js:288–320`       | Der Token-Refresh läuft per `setInterval` mit dem _initialen_ `expires_in`. Schlägt ein Refresh fehl, gibt es keinen Retry und keinen Re-Login — das Plugin ist bis zum Neustart tot (Issue #136).                                                                                                                            |
| **S13** | `index.js:130–135`             | `getThermostats()` und `getSystemModeStatus()` rufen **denselben** Endpunkt auf. Jeder Poll macht drei Requests, wo einer reicht.                                                                                                                                                                                             |

### 3.3 Abhängigkeiten und Sicherheit

- **S14** — `request` ist seit 2020 deprecated und unmaintained, `q` ebenfalls deprecated.
  Node 22 hat globales `fetch`; beide können ersatzlos entfallen. `lodash` (5 × `_.map`)
  und `moment` (3 × `.unix()`) ebenso.
- **S15** — `fakegato-history` zieht `googleapis` (~100 MB) und `debug@^2` nach. Der
  `googleapis`-Import ist genau die Fehlerquelle in Issue #166 (Hoobs). Der
  Google-Drive-Pfad wird von diesem Plugin nie benutzt (`storage: "fs"`).
- **S16** — Keine `package-lock.json`, alle Runtime-Deps als offene Ranges (`>=`).
  Ein kaputtes Transitiv-Update trifft alle Nutzer sofort.

### 3.4 Qualitätssicherung

- **S17** — `.eslintrc` konfiguriert `@typescript-eslint` und `eslint-plugin-jest`; beide
  sind nicht installiert, es gibt keine `.ts`-Dateien und kein `lint`-Script. Die Config
  läuft nie.
- **S18** — `npm-publish.yml` nutzt **Node 12** und ruft `npm test`, obwohl kein
  `test`-Script existiert. Der Release-Workflow ist in diesem Zustand nicht belastbar.
- **S19** — Null Tests. Es gibt keine Möglichkeit, eine Verhaltensänderung ohne echtes
  Evohome-System zu prüfen — der Hauptgrund, warum sich Beiträge hier so zäh anfühlen.

## 4. Zielarchitektur

TypeScript, ESM, `DynamicPlatformPlugin`, Node ≥ 22, keine Runtime-Deps außer optional
FakeGato.

```
src/
  index.ts                  registerPlatform, Default-Export
  settings.ts               PLATFORM_NAME, PLUGIN_NAME, Defaults
  platform.ts               EvohomePlatform: configureAccessory, discovery, ein Poller
  config.ts                 Config-Typ + Validierung + Migration alter Keys
  api/
    client.ts               EvohomeClient: fetch, Retry, Backoff, Rate-Limit-Handling
    auth.ts                 TokenStore: Login, Refresh, Re-Login, Persistenz
    types.ts                Response-Typen der TCC-EMEA-API
    errors.ts               EvohomeAuthError | EvohomeApiError | EvohomeNetworkError
  accessories/
    thermostat.ts           ThermostatHandler
    dhw.ts                  DomesticHotWaterHandler
    systemMode.ts           SystemModeSwitchHandler
  characteristics/eve.ts    ValvePosition, ProgramCommand, ProgramData als ES-Klassen
  util/schedule.ts          nextSwitchpoint() — testbar, ohne HomeKit-Abhängigkeit
test/                       Vitest + aufgezeichnete API-Fixtures
```

**Leitentscheidungen**

1. **Eine Datenquelle.** Ein `PollingCoordinator` holt pro Zyklus genau einmal
   `/location/{id}/status` und verteilt das Ergebnis an alle Handler (behebt S13).
   Ein einziger Timer statt N+2 (behebt S11), mit echtem `async`-Guard (behebt S5).
2. **Stabile Identität.** `api.hap.uuid.generate("evohome:" + zoneId)` statt Array-Index.
   Einmalige, dokumentierte Migration für Bestandsnutzer (Abschnitt 7).
3. **`onGet`/`onSet` statt `.on("get"/"set")`.** Async-Handler, die einen Wert
   zurückgeben bzw. bei Fehlern `HapStatusError` werfen, statt Fehler zu verschlucken.
   Werte kommen aus dem Cache des Pollers — kein API-Call im HomeKit-Pfad.
4. **Kein Callback-Fehlerverlust.** Jeder API-Fehler wird typisiert, geloggt und führt
   zu einem definierten Zustand (`StatusFault` / letzter bekannter Wert), nicht zum Abbruch.
5. **Login mit Backoff.** Exponentiell mit Cap, damit der Rate-Limiter nicht getroffen
   wird (Issue #136 fordert das explizit).
6. **Eine Platform-Instanz = eine Location** (Entscheidung F5). `singular: false` und
   `locationIndex` bleiben erhalten; mehrere Systeme pro Account sind in der Regel
   verschiedene Haushalte und gehören in getrennte Config-Blöcke — ggf. in getrennte
   Child Bridges. `locationIndex` wird zusätzlich per `locationId` adressierbar, damit
   das Umsortieren bei Honeywell nicht die Zuordnung verschiebt.
7. **`Service.Thermostat` bleibt** (Entscheidung F4). Die Feuchtigkeits-Kachel aus #130
   ist Home-App-Verhalten und wird als Einschränkung dokumentiert, nicht umgangen.
8. **Eve-History ist optional** (Entscheidung F3). `fakegato-history` wandert in
   `optionalDependencies`, die Option `history` (Default `true`) schaltet sie ab. Fehlt
   das Modul, läuft das Plugin ohne History weiter statt zu crashen.

## 5. Phasenplan

Mit Entscheidung **F1 (direkt auf 1.0.0)** entfällt der Zwischen-Release 0.12.0. Der
bestehende Code wird nicht mehr angefasst — jede in Abschnitt 2 und 3 gefundene Schwäche
muss stattdessen im neuen Code nachweislich adressiert sein. Abschnitt 5.1 hält das als
Prüfliste fest, damit beim Wegwerfen des alten Codes nichts verloren geht.

**Konsequenz, die bewusst in Kauf genommen wird:** `master` bleibt für Homebridge-2-Nutzer
kaputt, bis 1.0.0 fertig ist (#205 seit Mai 2026 offen). Gegenmaßnahme: früh und oft
`npm publish --tag beta` aus diesem Branch und die Tester in #205 gezielt darauf
verweisen — dort haben mehrere Nutzer mit 12-Zonen-Systemen Hilfe angeboten.

### Phase 0 — Fundament und Toolchain (1,5 Tage)

- [x] Branch `homebridge-v2`
- [x] Bestandsaufnahme und Plan
- [x] TypeScript strict, `tsconfig.json`, Build nach `dist/`, `"type": "module"`
- [x] ESLint 9 Flat Config mit `typescript-eslint` (ersetzt die tote `.eslintrc`) — S17
- [x] Vitest + `npm scripts`: `build`, `lint`, `test`, `watch`, `check`
- [x] CI-Workflow: Matrix Node 22/24/26, `lint` + `typecheck` + `test` + `build` — S19
- [x] `npm-publish.yml`: Node 22 statt 12, `npm ci`, `npm run check`, Build vor
      Publish, Prereleases automatisch unter dem npm-Tag `beta` — S18
- [x] `package.json`: `files`, `engines` (F2), keine Laufzeitabhängigkeiten mehr — B4/B5
- [x] `package-lock.json` committen — S16
- [x] Altcode nach `legacy/*.cjs` verschoben (nötig wegen `"type": "module"`),
      von Build, Lint und `files` ausgeschlossen
- [x] Platform-Gerüst: `EvohomePlatform implements DynamicPlatformPlugin` mit
      `configureAccessory()` — lädt unter Homebridge 2.x, legt noch keine Accessories an
- [x] Testinstanz: `npm run dev` startet Homebridge 2.4.0 aus den devDependencies mit
      `-P .` gegen das Repo — verifiziert, das Plugin lädt und registriert die Platform
- [x] Lauf mit echten Zugangsdaten gegen ein produktives Honeywell-Konto:
      Anmeldung, Erkennung und Anlage der Geräte funktionieren (2026-09-03)

### Phase 1 — API-Client (2–3 Tage)

- [x] `api/types.ts` als Domänentypen, Fixtures in `test/fixtures/`
- [x] `EvohomeClient` auf `fetch` + `AbortSignal.timeout` — `request`/`q`/`lodash`/`moment`
      restlos entfallen, das Paket hat keine Laufzeitabhängigkeiten mehr (S14)
- [x] Response-Validierung an jeder Grenze (`validate.ts`, `parse.ts`): jeder Fehler
      nennt den Pfad in der Antwort statt eines nackten `TypeError` — S8
- [x] `TokenStore`: bedarfsgesteuerter Refresh, Re-Login bei verbrauchtem
      Refresh-Token, Aufgabe nur bei dauerhaft falschen Zugangsdaten — #136, S12
- [x] Zugangsdaten in ES-Private-Feldern, keine globale Map, kein Passwort in
      `JSON.stringify(store)` — S10
- [x] `util/backoff.ts`: exponentiell mit Deckel und Jitter — #136
- [x] `util/schedule.ts`: `nextSwitchpoint()` neu, mit Tests über Tageswechsel,
      Sonntag-Montag-Grenze, Sortierreihenfolge und DST — S9
- [x] Ein Statusaufruf pro Zyklus statt dreier (S13) — im Client umgesetzt, der
      Poller folgt in Phase 2
- [x] 84 Tests, Coverage-Schwelle in `vitest.config.ts` auf 90/85 angehoben
- [x] Teilweise gegen ein echtes Konto bestätigt (2026-09-03): der Lesepfad
      `/Auth/OAuth/Token`, `/userAccount`, `/location/installationInfo` und
      `/location/{id}/status` läuft ohne `EvohomeResponseError` durch — die
      Feldnamen in `parse.ts` stimmen also für diese vier Antworten
- [x] Schreibpfad am echten System bestätigt (2026-09-03): eine Temperaturänderung
      aus HomeKit liest `/temperatureZone/{id}/schedule`, schreibt
      `PUT …/heatSetpoint` und verarbeitet die Quittung — die Regel aus
      `setpointMode` greift dabei wie vorgesehen (#149)
- [ ] **Offen:** der Warmwasserstatus (`dhw` in `/location/{id}/status` sowie
      `PUT /domesticHotWater/{id}/state`) ist noch ungeprüft — nur relevant für
      Systeme mit Warmwasserbereitung
- [ ] **Verschoben nach Phase 2:** Token-Persistenz über `api.user.storagePath()`;
      das `TokenCache`-Interface steht, die Homebridge-Anbindung braucht die Platform

### Phase 2 — Dynamische Platform und Accessories (3–4 Tage)

- [x] `EvohomePlatform implements DynamicPlatformPlugin`, `configureAccessory()`,
      `didFinishLaunching` → Discovery, `unregisterPlatformAccessories` für
      verschwundene Zonen — S1, #61
- [x] Stabile UUIDs aus `zoneId` / `dhwId` / `systemId+mode`
- [x] `PollingCoordinator`: ein Request pro Zyklus, konfigurierbares Intervall,
      echter Reentrancy-Schutz, `clearTimeout` beim Shutdown — S5, S11, S13, #172
- [x] `characteristics/eve.ts`: `ValvePosition` als ES-Klasse mit
      `api.hap.Formats/Units/Perms` — B1, B2 (Vorlage: PR #207).
      `ProgramCommand`/`ProgramData` **bewusst weggelassen**, siehe unten
- [x] `ThermostatAccessory`, `DomesticHotWaterAccessory`, `SystemModeAccessory`
      mit `onGet`/`onSet`; `updateValue` statt `getValue()` — B3
- [x] Sollwerte auf `setpointCapabilities` geklemmt, „Aus" über
      `TargetHeatingCoolingState` statt über 5 °C — B6, #94
- [x] `new Buffer` entfällt mit `ProgramData` — B7
- [x] `childBridge` entfernt, wird mit Hinweis ignoriert — S2
- [x] `config.ts`: geprüfte Konfiguration mit Warnungen statt `!= false`;
      `temperatureAboveAsOff` wirkt jetzt tatsächlich — S6 (aus Phase 3 vorgezogen)
- [x] Token-Persistenz über `api.user.storagePath()` — aus Phase 1 nachgeholt
- [x] Schreibpfad blockiert nicht mehr: `scheduleRefresh()` statt `await refresh(3000)`
- [x] Tests gegen das **echte** `@homebridge/hap-nodejs` statt gegen eine Attrappe;
      140 Tests, Coverage 92 %
- [x] Verifiziert: Plugin lädt unter Homebridge 2.4.0 und registriert die Platform

**Bewusst abgewichen:** `ProgramCommand` und `ProgramData` aus 0.11.2 wurden nicht
übernommen. Beide waren nie implementiert; `ProgramData` lieferte einen fest
einkodierten Hex-Blob, der nichts mit dem tatsächlichen Zeitprogramm zu tun hatte.
Der Eve-App ein erfundenes Programm zu melden ist schlechter, als die
Characteristics gar nicht anzubieten. Bei Bedarf gehören sie zusammen mit #54 in
Phase 4.

### Phase 3 — Verhalten und offene Issues (2–3 Tage)

- [x] `setpointMode`-Option: **`keepExistingUntil` (Default)** | `untilNextSwitchpoint`
      | `permanent` — #149, siehe Analyse unten
- [x] `logTemperatureChanges`-Option — #146 (Vorlage: PR #204)
- [x] `ScheduleCache`: Zeitprogramme werden zwischengespeichert statt bei jeder
      Temperaturänderung neu geholt
- [x] Off-Zustand über `TargetHeatingCoolingState` statt über 5 °C — #94 _(Phase 2)_
- [x] DHW-Set-Pfad antwortet in _allen_ Zweigen — #180 _(Phase 2)_
- [x] `temperatureAboveAsOff` am Handler ausgewertet — S6 _(Phase 2)_
- [x] Modell-Erkennung typisiert — S4 _(Phase 1, `parse.ts`)_
- [x] Adressierung per `locationId` zusätzlich zu `locationIndex` — F5 _(Phase 2)_

#### Analyse zu #149

Die API kennt **keinen** Modus „Wert ändern, Endzeit behalten":
`PUT /temperatureZone/{id}/heatSetpoint` verlangt zwingend einen der drei
`SetpointMode`-Werte. Die Vermutung im Issue, es gebe einen Endpunkt zum reinen
Setzen der Temperatur, trifft nicht zu.

Lösbar ist es trotzdem, weil `setpointStatus.until` die laufende Endzeit meldet
(gegen die Schema-Definition von `evohome-async` geprüft: ISO-8601-Zeitstempel,
nur bei zeitbegrenzten Modi vorhanden). Sie wird beim Schreiben einfach wieder
mitgeschickt.

Da HomeKit kein „bis wann" kennt, ist die Regel eine Konfigurationsentscheidung
und keine pro Bedienvorgang. Gewählt wurde `keepExistingUntil` als Default: es
verhält sich exakt wie 0.11.2, solange kein Override läuft, und behebt genau den
gemeldeten Fall. „Aus" schreibt unabhängig davon immer einen dauerhaften
Override — eine abgeschaltete Zone soll nicht am nächsten Schaltpunkt von selbst
wieder angehen.

### Phase 4 — Optionale Eve-History (0,5–1 Tag)

- [ ] `fakegato-history` nach `optionalDependencies`, Option `history` (Default `true`) — F3
- [ ] Dynamischer Import mit Fallback: fehlt das Modul, läuft alles ohne History weiter
- [ ] Auswirkung auf #166 (Hoobs/`googleapis`) im README dokumentieren
- [ ] Echte DHW-Zieltemperatur statt der hartkodierten `60`

### Phase 5 — Config, Doku, Release 1.0.0 (1–1,5 Tage)

- [x] `config.schema.json` v2: neue Optionen, `childBridge` und `temperatureUnit`
      raus, Migrationshinweis im Header — **aus Phase 5 vorgezogen**, damit sich
      die neuen Optionen über Config UI X testen lassen. Ein Test hält Schema und
      `src/config.ts` synchron: Voreinstellungen, Wertelisten und Layout-Verweise
      müssen übereinstimmen. `history` fehlt bewusst noch und kommt mit Phase 4
- [ ] Sanfte Config-Migration: alte Keys werden gelesen, gewarnt, übersetzt
- [ ] README neu: Anforderungen (HB 2.x, Node 22+), Migration, bekannte Einschränkungen
      inkl. #130 als dokumentiertes Home-App-Verhalten (F4)
- [ ] `CHANGELOG.md` mit expliziter Breaking-Change-Liste
- [ ] Credits für die Vorarbeit aus PR #207 (@MGMsystems) und PR #204 (@PuzzledUser);
      beide PRs mit Verweis auf die Umsetzung im Rewrite schließen
- [ ] Beta-Releases über `npm publish --tag beta`, Testaufruf in #205
- [ ] 1.0.0

**Aufwandsschätzung gesamt:** ca. 10,5–14 Personentage.

### 5.1 Prüfliste: nichts geht beim Rewrite verloren

Da der alte Code nicht mehr gepatcht wird, muss jeder Befund aus Abschnitt 2 und 3 im
neuen Code belegt sein. Zielzustand ist jeweils ein Test oder ein bewusster Verzicht.

| Befund        | Adressiert in | Nachweis                                                                |
| :------------ | :------------ | :---------------------------------------------------------------------- |
| B1, B2, B7    | Phase 2       | Plugin startet unter HB 2.4.0 ohne `TypeError`                          |
| B3            | Phase 2       | kein `getValue()` mehr im Code (Lint-Regel)                             |
| B4, B5        | Phase 0       | `engines` korrekt, HB2-Badge in Config UI X                             |
| B6            | Phase 2 + 3   | Unit-Test: Setpoint unter `minHeatSetpoint`, `NaN`-Eingabe              |
| S1, S2        | Phase 2       | Neustart-Test: Raumzuordnung bleibt erhalten                            |
| S3            | Phase 1 + 2   | `async`/`await`, max. 3 Verschachtelungsebenen (Lint)                   |
| S4            | Phase 3       | Typisierte Modell-Enum, kein `=` in Bedingungen (Lint `no-cond-assign`) |
| S5, S11, S13  | Phase 2       | ein Timer, ein Request pro Zyklus; Test auf überlappende Polls          |
| S6            | Phase 3       | Unit-Test für `temperatureAboveAsOff`                                   |
| S7, S8        | Phase 1 + 2   | Fixture mit Fehlerkörper führt zu geloggtem Fehler, nicht zum Crash     |
| S9            | Phase 1       | Tests über Tageswechsel, DST-Umstellung, Zeitzonen ≠ Systemzeit         |
| S10           | Phase 1       | keine Klartext-Credentials außerhalb des `TokenStore`                   |
| S12           | Phase 1       | Test: Refresh schlägt fehl → Backoff → Re-Login                         |
| S14, S15, S16 | Phase 0 + 4   | `npm ls` ohne deprecated Pakete, Lockfile vorhanden                     |
| S17, S18, S19 | Phase 0       | CI grün auf Node 22/24/26                                               |

## 6. Zuordnung offener Issues

Phasennummern beziehen sich auf den Plan in Abschnitt 5.

| Issue    | Titel                                                                        | Bewertung                                                                                                                                                                                                                                              | Phase              |
| :------- | :--------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------- |
| **#205** | `Class constructor Characteristic cannot be invoked without 'new'` unter HB2 | **Der Blocker.** Ursache B1/B2/B3. PR #207 löst B1/B2 im Altcode; im Rewrite wird das in `characteristics/eve.ts` neu umgesetzt. Die DHW-Fehlermeldung im selben Thread ist S7/S8.                                                                     | 2                  |
| **#208** | „Out of compliance" beim Pairing                                             | Kein Beleg für Plugin-Ursache; typische Auslöser sind ungültige Characteristic-Werte oder Service-Limits. B6 ist ein plausibler Kandidat und wird ohnehin behoben. Nach der Beta mit dem Melder erneut prüfen, sonst an Homebridge verweisen.          | 2, dann beobachten |
| **#172** | Steigende CPU-Last auf dem Pi                                                | Sehr wahrscheinlich S5 (wirkungsloses `updating`-Guard) plus S11 (N Timer). Der `PollingCoordinator` löst beides strukturell.                                                                                                                          | 2                  |
| **#94**  | „Target Temperature: illegal value"                                          | B6: 5 °C als Off-Wert bei `minHeatSetpoint: 10`, zusätzlich `NaN` bei leerer Batterie. Werte klemmen, Off über `TargetHeatingCoolingState`.                                                                                                            | 2 + 3              |
| **#136** | Automatischer Retry bei fehlgeschlagenem Login                               | S12. `TokenStore` mit Backoff.                                                                                                                                                                                                                         | 1                  |
| **#149** | Temperaturänderung überschreibt aktiven Override                             | Bestätigt durch Code: es wird immer `TemporaryOverride` bis zum nächsten Switchpoint erzwungen. Die API kann auch `PermanentOverride` und `FollowSchedule`. → Option `setpointMode`. Deckt auch @DenyTsjapanovs Wunsch nach permanenten Sollwerten ab. | 3                  |
| **#146** | Änderungen der Ist-Temperatur wieder loggen                                  | Option `logTemperatureChanges`, Vorlage PR #204.                                                                                                                                                                                                       | 3                  |
| **#180** | Warmwasser-Szene schlägt fehl (Controller for HomeKit)                       | „Error Action Set Failed" nach ~15 s = HomeKit-Timeout. Ursache: `setHotWaterStatus` ruft den `callback` im Erfolgsfall **nie** auf (`index.js:1198–1265`). Mit `onSet` strukturell erledigt.                                                          | 2 + 3              |
| **#130** | Thermostate erscheinen als Feuchtigkeitssensoren                             | Home-App-Verhalten: `Service.Thermostat` deklariert `CurrentRelativeHumidity` als optional. Mit Entscheidung **F4** bleibt es dabei → als bekannte Einschränkung dokumentieren, Issue mit Erklärung schließen.                                         | 5 (Doku)           |
| **#166** | Hoobs-Plugin startet nicht                                                   | Fehler stammt aus `googleapis` unter `fakegato-history` (S15), nicht aus dem Plugin-Code. Löst sich, sobald FakeGato optional ist (F3).                                                                                                                | 4                  |
| **#83**  | Evohome-Security (Total Connect 2.0E)                                        | Anderes Backend, anderes Produkt. Nicht Teil dieser Migration; als eigenes Plugin abgrenzen.                                                                                                                                                           | out of scope       |
| **#54**  | Schedule-Support in FakeGato                                                 | Hängt an der History-Entscheidung. Sinnvoll erst nach Phase 4, und nur wenn `history` aktiv ist.                                                                                                                                                       | nach 4             |

Nicht aus Issues, aber aus dem Code: **#61** (Accessories verlieren Raumzuordnung) ist
S1 und wird durch Phase 2 strukturell erledigt.

## 7. Migration der Bestandsnutzer

**Entschieden (F1): Variante A.** Der Wechsel auf stabile UUIDs ist einmalig breaking —
HomeKit sieht neue Accessories, Raumzuordnung und Automationen müssen neu gesetzt werden.
Der Bruch wird akzeptiert, als Major 1.0.0 releast und im README sowie im
Config-UI-Header angekündigt. Danach ist die Identität dauerhaft stabil; genau der Punkt,
der heute als „Known Issue" im README steht.

Ein Kompatibilitätsmodus, der alte `systemId:index`-UUIDs weiterverwendet, wurde
verworfen: er konserviert die instabile Identität und verdoppelt den Testaufwand.

Was Nutzer beim Update tun müssen, gehört so in den CHANGELOG und ins README:

1. Vor dem Update Homebridge 2.x und Node 22+ sicherstellen.
2. Nach dem Update erscheinen die Geräte einmalig im Standardraum und müssen neu
   zugeordnet werden; Automationen und Szenen sind neu anzulegen.
3. `childBridge` aus der Config entfernen (wird ignoriert, mit Warnung).

## 8. Risiken

| Risiko                                                                          | Wirkung                                                                                 | Gegenmaßnahme                                                                                                                                            |
| :------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Kein Zwischen-Release** (Folge von F1)                                        | HB2-Nutzer bleiben bis 1.0.0 blockiert (#205 seit Mai 2026)                             | Früh Betas aus diesem Branch veröffentlichen (`--tag beta`) und in #205 verlinken; Phasen 0–2 priorisieren, denn danach ist das Plugin bereits lauffähig |
| Kein Testsystem für alle Gerätetypen (DHW, RoundWireless, RoundModulation, UFH) | Regressionen bei Nutzern, die der Maintainer nicht reproduzieren kann                   | Fixtures aus echten Responses; in #205 haben mehrere Nutzer mit 12-Zonen-Systemen Hilfe angeboten                                                        |
| Undokumentierte TCC-EMEA-API kann sich ändern                                   | Plugin bricht ohne Vorwarnung (wie beim Domain-Wechsel `honeywell.com` → `resideo.com`) | API-Zugriff isolieren; Basis-URL und Endpunkte konfigurierbar halten                                                                                     |
| Rate-Limiting bei aggressiverem Retry                                           | Konto temporär gesperrt                                                                 | Exponentieller Backoff mit Cap, Mindest-Poll-Intervall im Schema erzwingen                                                                               |
| Maintainer-Kapazität (siehe Kommentar in #172)                                  | Rewrite bleibt liegen                                                                   | Phasen sind einzeln abschließbar; nach Phase 2 existiert ein lauffähiges Plugin, das als Beta nutzbar ist                                                |

## 9. Getroffene Entscheidungen

Alle am 2026-09-03 entschieden.

|        | Frage                                      | Entscheidung                                                | Auswirkung                                                                                                                                                                                |
| :----- | :----------------------------------------- | :---------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** | Hotfix 0.12.0 zuerst oder direkt 1.0.0?    | **direkt 1.0.0**                                            | Kein Zwischen-Release; Altcode wird nicht mehr gepatcht. PRs #207/#204 dienen als Vorlage, werden nicht gemerged. Prüfliste 5.1 sichert die Befunde ab. Betas als Ausgleich.              |
| **F2** | Node-Floor?                                | **`^22 \|\| ^24 \|\| ^26`** — identisch zu Homebridge 2.4.0 | Kein Support für Homebridge 1.x nötig, `engines.homebridge: "^2.0.0"`. Erlaubt `fetch`, `AbortSignal.timeout` und moderne Syntax ohne Polyfills.                                          |
| **F3** | FakeGato behalten, ersetzen oder optional? | **optional**                                                | `optionalDependencies` + Option `history` (Default `true`), dynamischer Import mit Fallback. Entschärft #166 und die `googleapis`-Last.                                                   |
| **F4** | `Thermostat` oder `HeaterCooler`?          | **`Thermostat`**                                            | #130 (Feuchtigkeits-Kachel) wird als Home-App-Verhalten dokumentiert und das Issue geschlossen. Keine Änderung am Service-Typ.                                                            |
| **F5** | Mehrere Locations in einer Instanz?        | **Filter beibehalten**                                      | Mehrere Systeme pro Account sind in der Regel verschiedene Haushalte. `singular: false` und `locationIndex` bleiben; zusätzlich wird `locationId` als stabilere Adressierung unterstützt. |
