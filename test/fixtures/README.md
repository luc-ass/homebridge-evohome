# API-Fixtures

Anonymisierte Antworten der TCC-EMEA-API, wie sie `src/api/parse.ts` erwartet.

Die Daten sind erfunden, die **Struktur** stammt aus `legacy/evohome.cjs` und aus den
Logausschnitten in den Issues. IDs sind innerhalb aller Fixtures konsistent
(Location `9876543`, System `444001`, Zonen `3001`–`3004`, DHW `2001`), damit
Zuordnungstests greifen.

`locationStatus.json` deckt bewusst die Grenzfälle ab, an denen 0.11.2 scheiterte:

| Zone | Fall | Befund |
| :-- | :-- | :-- |
| 3002 Bad | laufender `TemporaryOverride` mit `until` | #149 |
| 3003 Flur | `isAvailable: false`, keine `temperature`, aktive Störung | #94, S8 |
| 3004 Wintergarten | unbekannter `modelType` in `installationInfo.json` | Robustheit |

Neue Fixtures aus echten Konten bitte vor dem Commit anonymisieren — siehe
[../../docs/TESTING.md](../../docs/TESTING.md) Abschnitt 3.
