import { Feature } from '../providers/types.js';
import { AgentError } from '../errors.js';

export function assertDnsWrite(providerName: string, supports: (f: Feature) => boolean): void {
  if (!supports(Feature.DnsWrite)) {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Provider '${providerName}' does not support DNS record management.`,
      'Use a provider that supports DNS writes (e.g., cloudflare, godaddy, namecheap, porkbun).',
      providerName,
    );
  }
}

export function assertTransfer(providerName: string, supports: (f: Feature) => boolean): void {
  if (!supports(Feature.Transfer)) {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Provider '${providerName}' does not support domain transfers via API.`,
      'Use Porkbun, Namecheap, or GoDaddy for domain transfers.',
      providerName,
    );
  }
}

export function assertSsl(providerName: string, supports: (f: Feature) => boolean): void {
  if (!supports(Feature.SSL)) {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Provider '${providerName}' does not support SSL certificate management via API.`,
      'Use Porkbun, Namecheap, or Cloudflare for SSL certificate management.',
      providerName,
    );
  }
}

export function assertWhoisContact(providerName: string, supports: (f: Feature) => boolean): void {
  if (!supports(Feature.WhoisContact)) {
    throw new AgentError(
      'FEATURE_NOT_SUPPORTED',
      `Provider '${providerName}' does not support WHOIS contact management via API.`,
      'Use Namecheap or GoDaddy for WHOIS contact management, or update contacts via the provider web interface.',
      providerName,
    );
  }
}
