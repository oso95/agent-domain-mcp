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
  },
  godaddy: {
    [Feature.SSL]: 'GoDaddy does not expose an SSL certificate management API. Manage certificates via the GoDaddy dashboard.',
  },
  porkbun: {
    [Feature.WhoisContact]: 'Porkbun v3 API does not expose WHOIS contact management endpoints. Manage contacts via https://porkbun.com.',
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
