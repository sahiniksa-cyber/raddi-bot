# Legacy ExcelJS capability matrix

Scope: this is an inventory of the installed `exceljs@4.4.0` behavior before
any adapter or dependency change.  The executable oracle is
`scripts/legacy-exceljs-oracle.js`; its semantic evidence is
`legacy-exceljs-oracle.json`.  No comparison uses workbook bytes.

| Area | Production call site | Legacy ExcelJS operations | Observable contract frozen by oracle |
| --- | --- | --- | --- |
| Campaign contact import | `src/services/campaigns/campaign-service.js:importContacts` | `new Workbook`; `csv.read(Readable.from(buffer))` for `.csv`; `xlsx.load(buffer)` for `.xlsx`; header and row iteration through `getRow`, `eachCell`, and `eachRow` | All worksheets are traversed in workbook order (not only the first); every non-header row is retained in that order. The evidence records source cells, accepted/rejected totals, normalized phones, contact-write order, and exact application error object. |
| Campaign contact template | `campaign-service.js:exportContactTemplate` | `new Workbook`; `addWorksheet`; `columns`; `addRow(s)`; font, autofilter, list validation; `xlsx.writeBuffer()` | Two sheets and their order, cell values, Arabic headers, sample rows, and guide rows. Styling is inventory-only because it is not consumed by application logic. |
| Campaign contacts export | `campaign-service.js:exportContacts` | `new Workbook`; `addWorksheet`; `columns`; `addRow`; font/autofilter; `xlsx.writeBuffer()` | One Arabic-named sheet, row order supplied by the existing query, normalized phone, customer fields, date strings, source, and update time cells. |
| Customer signals export | `campaign-service.js:exportSignals` | `new Workbook`; one `addWorksheet` per state; `columns`; `addRow`; font/autofilter; `xlsx.writeBuffer()` | State sheet order is `interested_unverified`, `ordered_confirmed`, `needs_verification`; every semantic cell, including confidence/empty values and Unicode text, is recorded. |
| Billing ledger | `src/services/billing/excel-ledger.js:appendLedgerRow` | `new Workbook`; `xlsx.readFile` when present; `getWorksheet`/`addWorksheet`; column headers; `addRow`; `xlsx.writeFile` | `Payments` sheet creation/read-append-write, header row, stable appended row order, ISO date cells, decimal amounts, currencies, and all ledger cells. |

## Deterministic fixture corpus

The corpus is constructed in memory by `buildFixtureCorpus()` in the oracle so
test runs never depend on user data or machine paths. It covers:

- Arabic/English names and Unicode/symbol text.
- Whitespace, `05...`, `+966...`, and a numeric cell that has lost its leading
  zero.
- Duplicate, invalid, empty, missing-phone-column, and reordered-column rows.
- Excel date cells, date strings, decimal amounts, and SAR/USD currency cells.
- A two-sheet workbook whose rows prove the observed all-sheet traversal.
- A 65,536-character cell, corrupt and empty XLSX buffers, a text buffer with
  an `.xlsx` extension, a valid CSV, and an unsupported extension.

The large-file case deliberately records current legacy behavior; it is not a
security limit. Limits and replacement-owned errors belong to later tasks.

## Reproduction

```powershell
node --test tests/legacy-exceljs-oracle.test.js
node scripts/legacy-exceljs-oracle.js
```

The second command rewrites only the tracked semantic evidence file. It does
not connect to a database, Railway, WhatsApp, Shadow Mode, or any production
service.
