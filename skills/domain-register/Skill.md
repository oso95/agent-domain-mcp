---
name: domain-register
description: Register a new domain name. Use when the user wants to purchase a domain. Requires domain-suite-mcp with Porkbun, Namecheap, or GoDaddy configured.
---

Register the domain $ARGUMENTS using the domain-suite-mcp server.

## Steps

1. Call `list_providers` to see which providers support registration. If none do, tell the user which providers to configure and stop.

2. Check availability first (call `check_availability`) unless the user has already confirmed the domain is available.

3. Collect required information if not already provided:
   - **Registrant contact**: firstName, lastName, email, phone (format: +1.5555555555), address1, city, state, postalCode, country (2-letter ISO)
   - **Provider**: which registrar to use (default to the first configured provider that supports registration)
   - **Years**: registration period (default: 1)
   - **Privacy protection**: WHOIS privacy (default: true — strongly recommend keeping enabled)
   - **Auto-renew**: whether to auto-renew on expiry (ask the user)

4. Confirm the details with the user before proceeding — registration is a paid, irreversible action.

5. Call `register_domain` with all collected fields.

6. On success, offer to:
   - Configure DNS records (suggest `/domain-dns-setup`)
   - Set up email authentication (suggest `/domain-email-setup`)

## Notes
- Porkbun registration requires: verified email, verified phone, account credit, and at least one previously registered domain
- GoDaddy registration requires Domain Pro plan or 10+ existing domains for DNS write access
- If the call fails with `AUTH_FAILED` or similar, check environment variables with `list_providers`
