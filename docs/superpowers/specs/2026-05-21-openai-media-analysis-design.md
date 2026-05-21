# OpenAI Media Analysis Design

## Goal

Enable WhatsApp customers to send images or voice notes and receive one natural reply, while keeping the platform's existing AI model choice for normal conversation. OpenAI is the fixed media-analysis provider.

## Scope

- Analyze inbound WhatsApp images and audio through OpenAI only.
- Keep text conversation replies on the customer's selected model: OpenAI, Gemini, Claude, or OpenRouter.
- Combine rapid consecutive inbound messages from the same customer into one AI reply.
- Let each escalation contact define how the team notification should be written.
- Improve bot start feedback when the first start request is still connecting, waiting for QR, or held by a deployment lock.

## Architecture

### Media Extraction

WhatsApp adapters will normalize inbound media into a safe object:

- `kind`: `image` or `audio`
- `mimeType`: original MIME type when available
- `data`: base64 media bytes
- `caption`: optional customer text or image caption
- `sizeBytes`: decoded media size estimate

The ingestion layer will reject unsupported or oversized media gracefully. Oversized media will not be sent to OpenAI; the bot will ask the customer to send a smaller file or describe what they need.

### OpenAI Media Analysis

A new media-analysis module will use OpenAI for:

- Image understanding from base64 image input.
- Audio transcription from base64 audio input.

The output is plain text inserted into the existing conversation flow. Example:

`[صورة من العميل: يظهر في الصورة منتج مكسور...]`

or:

`[رسالة صوتية من العميل: العميل يسأل عن سعر الاشتراك...]`

This keeps the rest of the AI reply path stable and provider-agnostic.

### Message Batching

The AI queue will use a per-conversation debounce key instead of one isolated AI job per inbound message. When a customer sends several messages quickly, newer messages replace the pending AI job and delay it slightly. The worker then loads all unhandled inbound messages since the last assistant reply and asks the AI to answer all of them in one response.

### Escalation Template

Each escalation contact may include `messageTemplate`. If present, the notification builder fills these variables:

- `{{contactName}}`
- `{{contactRole}}`
- `{{customerPhone}}`
- `{{customerMessage}}`
- `{{summary}}`

If no template exists, the current default notification format remains unchanged.

### Start Feedback

The start endpoint will return a clearer message for non-error states:

- `qr_ready`: scan the QR.
- `connecting` or `waiting_qr`: wait and refresh, or press restart if it remains stuck.
- lock held by another instance: wait a few seconds and press start again.

The dashboard can show this directly without changing the underlying connection model.

## Error Handling

- Missing OpenAI key for media: skip media analysis and ask the customer for text clarification.
- Unsupported media type: reply with a friendly clarification request.
- OpenAI failure: mark the inbound message with media error metadata and continue without crashing the worker.
- Empty transcript or image description: ask a short follow-up question.

## Testing

Add focused tests for:

- Media normalization and size/type guards.
- OpenAI media prompt payload construction using a fake OpenAI client.
- AI worker batching query behavior.
- Escalation notification templates.
- Start endpoint feedback messages.

## Operational Notes

Media analysis is not free. It consumes OpenAI API usage. The implementation must include limits and must avoid storing large media indefinitely.
