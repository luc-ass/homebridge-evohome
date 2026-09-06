# Legacy code from 0.11.2 — reference only

These two files are the unchanged state of version 0.11.2:

| File | Previously |
| :-- | :-- |
| `index.cjs` | `index.js` |
| `evohome.cjs` | `lib/evohome.js` |

They are **no longer loaded, built, linted or published**. `package.json` points
`main` at `dist/index.js`, and `files` excludes this directory.

## Why they are still here

The rewrite in `src/` follows this code phase by phase, above all for the details
of the undocumented TCC EMEA API, which would otherwise have to be rediscovered
by trial and error against a real account. `docs/MIGRATION-HB2.md` refers here by
line number in many places.

The `.cjs` extension is required because `package.json` sets `"type": "module"`;
as `.js` these files would be parsed as ESM and fail on `require(...)`.

## When they go away

Once 1.0.0 is released. Until then: **nothing gets fixed in here.** Every finding
is addressed in the new code instead.
