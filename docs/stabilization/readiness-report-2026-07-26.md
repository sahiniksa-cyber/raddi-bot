# Production stabilization readiness report

## Verdict

**NOT READY for production deployment.**

The local branch is ready for review and a later Shadow Mode phase, but
production reliance is not approved: `npm audit` still reports 10 high-severity
findings and Shadow Mode has not run. No Railway or production action occurred.

## Root causes

1. Merchant truth was distributed across typed fields, free-form instructions,
   prompts, learned replies, validators and post-processing.
2. senders could bypass shared policy, audit, tenant and idempotency controls.
3. LLM review and optional wiring could influence authorization.
4. queued replies did not consistently re-check the latest policy at network
   time.
5. retry state did not distinguish pre-network from ambiguous provider failure.
6. audit data could not reconstruct every reply transformation.
7. legacy fallback could derive a contact/transfer marker from non-canonical
   configuration.
8. the sanitizer restored a wholly forbidden original reply.
9. writers/importers accepted untyped or caller-versioned policy data.
10. old green tests omitted architecture, isolation, race and failure invariants.

## Controls delivered

- one validated/versioned `merchantPolicy`;
- no automated runtime use of `botInstructions`;
- ambiguous legacy input is `needs_review`;
- code-derived `policyVersion`;
- fail-closed policy, scope, audit, reservation, validation and DB dependencies;
- unified automated, human, campaign, alert and handoff send classes;
- byte-preserving human/campaign content;
- one low-level WhatsApp adapter;
- durable retryable/reserved/sending/unknown/blocked/sent reservation states;
- staged append-only audit;
- product/variant-bound facts and current-turn relevance;
- fallback with no invented commercial data.

## Evidence

- full suite: **1,575/1,575 passed**, 0 failed;
- targeted critical suites: **39/39 passed**;
- simulation: **10,000/10,000 asserted**, seed `20260726`, 12/12 cases covered;
- mutation: **12/12 killed (100%)**, no survivors;
- `git diff --check`: no whitespace errors;
- dependency audit: **10 high, 0 critical**.

See `final-tests.tap`, `simulation-report.json`, `mutation-report.json`,
`npm-audit.json`, `source-of-truth-before-after.md`, and
`restored-protections.md`.

## Remaining risks

1. Ten high-severity dependency findings include direct packages `exceljs` and
   `whatsapp-web.js`; available changes require separate compatibility review.
2. Dashboard legacy controls remain for display/import compatibility. Writes
   strip legacy truth and runtime ignores it, but a native typed editor remains
   desirable.
3. Unreachable compatibility prompt code remains after the canonical early
   return in `AIClient`. It is not executable, but should be deleted later to
   reduce maintenance confusion.
4. Maximum-parallel Node tests can crash a Windows test process under resource
   pressure; the test passes alone and the explicit serial full suite is green.
5. Shadow Mode remains intentionally pending user review.

Next gate: review the local branch and dependency decision, then authorize a
separate Shadow Mode phase. Railway remains a later separate approval.
