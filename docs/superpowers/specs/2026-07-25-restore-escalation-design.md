# Restore Escalation Without Reverting Conversation Safety

## Goal

Restore the bot's earlier conversational behavior by removing escalation authority
from AI quality reviewers, while preserving tenant isolation, message batching,
idempotency, grounding, duplicate prevention, and the final pre-send review.

## Evidence

The production conversation `1ab14eb6-52e0-4769-9a39-0d4833c35cb3` asked:
`وش المدد المتاحة؟`

The configured Adobe product contains two variants: four months and eight months.
The quality reviewer understood the intent with confidence `0.95`, but returned
`needs_human` with `unsupported_information`. The pipeline replaced the useful
answer with a handoff acknowledgement. Because the merchant had
`escalationPausesBot=true` for 30 minutes, the pause was set before the delayed
customer acknowledgement was sent, and the outgoing owner-pause guard canceled
that acknowledgement.

## Root Cause

Commit `5d83a2e` coupled reply review and escalation routing:

- Reviewer decisions (`escalate` and `needs_human`) became mandatory handoffs.
- Reviewer confidence below a threshold became a mandatory handoff.
- A deterministic unsupported-information result became a mandatory handoff.
- The escalation pause could become active before the customer-facing
  acknowledgement was delivered.

The later commits added exceptions for individual false-positive cases, but the
coupling remained.

## Target Behavior

### Reply quality

Quality reviewers may pass, repair, clarify, or suppress a duplicate. They may
record confidence and diagnostic metadata, but they must not create an escalation
marker or replace a useful reply with a generic handoff.

Every customer question is classified into exactly one evidence basis:

1. `general_conversation`: greetings, explanations of ordinary words, and other
   general conversation that needs no merchant fact. Answer naturally.
2. `natural_low_risk_inference`: an ordinary consequence inherent in the
   product or service category whose answer does not create a material
   commercial promise. For example, ordinary exterior car washing includes
   washing the exterior mirrors. Answer naturally even when the merchant prompt
   does not enumerate that component.
3. `merchant_source`: a store-specific or product-specific fact supported by the
   matched product's complete configured data: name, aliases, variants, prices,
   description, long description, links, or matched merchant policies.
4. `missing_product_fact`: a material product/store fact that is genuinely absent
   from all authorized sources and cannot be safely inferred. This is the only
   missing-information class that may route to a human.

`missing_product_fact` is not sufficient by itself to change routing. A transfer
also requires either an explicit transfer marker already produced by the normal
reply path or a deterministic unsupported-fact finding. This two-signal rule
prevents one reviewer misclassification from hijacking a grounded answer. A
reviewer-added marker that was not present in the draft is removed.

Material commercial facts must never use natural inference. These include price,
discount, availability, subscription duration, warranty, refund terms, delivery
time, contractual coverage, compatibility, financial status, and any promise
that could change the customer's purchase decision.

The deterministic grounding layer covers both hard numeric facts and sensitive
nonnumeric promises. Compatibility subjects, warranty, free delivery, refunds,
premium add-ons, broad coverage, and availability must match authorized product
or merchant evidence. Matching only the broad category is insufficient: support
for one device, add-on, or delivery mode does not authorize another.

If the product or intent is ambiguous, ask one concise clarifying question
without escalation. If the answer is a harmless natural consequence of the
known product category, answer it directly. The absence of an exact sentence in
the merchant prompt is not evidence that the answer is unsupported.

Before declaring a material fact unsupported, the reviewer must inspect all
authorized data for the matched product and merchant. The grounding fallback
must remove unsupported claims. Reviewer uncertainty alone must not transfer a
conversation.

### Escalation

Escalation is triggered only by:

1. An explicit customer request to speak with a human.
2. A genuinely high-risk case such as a refund, compensation, a real payment
   incident, or a confirmed data contradiction that cannot be answered safely
   from the configured sources.
3. An explicit transfer marker deliberately produced by the normal reply path
   under the merchant's configured escalation rules for missing information.

The independent quality reviewers do not invent routing merely because they
return low confidence or misunderstand a grounded product question.

### Pause ordering

When a real escalation occurs, the customer acknowledgement must be delivered
before an optional escalation pause can block later automated replies. A pause
created by that escalation must never cancel its own acknowledgement.

If the normal reply path selected a specific escalation contact, the final
review preserves that contact and summary instead of replacing them with the
first configured contact.

A semantic-review outage returns a marker-free retry response unless the
deterministic grounding layer found an unsupported material claim. Reviewer
availability alone never creates a handoff.

The merchant's configured pause remains supported, but the current merchant
configuration should return to the normal continue-replying behavior
(`escalationPausesBot=false`) after deployment.

## Preserved Safety

The change must not revert or weaken:

- `user_id` / tenant scoping.
- `channel_id`, `customer_id`, and `conversation_id` scoping.
- Batched rapid-message context.
- Database idempotency and unique inbound identifiers.
- Durable send reservation and duplicate suppression.
- Product grounding and unsupported-fact removal.
- Owner manual-reply interruption.

## Test Plan

Add failing regression tests before production changes:

1. A reviewer returning `needs_human` for a grounded Adobe-duration question
   cannot replace the correct answer with a handoff.
2. Low reviewer confidence alone cannot create an escalation.
3. Unsupported information is made honest or clarified without automatic
   escalation.
4. An explicit customer request for a human still escalates.
5. An explicit transfer marker from the normal reply path still routes to the
   configured contact.
6. An escalation pause cannot cancel the customer acknowledgement generated by
   the same escalation.
7. A genuine later owner reply still cancels an in-flight AI reply.
8. The production Adobe variants question returns the configured durations.
9. A car-wash question about washing exterior mirrors is answered normally as a
   low-risk natural inference even when mirrors are not listed in the prompt.
10. A car-wash question about an unlisted warranty, price, or special coating is
    not inferred; it is clarified or transferred according to missing-product
    routing.

Run targeted tests, then the complete test suite before commit and deployment.
