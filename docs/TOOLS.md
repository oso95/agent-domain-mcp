# Tool Reference

Complete reference for all 21 MCP tools provided by `domain-suite-mcp`.

---

## Provider Tools

### `list_providers`

Returns which providers are currently configured and what each one supports.

**Input:** none

**Output:**
```json
{
  "configured": [
    {
      "name": "porkbun",
      "supports": ["registration", "renewal", "dns_write", "transfer", "ssl", "pricing"],
      "unsupported": ["whois_contact"],
      "notes": ["Porkbun v3 API does not expose WHOIS contact management endpoints. Manage contacts via https://porkbun.com.", "Porkbun supports initiating transfers (transfer_domain_in) but cannot query transfer status (get_transfer_status) via API."]
    },
    {
      "name": "cloudflare",
      "supports": ["dns_write", "ssl"],
      "unsupported": ["registration", "renewal", "transfer", "pricing", "whois_contact"],
      "notes": ["Cloudflare registration requires Enterprise plan. Use as DNS layer only.", "Cloudflare SSL provisioning requires the Advanced Certificate Manager add-on."]
    }
  ],
  "unconfigured": ["namecheap", "godaddy"]
}
```

---

## Availability Tools

### `check_availability`

Check if a domain name is available for registration. **Works with zero configuration** — no API keys needed. Uses RDAP → GoDaddy public → WHOIS fallback chain. If provider credentials are configured, also returns real-time pricing.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name, e.g. `"myapp"` or `"myapp.com"` |
| `tlds` | string[] | no | TLDs to check, e.g. `["com", "io", "dev"]`. Default: `.com` |
| `provider` | string | no | Provider to use for pricing lookup |

**Output:**
```json
{
  "results": [
    {
      "domain": "myapp.com",
      "available": true,
      "premium": false,
      "price": { "registration": 10.99, "renewal": 10.99, "currency": "USD" },
      "priceSource": "porkbun",
      "availabilitySource": "rdap"
    }
  ]
}
```

**Notes:**
- Pricing is only returned when provider credentials are configured
- `availabilitySource` indicates which protocol was used: `rdap`, `public`, `whois`, or `porkbun`/`namecheap` (provider API)

---

## Domain Tools

### `list_domains`

List all domains across all configured providers. If multiple providers are configured, results are aggregated from all of them.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | no | Specific provider to query, or omit for all |

**Output:** `{ "domains": [Domain, ...] }` — when all providers succeed.

`{ "domains": [Domain, ...], "errors": [{ "provider": "godaddy", "error": "[AUTH_FAILED] ..." }] }` — when some providers fail; partial results are still returned.

---

### `get_domain`

Get details for a specific domain.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name |
| `provider` | string | no | Provider name, or omit to auto-detect |

---

### `register_domain`

Register a new domain. Requires provider credentials with registration support.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name to register |
| `provider` | string | yes | Provider to register with |
| `years` | number | no | Registration period (default: 1) |
| `contact` | Contact | yes | Registrant contact information |
| `autoRenew` | boolean | no | Auto-renew on expiry (default: false) |
| `privacyProtection` | boolean | no | Enable WHOIS privacy (default: true) |

**Contact object:**
```json
{
  "firstName": "Jane",
  "lastName": "Doe",
  "email": "jane@example.com",
  "phone": "+1.5555555555",
  "address1": "123 Main St",
  "city": "San Francisco",
  "state": "CA",
  "postalCode": "94102",
  "country": "US"
}
```

---

### `renew_domain`

Renew an existing domain.

**Input:** `domain`, `years` (default: 1), `provider` (optional)

---

## DNS Tools

### `list_dns_records`

List all DNS records for a domain.

**Input:** `domain`, `provider` (optional)

**Output:** `{ "records": [DNSRecord, ...] }`

---

### `create_dns_record`

Create a new DNS record.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name |
| `type` | string | yes | `A`, `AAAA`, `CNAME`, `MX`, `TXT`, `NS`, `SRV`, `CAA` |
| `name` | string | yes | Subdomain or `@` for root |
| `content` | string | yes | IP address, hostname, or TXT value |
| `ttl` | number | no | TTL in seconds (default: 300) |
| `priority` | number | no | Required for MX and SRV records |
| `provider` | string | no | Provider, or omit to auto-detect from domain ownership |

**Note (Namecheap):** DNS writes on Namecheap cost 2 API calls (read + write all records). This is handled transparently.

---

### `update_dns_record`

Update an existing DNS record by ID.

**Input:** Same as `create_dns_record`, plus `id` (required).

---

### `delete_dns_record`

Delete a DNS record.

**Input:** `domain`, `id` (record ID from `list_dns_records`), `provider` (optional)

---

## SSL Tools

### `list_certificates`

List SSL certificates for a domain.

**Input:** `domain`, `provider` (optional)

**Output:** `{ "certificates": [Certificate, ...] }`

---

### `create_certificate`

Provision a new SSL certificate for a domain.

**Input:** `domain`, `provider` (optional)

---

### `get_certificate_status`

Get the status of a certificate.

**Input:** `certId`, `provider` (required)

**Note (Cloudflare):** The `certId` for Cloudflare uses the format `zoneId:certId` as returned by `list_certificates`.

---

## Email Setup Tools

### `setup_spf`

Create an SPF TXT record using a mail provider template.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name |
| `provider` | string | no | DNS provider (auto-detected if omitted) |
| `mailProvider` | string | yes | `google`, `resend`, `sendgrid`, `mailgun`, `ses`, `postmark`, `custom` |
| `customPolicy` | string | no | Required when `mailProvider` is `custom` |

**Idempotent:** Updates existing SPF record in place if found (prevents duplicate SPF records per RFC 7208).

**SPF templates:**
| mailProvider | Record created |
|---|---|
| `google` | `v=spf1 include:_spf.google.com ~all` |
| `resend` | `v=spf1 include:spf.resend.com ~all` |
| `sendgrid` | `v=spf1 include:sendgrid.net ~all` |
| `mailgun` | `v=spf1 include:mailgun.org ~all` |
| `ses` | `v=spf1 include:amazonses.com ~all` |
| `postmark` | `v=spf1 include:spf.mtasv.net ~all` |

---

### `setup_dkim`

Add a DKIM TXT record for email authentication.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name |
| `provider` | string | no | DNS provider (auto-detected if omitted) |
| `selector` | string | yes | DKIM selector, e.g. `"mail"` or `"google"` |
| `publicKey` | string | yes | DKIM public key value (base64). PEM headers and whitespace are stripped automatically. |
| `keyType` | string | no | `rsa` (default) or `ed25519` |

Creates: `{selector}._domainkey.{domain} TXT "v=DKIM1; k={keyType}; p={publicKey}"`

**Idempotent:** Updates existing DKIM record in place if found (prevents duplicate records). Returns `previous` value when overwriting.

---

### `setup_dmarc`

Add a DMARC policy TXT record.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name |
| `provider` | string | no | DNS provider (auto-detected if omitted) |
| `policy` | string | no | `none`, `quarantine`, `reject` (default: `none`) |
| `reportEmail` | string | no | Email address to receive DMARC reports |
| `pct` | number | no | Percentage of messages to filter (default: 100) |

**Idempotent:** Updates existing DMARC record in place if found (prevents duplicate DMARC records per RFC 7489).

---

### `setup_mx`

Configure MX records using a mail provider template.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name |
| `provider` | string | no | DNS provider (auto-detected if omitted) |
| `mailProvider` | string | yes | `google`, `resend`, `sendgrid`, `mailgun`, `ses`, `protonmail`, `custom` |
| `customRecords` | array | no | Required when `mailProvider` is `custom` |

**Idempotent:** Skips exchanges already present. Returns `alreadyPresent` array listing skipped exchanges.

**MX templates:**
| mailProvider | Records set |
|---|---|
| `google` | ASPMX.L.GOOGLE.COM (pri 1), ALT1-4.ASPMX.L.GOOGLE.COM (pri 5, 5, 10, 10) |
| `sendgrid` | mx.sendgrid.net (pri 10) |
| `mailgun` | mxa.mailgun.org (pri 10), mxb.mailgun.org (pri 10) |
| `ses` | inbound-smtp.us-east-1.amazonaws.com (pri 10) |
| `protonmail` | mail.protonmail.ch (pri 10), mailsec.protonmail.ch (pri 20) |

---

## Transfer Tools

### `transfer_domain_in`

Initiate an inbound domain transfer from another registrar.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name |
| `authCode` | string | yes | Authorization/EPP code from current registrar |
| `provider` | string | yes | Provider to transfer to |

---

### `get_transfer_status`

Check the status of a pending domain transfer.

**Input:** `domain`, `provider` (optional)

**Output:** `{ "domain": "...", "status": "pending|approved|rejected|completed|cancelled" }`

---

## WHOIS Contact Tools

> **Provider support:** Namecheap and GoDaddy support WHOIS contact management. Porkbun and Cloudflare do not expose contact management via API — use their respective web dashboards instead.

### `get_whois_contact`

Get WHOIS registrant contact information for a domain.

**Input:** `domain`, `provider` (optional)

---

### `update_whois_contact`

Update WHOIS registrant contact information for a domain.

**Input:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `domain` | string | yes | Domain name |
| `provider` | string | no | Provider, or omit to auto-detect |
| `contact` | Contact | yes | Updated contact information |

---

## Error Handling

All errors are returned as agent-friendly messages with three components:
- **What went wrong** — clear description
- **Why** — root cause
- **What to do** — actionable next step

Example error (compact format):
```
[IP_NOT_WHITELISTED] namecheap: Namecheap API authentication failed. Your server's IP address must be whitelisted in your Namecheap account under Profile → Tools → API Access → Whitelisted IPs. → Log in to Namecheap, go to Profile → Tools → API Access, and add your current IP address to the whitelist.
```

Format: `[ERROR_CODE] provider: what went wrong → what to do`

Raw provider API error codes are never surfaced directly.
