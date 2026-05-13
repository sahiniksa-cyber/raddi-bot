# Product Sync and Escalation Design

## Goals

- Prevent the AI from saying an available product is unavailable when the product exists in the product fields or owner prompt.
- Make owner escalation send a real WhatsApp notification containing the customer's question/problem and customer number.
- Prepare the platform for official Salla and Zid catalog sync without needing a Chrome extension.

## Design

- Product knowledge is normalized into a small internal catalog built from `config.products` and recognizable product sections inside `botInstructions`.
- AI prompts include a compact product context relevant to the latest customer message, and explicit rules that product fields and owner prompt are the source of truth.
- Escalation jobs use Redis-safe job ids and old queued escalation jobs are requeued with safe ids.
- The owner notification format is concise: customer question/problem, customer number, matched rule/contact, and contact label.
- Product import endpoints expose a safe preview/import path so the dashboard can later connect Salla/Zid OAuth or token flows and store a structured catalog in `config.products`.

## Platform Recommendation

- Use official Salla/Zid API integrations for production sync.
- Use Salla/Zid webhooks for updates after the first full import.
- Do not build a Chrome extension as the primary path; use it only as a fallback/manual helper if a store cannot authorize API access.

## Testing

- Unit tests cover product extraction and matching, prompt product context, escalation notification formatting, and safe escalation job ids.
- Existing WhatsApp connection, delay, memory, and auth preservation tests must continue to pass.
