import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ProviderRegistry } from './registry.js';
import type { ProviderConfig } from './config.js';
import { handleCheckAvailability, CheckAvailabilityInputSchema, type CheckAvailabilityInput } from './tools/availability.js';
import { handleListProviders } from './tools/providers.js';
import { formatErrorForAgent } from './errors.js';

/** Validates a fully-qualified domain name (labels separated by dots, RFC 1123 compliant) */
const domainSchema = z
  .string()
  .regex(
    /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
    'Must be a valid domain name (e.g. example.com)',
  );

export function createServer(registry: ProviderRegistry, config: ProviderConfig): McpServer {
  const server = new McpServer({
    name: 'domain-suite-mcp',
    version: '0.1.0',
  });

  // list_providers
  server.tool(
    'list_providers',
    'List configured providers and their capabilities',
    {},
    async () => {
      try {
        const result = handleListProviders(registry, config);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
      }
    },
  );

  // check_availability
  server.tool(
    'check_availability',
    'Check domain availability. Zero-config via RDAP/WHOIS; adds pricing if provider configured.',
    CheckAvailabilityInputSchema.shape,
    async (input) => {
      try {
        const result = await handleCheckAvailability(input as CheckAvailabilityInput, registry);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
      }
    },
  );

  // Domain tools
  server.tool('list_domains', 'List all domains across all configured providers', {
    provider: z.string().optional().describe('Specific provider to query, or omit for all'),
  }, async (input) => {
    try {
      const { handleListDomains } = await import('./tools/domains.js');
      const result = await handleListDomains(input as { provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('get_domain', 'Get details for a specific domain', {
    domain: domainSchema.describe('Domain name'),
    provider: z.string().optional().describe('Provider name, or omit to auto-detect'),
  }, async (input) => {
    try {
      const { handleGetDomain } = await import('./tools/domains.js');
      const result = await handleGetDomain(input as { domain: string; provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('register_domain', 'Register a new domain', {
    domain: domainSchema.describe('Domain name to register'),
    years: z.number().int().min(1).max(10).default(1).describe('Registration period in years'),
    provider: z.string().describe('Provider to register with'),
    contact: z.object({
      firstName: z.string().describe('First name'),
      lastName: z.string().describe('Last name'),
      email: z.string().email().describe('Contact email address'),
      phone: z.string().describe('Phone in E.164 format with dot separator, e.g. +1.2025551234'),
      address1: z.string().describe('Street address'),
      city: z.string().describe('City'),
      state: z.string().describe('State or province code'),
      postalCode: z.string().describe('Postal/ZIP code'),
      country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. US, GB, CA'),
    }),
    autoRenew: z.boolean().default(false).describe('Enable automatic renewal'),
    privacyProtection: z.boolean().default(true).describe('Enable WHOIS privacy protection'),
  }, async (input) => {
    try {
      const { handleRegisterDomain } = await import('./tools/domains.js');
      const result = await handleRegisterDomain(input as Parameters<typeof handleRegisterDomain>[0], registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('renew_domain', 'Renew an existing domain', {
    domain: domainSchema.describe('Domain name'),
    years: z.number().int().min(1).max(10).default(1).describe('Renewal period in years'),
    provider: z.string().optional().describe('Provider name, or omit to auto-detect'),
  }, async (input) => {
    try {
      const { handleRenewDomain } = await import('./tools/domains.js');
      const result = await handleRenewDomain(input as { domain: string; years: number; provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  // DNS tools
  server.tool('list_dns_records', 'List all DNS records for a domain', {
    domain: domainSchema,
    provider: z.string().optional().describe('Provider name, or omit to auto-detect'),
  }, async (input) => {
    try {
      const { handleListDnsRecords } = await import('./tools/dns.js');
      const result = await handleListDnsRecords(input as { domain: string; provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('create_dns_record', 'Create a new DNS record', {
    domain: domainSchema,
    provider: z.string().optional(),
    type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']),
    name: z.string().describe("Subdomain or '@' for root"),
    content: z.string().describe('IP address, hostname, or TXT value'),
    ttl: z.number().int().min(1).default(300).describe('TTL in seconds; use 1 for Cloudflare Auto'),
    priority: z.number().int().optional().describe('Required for MX and SRV records'),
  }, async (input) => {
    try {
      const { handleCreateDnsRecord } = await import('./tools/dns.js');
      const result = await handleCreateDnsRecord(input as Parameters<typeof handleCreateDnsRecord>[0], registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('update_dns_record', 'Update an existing DNS record. All fields are required (full record replacement, not partial update).', {
    domain: domainSchema,
    provider: z.string().optional(),
    id: z.string().min(1).describe('Record ID from list_dns_records'),
    type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', 'CAA']),
    name: z.string().describe("Subdomain or '@' for root"),
    content: z.string().describe('IP address, hostname, or TXT value'),
    ttl: z.number().int().min(1).default(300).describe('TTL in seconds; use 1 for Cloudflare Auto'),
    priority: z.number().int().optional().describe('Required for MX and SRV records'),
  }, async (input) => {
    try {
      const { handleUpdateDnsRecord } = await import('./tools/dns.js');
      const result = await handleUpdateDnsRecord(input as Parameters<typeof handleUpdateDnsRecord>[0], registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('delete_dns_record', 'Delete a DNS record. On GoDaddy, deletes ALL records of same type+name (API limitation).', {
    domain: domainSchema,
    id: z.string().min(1).describe('Record ID from list_dns_records'),
    provider: z.string().optional().describe('Provider name, or omit to auto-detect'),
  }, async (input) => {
    try {
      const { handleDeleteDnsRecord } = await import('./tools/dns.js');
      const result = await handleDeleteDnsRecord(input as { domain: string; id: string; provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  // SSL tools
  server.tool('list_certificates', 'List SSL certificates for a domain', {
    domain: domainSchema,
    provider: z.string().optional().describe('Provider name, or omit to auto-detect'),
  }, async (input) => {
    try {
      const { handleListCertificates } = await import('./tools/ssl.js');
      const result = await handleListCertificates(input as { domain: string; provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('create_certificate', 'Provision SSL certificate. On Porkbun, retrieves auto-provisioned cert (no explicit create needed). On Cloudflare, requires Advanced Certificate Manager.', {
    domain: domainSchema,
    provider: z.string().optional().describe('Provider name, or omit to auto-detect'),
  }, async (input) => {
    try {
      const { handleCreateCertificate } = await import('./tools/ssl.js');
      const result = await handleCreateCertificate(input as { domain: string; provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('get_certificate_status', 'Get certificate status', {
    certId: z.string().describe('Certificate ID from list_certificates or create_certificate'),
    provider: z.string().describe('Provider name (required)'),
  }, async (input) => {
    try {
      const { handleGetCertificateStatus } = await import('./tools/ssl.js');
      const result = await handleGetCertificateStatus(input as { certId: string; provider: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  // Email tools
  server.tool('setup_spf', 'Add SPF record with mail provider template', {
    domain: domainSchema,
    provider: z.string().optional().describe('DNS provider (auto-detected if omitted)'),
    mailProvider: z.enum(['google', 'resend', 'sendgrid', 'mailgun', 'ses', 'postmark', 'custom']),
    customPolicy: z.string().optional().describe("Required when mailProvider is 'custom'"),
  }, async (input) => {
    try {
      const { handleSetupSpf } = await import('./tools/email.js');
      const result = await handleSetupSpf(input as Parameters<typeof handleSetupSpf>[0], registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('setup_dkim', 'Add DKIM TXT record', {
    domain: domainSchema,
    provider: z.string().optional().describe('DNS provider (auto-detected if omitted)'),
    selector: z.string().describe('DKIM selector, e.g. "mail" or "google"'),
    publicKey: z.string().describe('DKIM public key (base64 or PEM; headers auto-stripped)'),
    keyType: z.enum(['rsa', 'ed25519']).default('rsa').describe('Key algorithm: rsa (default) or ed25519'),
  }, async (input) => {
    try {
      const { handleSetupDkim } = await import('./tools/email.js');
      const result = await handleSetupDkim(input as Parameters<typeof handleSetupDkim>[0], registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('setup_dmarc', 'Add DMARC policy TXT record', {
    domain: domainSchema,
    provider: z.string().optional().describe('DNS provider (auto-detected if omitted)'),
    policy: z.enum(['none', 'quarantine', 'reject']).default('none').describe('DMARC enforcement: none=monitor only, quarantine=spam folder, reject=block'),
    reportEmail: z.string().email().optional().describe('Email address to receive DMARC reports'),
    pct: z.number().int().min(0).max(100).default(100).describe('Percentage of messages to filter'),
  }, async (input) => {
    try {
      const { handleSetupDmarc } = await import('./tools/email.js');
      const result = await handleSetupDmarc(input as Parameters<typeof handleSetupDmarc>[0], registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('setup_mx', 'Configure MX records with mail provider template', {
    domain: domainSchema,
    provider: z.string().optional().describe('DNS provider (auto-detected if omitted)'),
    mailProvider: z.enum(['google', 'resend', 'sendgrid', 'mailgun', 'ses', 'protonmail', 'custom']),
    customRecords: z.array(z.object({
      exchange: z.string(),
      priority: z.number().int(),
    })).optional().describe("Required when mailProvider is 'custom'"),
  }, async (input) => {
    try {
      const { handleSetupMx } = await import('./tools/email.js');
      const result = await handleSetupMx(input as Parameters<typeof handleSetupMx>[0], registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  // Transfer tools
  server.tool('transfer_domain_in', 'Initiate inbound domain transfer', {
    domain: domainSchema,
    authCode: z.string().min(1).describe('Authorization/EPP code from current registrar'),
    provider: z.string().describe('Provider to transfer to'),
  }, async (input) => {
    try {
      const { handleTransferDomainIn } = await import('./tools/transfer.js');
      const result = await handleTransferDomainIn(input as Parameters<typeof handleTransferDomainIn>[0], registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('get_transfer_status', 'Get domain transfer status. During an in-flight transfer the domain may not appear in list_domains yet — specify provider explicitly in that case.', {
    domain: domainSchema,
    provider: z.string().optional().describe('Provider name (recommended during active transfers)'),
  }, async (input) => {
    try {
      const { handleGetTransferStatus } = await import('./tools/transfer.js');
      const result = await handleGetTransferStatus(input as { domain: string; provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  // Contact tools
  server.tool('get_whois_contact', 'Get domain WHOIS contact', {
    domain: domainSchema,
    provider: z.string().optional(),
  }, async (input) => {
    try {
      const { handleGetWhoisContact } = await import('./tools/contacts.js');
      const result = await handleGetWhoisContact(input as { domain: string; provider?: string }, registry);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  server.tool('update_whois_contact', 'Update domain WHOIS contact', {
    domain: domainSchema,
    provider: z.string().optional().describe('Provider name, or omit to auto-detect'),
    contact: z.object({
      firstName: z.string().describe('First name'),
      lastName: z.string().describe('Last name'),
      email: z.string().email().describe('Contact email address'),
      phone: z.string().describe('Phone in E.164 format with dot separator, e.g. +1.2025551234'),
      address1: z.string().describe('Street address'),
      city: z.string().describe('City'),
      state: z.string().describe('State or province code'),
      postalCode: z.string().describe('Postal/ZIP code'),
      country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code, e.g. US, GB, CA'),
    }),
  }, async (input) => {
    try {
      const { handleUpdateWhoisContact } = await import('./tools/contacts.js');
      const typedInput = input as Parameters<typeof handleUpdateWhoisContact>[0];
      await handleUpdateWhoisContact(typedInput, registry);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, domain: typedInput.domain }) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: formatErrorForAgent(err) }], isError: true };
    }
  });

  return server;
}
