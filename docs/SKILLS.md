# Agent Skills

Pre-written prompts and workflow patterns for using `domain-suite-mcp` with AI coding agents.

---

## Enabling the Server

### Claude Code

Add to your project's `CLAUDE.md` or pass as system prompt context:

```
You have access to the domain-suite-mcp MCP server, which provides 21 tools for managing
domains and DNS. Use list_providers first to see which providers are configured and what
they support. Use check_availability to check if a domain is available before registering.
When performing DNS operations, prefer specifying the provider explicitly to avoid an
auto-detection round-trip.
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "domain": {
      "command": "npx",
      "args": ["-y", "domain-suite-mcp"],
      "env": {
        "PORKBUN_API_KEY": "pk1_...",
        "PORKBUN_SECRET_API_KEY": "sk1_...",
        "CLOUDFLARE_API_TOKEN": "..."
      }
    }
  }
}
```

---

## Workflow Patterns

### Register a domain and configure DNS

```
Check if myapp.com is available on Porkbun, then register it for 1 year with privacy
protection, then create an A record pointing @ to 1.2.3.4 and a CNAME pointing www to @.
```

### Full email setup (Google Workspace)

```
For myapp.com using Cloudflare DNS:
1. Set up Google Workspace MX records
2. Add an SPF record for Google
3. Add a DKIM record — selector "google", public key: <paste key>
4. Add a DMARC record with policy "none" and report email dmarc@myapp.com
```

### Migrate a domain to Cloudflare DNS

```
I'm moving myapp.com to Cloudflare for DNS management. The domain is registered on Porkbun.
List the current DNS records from Porkbun, then recreate each one on Cloudflare.
```

### Check availability across multiple TLDs

```
Check if "myapp" is available as .com, .io, .dev, and .co using Porkbun — show pricing for each.
```

### Provision SSL on Porkbun

```
List all SSL certificates for myapp.com on Porkbun. If none exist, provision one.
Then show me the certificate chain and private key.
```

### Inspect and update WHOIS contact

```
Get the current WHOIS contact for myapp.com on Namecheap, then update the email to
admin@myapp.com and phone to +1.4155551234.
```

### Transfer a domain in

```
Initiate an inbound transfer of myapp.com to Porkbun. The auth code is: XXXX-XXXX-XXXX.
Check the transfer status after initiating.
```

---

## Automation Patterns

### In a deployment pipeline

When an agent is deploying a new project end-to-end, domain steps fit naturally into the pipeline:

```
Phase 1: Infrastructure
  - check_availability { domain: "myapp", tlds: ["com", "io"], provider: "porkbun" }
  - register_domain { domain: "myapp.com", provider: "porkbun", contact: {...} }

Phase 2: DNS
  - create_dns_record { domain: "myapp.com", provider: "cloudflare", type: "A", name: "@", content: "<server-ip>" }
  - create_dns_record { domain: "myapp.com", provider: "cloudflare", type: "CNAME", name: "www", content: "@" }

Phase 3: Email
  - setup_mx { domain: "myapp.com", provider: "cloudflare", mailProvider: "google" }
  - setup_spf { domain: "myapp.com", provider: "cloudflare", mailProvider: "google" }
  - setup_dmarc { domain: "myapp.com", provider: "cloudflare", policy: "none", reportEmail: "dmarc@myapp.com" }

Phase 4: SSL
  - create_certificate { domain: "myapp.com", provider: "porkbun" }
```

### Provider resolution

When you don't know which provider holds a domain, omit `provider` from any tool call.
The server will fan out across all configured providers and auto-detect the correct one.
Specifying `provider` explicitly skips this and saves one network round-trip per call.

---

## Error Recovery Patterns

When a tool returns an error, the `action` field tells the agent exactly what to do next.

Common errors and responses:

| Error code | Meaning | Action |
|---|---|---|
| `IP_NOT_WHITELISTED` | Namecheap IP not whitelisted | Add server IP in Namecheap dashboard |
| `AUTH_FAILED` | Invalid API credentials | Check the environment variable values |
| `DOMAIN_NOT_FOUND` | Domain not in this provider | Try a different provider, or omit `provider` to auto-detect |
| `FEATURE_NOT_SUPPORTED` | Provider doesn't support this feature | Use a different provider (see `list_providers`) |
| `RATE_LIMITED` | Too many requests | Wait and retry; server handles backoff automatically on DNS calls |
| `MISSING_PARAMETER` | Required field not supplied | Add the missing field shown in the error |

---

## Tips for Agents

- Call `list_providers` first in any new session to understand what's configured
- Specify `provider` explicitly whenever you know which provider manages a domain
- For email setup: do MX first, then SPF, DKIM, DMARC — order matters for deliverability testing
- SPF, DKIM, and DMARC tools are idempotent: safe to call multiple times, they update in place
- DNS propagation is not instant — the tools confirm the record was created, not that it has propagated
