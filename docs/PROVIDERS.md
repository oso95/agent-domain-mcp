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
