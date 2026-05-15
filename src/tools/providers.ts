import type { ProviderRegistry } from '../registry.js';
import { Feature } from '../providers/types.js';
import { getUnconfiguredProviderNames, type ProviderConfig } from '../config.js';

// Notes for UNsupported features — explain why and what to do instead
const UNSUPPORTED_NOTES: Partial<Record<string, Partial<Record<string, string>>>> = {
  cloudflare: {
    [Feature.Registration]: 'Cloudflare registration requires Enterprise plan. Use as DNS layer only.',
    [Feature.Renewal]: 'Cloudflare does not support domain renewals via API. Renew with your original registrar.',
    [Feature.Pricing]: 'Cloudflare does not expose a pricing API.',
    [Feature.WhoisContact]: 'Cloudflare does not provide a WHOIS contact API.',
    [Feature.Transfer]: 'Cloudflare does not support domain transfers via API.',
    [Feature.NameserverWrite]: 'Cloudflare is a DNS host, not a registrar — it cannot change registrar-level nameservers. Update nameservers at your original registrar to point at the Cloudflare ones.',
  },
  godaddy: {
    [Feature.SSL]: 'GoDaddy does not expose an SSL certificate management API. Manage certificates via the GoDaddy dashboard.',
  },
  porkbun: {
    [Feature.WhoisContact]: 'Porkbun v3 API does not expose WHOIS contact management endpoints. Manage contacts via https://porkbun.com.',
  },
  namecheap: {
    [Feature.Dnssec]: 'Namecheap does not expose DNSSEC management via its public API (verified 2026-05). Configure DNSSEC via the Namecheap dashboard (Advanced DNS panel).',
  },
};

// Notes for SUPPORTED features — warn about partial support or known limitations
const SUPPORTED_NOTES: Partial<Record<string, Partial<Record<string, string>>>> = {
  porkbun: {
    [Feature.Transfer]: 'Porkbun supports initiating transfers (transfer_domain_in) but cannot query transfer status (get_transfer_status) via API.',
  },
  namecheap: {
    [Feature.SSL]: 'Namecheap can list/query SSL certificates but cannot provision new ones via API. Purchase via the Namecheap dashboard first.',
  },
  cloudflare: {
    [Feature.SSL]: 'Cloudflare SSL provisioning requires the Advanced Certificate Manager add-on. Free/Pro plans use automatic Universal SSL only.',
    [Feature.DnsWrite]: 'Each Cloudflare DNS operation resolves the zone ID via listZones(), which paginates through all zones in your account. Accounts with many zones (100+) may experience slower DNS operations due to this O(N) lookup.',
  },
  godaddy: {
    [Feature.DnsWrite]: 'GoDaddy DNS management requires 10+ domains or an active Domain Pro plan (~$240/yr). Accounts that do not meet this requirement will receive a PERMISSION_DENIED error.',
  },
  webnic: {
    [Feature.Registration]: 'Webnic registration requires a pre-created contact handle (WEBNIC_DEFAULT_CONTACT_ID) and registrant user ID (WEBNIC_DEFAULT_REGISTRANT_USER_ID). Without them, register_domain returns REGISTRATION_PREREQUISITES_NOT_MET.',
    [Feature.Transfer]: 'Webnic transfers require the same pre-created contact handle and registrant user ID as registration.',
    [Feature.WhoisContact]: 'Webnic exposes WHOIS contact reads (get_whois_contact) but contact updates are not implemented in this MCP version — use the WebNIC portal.',
    [Feature.DnsWrite]: 'Webnic DNS supports 22 record types: A, AAAA, CNAME, MX, TXT, SRV, CAA, ALIAS, HTTPS, SVCB, TLSA, SMIMEA, DS, CDS, CDNSKEY, PTR, SSHFP, NAPTR, SOA, CERT, LOC, URI. NS is explicitly rejected (delegation = update_nameservers). DNSKEY is managed via the zone DNSSEC endpoints. The official /dns/v2/zone/record-types endpoint understates the catalog — types verified live on both basic and Premium zones (2026-05).',
    [Feature.NameserverWrite]: 'Webnic auto-unlocks domains in name_protected / transfer_protected for the duration of update_nameservers, then re-locks to name_protected (the strictest level — also WebNIC default for new domains).',
    [Feature.SSL]: 'Webnic SSL is read-only via the MCP: list_certificates and get_certificate_status work for issued / pending orders, but create_certificate requires a CSR that the MCP interface does not accept — place the order via the WebNIC portal, then track it via the MCP.',
  },
};

export function handleListProviders(
  registry: ProviderRegistry,
  config: ProviderConfig,
): object {
  const configured = registry.getAll().map((p) => {
    const supported: string[] = [];
    const unsupported: string[] = [];
    const notes: string[] = [];

    for (const feature of Object.values(Feature)) {
      if (p.supports(feature)) {
        supported.push(feature);
        const note = SUPPORTED_NOTES[p.name()]?.[feature];
        if (note) notes.push(note);
      } else {
        unsupported.push(feature);
        const note = UNSUPPORTED_NOTES[p.name()]?.[feature];
        if (note) notes.push(note);
      }
    }

    return {
      name: p.name(),
      supports: supported,
      ...(unsupported.length > 0 ? { unsupported } : {}),
      ...(notes.length > 0 ? { notes } : {}),
    };
  });

  return {
    configured,
    unconfigured: getUnconfiguredProviderNames(config),
  };
}
