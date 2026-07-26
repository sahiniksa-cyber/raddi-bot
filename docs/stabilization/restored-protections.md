# Protections selectively restored around `70f9fd1`

- prohibited prose cannot reappear when the whole reply is removed;
- internal handoff markers are protected during formatting but cannot be
  invented as authorization by an LLM;
- contact numbers require exact canonical routing evidence;
- prices, durations, availability, compatibility, warranties, URLs, discounts,
  delivery, refunds and promises are bound to the focused product, variant or
  stable rule;
- prior-topic evidence cannot answer an unrelated current turn;
- invented wrong-number/helpdesk advice is blocked;
- handoff uses stable contacts and an idempotent notification;
- advisory reviewer metadata cannot force a false handoff;
- missing facts yield safe non-commercial clarification, never a guess;
- semantic duplicate protection remains deterministic.

Intentionally not restored: LLM confidence as authority, keyword-only handoff,
free-form product parsing, reviewer-created transfer markers, or stale cached
policy authorization.
