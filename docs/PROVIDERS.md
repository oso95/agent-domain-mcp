# Provider Setup Guide

Step-by-step instructions for configuring each supported provider.

---

## Porkbun (Recommended)

**Best for:** New projects. Clean JSON API, free keys, no IP whitelist, sandbox available.

### Setup

1. Log in to [porkbun.com](https://porkbun.com) and go to **Account → API Access**
2. Enable API access and create an API key
3. Copy your `PORKBUN_API_KEY` (starts with `pk1_`) and `PORKBUN_SECRET_API_KEY` (starts with `sk1_`)

```env
PORKBUN_API_KEY=pk1_...
PORKBUN_SECRET_API_KEY=sk1_...
```

### Known Limitations

- **Rate limits are strict:** ~1 domain availability check per 10 seconds, ~60 DNS requests/minute. The server handles backoff automatically.
- **Registration prerequisites:** Your Porkbun account must have (1) at least one previously registered domain, (2) a verified email address, (3) a verified phone number, and (4) sufficient account credit. Registration will fail without these.
- **No WHOIS contact management via API:** Porkbun v3 API does not expose contact management endpoints. Manage WHOIS contacts at [porkbun.com](https://porkbun.com).

---

## Namecheap

**Best for:** Users who already have a Namecheap account with existing domains.

### Setup

1. Log in to Namecheap and go to **Profile → Tools → API Access**
2. Enable API access
3. Copy your API key and note your account username

```env
NAMECHEAP_API_KEY=your_api_key
NAMECHEAP_API_USER=your_username
```

### IP Whitelisting (Required)

**Critical:** Namecheap requires your server's IP address to be whitelisted before any API call works.

1. Go to **Profile → Tools → API Access → Whitelisted IPs**
2. Add your server's IP address (must be IPv4)
3. If running locally, add your public IP (check `curl https://api.ipify.org`)

If you don't whitelist your IP, every API call will fail with an authentication error regardless of key validity.

```env
# Optional: set explicitly if auto-detection fails
NAMECHEAP_CLIENT_IP=1.2.3.4
```

### Sandbox

```env
NAMECHEAP_SANDBOX=true
```

Sandbox URL: `api.sandbox.namecheap.com`

### Known Limitations

- **IP whitelist required** (see above)
- **DNS write pattern:** Namecheap's DNS API is set-all-records-at-once. Every `create_dns_record`, `update_dns_record`, or `delete_dns_record` call costs 2 API calls (read existing + write all). This counts against your rate limit (20/min, 700/hr, 8,000/day).
- **Rate limits:** 20 requests/minute, 700/hour, 8,000/day. The server handles backoff automatically.

---

## GoDaddy

**Best for:** Users who already have 10+ domains on GoDaddy, or pay for Domain Pro.

### Setup

1. Go to [developer.godaddy.com/keys](https://developer.godaddy.com/keys)
2. Create a production API key
3. Copy your `GODADDY_API_KEY` and `GODADDY_API_SECRET`

```env
GODADDY_API_KEY=your_api_key
GODADDY_API_SECRET=your_api_secret
```

### Sandbox (OTE)

```env
GODADDY_SANDBOX=true
```

OTE URL: `api.ote-godaddy.com`

### Known Limitations

- **DNS management requires:** Either 10+ active domains in your account, OR an active [Domain Pro plan](https://www.godaddy.com/domain/api-access) (~$240/yr). New accounts with fewer domains are effectively read-only for DNS writes. You will receive a clear error if your account doesn't qualify.
- **Not recommended for new users:** Unless you already have a qualifying account, use Porkbun or Namecheap instead.

---

## Cloudflare

**Best for:** DNS management layer. Pair with Porkbun/Namecheap for registration.

### Setup

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use the **Edit zone DNS** template, or create a custom token with:
   - **Zone → Zone: Read** (all zones)
   - **Zone → DNS: Edit** (all zones)
   - **Zone → SSL and Certificates: Edit** (all zones)
4. Copy the generated token

```env
CLOUDFLARE_API_TOKEN=your_api_token
# Optional: restrict to a specific account
CLOUDFLARE_ACCOUNT_ID=your_account_id
```

### Recommended Pattern

Cloudflare's DNS API is the best in class. The recommended setup:

1. Register domains on **Porkbun** or **Namecheap**
2. Point nameservers to **Cloudflare** (get nameservers from Cloudflare dashboard)
3. Use `create_dns_record` / `update_dns_record` with `provider: "cloudflare"` for all DNS management

### Known Limitations

- **No domain registration via API** — Registration is Enterprise-tier only. Use `supports()` to check: the server will return an actionable error if you attempt to register via Cloudflare.
- **No pricing API** — Cloudflare doesn't expose domain pricing via API.
- **No WHOIS contact management** — Also Enterprise-only.
- **Most generous rate limits:** 1,200 requests per 5 minutes (~240/min). Rarely an issue in practice.

---

## Webnic

**Best for:** Resellers and partners using the [WebNIC Premier Partner Program](https://www.webnic.cc/premier-partner-program/) — wide ccTLD coverage (Asia-Pacific in particular).

### Setup

1. Sign in to the WebNIC Partner Portal at [portal.webnic.cc](https://portal.webnic.cc)
2. Request API access — your IP must be added to the authorized access list (separate per environment: production vs OTE sandbox)
3. Receive your API username and secret

```env
WEBNIC_USERNAME=your_api_user
WEBNIC_PASSWORD=your_api_secret
```

### Sandbox (OTE)

```env
WEBNIC_SANDBOX=true
```

OTE base URL: `https://oteapi.webnic.cc`. Production base URL: `https://api.webnic.cc`. Credentials are environment-specific — OTE tokens do not work in production.

### Registration Prerequisites

Unlike registrars that accept contact info inline at register time, WebNIC works with pre-created **contact handles** (e.g. `WN964984T`) and a **registrant account user ID** (e.g. `REG100015`). Both must already exist before any `register_domain` or `transfer_domain_in` call. Create them via the WebNIC portal or via the contact/registrant API endpoints, then export:

```env
WEBNIC_DEFAULT_CONTACT_ID=WN964984T
WEBNIC_DEFAULT_REGISTRANT_USER_ID=REG100015
# Optional: defaults to ns1.web.cc,ns2.web.cc. Custom nameservers must already exist as host objects on your account.
WEBNIC_DEFAULT_NAMESERVERS=ns1.example.cc,ns2.example.cc
```

Without these, `register_domain` returns `REGISTRATION_PREREQUISITES_NOT_MET` with the actionable next steps.

### Domain Protection Auto-Unlock

WebNIC ships three registry-side protection levels:

| Level | What it blocks |
|---|---|
| `active` | Nothing — fully writable |
| `transfer_protected` | Unauthorised transfers |
| `name_protected` (strictest) | Transfers, deletion, contact updates, nameserver changes |

Newly-registered domains land in `name_protected` by default at WebNIC. Any registry-side write (`update_nameservers`, `transfer_domain_in`, `update_whois_contact` once implemented) needs the domain in `active` for the duration of the call.

The provider performs this transparently:

1. capture the current status,
2. switch to `active` (only if not already),
3. run the operation,
4. re-lock to `name_protected` in a `finally` block — even if the op throws.

No configuration needed. The post-write level is always `name_protected` (the strictest, and WebNIC's own default). Restore failures are logged to stderr (out of band from the MCP stdio channel) and never mask the original error.

### Known Limitations

- **DNS record types:** A, AAAA, CNAME, MX, TXT, SRV are supported. NS and CAA are not. The save endpoint replaces the entire record set for `(type, name)`, so the provider transparently read-merge-writes when you add/update a single rdata to preserve siblings (mirroring the GoDaddy strategy).
- **WHOIS contact updates not implemented:** `get_whois_contact` works (reads via `get_domain_info` + `query-contact`); `update_whois_contact` returns `FEATURE_NOT_SUPPORTED` — update contacts via the WebNIC portal or call the WebNIC REST contact endpoints directly.
- **SSL is read-only:** `list_certificates` and `get_certificate_status` are wired against the WebNIC SSL Restful v2 API (`/ssl/v2/orders/search`, `/ssl/v2/orders/info`). `create_certificate` returns `SSL_CSR_REQUIRED` because the MCP interface does not currently carry a CSR — the WebNIC `Place Order` endpoint requires one. Place the order via the WebNIC portal (or call `/ssl/v2/orders/new` directly with a CSR), then track issuance via `list_certificates` / `get_certificate_status`. Certificate IDs are formatted `webnic-ssl-<orderId>`. DCV (email/DNS/file) is handled outside the MCP. Use Porkbun for fully-automated SSL.
- **Rate limits:** 5,000 requests/day and 100,000/month per account. The server enforces a small client-side limiter to stay well below.

---

## Availability lookup fallback chain

When no provider returns availability data, the server falls back to RDAP → GoDaddy public availability → [whoisjson.com](https://whoisjson.com/) (third-party). The third-party fallback transmits the domain name to whoisjson.com, which is operated outside the providers configured above. If you do not want domain names sent to that endpoint, configure at least one registrar provider with `Pricing` capability so the cascade resolves earlier.

---

## Multi-Provider Setup

You can configure multiple providers simultaneously. The server will:

1. Use the specified provider if `provider` is given in a tool call
2. Auto-detect the provider from domain ownership (via `listDomains` fan-out) if not specified
3. Return a clear error if the domain is not found in any configured provider

Example: Register on Porkbun, manage DNS on Cloudflare:

```env
PORKBUN_API_KEY=pk1_...
PORKBUN_SECRET_API_KEY=sk1_...
CLOUDFLARE_API_TOKEN=...
```

```
# Register on Porkbun
register_domain { domain: "myapp.com", provider: "porkbun", ... }

# Then set nameservers to Cloudflare (done in Cloudflare dashboard)
# Then manage DNS via Cloudflare
create_dns_record { domain: "myapp.com", provider: "cloudflare", type: "A", ... }
```
