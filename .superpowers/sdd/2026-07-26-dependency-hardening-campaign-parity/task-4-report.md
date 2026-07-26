# Task 4 report — adapter wiring and campaign/billing parity

Date: 2026-07-26
Scope: local stabilization worktree only; no Railway, production, Shadow Mode,
or `docs/stabilization/current-full-suite*.txt` changes.

## Outcome

Campaign contact import, contact/template/signal exports, and the billing
ledger now use the internal spreadsheet adapter. `exceljs@4.4.0` remains
installed solely for the frozen legacy oracle and independent test reads until
Task 6.

The exact committed fixture corpus produced no campaign import or export
semantic delta. The only observed before/after delta is the pre-approved repair
of `EXCELJS_LEDGER_SECOND_APPEND_LOST`: the second valid payment is now present
as row 3.

## RED evidence

Command:

```powershell
node --test tests/spreadsheet-adapter.test.js tests/billing-ledger.test.js tests/campaign-route-spreadsheet-upload.test.js
```

Result before production changes: 34 tests, 26 passed, 8 failed.

| RED failure | Legacy observation |
| --- | --- |
| Sequential ledger append | Expected two payment rows; only the first survived. |
| 12 concurrent ledger appends | Expected header + 12 rows; observed header + 1 row. |
| Empty valid ledger workbook | Raised `SPREADSHEET_EMPTY`. |
| Atomic rename failure | Writer ignored the injected failing rename and overwrote the target. |
| Streamed contact success | Route used `req.file.buffer`; no temp-path marker or cleanup. |
| Contact service/read failure | Injected 422 service boundary was not reached. |
| Oversized contact upload | Multer collapsed the result to 400 instead of 413. |
| Media route control | Route had no observable separation between contact and media storage in the focused integration harness. |

Each failure was caused by the missing Task 4 behavior, not a syntax, fixture,
or setup error.

## GREEN implementation

- `campaign-service.js`
  - Removed its ExcelJS import.
  - Reads Buffer or file-path sources with `readSpreadsheet`.
  - Traverses every returned sheet and row in physical order.
  - Preserves typed values and physical row/sheet metadata.
  - Maps unsupported/corrupt/empty/spoofed errors to the frozen campaign
    contract and rethrows the four adapter security-limit errors unchanged.
  - Writes the template, contacts, and state sheets with
    `writeSpreadsheetBuffer`, retaining exact names/order, RTL, widths, bold
    headers, filters, empty-string cells, guide rows, and `C2:C1000`
    validation.
- `campaign.routes.js`
  - Keeps media on `multer.memoryStorage()`.
  - Uses a contact-only storage engine that streams to a unique adapter temp
    path.
  - Passes the path to `importContacts` and awaits cleanup before responding.
  - `_removeFile` also cleans the temp directory for Multer abort/error paths.
  - Preserves the 25 MiB/one-file contact limit and reports the limit as 413.
- `excel-ledger.js`
  - Removed its ExcelJS import.
  - Defines the ten frozen Payments columns once.
  - Restores every existing sheet/header/row/value in workbook order and
    appends a positional payment row.
  - Accepts a valid workbook with no used cells.
  - Serializes the read → append → atomic-write critical section per resolved
    ledger path.
- `spreadsheet-adapter.js`
  - Adds a ledger-only `allowEmptyWorkbook` read path; campaign reads still
    reject empty workbooks.
  - Keeps atomic temp-write cleanup testable and preserves the prior target on
    rename failure.
  - Preserves explicit empty-string cells in exports through the writer's
    shared-string XML sanitizer so independent ExcelJS reads match the oracle.

## Before/after semantic comparison

The replacement harness reads the committed
`docs/stabilization/dependency-hardening/legacy-exceljs-oracle.json`, consumes
the unchanged `buildFixtureCorpus()`, runs current call sites, and compares
semantics rather than workbook bytes.

| Contract | Before | After | Classification |
| --- | --- | --- | --- |
| Import fixture identities/order | 8 frozen fixtures | Exact match | No delta |
| Import rows, accepted/rejected, normalized phones, DB write order | Frozen legacy evidence | Exact deep match | No delta |
| Typed dates/numbers and all-sheet traversal | Frozen legacy evidence | Exact deep match | No delta |
| Unsupported/corrupt/empty/spoofed public errors | Frozen code/status/message | Exact deep match | No delta |
| Template sheets/rows/presentation/validation | Frozen semantic workbook | Exact deep match | No delta |
| Contact export cells/order/presentation | Frozen semantic workbook | Exact deep match | No delta |
| Signal sheet order/cells/empty strings/presentation | Frozen semantic workbook | Exact deep match | No delta |
| Existing billing header + first payment | Header + one payment | Exact prefix match | No delta |
| Second valid billing append | Lost by ExcelJS object-row keys | Exact row 3 retained | **Intentional: `EXCELJS_LEDGER_SECOND_APPEND_LOST`** |
| Other billing semantics | Dates, decimals, currencies, email casing, order | Exact match | No delta |

Unintended differences: **none**.
Security-limit differences exercised: the documented 413 upload-size and 422
row-limit boundaries only.

## GREEN verification

Primary focused command:

```powershell
node --test tests/legacy-exceljs-oracle.test.js tests/spreadsheet-wiring-parity.test.js tests/spreadsheet-adapter.test.js tests/billing-ledger.test.js tests/campaign-route-spreadsheet-upload.test.js tests/campaigns.test.js
```

Final observed result: **88 tests, 88 passed, 0 failed**.

Concurrency repetition:

```powershell
1..10 | ForEach-Object { node --test tests/billing-ledger.test.js }
1..3 | ForEach-Object { node --test tests/campaign-route-spreadsheet-upload.test.js }
```

Observed: billing 10/10 repeated runs passed; route upload 3/3 repeated runs
passed.

Independent checks:

- Production campaign and billing modules contain no `exceljs`/`ExcelJS`
  reference.
- `package.json` and `package-lock.json` still retain ExcelJS for the oracle.
- `git diff --check` passed.
- The legacy oracle test and committed JSON evidence were not modified.

## Oracle harness decoupling

The original `createLegacyOracleEvidence()` interface dynamically invoked
production call sites. Once those call sites were wired, it observed the fixed
three-row ledger while claiming to be OLD legacy evidence. The interface was
minimally separated:

- `createLegacyOracleEvidence()` now loads the immutable committed legacy JSON
  and never invokes newly wired production.
- `buildFixtureCorpus()` remains executable, including the direct >64 KiB
  fixture check.
- `createCurrentSpreadsheetEvidence()` runs the current call sites and labels
  itself `current-spreadsheet-call-sites`.
- `tests/spreadsheet-wiring-parity.test.js` compares NEW current evidence to
  OLD committed evidence and permits only exact row 3.

The legacy oracle test and the replacement parity test pass together. The
committed JSON and every approved old value remain byte-for-byte untouched.

## Residual concerns

- Per-path serialization is intentionally in-process. Cross-process writers
  would require an external lock, which is outside this task's stated minimum.
- Arbitrary third-party workbook styling is outside the frozen billing
  semantics; sheet names, order, headers, rows, values, dates, decimals, and
  currencies are preserved.
