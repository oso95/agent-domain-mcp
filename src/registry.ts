import type { Provider } from './providers/types.js';
import type { ProviderConfig } from './config.js';
import { AgentError } from './errors.js';

export class ProviderRegistry {
  private providers: Map<string, Provider> = new Map();

  register(provider: Provider): void {
    this.providers.set(provider.name(), provider);
  }

  get(name: string): Provider {
    const p = this.providers.get(name);
    if (!p) {
      throw new AgentError(
        'PROVIDER_NOT_CONFIGURED',
        `Provider '${name}' is not configured.`,
        `Set the required environment variables for '${name}' and restart the server. Run list_providers to see available providers.`,
        name,
      );
    }
    return p;
  }

  getAll(): Provider[] {
    return Array.from(this.providers.values());
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  names(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Resolve which provider owns a domain by querying listDomains on all providers.
   * Returns the provider that has the domain in its account.
   */
  async resolveProviderForDomain(domain: string): Promise<Provider> {
    const providers = this.getAll();
    if (providers.length === 0) {
      throw new AgentError(
        'NO_PROVIDERS_CONFIGURED',
        'No providers are configured.',
        'Set API credentials for at least one provider (Porkbun, Namecheap, GoDaddy, or Cloudflare) in your environment.',
        'none',
      );
    }

    if (providers.length === 1) {
      return providers[0];
    }

    // Fan out to all providers
    const results = await Promise.allSettled(
      providers.map(async (p) => {
        const domains = await p.listDomains();
        const found = domains.find((d) => d.name.toLowerCase() === domain.toLowerCase());
        if (found) return p;
        return null;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        return result.value;
      }
    }

    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    // When all providers failed, surface the first error — helps agents diagnose auth/network issues
    if (failures.length === results.length && failures.length > 0) {
      const first = failures[0].reason;
      if (first instanceof AgentError) throw first;
      throw new AgentError(
        'PROVIDER_ERROR',
        `All providers failed when searching for '${domain}': ${first?.message ?? 'unknown error'}`,
        'Check your API credentials and network connectivity.',
        'registry',
      );
    }

    // Some providers failed, but domain not found in the ones that succeeded
    const partialNote = failures.length > 0
      ? ` (${failures.length} provider(s) also returned errors — check credentials)`
      : '';

    throw new AgentError(
      'DOMAIN_NOT_FOUND',
      `Domain '${domain}' was not found in any configured provider account.${partialNote}`,
      `Verify that '${domain}' exists in one of your configured provider accounts: ${this.names().join(', ')}.`,
      'registry',
    );
  }
}

export async function buildRegistry(config: ProviderConfig): Promise<ProviderRegistry> {
  const registry = new ProviderRegistry();

  if (config.porkbun) {
    const { PorkbunProvider } = await import('./providers/porkbun/provider.js');
    registry.register(new PorkbunProvider(config.porkbun));
  }

  if (config.cloudflare) {
    const { CloudflareProvider } = await import('./providers/cloudflare/provider.js');
    registry.register(new CloudflareProvider(config.cloudflare));
  }

  if (config.namecheap) {
    const { NamecheapProvider } = await import('./providers/namecheap/provider.js');
    registry.register(new NamecheapProvider(config.namecheap));
  }

  if (config.godaddy) {
    const { GoDaddyProvider } = await import('./providers/godaddy/provider.js');
    registry.register(new GoDaddyProvider(config.godaddy));
  }

  return registry;
}
