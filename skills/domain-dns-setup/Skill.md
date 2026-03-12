---
name: domain-dns-setup
description: Configure DNS records (A, CNAME, TXT) for a domain. Use when pointing a domain at a server, CDN, or hosting provider. Requires domain-suite-mcp with a DNS-capable provider configured.
---

Configure DNS records for $ARGUMENTS using the domain-suite-mcp server.

## Steps

1. Call `list_providers` to see which providers support DNS writes (`dns_write`). If none do, tell the user and stop.

2. Call `list_dns_records` for the domain to see what currently exists.

3. Ask the user what they need to set up if not already specified. Common patterns:

   **Point domain to a server IP:**
   - `create_dns_record` → type: A, name: @, content: <ip>
   - `create_dns_record` → type: A, name: www, content: <ip>  (or CNAME www → @)

   **Point to a CDN/hosting service (e.g. Vercel, Netlify, Render):**
   - `create_dns_record` → type: CNAME, name: @, content: <cname-target>
   - `create_dns_record` → type: CNAME, name: www, content: <cname-target>
   - Note: root CNAMEs are not supported by all providers — use ALIAS/ANAME if available, or A record

   **Add a subdomain:**
   - `create_dns_record` → type: CNAME or A, name: <subdomain>, content: <target>

   **Verify domain ownership (TXT record):**
   - `create_dns_record` → type: TXT, name: @ (or as specified by service), content: <verification-value>

4. After creating records, remind the user that DNS propagation takes time (minutes to 48 hours depending on TTL).

## Notes
- Use `update_dns_record` with the record `id` (from `list_dns_records`) to change an existing record
- Use `delete_dns_record` with the record `id` to remove a record
- Namecheap DNS writes cost 2 API calls each (read-modify-write pattern) — this is handled transparently
- Cloudflare DNS is fastest and most generous for rate limits; recommended for high-volume changes
- For email DNS setup, use `/domain-email-setup` instead
