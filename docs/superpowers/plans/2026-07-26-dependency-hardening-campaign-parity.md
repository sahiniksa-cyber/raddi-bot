# Dependency Hardening and Campaign Parity Plan

## Objective

Remove `whatsapp-web.js`, `exceljs`, and every production dependency path to
`brace-expansion`, `minimatch`, `glob`, and `archiver` without changing
campaign or billing behavior. Work is local-only on
`codex/dependency-hardening-shadow-plan`, based on
`0252164042ee543c5b35fdb9e4fc38d0a7d8aba6`.

## Global Constraints

- Do not deploy to Railway, contact production services, activate Shadow Mode,
  or modify real data.
- Baileys is the only supported WhatsApp engine after this phase.
- Do not remove ExcelJS until the legacy and replacement paths have processed
  the same fixture corpus and all observable results match row-for-row.
- Stop before removing ExcelJS if any unintended difference exists in a phone
  number, accepted/rejected count, message bytes, schedule, quota, recipient
  status, or tenant/campaign isolation.
- Preserve campaign import, export, creation, recipient persistence,
  scheduling, worker execution, retry/idempotency, pause/resume, quota, and
  message-content behavior.
- Preserve billing-ledger read/write behavior.
- Add explicit upload byte and row limits, reject corrupt/empty/spoofed XLSX
  input, bound memory use, and return clear errors without crashing a worker.
- All new behavior follows RED -> GREEN -> refactor. Every claimed guard must
  be killed by a mutation or equivalent protection-disabling test.
- No bulk dependency upgrade and no `npm audit fix --force`.
- No Shadow Mode code is implemented in this phase.
- The final production dependency audit must have zero High and Critical
  findings, and the named vulnerable packages must be absent from the
  production runtime tree.

## Baseline Evidence

- Branch HEAD before changes:
  `0252164042ee543c5b35fdb9e4fc38d0a7d8aba6`.
- Stable local tag:
  `stable/stabilization-0252164`.
- Fresh full suite: 1575 passed, 0 failed.
- Fresh `npm audit --omit=dev`: 10 High, 0 Critical.
- Vulnerable roots: `exceljs@4.4.0` and `whatsapp-web.js@1.34.7`.
- Existing untracked diagnostic files under `docs/stabilization/` belong to
  the prior sprint and must not be overwritten or committed accidentally.

## Task 1: Inventory ExcelJS behavior and freeze the legacy oracle

Identify every production import and every workbook operation. Document the
capability matrix for campaign imports, all campaign exports/templates, and
the billing ledger. Build a deterministic fixture corpus and a legacy oracle
that records semantic results, not binary workbook bytes.

Fixtures must cover:

- Arabic and English names.
- `05...`, `+966...`, numeric Excel cells that lose a leading zero, and
  surrounding whitespace.
- Duplicate, invalid, empty, missing-column, and reordered-column rows.
- Unicode and symbols.
- Dates, decimals, and currencies.
- Multiple sheets according to the current first-sheet behavior.
- Large, corrupt, empty, extension-spoofed, and non-XLSX files.

Oracle output must record:

- Row count and stable row order.
- Accepted and rejected recipient counts.
- Normalized phone numbers.
- Every consumed cell value.
- Exact user-visible error category and message.
- Exported workbook semantic cells and sheet order.
- Billing-ledger semantic rows and cells.

Run the legacy oracle against ExcelJS and preserve the JSON evidence in
`docs/stabilization/dependency-hardening/`.

## Task 2: Remove whatsapp-web.js and retain Baileys only

Write failing behavior tests proving that engine configuration rejects
`whatsapp-web`, campaign media always uses the Baileys payload contract, and
production startup cannot load the legacy connection manager. Then:

- Remove `whatsapp-web.js` from dependencies.
- Remove or retire its connection-manager implementation and all fallback
  branches.
- Keep inbound source strings only where they are historical data labels, not
  runtime engine options.
- Update local configuration and deployment documentation to state Baileys
  only without deploying anything.

Run engine, runtime-bot, campaign-worker, outgoing gateway, and campaign tests.
Record the audit/tree delta; expected High count is 10 -> 9.

## Task 3: Implement the internal spreadsheet adapter

Write failing adapter contract tests first. Evaluate the focused candidates
`read-excel-file@9.3.4` and `write-excel-file@4.1.1` independently. Accept
them only if their resolved production tree has no High/Critical advisory and
they meet the fixture contract. Otherwise stop because a new architectural
choice is required.

Expose only the capabilities the application uses:

- Read the current campaign import formats with bounded rows/bytes.
- Write campaign templates and exports with stable sheet names, row order,
  headers, values, date/number semantics, and buffer responses.
- Read and atomically write the billing ledger.
- Return stable application-owned errors for empty, corrupt, oversized,
  over-row-limit, wrong-extension, and non-XLSX input.

Keep ExcelJS installed and the production call sites unchanged until all
adapter and legacy-oracle comparisons are GREEN.

## Task 4: Wire the adapter and prove campaign/billing parity

Switch campaign and billing call sites to the internal adapter while retaining
the legacy oracle in tests. Run both implementations over the exact same
fixture corpus and produce a before/after comparison report.

The comparison gate must stop the task on any unintended difference in:

- Rows, accepted/rejected recipients, normalized phones, order, cells, or
  errors.
- Campaign message bytes, scheduled timestamps, recipient counts/statuses, or
  quota effects.
- Billing-ledger rows, values, dates, decimals, or currencies.

Only explicitly documented security-limit errors may differ, and each such
difference must be marked intentional.

## Task 5: Prove the complete campaign lifecycle and isolation

Add and run integration tests for:

- Upload -> parse -> validate -> create -> persist recipients -> schedule ->
  Campaign Worker -> send -> success/failure state.
- Retries, duplicate jobs, worker restart, stop/resume, and prevention of
  duplicate sends or duplicate quota decrement.
- Preservation of exact message bytes, schedule, and recipient count.
- Two concurrent campaigns for one merchant.
- Two concurrent campaigns for different merchants with recipient, text,
  quota, send-state, and result isolation.
- Large/corrupt/empty/spoofed inputs and clear non-crashing errors.

Use deterministic transports and isolated local stores only. Never use a live
WhatsApp client, database, Redis instance, or production credential.

## Task 6: Remove ExcelJS and prove the production tree is clean

This task may start only after Tasks 1-5 are GREEN and the parity report has no
unintended differences.

- Remove ExcelJS and its override from `package.json` and lockfile.
- Add an executable architecture/runtime-tree test that fails if any removed
  vulnerable package returns.
- Run `npm audit --omit=dev`.
- Run
  `npm ls brace-expansion minimatch glob archiver exceljs whatsapp-web.js`.
- Confirm zero High/Critical and no named package in the production tree.

## Task 7: Full verification, mutation, report, and final commit

Run fresh:

- All existing tests.
- New campaign and golden-XLSX tests.
- Concurrency, retries, and duplicate-job tests.
- Stabilization simulation with 10,000 sequences and the critical matrix.
- Mutation tests, extended so disabling the new dependency, file-limit,
  idempotency, quota, and isolation guards is detected.
- Production audit and dependency-tree inspection.

Create the final dependency-hardening report containing changed files,
removed/added packages, replacement rationale, capability matrix, legacy/new
campaign comparison, all command results, remaining differences/risks, final
commit, rollback instructions, and explicit confirmation of no deployment and
no Shadow Mode.
