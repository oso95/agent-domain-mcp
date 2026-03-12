import { z } from 'zod';
import { checkAvailabilityRDAP } from '../lookup/rdap.js';
import { checkAvailabilityPublic } from '../lookup/public.js';
import { checkAvailabilityWhois } from '../lookup/whois.js';
import { errorToObject } from '../errors.js';
import type { ProviderRegistry } from '../registry.js';
import type { AvailabilityResult } from '../providers/types.js';
import { Feature } from '../providers/types.js';

export const CheckAvailabilityInputSchema = z.object({
  domain: z
    .string()
    .regex(
      /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
      "Must be a valid domain label (e.g. 'myapp' or 'myapp.com')",
    )
    .describe("e.g. 'myapp' or 'myapp.com'"),
  tlds: z.array(z.string()).optional().describe("e.g. ['com','io','dev']; default .com"),
  provider: z.string().optional().describe('provider for pricing (optional)'),
});

export type CheckAvailabilityInput = z.infer<typeof CheckAvailabilityInputSchema>;

function buildDomainList(input: CheckAvailabilityInput): string[] {
  const { domain, tlds } = input;

  // If domain already has a TLD (contains a dot), just check that domain
  if (domain.includes('.')) {
    return [domain.toLowerCase()];
  }

  // No TLD specified — use provided tlds or default to .com
  const effectiveTlds = tlds && tlds.length > 0 ? tlds : ['com'];
  return effectiveTlds.map((tld) => `${domain.toLowerCase()}.${tld.replace(/^\./, '')}`);
}

async function checkSingleDomain(domain: string): Promise<AvailabilityResult> {
  // Step 1: Try RDAP
  try {
    return await checkAvailabilityRDAP(domain);
  } catch {
    // RDAP failed, try GoDaddy public
  }

  // Step 2: GoDaddy public fallback
  try {
    return await checkAvailabilityPublic(domain);
  } catch {
    // Public API failed, try WHOIS
  }

  // Step 3: WHOIS last resort
  return await checkAvailabilityWhois(domain);
}

export async function handleCheckAvailability(
  input: CheckAvailabilityInput,
  registry: ProviderRegistry,
): Promise<Record<string, unknown>> {
  const domains = buildDomainList(input);

  // Run all availability checks in parallel (RDAP/public/WHOIS — no provider needed)
  const rawResults = await Promise.allSettled(domains.map(checkSingleDomain));

  const results: AvailabilityResult[] = rawResults.map((r, i) => {
    if (r.status === 'rejected') {
      return {
        domain: domains[i],
        available: false,
        premium: false,
        availabilitySource: 'error',
        error: errorToObject(r.reason),
      };
    }
    return r.value;
  });

  // Enrich available domains with pricing — fetch pricing table ONCE per provider
  // instead of one API call per domain
  const providerName = input.provider ?? registry.names()[0];
  if (providerName) {
    try {
      const provider = registry.get(providerName);
      if (!provider.supports(Feature.Pricing)) return stripSources(results);
      const availableDomains = results.filter((r) => r.available);
      if (availableDomains.length > 0) {
        if (provider.getPricingTable) {
          // Batch: one API call for all TLD prices
          const pricingTable = await provider.getPricingTable();
          for (const result of availableDomains) {
            const tld = result.domain.split('.').slice(1).join('.');
            const price = pricingTable[tld];
            if (price) {
              result.price = price;
              result.priceSource = providerName;
            }
          }
        } else {
          // Fallback: per-domain enrichment for providers without getPricingTable
          await Promise.allSettled(
            availableDomains.map(async (result) => {
              try {
                const enriched = await provider.checkAvailability(result.domain);
                if (enriched.price) {
                  result.price = enriched.price;
                  result.priceSource = enriched.priceSource ?? providerName;
                }
              } catch {
                // Pricing enrichment failure is non-fatal
              }
            }),
          );
        }
      }
    } catch {
      // No provider or pricing failure — proceed without pricing
    }
  }

  return stripSources(results);
}

/** Strip redundant per-domain source fields. availabilitySource kept only for errors;
 *  priceSource hoisted to top-level to avoid repeating per domain. */
function stripSources(results: AvailabilityResult[]): Record<string, unknown> {
  const priceSources = new Set(results.map((r) => r.priceSource).filter(Boolean));
  const priceSource = priceSources.size === 1 ? [...priceSources][0] : undefined;
  const cleanResults = results.map(({ availabilitySource, priceSource: _ps, ...rest }) => ({
    ...rest,
    ...(availabilitySource === 'error' ? { availabilitySource } : {}),
  }));
  return { results: cleanResults, ...(priceSource ? { priceSource } : {}) };
}
