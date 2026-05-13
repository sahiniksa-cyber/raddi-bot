# Billing Checkout Design

## Goal

Add a reusable billing system for Raddi and future projects. A customer must buy platform access once before using the dashboard. The default upfront access price is 1750 SAR. Message cost is shown as a usage note only, not as a plan or token package.

## Recommended Provider

Use Moyasar first. It supports Saudi payment methods including cards and Apple Pay, has a Payments API, supports webhooks, and provides card tokenization so we never store raw card data. The system will keep provider logic behind a small adapter so a future provider can replace Moyasar without rewriting the dashboard.

Sources checked:
- https://docs.moyasar.com/category/payments-api
- https://docs.moyasar.com/guides/references/tokenization/
- https://help.moyasar.com/en/article/moyasar-dashboard-webhooks-44p8en/
- https://help.moyasar.com/en/article/moyasar-dashboard-apple-pay-domain-registration-h9nawo/

## User Experience

Unauthenticated users keep the current login flow. Authenticated users without active platform access are redirected from `/` to `/billing`.

The billing page shows:
- Platform access purchase: 1750 SAR upfront.
- Apple Pay button when available.
- Card payment form.
- Optional automatic renewal toggle for future monthly message charges.
- Clear usage note: messages may be charged monthly per message according to the configured message price.
- Activation code field for admin/free access.

No UI copy should call the monthly usage charge a token package or a subscription plan.

## Admin Configuration

Use environment defaults first:
- `PLATFORM_ACCESS_PRICE_HALALAS=175000`
- `MESSAGE_PRICE_HALALAS=0` until the owner sets the real value.
- `BILLING_CURRENCY=SAR`
- `ADMIN_ACTIVATION_CODES` as comma-separated one-time or reusable codes for manual/free access.

Later we can add a small admin page for editing these values; the first production-safe version can use environment variables and database records.

## Data Model

Add database tables:
- `billing_accounts`: one row per user, with access status, activation source, current message price, auto-renew preference, and provider customer reference.
- `billing_payments`: each payment attempt and result, including provider payment id, amount, currency, status, method, and raw provider payload.
- `billing_payment_methods`: tokenized cards only, never raw card data.
- `billing_events`: webhook and internal billing audit log.
- `billing_excel_exports`: optional metadata about the last Excel write.

Dashboard access is granted when `billing_accounts.platform_access_status = 'active'`.

## Excel Ledger

The database is the source of truth. After a successful payment or free activation, the server appends a row to an Excel workbook under persistent storage:

`<DATA_DIR>/billing/payments-ledger.xlsx`

Rows include:
- Date/time
- User name
- User email
- Amount
- Currency
- Payment method
- Provider payment id
- Status
- Activation type: paid, free_code, admin_manual

If writing Excel fails, platform access still follows the database payment state, and the failure is logged to `billing_events` for retry. This avoids blocking customers because of a reporting-file issue.

## Payment Flow

1. User opens `/billing`.
2. Server returns public billing settings and current billing state.
3. User chooses Apple Pay or card.
4. Server creates a payment intent/session through the provider adapter.
5. Moyasar confirms payment through redirect/webhook.
6. Webhook updates `billing_payments` and activates `billing_accounts`.
7. Excel ledger row is appended.
8. User is redirected to `/`.

For automatic renewal of message charges, saved cards use Moyasar tokenization. Apple Pay is used for the upfront payment where available; recurring usage charges rely on tokenized cards unless Moyasar confirms Apple Pay recurring support for the live merchant setup.

## Activation Codes

Activation codes allow the owner to grant access without payment. The code flow:
- User enters code on `/billing`.
- Server validates code against environment/database.
- If valid, `billing_accounts.platform_access_status` becomes `active`.
- `billing_payments` gets a zero-amount record with status `free_activated`.
- Excel ledger receives a free activation row.

This supports owner access, test accounts, and free customer access without bypassing audit history.

## Security

- Never store full card numbers or CVV.
- Store only provider token/customer/payment ids.
- Validate Moyasar webhook signatures or shared secret if available in the selected webhook configuration.
- Billing endpoints require login except public provider callback/webhook endpoints.
- Dashboard routes check billing state before serving `/`.

## Testing

Add tests for:
- Access gating redirects unpaid users to `/billing`.
- Paid or free activated users can open `/`.
- Billing price settings parse correctly.
- Activation code creates active access and audit rows.
- Webhook success activates platform access.
- Excel ledger write is called after successful payment and free activation.
- Excel write failure does not revoke access.

