# Migrationsplan: homebridge-evohome → Homebridge 2.x

Stand: 2026-09-03 · Branch `homebridge-v2` · Ausgangsbasis `7a583c8`
Ist-Zustand: [ARCHITECTURE.md](ARCHITECTURE.md)

---

## 1. Zielumgebung (verifiziert, nicht aus dem Gedächtnis)

| | Wert | Quelle |
| :-- | :-- | :-- |
| Homebridge | 2.4.0 (latest) | `npm view homebridge` |
| Node | `^22 \|\| ^24 \|\| ^26` | `homebridge@2.4.0` engines |
| HAP | `@homebridge/hap-nodejs` 2.2.x | homebridge dependencies |
| Modulsystem homebridge | **ESM** (`"type": "module"`) | `homebridge@2.4.0` package.json |
| Plugin-Laden | `await import(pathToFileURL(main))` | `homebridge/dist/plugin.js:164` |

**Wichtig:** Homebridge selbst ist ESM, lädt Plugins aber per dynamischem `import()`.
CommonJS-Plugins funktionieren dadurch weiterhin, solange sie nicht `require("homebridge")`
aufrufen — was dieses Plugin nie tut. Ein Rewrite ist also *nicht* durch das Modulsystem
erzwungen; er ist aus anderen Gründen sinnvoll (Abschnitt 3).

Die Static-Platform-API (`accessories(callback)` + `getServices()`) existiert in 2.4.0
weiterhin (`HomebridgeAPI.isStaticPlatformPlugin`, `bridgeService.js:499`). Sie ist aber
die Ursache mehrerer Dauerprobleme und sollte trotzdem aufgegeben werden.

## 2. Was unter Homebridge 2 konkret bricht

Verifiziert gegen `@homebridge/hap-nodejs@2.2.3`:

| # | Bruch | Fundstelle im Plugin | Wirkung |
| :-- | :-- | :-- | :-- |
| B1 | `Characteristic` ist eine ES-Klasse; `Characteristic.call(this, …)` + `util.inherits` ist unmöglich | `index.js:29–69` | **Absturz beim Start** — `TypeError: Class constructor Characteristic cannot be invoked without 'new'` (Issue #205) |
| B2 | `Characteristic.Formats/Units/Perms` als Statics entfernt, nur noch `api.hap.Formats/Units/Perms` | `index.js:36–38, 51, 63` | `undefined`-Zugriff |
| B3 | `Characteristic.getValue()` entfernt | `index.js:498, 504` | `TypeError` in jedem `periodicUpdate` |
| B4 | Node-Floor 22 | `engines.node: ">=0.12.0"` | Warnung, falsche Signalisierung |
| B5 | `engines.homebridge` muss `^2` einschließen, sonst kein „HB2-ready"-Badge in Config UI X | `engines.homebridge: ">=0.3.1"` | Sichtbarkeit/Vertrauen |
| B6 | Strengere Wertevalidierung | 5 °C bei `minHeatSetpoint: 10`, `NaN` bei leerer Batterie | Issue #94, Warn-Spam |
| B7 | `new Buffer(...)` | `index.js:1038` | Deprecation, in Node 22 laut |
| B8 | `Accessory.setPrimaryService()` entfernt | Plugin nutzt `Service.setPrimaryService()` (`index.js:1277`) | **kein Problem**, korrekte Variante |
| B9 | `BatteryService` entfernt | nicht genutzt | kein Problem |

## 3. Schwachstellen des Ist-Standes

Unabhängig von HB2 — diese Punkte bestimmen, ob sich ein Rewrite lohnt.

### 3.1 Architektur

* **S1 — Static Platform ⇒ keine persistenten Accessories.**
  Accessories werden bei jedem Start neu erzeugt. Ändert sich die `uuid_base`, legt
  HomeKit neue Geräte an: Räume, Namen, Szenen und Automationen sind weg. Genau das
  steht als „Known Issue" im README (#61) und ist der Grund für den `childBridge`-Schalter.
  `uuid_base` ist zudem `systemId + ":" + Array-Index` — schon ein Umsortieren oder
  Hinzufügen einer Zone bei Honeywell verschiebt alle IDs.
  → Lösung: `DynamicPlatformPlugin` mit `configureAccessory()` + stabiler UUID aus `zoneId`.

* **S2 — `childBridge`-Config ist ein Workaround für fehlende Fehlerbehandlung.**
  Der Schalter unterdrückt lediglich `callback([])` im Fehlerfall. Mit einer dynamischen
  Platform entfällt er ersatzlos.

* **S3 — Callback-Pyramide.** `accessories()` und `periodicUpdate()` sind bis zu zehn
  Ebenen tief verschachtelt (`index.js:106–360`, `385–677`), mit `.bind(this)`,
  `that`-Aliasen und teils widersprüchlichem `this`. Praktisch nicht erweiterbar.

### 3.2 Konkrete Bugs (im Code verifiziert)

| ID | Fundstelle | Defekt |
| :-- | :-- | :-- |
| **S4** | `index.js:982` | `if ((this.model = "HeatingZone"))` — **Zuweisung statt Vergleich**. Setzt bei jedem `getTargetTemperature` das Modell jedes Accessories auf `"HeatingZone"`, überschreibt also auch `RoundWireless`/`RoundModulation`/`domesticHotWater`. Die `else`-Zweige an `:840`, `:947`, `:1016` werden dadurch faktisch nie erreicht. |
| **S5** | `index.js:390 vs. 677` | `this.updating = true` steht im Kopf von `periodicUpdate`, `this.updating = false` **synchron am Ende der Funktion** — also lange bevor die Promise-Kette fertig ist. Das Reentrancy-Guard wirkt nicht; Updates können sich überlappen und stapeln. Heißer Kandidat für Issue #172 (CPU-Anstieg). |
| **S6** | `index.js:90 vs. 956` | `temperatureAboveAsOff` wird auf der Platform gesetzt, aber nie an das Accessory übergeben. `that.temperatureAboveAsOff` ist immer `undefined` — **das Feature ist wirkungslos**, obwohl es in Config-Schema und README dokumentiert ist. |
| **S7** | `index.js:1164, 1168–1187` | `EvohomeDhwAccessory.periodicCheckStatus` wird per `setInterval` ohne Argument aufgerufen, ruft im Fehlerfall aber `callback(err)` → `TypeError: callback is not a function`. Erklärt das „Failed to load Hot Water"-Dauerfeuer im Log (Kommentar zu #205). |
| **S8** | `lib/evohome.js:138` | `getHotWater` baut `new DHW(json)` ohne Prüfung. Liefert die API einen Fehlerkörper, ist `json.temperatureStatus` `undefined` → `Cannot read properties of undefined (reading 'temperature')`. |
| **S9** | `index.js:730–800` | `getNextScheduledTime()`: `proceed` wird zwischen den Wochentagen nicht zurückgesetzt, verglichen wird per lokalisiertem `toLocaleTimeString()`-String, und über Mitternacht fällt alles auf `"00:00:00"` zurück. Daher die README-Warnung zur Zeitzone. |
| **S10** | `lib/evohome.js:21–33` | `sessionCredentials` speichert Benutzername + **Passwort im Klartext** in einer Modul-globalen Map, keyed auf das Bearer-Token. Die Map wird **nirgends gelesen** und nie geleert. Ersatzlos löschen. |
| **S11** | `index.js:322, 326, 724, 1164` | `setInterval`-Handles werden nie gespeichert oder mit `clearInterval` abgeräumt. Bei N Zonen laufen N Timer à 5 s dauerhaft. |
| **S12** | `lib/evohome.js:288–320` | Der Token-Refresh läuft per `setInterval` mit dem *initialen* `expires_in`. Schlägt ein Refresh fehl, gibt es keinen Retry und keinen Re-Login — das Plugin ist bis zum Neustart tot (Issue #136). |
| **S13** | `index.js:130–135` | `getThermostats()` und `getSystemModeStatus()` rufen **denselben** Endpunkt auf. Jeder Poll macht drei Requests, wo einer reicht. |

### 3.3 Abhängigkeiten und Sicherheit

* **S14** — `request` ist seit 2020 deprecated und unmaintained, `q` ebenfalls deprecated.
  Node 22 hat globales `fetch`; beide können ersatzlos entfallen. `lodash` (5 × `_.map`)
  und `moment` (3 × `.unix()`) ebenso.
* **S15** — `fakegato-history` zieht `googleapis` (~100 MB) und `debug@^2` nach. Der
  `googleapis`-Import ist genau die Fehlerquelle in Issue #166 (Hoobs). Der
  Google-Drive-Pfad wird von diesem Plugin nie benutzt (`storage: "fs"`).
* **S16** — Keine `package-lock.json`, alle Runtime-Deps als offene Ranges (`>=`).
  Ein kaputtes Transitiv-Update trifft alle Nutzer sofort.

### 3.4 Qualitätssicherung

* **S17** — `.eslintrc` konfiguriert `@typescript-eslint` und `eslint-plugin-jest`; beide
  sind nicht installiert, es gibt keine `.ts`-Dateien und kein `lint`-Script. Die Config
  läuft nie.
* **S18** — `npm-publish.yml` nutzt **Node 12** und ruft `npm test`, obwohl kein
  `test`-Script existiert. Der Release-Workflow ist in diesem Zustand nicht belastbar.
* **S19** — Null Tests. Es gibt keine Möglichkeit, eine Verhaltensänderung ohne echtes
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
   Für Bestandsnutzer eine dokumentierte, einmalige Migration (siehe Abschnitt 7).
3. **`onGet`/`onSet` statt `.on("get"/"set")`.** Async-Handler, die einen Wert
   zurückgeben bzw. bei Fehlern `HapStatusError` werfen, statt Fehler zu verschlucken.
   Werte kommen aus dem Cache des Pollers — kein API-Call im HomeKit-Pfad.
4. **Kein Callback-Fehlerverlust.** Jeder API-Fehler wird typisiert, geloggt und führt
   zu einem definierten Zustand (`StatusFault` / letzter bekannter Wert), nicht zum Abbruch.
5. **Login mit Backoff.** Exponentiell mit Cap, damit der Rate-Limiter nicht getroffen
   wird (Issue #136 fordert das explizit).

## 5. Phasenplan

Der Plan ist bewusst zweigeteilt: **Phase 1 liefert kurzfristig eine funktionierende
0.12.0** für die Nutzer, die seit dem HB2-Update auf Homebridge 1.11.4 festhängen. Der
Rewrite läuft danach ohne Zeitdruck.

### Phase 0 — Absicherung (0,5 Tag)
- [ ] Branch `homebridge-v2` (erledigt)
- [ ] `package-lock.json` erzeugen und committen, Runtime-Deps auf `^` pinnen
- [ ] `npm-publish.yml`: Node 22, `npm ci`, `npm test` erst wenn es Tests gibt
- [ ] Testinstanz: Homebridge 2.4.0 + Node 22 im Docker-Container gegen ein echtes Konto

### Phase 1 — HB2-Hotfix auf bestehendem Code (1–2 Tage) → **Release 0.12.0**
Ziel: läuft unter Homebridge 1.8 *und* 2.x, kein Umbau der Architektur.
- [ ] B1/B2/B7: PR **#207** übernehmen (Custom Characteristics als ES-Klassen,
      `api.hap.Formats/Units/Perms`, `Buffer.from`, NaN-Guard) — schließt #205
- [ ] B3: `.getValue()` in `periodicUpdate` durch `updateValue(...)` mit selbst
      berechnetem Zustand ersetzen
- [ ] B4/B5: `engines` → `{"node": "^22 || ^24 || ^26", "homebridge": "^1.8.0 || ^2.0.0"}`
- [ ] S7/S8: DHW-Fehlerpfad reparieren (kein `callback` im Interval, Response prüfen)
- [ ] S4: `(this.model = …)` → `===`
- [ ] S5: `updating`-Flag korrekt im `finally` zurücksetzen
- [ ] S6: `temperatureAboveAsOff` an das Accessory durchreichen
- [ ] S10: `sessionCredentials` löschen
- [ ] B6: Setpoint auf `[minHeatSetpoint, maxHeatSetpoint]` klemmen, `NaN` abfangen — #94
- [ ] PR **#204** übernehmen (Fehler-Trapping bei Honeywell-Ausfällen) — #153, #146
- [ ] README: HB2-Kompatibilität, Node-Anforderung

### Phase 2 — Toolchain (1 Tag)
- [ ] TypeScript strict, `tsconfig.json`, Build nach `dist/`, `"type": "module"`
- [ ] ESLint 9 Flat Config mit `typescript-eslint` (ersetzt die tote `.eslintrc`) — S17
- [ ] Vitest + `npm scripts`: `build`, `lint`, `test`, `watch`
- [ ] CI-Workflow: Node 22/24/26 Matrix, lint + build + test bei jedem PR — S18/S19
- [ ] `.npmignore`/`files`: nur `dist/`, `config.schema.json`, Assets publizieren

### Phase 3 — API-Client (2–3 Tage)
- [ ] `api/types.ts` aus echten Responses ableiten, Fixtures in `test/fixtures/` ablegen
- [ ] `EvohomeClient` auf `fetch` + `AbortSignal.timeout` — `request`/`q` raus (S14)
- [ ] `TokenStore`: Refresh vor Ablauf, Retry mit Backoff, Re-Login bei `invalid_grant`,
      Token verschlüsselt/uid-scoped in `api.user.storagePath()` cachen — #136, S12
- [ ] `lodash`/`moment` entfernen
- [ ] `util/schedule.ts`: `nextSwitchpoint()` neu, zeitzonenrichtig, mit Tests über
      Tageswechsel und DST — S9
- [ ] Unit-Tests gegen Fixtures, inkl. HTTP 401/429/5xx und leerem Body

### Phase 4 — Dynamische Platform (3–4 Tage)
- [ ] `EvohomePlatform implements DynamicPlatformPlugin`, `configureAccessory()`,
      `didFinishLaunching` → discovery, `unregisterPlatformAccessories` für verschwundene Zonen
- [ ] Stabile UUIDs aus `zoneId` / `dhwId` / `systemId+mode` — S1
- [ ] `PollingCoordinator`: ein Request pro Zyklus, konfigurierbares Intervall,
      `async`-Guard, `clearInterval` bei Shutdown — S5, S11, S13
- [ ] Handler-Klassen mit `onGet`/`onSet`
- [ ] `childBridge`-Option entfernen — S2
- [ ] Migrationspfad für Bestands-Accessories (Abschnitt 7)

### Phase 5 — Offene Issues abarbeiten (2–3 Tage)
Siehe Mapping in Abschnitt 6.

### Phase 6 — FakeGato-Entscheidung (0,5–1 Tag)
Siehe offene Frage F3.

### Phase 7 — Release 1.0.0 (1 Tag)
- [ ] `config.schema.json` v2 inkl. neuer Optionen und Entfernung von `childBridge`
- [ ] README neu: Anforderungen, Migration, bekannte Einschränkungen
- [ ] `CHANGELOG.md` mit expliziter Breaking-Change-Liste
- [ ] Beta über `npm publish --tag beta`, Testaufruf in #205 (dort haben mehrere
      Nutzer mit 12-Zonen-Systemen Hilfe angeboten)

**Aufwandsschätzung gesamt:** ca. 11–16 Personentage, davon 1,5–2,5 bis zur
funktionsfähigen 0.12.0.

## 6. Zuordnung offener Issues

| Issue | Titel | Bewertung | Phase |
| :-- | :-- | :-- | :-- |
| **#205** | `Class constructor Characteristic cannot be invoked without 'new'` unter HB2 | **Der Blocker.** Ursache B1/B2, Fix liegt als PR #207 vor. Die DHW-Fehlermeldung im selben Thread ist S7/S8. | 1 |
| **#208** | „Out of compliance" beim Pairing | Kein Beleg für Plugin-Ursache; typische Auslöser sind ungültige Characteristic-Werte oder Service-Limits. B6 (5 °C unter `minValue`, `NaN`) ist ein plausibler Kandidat und wird in Phase 1 ohnehin behoben. Danach mit Nutzer erneut prüfen, sonst an Homebridge verweisen. | 1, dann beobachten |
| **#172** | Steigende CPU-Last auf dem Pi | Sehr wahrscheinlich S5 (wirkungsloses `updating`-Guard) plus S11 (N Timer). Phase 4 löst es strukturell, Phase 1 mildert es. | 1 + 4 |
| **#94** | „Target Temperature: illegal value" | B6: 5 °C als Off-Wert bei `minHeatSetpoint: 10`, zusätzlich `NaN` bei leerer Batterie. Werte klemmen + Off über `TargetHeatingCoolingState` statt über 5 °C abbilden. | 1 |
| **#136** | Automatischer Retry bei fehlgeschlagenem Login | S12. Ein `TokenStore` mit Backoff ist Teil von Phase 3. | 3 |
| **#149** | Temperaturänderung überschreibt aktiven Override | Bestätigt durch Code: `periodicCheckSetTemperature` erzwingt immer `TemporaryOverride` bis zum nächsten Switchpoint. Die API kann laut `setHeatSetpoint` auch `PermanentOverride` und `FollowSchedule`. → Neue Option `setpointMode`: `untilNextSwitchpoint` (Default, heutiges Verhalten) \| `permanent` \| `keepExistingUntil` (Endzeit eines laufenden Overrides aus `setpointStatus` übernehmen). Deckt auch @DenyTsjapanovs Wunsch nach permanenten Sollwerten ab. | 5 |
| **#146** | Änderungen der Ist-Temperatur wieder loggen | Trivial, liegt als PR #204 vor. Als Option `logTemperatureChanges` aufnehmen. | 1 |
| **#180** | Warmwasser-Szene schlägt fehl (Controller for HomeKit) | „Error Action Set Failed" nach ~15 s = HomeKit-Timeout. Ursache: `setHotWaterStatus` ruft den `callback` im Erfolgsfall **nie** auf (`index.js:1198–1265`) — der Set-Handler antwortet nur im Fehlerfall. Klarer Bug, in Phase 1 oder 4 zu beheben. | 1 |
| **#130** | Thermostate erscheinen als Feuchtigkeitssensoren | Verhalten der Home-App: der Thermostat-Service deklariert `CurrentRelativeHumidity` als optional. Nicht abstellbar, solange `Service.Thermostat` genutzt wird. → Als „won't fix" dokumentieren; optional als `HeaterCooler` anbieten (F4). | Doku |
| **#166** | Hoobs-Plugin startet nicht | Fehler stammt aus `googleapis` unter `fakegato-history` (S15), nicht aus dem Plugin-Code. Löst sich, wenn FakeGato ersetzt oder optional wird (Phase 6). | 6 |
| **#83** | Evohome-Security (Total Connect 2.0E) | Anderes Backend, anderes Produkt. Nicht Teil dieser Migration; als eigenes Plugin abgrenzen. | out of scope |
| **#54** | Schedule-Support in FakeGato | Hängt an der FakeGato-Entscheidung. Erst nach Phase 6 sinnvoll. | 6 |

Nicht aus Issues, aber aus dem Code: **#61** (Accessories verlieren Raumzuordnung) ist
S1 und wird durch Phase 4 strukturell erledigt.

## 7. Migration der Bestandsnutzer

Der Wechsel auf stabile UUIDs ist **einmalig breaking**: HomeKit sieht neue Accessories,
Raumzuordnung und Automationen müssen neu gesetzt werden. Optionen:

* **A (empfohlen):** Bruch akzeptieren, als Major 1.0.0 releasen, im README und im
  Config-UI-Header prominent ankündigen. Danach ist der Zustand dauerhaft stabil —
  genau der Punkt, der heute im README als „Known Issue" steht.
* **B:** Kompatibilitätsmodus, der die alte `systemId:index`-UUID weiterverwendet, wenn
  ein Accessory mit dieser UUID im Cache liegt. Halbiert den Schmerz, konserviert aber
  die instabile Identität und verdoppelt den Testaufwand.

Empfehlung: **A**, gebündelt mit allen anderen Breaking Changes in einem Release.

## 8. Risiken

| Risiko | Wirkung | Gegenmaßnahme |
| :-- | :-- | :-- |
| Kein Testsystem für alle Gerätetypen (DHW, RoundWireless, RoundModulation, UFH) | Regressionen bei Nutzern, die der Maintainer nicht reproduzieren kann | Fixtures aus echten Responses (#205 hat Freiwillige mit 12 Zonen); Beta-Tag vor dem Release |
| Undokumentierte TCC-EMEA-API kann sich ändern | Plugin bricht ohne Vorwarnung (wie beim Domain-Wechsel `honeywell.com` → `resideo.com`) | API-Zugriff isolieren; Endpunkte und Basis-URL konfigurierbar halten |
| Rate-Limiting bei aggressiverem Retry | Konto temporär gesperrt | Exponentieller Backoff mit Cap, Mindest-Poll-Intervall im Schema erzwingen |
| Maintainer-Kapazität (siehe Kommentar in #172) | Rewrite bleibt liegen | Phase 1 ist bewusst eigenständig releasebar und liefert den Nutzern sofort Wert |

## 9. Offene Entscheidungen

* **F1 — Reihenfolge:** Erst 0.12.0 als Hotfix veröffentlichen (Phase 1) und den Rewrite
  danach in Ruhe machen, oder direkt auf 1.0.0 zuarbeiten? *Empfehlung: Hotfix zuerst* —
  in #205 melden sich seit Mai 2026 Nutzer, die auf Homebridge 1.11.4 zurückmussten.
* **F2 — Node-Floor:** `^22 || ^24 || ^26` (identisch zu Homebridge 2.4.0) oder `>=20`
  für Homebridge-1.x-Nutzer? *Empfehlung: `^20.19 || ^22 || ^24 || ^26` in 0.12.0,
  ab 1.0.0 dann `^22 || ^24 || ^26`.*
* **F3 — FakeGato:** behalten (zieht `googleapis` mit, Ursache von #166), auf eine
  schlanke eigene Eve-History-Implementierung wechseln, oder optional machen
  (`history: true|false`, Default `true`)? *Empfehlung: optional machen und in
  `optionalDependencies` verschieben.*
* **F4 — Service-Typ:** `Thermostat` beibehalten (Feuchtigkeits-Kachel, #130) oder
  `HeaterCooler` anbieten? *Empfehlung: bei `Thermostat` bleiben, #130 als
  Home-App-Verhalten dokumentieren.*
* **F5 — Mehrere Locations:** weiterhin ein Platform-Block pro Location
  (`singular: false`), oder alle Locations in einer Instanz? *Empfehlung: alle Locations
  in einer Instanz, `locationIndex` als Deprecated-Filter beibehalten.*
