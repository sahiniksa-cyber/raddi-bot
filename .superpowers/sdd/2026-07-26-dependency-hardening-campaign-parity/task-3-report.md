# Task 3 report — internal spreadsheet adapter

Status: complete locally. The adapter and both focused candidates meet the
Task 3 contract. ExcelJS remains installed, and campaign/billing production
call sites remain unchanged for the Task 4 parity gate.

## Deliverables

- `src/services/spreadsheets/spreadsheet-adapter.js` exposes the bounded
  application-owned surface:
  - `readSpreadsheet({ source, originalName })` accepts a `Buffer` or file
    path, keeps CSV support, reads every XLSX sheet in workbook order, and
    returns typed used-cell rows.
  - `spoolUploadToTempFile(stream, { originalName })` writes an upload stream
    to a uniquely created OS temporary directory, enforces the byte limit
    while streaming, and supplies explicit cleanup.
  - `writeSpreadsheetBuffer(workbook)` writes multi-sheet buffer responses
    with stable values, types, order, RTL, widths, bold headers, autofilter,
    and template list validation.
  - `readBillingLedger(filePath)` and
    `writeBillingLedgerAtomic(filePath, workbook)` provide path-based ledger
    reads and same-directory temporary-file + fsync + atomic-rename writes.
- `tests/spreadsheet-adapter.test.js` contains 11 real contract tests. Workbook
  assertions compare semantic cells and presentation metadata, never XLSX
  bytes.
- `package.json` and `package-lock.json` exact-pin
  `read-excel-file@9.3.4` and `write-excel-file@4.1.1`.

## RED evidence

The complete adapter contract was written before the implementation or either
candidate was installed.

Command:

```powershell
node --test tests/spreadsheet-adapter.test.js
```

Expected failure observed: exit 1 with
`MODULE_NOT_FOUND: ../src/services/spreadsheets/spreadsheet-adapter`. This
proved that the new contract could not pass through the existing ExcelJS
production code.

The first reader implementation then exposed a candidate default that violated
the frozen input contract: the first semantic fixture returned
`"0551234567"` instead of `" 0551234567 "`. The focused run reported 7 pass,
1 fail. The adapter now calls the candidate with `trim: false`; the reader
contract then passed 8/8. This is important because downstream campaign
normalization, rather than the XLSX library, owns trimming and phone
normalization.

The first full writer run reported 10 pass, 1 fail because the test checked
ExcelJS row-level font metadata. The frozen legacy oracle checks per-cell bold
state, and the generated header cells were already bold. The assertion was
corrected to the actual frozen semantic contract (every header cell bold);
production code did not change for that correction.

## GREEN and capability evidence

Fresh focused adapter command:

```powershell
node --test tests/spreadsheet-adapter.test.js
```

Result: **11 tests, 11 pass, 0 fail**.

Fresh adapter + legacy-oracle command:

```powershell
node --test tests/spreadsheet-adapter.test.js tests/legacy-exceljs-oracle.test.js tests/campaigns.test.js tests/billing-ledger.test.js
```

Result: **61 tests, 61 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo**
(`duration_ms 1179.4425`).

| Required capability | Evidence |
| --- | --- |
| Every sheet in workbook order | Two-sheet Arabic/English fixture returns names and rows in source order. |
| Exact used cells and Unicode | Literal cell arrays preserve Arabic, English, symbols, surrounding phone whitespace, numeric phone cells, and reordered columns. |
| Dates, decimals, currencies | Date objects, ISO date strings, `1750`, `19.99`, `SAR`, and `USD` survive semantic write/read comparison. |
| Phone text/numeric behavior | Text phone including whitespace remains text; numeric `551234568` remains a number. |
| CSV behavior | BOM, CRLF, quoted commas, escaped quotes, Unicode, and trailing empty cells are parsed without XLSX conversion. |
| File-path input | A real XLSX is read from a path; upload spooling writes streamed chunks without retaining a whole upload buffer. |
| 25 MiB compressed limit | Path `stat`, buffer length, and streaming byte count reject byte `25 MiB + 1` with `SPREADSHEET_FILE_TOO_LARGE` / HTTP 413. |
| 50,000 workbook rows | A real two-sheet 50,001-row workbook is rejected on the aggregate count with `SPREADSHEET_ROW_LIMIT_EXCEEDED` / HTTP 422. |
| Stable invalid-input errors | Empty, corrupt ZIP, oversized, wrong extension, and non-XLSX content use `SpreadsheetAdapterError` with stable adapter-owned codes/statuses. |
| Buffer exports | `writeSpreadsheetBuffer()` returns a Node `Buffer`. |
| Sheet names/order and row order | Multi-sheet semantic reopen asserts the literal order and every emitted row. |
| RTL, widths, bold headers | Reopened output asserts `rightToLeft`, exact widths, and every header cell's bold state. |
| Autofilter | Reopened output asserts exact `A1:C1`. |
| Template validation | Reopened output asserts identical list validation from `C2` through `C1000`, 999 cells total. |
| Billing read/atomic write | Two successive same-path writes reopen with both payment rows, dates, decimals, and currencies; no temporary sibling remains. |

`write-excel-file` does not expose autofilter or data validation as simple
top-level options. It does expose an official feature transformation API.
The adapter uses that API plus the package's XML sanitizers and sibling-order
helper to add `autoFilter` and `dataValidations` in schema-valid worksheet
order. ExcelJS successfully reopens and semantically verifies the output, so
this is not a capability blocker and requires no third dependency.

## Candidate installation and audit evaluation

The candidates were installed and evaluated sequentially, without any bulk
upgrade or audit fix:

```powershell
npm install read-excel-file@9.3.4 --save-exact --ignore-scripts --no-audit --no-fund
npm ls read-excel-file fflate unzipper-esm saxen --omit=dev
npm audit --omit=dev --json
```

Resolved reader tree:

- `read-excel-file@9.3.4`
  - `fflate@0.8.3`
  - `saxen@11.1.0`
  - `unzipper-esm@0.13.2`

Audit after reader only: **9 High, 0 Critical** overall; no advisory named
`read-excel-file`, `fflate`, `saxen`, or `unzipper-esm`. All nine findings
remained on the pre-existing ExcelJS tree.

The writer was then installed:

```powershell
npm install write-excel-file@4.1.1 --save-exact --ignore-scripts --no-audit --no-fund
npm ls write-excel-file fflate --omit=dev
npm audit --omit=dev --json
```

Resolved writer tree:

- `write-excel-file@4.1.1`
  - `fflate@0.8.3` (deduplicated with the accepted reader)

Audit after writer: **9 High, 0 Critical** overall; no advisory named
`write-excel-file` or `fflate`. Findings remained exactly
`archiver`, `archiver-utils`, `brace-expansion`, `exceljs`, `glob`,
`minimatch`, `readdir-glob`, `rimraf`, and `zip-stream`, all intentionally
retained under ExcelJS until Tasks 4–6.

Fresh final tree:

```text
read-excel-file@9.3.4
├── fflate@0.8.3
├── saxen@11.1.0
└── unzipper-esm@0.13.2
write-excel-file@4.1.1
└── fflate@0.8.3 deduped
```

Fresh final `npm audit --omit=dev --json`: **0 Low, 0 Moderate, 9 High,
0 Critical**. The accepted candidate branches have no High/Critical advisory.

## Stable application-owned errors

| Condition | Code | HTTP status |
| --- | --- | --- |
| Zero-byte file or workbook with no used cells | `SPREADSHEET_EMPTY` | 400 |
| Corrupt XLSX ZIP/XML | `SPREADSHEET_CORRUPT` | 400 |
| More than 25 MiB compressed input | `SPREADSHEET_FILE_TOO_LARGE` | 413 |
| More than 50,000 rows across the workbook | `SPREADSHEET_ROW_LIMIT_EXCEEDED` | 422 |
| Extension other than `.csv` / `.xlsx` | `SPREADSHEET_UNSUPPORTED_EXTENSION` | 400 |
| XLSX extension with a non-XLSX signature | `SPREADSHEET_NOT_XLSX` | 400 |

## Scope and remaining concerns

- ExcelJS is deliberately still installed, including its existing override.
  `campaign-service.js` and `excel-ledger.js` still import it; Task 4 owns
  wiring and the row-for-row legacy/replacement parity gate.
- The overall production audit therefore intentionally remains at nine High
  findings until the later ExcelJS removal task. Neither new candidate adds a
  High/Critical path.
- The adapter fixes the known `EXCELJS_LEDGER_SECOND_APPEND_LOST` behavior in
  its isolated ledger contract: the second and later rows remain present.
  Production billing behavior has not changed because the production ledger
  call site is not wired yet.
- `read-excel-file` accepts file paths, preventing the HTTP upload layer from
  holding a second full upload buffer. XLSX decompression/parsing still
  materializes parsed worksheet data as required by the selected candidate;
  the compressed-byte and aggregate-row guards bound accepted input.
- No production/Railway/Shadow resource was accessed. No deployment occurred.
  The pre-existing untracked `docs/stabilization/current-full-suite*.txt`
  files were not read, modified, staged, or committed.
