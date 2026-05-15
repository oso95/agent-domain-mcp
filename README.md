# domain-suite-mcp

> MCP server for AI agents to autonomously manage domains and DNS — without human intervention.

[![npm version](https://img.shields.io/npm/v/domain-suite-mcp.svg)](https://www.npmjs.com/package/domain-suite-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-195%20passing-brightgreen.svg)](tests)

`domain-suite-mcp` is an open-source [MCP](https://modelcontextprotocol.io) server written in TypeScript that enables AI agents to autonomously manage domains and DNS without human intervention. It acts as a unified abstraction layer over multiple domain registrar and DNS provider APIs, exposing a consistent set of 21 MCP tools that any MCP-compatible agent can call.

AI agents can now build and deploy full applications end-to-end — writing code, provisioning infrastructure, pushing to production. The remaining gap in the autonomous shipping pipeline is domain and DNS management. `domain-suite-mcp` eliminates that gap.

An agent can now complete the full domain lifecycle without human intervention:

```
check availability → register → configure DNS → provision SSL → set up email
```

<a href="https://glama.ai/mcp/servers/oso95/domain-suite-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/oso95/domain-suite-mcp/badge" alt="domain-suite-mcp MCP server" />
</a>

---

## Quick Start

**No installation required.** Domain availability checking works immediately with zero configuration via public RDAP/WHOIS protocols.

```bash
npx domain-suite-mcp
```

Add provider credentials via environment variables to enable registration, DNS management, SSL, and more.

### Install globally

```bash
npm install -g domain-suite-mcp
domain-suite-mcp
```

### Install Claude Code skills

Install five pre-built skills (`/domain-check`, `/domain-register`, `/domain-dns-setup`, `/domain-email-setup`, `/domain-full-setup`) into your Claude Code setup:

```bash
npx domain-suite-mcp install
```

This copies the skills to `~/.claude/skills/`. Restart Claude Code to activate them.

### Print MCP client config

```bash
npx domain-suite-mcp config
```

Prints the ready-to-paste JSON snippet for Claude Desktop, Cursor, Windsurf, or any MCP client.

---

## Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "domain": {
      "command": "npx",
      "args": ["-y", "domain-suite-mcp"],
      "env": {
        "PORKBUN_API_KEY": "pk1_...",
        "PORKBUN_SECRET_API_KEY": "sk1_..."
      }
    }
  }
}
```

### Cursor / Windsurf / Kiro

Add to your MCP settings (varies by client):

```json
{
  "command": "npx",
  "args": ["-y", "domain-suite-mcp"],
  "env": {
    "PORKBUN_API_KEY": "pk1_...",
    "PORKBUN_SECRET_API_KEY": "sk1_..."
  }
}
```

### Claude Code

Install the skills, then add the MCP server to your project settings:

```bash
npx domain-suite-mcp install    # installs /domain-* skills to ~/.claude/skills/
npx domain-suite-mcp config     # prints the MCP server config to add
```

Once configured, you can invoke skills directly in Claude Code:

```
/domain-check myapp.com io,dev
/domain-register myapp.com
/domain-email-setup myapp.com google
/domain-full-setup myapp.com
```

See [docs/SKILLS.md](docs/SKILLS.md) for full workflow patterns and prompt templates.

---

## Provider Support

| Feature | Porkbun | Namecheap | GoDaddy | Cloudflare | Webnic |
|---|---|---|---|---|---|
| Domain availability check | Yes | Yes | Yes | Yes | Yes |
| Domain registration | Yes | Yes | Yes | Enterprise only | Yes† |
| Domain renewal | Yes | Yes | Yes | Enterprise only | Yes |
| DNS record CRUD | Yes | Yes | Yes* | Yes | Yes‡ |
| Registrar nameserver update | Yes | Yes | Yes | No (DNS host only) | Yes |
| SSL certificate management | Yes (full) | No | No | List/status only | Read-only◆ |
| WHOIS contact management | No | Yes | Yes | Enterprise only | Read-only |
| Domain transfer (inbound) | Yes | Yes | Yes | No | Yes† |
| Pricing via API | Yes | Yes | Yes | No | Yes |
| DNSSEC management | No** | Dashboard only | No** | Yes§ | Yes¶ |
| Sandbox / test environment | Yes | Yes | Yes | No | Yes (OTE) |

\* GoDaddy DNS management requires 10+ active domains or Domain Pro plan (~$240/yr).
† Webnic registration and transfer require a pre-created contact handle and registrant user ID (see [docs/PROVIDERS.md](docs/PROVIDERS.md#webnic)).
‡ Webnic DNS supports 22 record types (A/AAAA/CNAME/MX/TXT/SRV/CAA/ALIAS/HTTPS/SVCB/TLSA/SMIMEA/DS/CDS/CDNSKEY/PTR/SSHFP/NAPTR/SOA/CERT/LOC/URI). NS = `update_nameservers` (registrar-level). DNSKEY via the zone DNSSEC tool.
§ Cloudflare DNSSEC is zone-side only: Cloudflare signs the zone and returns the DS for the caller to publish at their registrar.
¶ Webnic DNSSEC covers both registry-side (DS records at the parent) and zone-side (Webnic-hosted authoritative DNS) layers.
\*\* Porkbun and GoDaddy expose DNSSEC via API but are not yet wired in this MCP — see open PRs / roadmap. Namecheap's public API does not expose DNSSEC at all (verified 2026-05): configure via dashboard.
◆ Webnic SSL exposes `list_certificates` and `get_certificate_status` against the WebNIC SSL Restful v2 API. `create_certificate` requires a CSR up-front and DCV validation — place orders via the WebNIC portal, then track them via the MCP.

**Recommended setup:** Register on Porkbun or Namecheap, then point nameservers to Cloudflare for DNS. Best of both: easy registration + Cloudflare's fast DNS API.

---

## Environment Variables

### Porkbun

```bash
PORKBUN_API_KEY=pk1_...
PORKBUN_SECRET_API_KEY=sk1_...
```

### Namecheap

```bash
NAMECHEAP_API_KEY=...
NAMECHEAP_API_USER=your_username
NAMECHEAP_CLIENT_IP=...   # optional; auto-detected if not set
NAMECHEAP_SANDBOX=true    # optional; use sandbox environment
```

Your server IP must be whitelisted in Namecheap under **Profile → Tools → API Access → Whitelisted IPs** before any call will work.

### GoDaddy

```bash
GODADDY_API_KEY=...
GODADDY_API_SECRET=...
GODADDY_SANDBOX=true   # optional; use OTE environment
```

### Cloudflare

```bash
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_ACCOUNT_ID=...   # optional
```

### Webnic

```bash
WEBNIC_USERNAME=your_api_user
WEBNIC_PASSWORD=your_api_secret
WEBNIC_SANDBOX=true                       # optional; use OTE environment
WEBNIC_DEFAULT_CONTACT_ID=WN964984T       # required for register/transfer
WEBNIC_DEFAULT_REGISTRANT_USER_ID=REG100015  # required for register/transfer
WEBNIC_DEFAULT_NAMESERVERS=ns1.web.cc,ns2.web.cc  # optional; defaults shown
```

WebNIC blocks registry-side writes (nameservers, transfers, contact updates) when the domain status is `name_protected` or `transfer_protected`. The provider auto-unlocks the domain, performs the write, then re-locks to `name_protected` (the strictest level — and WebNIC's default for newly-registered domains). No configuration needed.

Your IP must be on the WebNIC authorized access list (separate per environment: production vs OTE).

---

## Tools

| Tool | Description |
|---|---|
| `list_providers` | List configured providers and their capabilities |
| `check_availability` | Check if a domain is available — works with zero configuration |
| `list_domains` | List all domains across configured providers |
| `get_domain` | Get details for a specific domain |
| `register_domain` | Register a new domain |
| `renew_domain` | Renew an existing domain |
| `update_nameservers` | Change the registrar-level nameservers (parent zone delegation) |
| `list_dns_records` | List all DNS records for a domain |
| `create_dns_record` | Create a new DNS record |
| `update_dns_record` | Update an existing DNS record (full replacement) |
| `delete_dns_record` | Delete a DNS record |
| `list_certificates` | List SSL certificates for a domain |
| `create_certificate` | Provision a new SSL certificate |
| `get_certificate_status` | Get the status of a certificate |
| `setup_spf` | Add SPF record with mail provider template (Google, Resend, SendGrid, Mailgun, SES, Postmark) |
| `setup_dkim` | Add DKIM record — supports RSA and Ed25519, idempotent |
| `setup_dmarc` | Add DMARC policy record, idempotent |
| `setup_mx` | Configure MX records with mail provider template |
| `transfer_domain_in` | Initiate inbound domain transfer |
| `get_transfer_status` | Check status of a pending transfer |
| `get_whois_contact` | Get WHOIS contact info for a domain |
| `update_whois_contact` | Update WHOIS contact info for a domain |

Full tool reference with schemas and examples: [docs/TOOLS.md](docs/TOOLS.md)

---

## Designed for AI Agents

Every error message tells the agent what went wrong, why, and exactly what to do next. No raw API error codes, no cryptic status numbers.

```
[IP_NOT_WHITELISTED] namecheap: Namecheap API authentication failed. Your server's IP
address must be whitelisted in your Namecheap account under Profile → Tools → API Access
→ Whitelisted IPs. → Log in to Namecheap and add your current IP address to the whitelist.
```

Format: `[ERROR_CODE] provider: what went wrong → what to do`

The server is fully stateless — no database, no persistent auth, no server to manage. Every call fetches fresh data directly from the provider API.

---

## Documentation

| Document | Description |
|---|---|
| [docs/TOOLS.md](docs/TOOLS.md) | Complete tool reference with schemas |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Provider setup guides and known limitations |
| [docs/SKILLS.md](docs/SKILLS.md) | Agent workflow patterns and prompt templates |
| [CHANGELOG.md](CHANGELOG.md) | Version history |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Contribution guide |

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and pull request guidelines.

```bash
git clone https://github.com/oso95/domain-suite-mcp.git
cd domain-suite-mcp
npm install && npm test
```

---

## License

[MIT](LICENSE)