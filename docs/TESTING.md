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

Braucht Docker. Läuft gegen ein echtes Honeywell-Konto — deshalb liegt die `config.json`
nicht im Repo (`.gitignore`).

```sh
cp test-instance/config.example.json test-instance/data/config.json
$EDITOR test-instance/data/config.json      # Zugangsdaten eintragen
npm run build
docker compose -f test-instance/docker-compose.yml up
```

Config UI X läuft danach auf <http://localhost:8581>. Das Repo wird schreibgeschützt
unter `/plugin` eingehängt und über `HOMEBRIDGE_PACKAGES` als lokales Plugin geladen —
kein `npm link` nötig. Nach Codeänderungen genügt `npm run build` plus ein Neustart des
Containers.

**Was in Phase 0 zu sehen sein soll:** Homebridge lädt das Plugin ohne Fehler und loggt
`Phase-0-Gerüst geladen — es werden noch keine Accessories angelegt.` Damit ist belegt,
dass das ESM-Build unter Homebridge 2.x geladen wird — genau der Punkt, an dem 0.11.2
mit `TypeError: Class constructor Characteristic cannot be invoked without 'new'`
abbrach (Issue #205).

## 3. Fixtures aus einem echten Konto

Ab Phase 1 werden API-Antworten als Fixtures in `test/fixtures/` abgelegt, damit
Gerätetypen getestet werden können, die kein Entwickler zu Hause stehen hat (DHW,
`RoundWireless`, `RoundModulation`, Fußbodenheizungszonen).

**Vor dem Commit anonymisieren:** `locationId`, `systemId`, `zoneId`, `userId`,
Adressdaten und Namen ersetzen. Die IDs müssen innerhalb einer Fixture konsistent
bleiben, sonst laufen die Zuordnungstests ins Leere.
