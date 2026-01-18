# Email (SMTP) Configuration

The onboarding flow emails tokens to clients via Nodemailer. Configure SMTP credentials that allow the API to relay messages reliably.

## Required Environment Variables
- `SMTP_HOST` — SMTP server hostname.
- `SMTP_PORT` — Port number (`587` for STARTTLS, `465` for SMTPS).
- `SMTP_USER` — Username or login email.
- `SMTP_PASS` — Password or API key.
- `SMTP_FROM` (optional) — Friendly from address; defaults to `SMTP_USER`.

## Setup Steps
1. Provision a dedicated mailbox or transactional email account (e.g., Postmark, SendGrid, Office365 shared mailbox).
2. Enable SMTP/IMAP access if required by the provider and note the TLS requirements.
3. Populate `.env` using the credentials. Example for Mailgun SMTP relay:
   ```env
   SMTP_HOST=smtp.mailgun.org
   SMTP_PORT=587
   SMTP_USER=postmaster@mg.example.com
   SMTP_PASS=generated-mailgun-password
   SMTP_FROM="DFWSC Onboarding" <onboarding@example.com>
   ```
4. Restart the server (`npm run dev`) so the new credentials are loaded.

## Testing
- Run a smoke test with MailHog or Mailpit by pointing `SMTP_HOST` to the local test server (usually `localhost`, port `1025`).
- Call the onboarding route and confirm the email is delivered:
  ```bash
  curl -X POST http://localhost:4242/connect/onboard \
    -H 'Content-Type: application/json' \
    -H 'Idempotency-Key: smtp-test' \
    -H 'x-api-role: admin' \
    -d '{"clientId":"smtp_test","name":"SMTP Demo","email":"demo@example.com"}'
  ```
- Inspect the SMTP logs or MailHog UI to verify the message payload.

## Troubleshooting
- **TLS errors**: confirm the port and protocol; some providers require `secure: true` (port 465) while others expect STARTTLS (port 587).
- **Authentication failures**: rotate app-specific passwords or API tokens—some providers block basic auth by default.
- **Spam filtering**: configure SPF/DKIM/DMARC for the sending domain to keep onboarding emails out of spam folders.

## Template Ownership
- Onboarding email copy is controlled in the backend mailer helper; update text/HTML there when branding changes.
- Keep subject lines and sender names aligned with your Stripe Connect onboarding brand settings.
