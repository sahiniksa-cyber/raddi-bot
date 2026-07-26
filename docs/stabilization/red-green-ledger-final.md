# Stabilization RED/GREEN final ledger

## Canonical authority and gateway

These suites were written RED before their production implementation and are
now GREEN:

- policy schema, compiler, derived version, migration and rollback;
- product-bound facts, current-turn relevance and safe fallback;
- mandatory policyVersion and fresh-policy-at-send;
- policy/scope/audit/reservation/validation failure with zero transport calls;
- direct transport and optional authorization-switch architecture scans;
- manual, campaign, alert, handoff, main reply, LID and quota sender contracts;
- original, modified, authorized, blocked and sent audit stages.

## Selective `70f9fd1` restoration

Behavioral RED cases recovered without restoring old LLM authority:

- fully removed forbidden prose was restored by the sanitizer;
- cross-product facts required product-bound evidence;
- an authorized stale topic could not answer the current turn;
- invented phone/general-advice output required contact and relevance rejection.

## Concurrency and failure

- 25 simultaneous attempts for one key: one transport call;
- 20 customers across four tenants: no scope crossover;
- duplicate webhook and job: one provider send;
- pre-network failure becomes retryable;
- ambiguous provider failure becomes unknown/held;
- stale policy is blocked before reservation/network;
- scope, policy DB, reservation, audit and state failures yield zero sends.

## Simulation, mutation and full suite

- seed `20260726`;
- 10,000 offline asserted sequences;
- 12 critical cases covered 833 or 834 times each;
- 12/12 critical source mutants killed, zero survivors;
- serial full suite: 1,575 tests, 1,575 passed, 0 failed;
- full-suite duration: 95,567.9422 ms.

The default maximum-parallel Windows run crashed one startup test process under
resource pressure. That file passed 3/3 alone; the retained full evidence uses
explicit serial execution.
