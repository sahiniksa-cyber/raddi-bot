# Source of truth map

## Before

| Concern | Competing sources |
|---|---|
| Products and prices | `config.products`, free-form instructions, auto/learned replies, imports, prompt prose and model inference |
| Persona | free-form instructions, `replyStyle`, platform defaults and hard-coded prompt clauses |
| Reply rules | free-form instructions, style fields, instant/auto replies, learned replies, prompt text, reviewer and post-processing |
| Prohibitions | style avoid lists, instructions, validator heuristics and sanitizer behavior |
| Fact authorization | product helpers, LLM verdicts, legacy validators and optional pre-send wiring |
| Send authorization | producer-specific checks and direct WhatsApp calls |

## After

| Concern | Sole authority |
|---|---|
| Products/prices | validated `merchantPolicy.catalog` |
| Persona | `merchantPolicy.persona` |
| Business/instant rules | `merchantPolicy.businessRules` and `merchantPolicy.instantReplies` |
| Prohibitions | `merchantPolicy.prohibitions` |
| Contacts/handoff | `merchantPolicy.routing` with stable IDs |
| Merchant policy identity | compiler-derived SHA-256 `policyVersion` |
| Platform alerts | code-owned `PLATFORM_REPLY_POLICY` |
| Final authorization | `WhatsAppSendGateway` and deterministic validator |
| Network send | `whatsapp-transport-adapter.js` |

Legacy fields are compatibility/archive input only and cannot authorize an
automated runtime reply. Ambiguous content becomes `needs_review`. Operational
settings such as provider keys, model selection and delays remain ordinary
configuration because they are not merchant reply facts.
