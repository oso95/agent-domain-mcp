---
name: domain-check
description: Check domain availability and pricing across TLDs. Use when the user asks if a domain is available, wants to find a domain name, or wants to compare TLD options. Requires domain-suite-mcp.
---

Check domain availability for $ARGUMENTS using the domain-suite-mcp server.

## Steps

1. Call `list_providers` to see which providers are configured and what pricing sources are available.

2. Parse the input:
   - If a full domain is given (e.g. `myapp.com`), split into name + TLD
   - If a name only (e.g. `myapp`), check `.com`, `.io`, `.dev`, `.co` by default
   - If TLDs are specified (e.g. `myapp com,io,net`), use those

3. Call `check_availability` with the domain name, tlds array, and provider (use the first configured provider that supports pricing, if any).

4. Present results in a clear table:
   - Domain | Available | Price (reg) | Price (renewal) | Source
   - Highlight available domains
   - If no provider is configured, note that pricing requires API credentials

5. If any domains are available and the user seems interested in registering, ask if they'd like to proceed and suggest using `/domain-register`.

## Notes
- `check_availability` works with zero configuration via RDAP/WHOIS — no API key needed for availability
- Pricing is only returned when a provider (Porkbun, Namecheap, GoDaddy) is configured
- For premium domains the `premium` field will be true — warn the user, prices may be much higher
