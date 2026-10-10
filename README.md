# Trade Republic Importer (Wealthfolio addon)

Import Trade Republic **stock and derivative transactions** from the broker's
CSV export ("Esportazione operazioni" / "Export transactions") into
[Wealthfolio](https://wealthfolio.app).

Community addon. Not affiliated with Trade Republic or Wealthfolio.

## Features

1. **Account picker on start** — choose the target account; every row is
   imported there.
2. **Trading + cash deposits** — keeps `TRADING / BUY|SELL` rows and
   `CASH` transfer rows (`TRANSFER_*` inbound/outbound). Other cash rows
   (interest, …) are skipped with a count.
3. **Transfer pairs** — pick the counterparty account (your bank /
   depository): each deposit becomes a `TRANSFER_OUT` + `TRANSFER_IN` pair
   via `saveTransferPair`, duplicate-checked per leg (same day + same
   amount) and auto-disabled with a reason.
4. **Standard market resolution** — ordinary stocks use Wealthfolio's
   standard market providers. Derivatives and ISINs without a standard quote
   import as **MANUAL** securities. The addon does not search custom markets,
   probe custom providers, or assign them.
5. **Duplicate check** — rows go through `activities.checkImport`. Anything
   flagged `duplicateOfId / duplicateOfLineNumber` is **auto-disabled** in the
   review table (red `DUPLICATE` badge). Per-row `force` re-enables with
   `forceImport`. Trade Republic transaction IDs (`[TR:...]` in comment) are
   also checked across all accounts.
6. **Review table** — one row per transaction: insert checkbox, date, side,
   name/ISIN, qty, price, amount, resolved market, status. Only checked rows
   are sent to `activities.import`.

> Trade Republic warrants and leveraged certificates (Optionsschein, Faktor,
> Turbo, etc.) are imported as equity-like securities so their per-certificate
> prices use a 1× multiplier. Wealthfolio's native `OPTION` type defaults to
> 100×, and the addon API does not expose a way to override that multiplier.
> Faktor and Turbo certificates have no dedicated Wealthfolio type.

## Requirements

- Wealthfolio `>= 3.9.0` (addon SDK `3.9.0`)
- For development: Node.js `20+`, `pnpm`

## Install (from GitHub Releases)

1. Go to **Releases** and download the latest
   `trade-republic-importer-<version>.zip`.
2. In Wealthfolio, open the addon manager and install from the zip file.
3. Open the **Trade Republic** sidebar entry added by the addon.

Zips are built automatically by the `release` workflow when a GitHub Release
is published. They contain only `manifest.json`, `dist/addon.js` and
`README.md` — no `node_modules`, no source maps — with Linux-compatible
forward-slash paths, so a zip built on any OS installs everywhere.

## Usage

1. Export your transactions in the Trade Republic app:
   **Transactions / Export transactions (CSV)**.
2. In the addon:
   1. **Target account** — choose where securities are imported.
   2. **Trade Republic CSV** — select the exported file.
   3. **Standard market lookup** — wait for automatic resolution
      (`STANDARD` vs `MANUAL`), then **Check duplicates**.
   4. **Cash transfers** — if present, choose the counterparty account
      (your bank/depository). Duplicates are auto-disabled.
   5. **Review** — uncheck anything to skip, `force` duplicates only if
      you really want them twice, then **Import**.
3. Portfolio totals refresh automatically after import.

Never commit your real CSV export: `*.csv` / `*.xlsx` are git-ignored.

## Development

```bash
pnpm install
pnpm dev:server   # dev server for Wealthfolio debug builds
pnpm build        # -> dist/addon.js
pnpm bundle       # clean + build + Linux-compatible zip (works on Windows too)
pnpm lint         # tsc --noEmit
```

Project layout:

```text
src/
  addon.tsx   # addon entry, route registration
  App.tsx     # importer UI (account -> file -> resolution -> review -> done)
  tr.ts       # TR CSV parser + Wealthfolio mapping (no UI)
scripts/
  package.mjs # cross-platform zip builder (Node + archiver)
  clean.mjs   # cross-platform rm -rf dist
manifest.json # Wealthfolio addon manifest
```

The zip is built by `scripts/package.mjs` (Node + `archiver`): forward-slash
entries, `manifest.json` at the root, no `node_modules`, no `*.map` — so a
zip compiled on Windows installs fine on Linux.

## Releasing

1. Bump `version` in `package.json` and `manifest.json` (keep them in sync).
2. Push to `main`, then create a GitHub Release with tag `v<version>`
   (e.g. `v1.0.0`).
3. The `.github/workflows/release.yml` workflow runs `pnpm bundle` and
   attaches `dist/trade-republic-importer-<version>.zip` to the Release.

## Permissions

- `accounts.getAll` — account picker
- `activities.getAll/checkImport/import/saveTransferPair` — preview, duplicate
  check, import, cash transfer pairs
- `portfolio.update` — refresh calculations after import
- `storage` / `query` / `toast` / `logger` via addon SDK context

See `manifest.json` for the exact permission declarations.

## License

MIT
