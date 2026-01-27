# src/lib/mailer.ts

## Purpose
Provides a cached Nodemailer transporter plus helper functions for sending onboarding token emails and clearing the cache during tests.

## Dependencies
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` — **required**. The module throws if any are missing or invalid.
- `SMTP_FROM` — optional override for the `from` address (falls back to `SMTP_USER`).

## Key Functions
- `createTransport()` — validates SMTP env vars, infers TLS (`secure`) from the port, and returns a Nodemailer transporter.
- `sendMail(payload)` — resolves (and caches) the transporter, then sends the email with text + optional HTML body.
- `clearTransporterCache()` — resets the cached transporter; mainly used by tests.

## Example Usage
```ts
import { sendMail } from '../lib/mailer';

await sendMail({
  to: 'client@example.com',
  subject: 'Complete your Stripe onboarding',
  text: 'Visit the portal and enter your token.',
});
```

## Testing & Debugging Notes
- Use `clearTransporterCache()` in Vitest `afterEach` hooks to avoid cross-test state.
- Run `SMTP_PORT=1025` with tools like MailHog or Mailpit during development to inspect outgoing emails locally.
- If you encounter TLS errors, confirm the chosen port matches your SMTP provider (e.g., 465 for SMTPS, 587 for STARTTLS).
