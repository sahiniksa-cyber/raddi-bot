# Task 1 report — RED architecture boundaries

## Files created

- `tests/architecture/single-policy-source.test.js`
- `tests/architecture/single-whatsapp-transport.test.js`
- `tests/architecture/mandatory-send-gateway.test.js`
- `tests/helpers/source-architecture.js`
- `docs/stabilization/red-green-ledger.md`

No runtime or production source files were changed.

## RED verification

Command:

```powershell
node --test tests/architecture/single-policy-source.test.js tests/architecture/single-whatsapp-transport.test.js tests/architecture/mandatory-send-gateway.test.js
```

Output summary (baseline):

```text
tests 3
pass 0
fail 3
cancelled 0
skipped 0
todo 0
exit code 1
```

Exact failing assertions and counts:

```text
Every WhatsApp producer must use WhatsAppSendGateway with a complete, tenant-scoped request. Found 11
botInstructions must be confined to dashboard compatibility import/export, the legacy migrator, migration fixtures, tests, and docs. Found 14
Direct WhatsApp transport calls must move to src/services/whatsapp/whatsapp-transport-adapter.js. Found 10
```

The failures enumerate the baseline locations in their assertion output:

- Policy source: `lib/ai-client.js`, `lib/constants.js`, quality gate (2), product knowledge, prompt edit service (5), escalation routing (2), and evaluation fixtures (2).
- Transport: bot controller, alerts, unlink alert, Baileys connection manager, campaign worker (3), and outgoing WhatsApp worker (3).
- Gateway: missing imports/invocations across the configured producers, `src/services/ai/pre-send-review.js:181` as the `preSendReviewRequired` authorization switch, and no gateway request construction.

## Self-review

- Scan scope is limited to `lib/`, `src/`, `dashboard/`, and `scripts/`; tests, docs, legacy archives, database migrations, and the dedicated legacy bot-instructions migrator are excluded.
- The direct transport pattern is AST-independent and permits `client.sendMessage` / `sock.sendMessage` only in `src/services/whatsapp/whatsapp-transport-adapter.js`.
- The gateway test requires producers to name and invoke `WhatsAppSendGateway`, rejects the authorization switch, and requires explicit `sendClass`, `policyVersion`, `idempotencyKey`, and `tenantScope` fields.
- `git diff --check` completed with no whitespace errors before the RED-test commit.

## Commit

RED architecture-test commit: `d88b6edaf0ea0c662e8e17ff736c5c5e3dcc7a80` (`test: expose distributed policy and send bypasses`).

## Concerns

The policy boundary intentionally flags existing comments, default configuration, and evaluation fixtures because Task 1 requires the `botInstructions` token to be confined to explicit compatibility/migration allowances. These failures are expected RED work for subsequent stabilization tasks.

## Review fix round 1/5

The review identified load-bearing test-quality gaps. No runtime files changed. The architecture harness was strengthened as follows:

- Producer wiring now extracts a concrete `WhatsAppSendGateway` import binding, follows a `new` instance binding, and requires that receiver's `.send({ ... })` invocation. An unrelated `.send()` no longer satisfies the producer rule.
- Gateway request fields must coexist in one object literal passed by a producer to that bound gateway receiver; field names elsewhere, or split across request objects, do not satisfy the rule.
- The authorization scan now treats every non-object-key `preSendReviewRequired` reference as a runtime authorization use, covering equality, truthy, negated, coerced, and other reads.
- Direct-transport scanning now covers dotted, optional-chaining, whitespace-around-dot, and bracket-member call forms.
- Source matching records every match on a line instead of stopping at the first; counts remain occurrence counts.

Focused evidence was run by the required Task 1 command:

```text
tests 7
pass 4
fail 3
exit code 1
```

The four focused checks passed. The intentionally RED architecture assertions remained and reported **7** gateway violations, **14** policy occurrences, and **10** direct transport occurrences. The gateway count changed from 11 to 7 because the stronger import-and-bound-invocation rule reports each missing producer wiring once instead of accepting unrelated `.send()` text and emitting a separate false-granularity omission. `git diff --check` also completed with exit code `0` before committing this review fix.
