# API fixtures

Anonymised responses from the TCC EMEA API, in the shape `src/api/parse.ts`
expects.

The data is made up; the **structure** comes from 0.11.2's `lib/evohome.js` and
from log excerpts in the issues. IDs are consistent across all fixtures (location
`9876543`, system `444001`, zones `3001`–`3004`, DHW `2001`) so that mapping
tests work.

`locationStatus.json` deliberately covers the edge cases 0.11.2 failed on:

| Zone | Case | Issue |
| :-- | :-- | :-- |
| 3002 Bad | a running `TemporaryOverride` with `until` | #149 |
| 3003 Flur | `isAvailable: false`, no `temperature`, active fault | #94 |
| 3004 Wintergarten | unknown `modelType` in `installationInfo.json` | robustness |

Please anonymise new fixtures taken from real accounts before committing them —
see [../../docs/TESTING.md](../../docs/TESTING.md) section 3.
