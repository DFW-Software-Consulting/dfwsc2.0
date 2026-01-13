# Secure Environment Sharing (Nextcloud E2EE)

When multiple teams need access to `.env` files, store them in a Nextcloud folder protected by end-to-end encryption (E2EE). This keeps Stripe keys and database credentials off of email or chat.

## Prerequisites
- Nextcloud server with the **End-to-End Encryption** app enabled.
- Desktop or mobile clients that support encrypted folders.

## Workflow
1. **Create an encrypted folder** in the Nextcloud client (e.g., `stripe-payment-portal-secrets`).
2. **Upload the `.env` file** (or a `env.<environment>.enc` variant) into the encrypted folder.
3. **Share the folder** with team members that require access. Ensure they authenticate with hardware tokens or strong MFA.
4. **Document version history**: include a `README.md` in the folder noting who updated the credentials and when.
5. **Rotate keys periodically**—set calendar reminders to refresh Stripe and SMTP credentials, then update the stored `.env` file.

## Retrieval Tips
- Always download and edit the file through the encrypted client; the web UI may not expose plaintext when E2EE is enabled.
- After pulling the latest file, copy it to your local project root as `.env` and restart the server (`npm run dev`).
- Avoid syncing the encrypted folder directly into the project workspace to prevent accidental commits.

## Incident Response
- If a device is compromised, revoke its Nextcloud session and rotate all secrets stored in the encrypted folder.
- Update the documentation changelog noting when new secrets were distributed.
