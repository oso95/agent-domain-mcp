---
name: domain-email-setup
description: Set up email authentication (MX, SPF, DKIM, DMARC) for a domain. Use when configuring Google Workspace, Resend, SendGrid, Mailgun, SES, Postmark, or ProtonMail. Requires domain-suite-mcp.
---

Configure email DNS records for $ARGUMENTS using the domain-suite-mcp server.

## Steps

1. Call `list_providers` to find the DNS provider. Call `list_dns_records` for the domain to see what email records already exist.

2. Identify the mail provider if not already specified. Supported templates:
   - `google` (Google Workspace / Gmail)
   - `resend`
   - `sendgrid`
   - `mailgun`
   - `ses` (Amazon SES)
   - `postmark`
   - `protonmail` (MX only)
   - `custom` (user provides their own values)

3. Set up records **in this order** (order matters for testing):

   **Step 1 — MX records** (call `setup_mx`):
   - Uses template for the mail provider
   - Idempotent: skips exchanges already present
   - For custom, ask for exchange hostnames and priorities

   **Step 2 — SPF record** (call `setup_spf`):
   - Uses template for the mail provider
   - Idempotent: updates existing SPF record in place (prevents duplicate SPF per RFC 7208)
   - For custom, ask for the full SPF policy string (must start with `v=spf1`)

   **Step 3 — DKIM record** (call `setup_dkim`):
   - Ask the user for: selector name (e.g. `google`, `mail`, `s1`) and the public key (base64)
   - PEM headers are stripped automatically
   - Supports `keyType: rsa` (default) or `ed25519`
   - Idempotent: updates existing record, returns previous value
   - Skip if the user doesn't have their DKIM key yet (they may need to get it from their mail provider dashboard)

   **Step 4 — DMARC record** (call `setup_dmarc`):
   - Recommend starting with `policy: none` for monitoring (won't reject mail)
   - Ask if the user wants a report email address for aggregate reports
   - Idempotent: updates existing record in place
   - After confirming deliverability, the user can escalate to `quarantine` then `reject`

4. Summarize all records created/updated. Remind the user:
   - DNS propagation takes time
   - DKIM requires publishing the key in their mail provider dashboard first
   - After propagation, use their mail provider's tools to verify DMARC pass

## Notes
- All four tools (setup_mx, setup_spf, setup_dkim, setup_dmarc) are idempotent — safe to run multiple times
- They return a `previous` field when overwriting an existing record so the user can see what changed
- For Resend: selector is typically `resend`, key is provided in Resend dashboard under Domains
- For Google Workspace: selector is `google`, key is in Admin Console → Apps → Gmail → Authenticate email
