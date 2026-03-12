---
name: domain-full-setup
description: End-to-end domain setup: check availability, register, configure DNS, and set up email. Use when launching a new project needing everything from scratch. Requires domain-suite-mcp.
---

Run a complete domain setup for $ARGUMENTS using the domain-suite-mcp server.

This skill walks through the full setup pipeline. Each phase is confirmed before proceeding.

## Phase 1 — Check & Register

1. Call `list_providers` to see what's configured.
2. Call `check_availability` for the domain across common TLDs.
3. Present availability and pricing. Let the user pick their preferred domain.
4. Collect registrant contact information.
5. Confirm with the user before registering (paid, irreversible).
6. Call `register_domain`.

## Phase 2 — DNS Setup

7. Ask for the server IP address or hosting target (Vercel, Netlify, Render, etc.).
8. Call `create_dns_record` for:
   - A/CNAME @ → <target>
   - CNAME www → @ (or separate A record)
9. Ask if any subdomains are needed (api., staging., etc.) and create them.

## Phase 3 — Email Setup

10. Ask which mail provider they're using (Google Workspace, Resend, SendGrid, etc.). Skip if none.
11. Run in order:
    - `setup_mx` with the mail provider template
    - `setup_spf` with the mail provider template
    - `setup_dkim` — ask for selector and public key (explain where to find them)
    - `setup_dmarc` — start with `policy: none`, ask for report email

## Phase 4 — Summary

12. Call `list_dns_records` to show the complete final DNS state.
13. Provide a checklist of next steps:
    - [ ] DNS propagation (check with `dig` or dnschecker.org)
    - [ ] Verify DKIM in mail provider dashboard
    - [ ] Test email deliverability (mail-tester.com)
    - [ ] Escalate DMARC policy to `quarantine` then `reject` after confirming deliverability
    - [ ] Set up SSL certificate if needed (`create_certificate`)

## Notes
- Each phase can be skipped if the user already completed it
- All email tools are idempotent — safe to re-run
- For a Porkbun/Cloudflare split setup: register on Porkbun, then point nameservers to Cloudflare before doing DNS/email steps
