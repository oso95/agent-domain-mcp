# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Webnic provider**: full domain lifecycle (query, register, renew, transfer-in) plus DNS records CRUD (A/AAAA/CNAME/MX/TXT/SRV) and read-only WHOIS contact
- Sandbox/OTE support via `WEBNIC_SANDBOX=true`
- JWT token caching with automatic refresh on 401
- Pricing enrichment for `check_availability` via WebNIC extension pricing API
- **Webnic SSL (read-only)** wired against the WebNIC SSL Restful v2 API: `list_certificates` (search by common name), `get_certificate_status` (full order info), with full lifecycle status mapping (pending / active / expired / failed). `create_certificate` surfaces `SSL_CSR_REQUIRED` because the MCP interface does not yet carry a CSR — place orders via the WebNIC portal, then track them via the MCP. Certificate IDs are formatted `webnic-ssl-<orderId>`.
- 34 unit tests covering provider mapping, client auth flow and error translation
- **DNSSEC support**: three new MCP tools (`get_dnssec`, `enable_dnssec`, `disable_dnssec`) wired against Cloudflare (zone-side) and Webnic (registry-side DS + zone-side signing). Aggregated `DnssecStatus` reports the active scope (`registry` / `zone` / `both` / `none`). Cloudflare signs the zone itself and returns the DS the caller must publish at the registrar; Webnic accepts user-supplied DS records to publish at the parent registry, or activates zone-side signing when called without DS. 16 unit tests cover both providers.
- **`update_nameservers` MCP tool**: change registrar-level nameservers (parent zone delegation). Distinct from DNS records — rewrites what the registry advertises for the domain.
- Wired in Porkbun (`/domain/updateNs`), Namecheap (`domains.dns.setCustom`), GoDaddy (`PATCH /v1/domains/{name}`), and Webnic (`PUT /domain/v2/dns`). Cloudflare returns `FEATURE_NOT_SUPPORTED` (it's a DNS host, not a registrar).
- New `Feature.NameserverWrite` capability flag
- **Webnic auto-unlock**: `update_nameservers` now transparently toggles a domain out of `name_protected` / `transfer_protected` for the duration of the API call, then re-locks it to `name_protected` (the strictest level — and WebNIC's default for newly-registered domains) in a `finally` block, even if the op throws. No configuration required. Restore failures log to stderr (out of band from MCP stdio) and never mask the original error. 5 new unit tests cover the lifecycle including the throw-then-restore guarantee.
- **Extended DNS record types** (verified live against both basic and Premium WebNIC zones, 2026-05): the cross-provider `DNSRecord.type` union and the `create_dns_record` / `update_dns_record` MCP schemas now accept 22 record types — A, AAAA, CNAME, MX, TXT, NS, SRV, CAA, ALIAS, HTTPS, SVCB, TLSA, PTR, SSHFP, NAPTR, SOA, DS, CDS, CDNSKEY, CERT, LOC, SMIMEA, URI. Webnic accepts the full catalog except NS (= `update_nameservers`) and DNSKEY (managed via the zone DNSSEC endpoints). The other providers (Porkbun / Namecheap / GoDaddy / Cloudflare) forward the type to their respective APIs unchanged.

[Unreleased]: https://github.com/oso95/domain-suite-mcp/compare/v0.1.0...HEAD

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
