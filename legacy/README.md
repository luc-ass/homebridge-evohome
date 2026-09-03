# Altcode aus 0.11.2 — nur als Referenz

Diese beiden Dateien sind der unveränderte Stand von Version 0.11.2:

| Datei | vorher |
| :-- | :-- |
| `index.cjs` | `index.js` |
| `evohome.cjs` | `lib/evohome.js` |

Sie werden **nicht mehr geladen, gebaut, gelintet oder publiziert**. `package.json`
zeigt mit `main` auf `dist/index.js`, und `files` schließt dieses Verzeichnis aus.

## Warum sie noch hier liegen

Der Rewrite in `src/` orientiert sich Phase für Phase an diesem Code — vor allem an den
Details der undokumentierten TCC-EMEA-API, die sich sonst nur durch erneutes Ausprobieren
gegen ein echtes Konto rekonstruieren ließen. `docs/MIGRATION-HB2.md` verweist an vielen
Stellen mit Zeilennummern hierhin.

Die Endung `.cjs` ist nötig, weil `package.json` seit Phase 0 `"type": "module"` setzt;
als `.js` würde Node die Dateien als ESM parsen und an `require(...)` scheitern.

## Wann sie verschwinden

Am Ende von Phase 5, zusammen mit dem 1.0.0-Release. Bis dahin gilt: **hier wird nichts
mehr repariert.** Jeder Befund aus `docs/MIGRATION-HB2.md` wird im neuen Code adressiert,
nachgewiesen über die Prüfliste in Abschnitt 5.1.
