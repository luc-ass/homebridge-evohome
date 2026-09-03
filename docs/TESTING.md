# Testen

Drei Ebenen, von schnell nach realistisch.

## 1. Statische Prüfung und Unit-Tests

```sh
npm run check      # lint + typecheck + test
npm run test:watch # Tests im Watch-Modus
npm run build      # nach dist/
```

`npm run check` ist genau das, was die CI auf Node 22, 24 und 26 ausführt, und was vor
jedem `npm publish` läuft (`prepublishOnly`).

Die Lint-Konfiguration setzt bewusst ein paar Regeln durch, die konkrete Altbefunde
absichern — siehe Kommentare in `eslint.config.js` und die Prüfliste in
[MIGRATION-HB2.md](MIGRATION-HB2.md#51-prüfliste-nichts-geht-beim-rewrite-verloren):

| Regel                                 | Befund                                   |
| :------------------------------------ | :--------------------------------------- |
| `no-cond-assign: always`              | S4 — `if ((this.model = "HeatingZone"))` |
| `max-depth`, `max-nested-callbacks`   | S3 — zehnfach verschachtelte Callbacks   |
| `no-restricted-syntax` auf `getValue` | B3 — in HAP 2.x entfernt                 |
| `no-restricted-globals` auf `Buffer`  | B7 — `new Buffer(...)`                   |
| `no-floating-promises`                | S5, S12 — verschluckte Fehler            |

## 2. Lokale Homebridge-2-Instanz

Homebridge 2.4.0 liegt als devDependency im Repo — es braucht weder eine globale
Installation noch Docker.

```sh
mkdir -p test-instance/data
cp test-instance/config.example.json test-instance/data/config.json
$EDITOR test-instance/data/config.json      # Zugangsdaten eintragen
npm run dev                                 # baut und startet Homebridge
```

`npm run dev` entspricht:

```sh
npm run build && homebridge -U ./test-instance/data -P . --strict-plugin-resolution -I
```

| Flag                         | Bedeutung                                                                                                                                                  |
| :--------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-U ./test-instance/data`    | Storage-Pfad: Config, Pairing-Daten und Accessory-Cache landen dort (gitignored, enthält Zugangsdaten)                                                     |
| `-P .`                       | lädt das Plugin aus dem Repo-Wurzelverzeichnis; Homebridge erkennt am `package.json`, dass der Pfad selbst ein Plugin ist                                  |
| `--strict-plugin-resolution` | lädt **nur** aus `-P`, nicht zusätzlich aus den globalen `node_modules` — sonst mischen sich lokal installierte Fremd-Plugins samt ihrer Fehler in den Log |
| `-I`                         | Insecure Mode, erlaubt Zugriff über Config UI X                                                                                                            |

`npm run dev:debug` ergänzt `-D` für die `log.debug`-Ausgaben.

### Mit Config UI X testen

`--strict-plugin-resolution` lädt **ausschließlich** das Plugin aus `-P` — also auch
kein Config UI X. Wer das Formular aus `config.schema.json` im Browser prüfen will,
braucht `npm run dev:ui`; das lässt das Flag weg.

```sh
npm install -g homebridge-config-ui-x
npm run dev:ui        # http://localhost:8581
```

Dafür lädt Homebridge dann wieder alle global installierten Plugins mit. Sind dort
ältere Plugins installiert, die die aktuelle Node-Version nicht unterstützen, füllen
deren Stacktraces das Log — das hat nichts mit diesem Plugin zu tun. Für den
normalen Entwicklungslauf ist `npm run dev` deshalb die ruhigere Wahl.

**Was zu sehen sein soll**, sobald echte Zugangsdaten hinterlegt sind:

```
[Evohome] Initializing Evohome platform...
[Evohome] Location "Zuhause" mit 6 Zone(n).
[Evohome] Neues Gerät: Wohnzimmer Thermostat
[Evohome] Neues Gerät: Bad Thermostat
[Evohome] Neues Gerät: Evohome Hot Water
[Evohome] Neues Gerät: Evohome Away Mode
...
```

Damit ist belegt, dass das ESM-Build unter Homebridge 2.x geladen wird — genau der
Punkt, an dem 0.11.2 mit
`TypeError: Class constructor Characteristic cannot be invoked without 'new'`
abbrach (Issue #205).

Sinnvoll danach zu prüfen:

| Prüfung                                | Erwartung                                                                                                                                  |
| :------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------- |
| Homebridge neu starten                 | Die Geräte kommen aus dem Cache, `Neues Gerät` erscheint **nicht** erneut, die Raumzuordnung in der Home-App bleibt (S1, #61)              |
| In der Home-App eine Temperatur ändern | Eine Logzeile `… Solltemperatur auf 21 °C, bis HH:MM UTC (…)` — die Begründung zeigt, welche Regel aus `setpointMode` gegriffen hat (#149) |
| Thermostat auf „Aus"                   | Sollwert geht auf das Minimum der Zone, **nicht** auf feste 5 °C; keine `illegal value`-Warnung im Log (#94)                               |
| Warmwasser schalten                    | Antwortet sofort, nicht erst nach ~15 s (#180)                                                                                             |
| Ein paar Stunden laufen lassen         | Konstante CPU-Last, ein Statusabruf je Intervall (#172)                                                                                    |

Ist in der Zwischenzeit eine Zone bei Honeywell hinzugekommen oder entfallen, meldet
das Log `Neues Gerät:` bzw. `Gerät entfernt:` — die übrigen Geräte behalten ihre
Identität.

### Fehlerbild „No plugin was found for the platform"

Homebridge findet das Plugin nicht. Übliche Ursachen:

- `npm run build` wurde nicht ausgeführt — ohne `dist/index.js` ist das Verzeichnis
  für Homebridge kein ladbares Plugin.
- Homebridge wurde ohne `-P` gestartet und sucht nur in den globalen `node_modules`.
- Eine **ältere globale Installation** von `homebridge-evohome` überdeckt das lokale
  Verzeichnis. Ohne `--strict-plugin-resolution` meldet der Log das explizit
  (`skipping plugin found at ... since we already loaded the same plugin from ...`);
  mit dem Flag kann es nicht mehr passieren.

### Test auf einem produktionsnahen System

Für Tests auf einem Raspberry Pi oder in einem Container gilt dasselbe: Repo auschecken,
`npm ci && npm run build`, dann Homebridge mit `-P /pfad/zum/repo` starten. Beim
offiziellen Docker-Image führt der Weg über das Startup-Skript in den Einstellungen von
Config UI X — dafür gibt es **keine** Umgebungsvariable.

## 3. Fixtures aus einem echten Konto

Ab Phase 1 werden API-Antworten als Fixtures in `test/fixtures/` abgelegt, damit
Gerätetypen getestet werden können, die kein Entwickler zu Hause stehen hat (DHW,
`RoundWireless`, `RoundModulation`, Fußbodenheizungszonen).

**Vor dem Commit anonymisieren:** `locationId`, `systemId`, `zoneId`, `userId`,
Adressdaten und Namen ersetzen. Die IDs müssen innerhalb einer Fixture konsistent
bleiben, sonst laufen die Zuordnungstests ins Leere.
