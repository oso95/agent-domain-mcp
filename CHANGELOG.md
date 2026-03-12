# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-03-11

### Added

- 21 MCP tools for domain and DNS management
- Four provider integrations: Porkbun, Namecheap, GoDaddy, Cloudflare
- Zero-config domain availability checking via RDAP → public → WHOIS fallback chain
- Email setup tools: `setup_spf`, `setup_dkim`, `setup_dmarc`, `setup_mx` with mail provider templates
- SSL certificate management for Porkbun (full) and Cloudflare (list/status)
- Domain transfer tools: `transfer_domain_in`, `get_transfer_status`
- WHOIS contact management for Namecheap and GoDaddy
- `setup_dkim` `keyType` parameter supporting `rsa` (default) and `ed25519`
- SPF/DKIM/DMARC tools are idempotent: update existing records in place, return `previous` value when overwriting
- `delete_dns_record` returns `{ success, id, domain }` confirmation
- Namecheap sandbox support via `NAMECHEAP_SANDBOX=true`
- GoDaddy OTE sandbox support via `GODADDY_SANDBOX=true`
- Structured `AgentError` with `code`, `message`, `action`, `provider`, `raw` fields
- All errors include actionable next steps for agents
- Rate-limit handling: Bottleneck for Porkbun, automatic retry with `Retry-After` for GoDaddy
- Namecheap IP auto-detection with public API fallback
- Cloudflare DNS write note: warns about O(N) zone-ID lookup for large accounts
- 161 unit tests across 13 test files
- Integration smoke test against real Porkbun and Namecheap sandbox APIs

[0.1.0]: https://github.com/oso95/domain-suite-mcp/releases/tag/v0.1.0
