import type { ProviderRegistry } from '../registry.js';
import type { DNSRecord } from '../providers/types.js';
import { AgentError } from '../errors.js';
import { assertDnsWrite } from './guards.js';

const SPF_TEMPLATES: Record<string, string> = {
  google: 'v=spf1 include:_spf.google.com ~all',
  resend: 'v=spf1 include:spf.resend.com ~all',
  sendgrid: 'v=spf1 include:sendgrid.net ~all',
  mailgun: 'v=spf1 include:mailgun.org ~all',
  ses: 'v=spf1 include:amazonses.com ~all',
  postmark: 'v=spf1 include:spf.mtasv.net ~all',
};

const MX_TEMPLATES: Record<string, Array<{ exchange: string; priority: number }>> = {
  google: [
    { exchange: 'ASPMX.L.GOOGLE.COM', priority: 1 },
    { exchange: 'ALT1.ASPMX.L.GOOGLE.COM', priority: 5 },
    { exchange: 'ALT2.ASPMX.L.GOOGLE.COM', priority: 5 },
    { exchange: 'ALT3.ASPMX.L.GOOGLE.COM', priority: 10 },
    { exchange: 'ALT4.ASPMX.L.GOOGLE.COM', priority: 10 },
  ],
  resend: [
    { exchange: 'feedback-smtp.us-east-1.amazonses.com', priority: 10 },
  ],
  sendgrid: [
    { exchange: 'mx.sendgrid.net', priority: 10 },
  ],
  mailgun: [
    { exchange: 'mxa.mailgun.org', priority: 10 },
    { exchange: 'mxb.mailgun.org', priority: 10 },
  ],
  ses: [
    { exchange: 'inbound-smtp.us-east-1.amazonaws.com', priority: 10 },
  ],
  protonmail: [
    { exchange: 'mail.protonmail.ch', priority: 10 },
    { exchange: 'mailsec.protonmail.ch', priority: 20 },
  ],
};

/** Matches root-record names returned by different providers (Cloudflare: FQDN, Namecheap/others: '@') */
function isRootRecord(name: string, domain: string): boolean {
  return name === '@' || name === domain || name === `${domain}.`;
}


export async function handleSetupSpf(
  input: { domain: string; provider?: string; mailProvider: string; customPolicy?: string },
  registry: ProviderRegistry,
) {
  const dnsProvider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnsWrite(dnsProvider.name(), (f) => dnsProvider.supports(f));

  let spfValue: string;
  if (input.mailProvider === 'custom') {
    if (!input.customPolicy) {
      throw new AgentError(
        'MISSING_PARAMETER',
        "customPolicy is required when mailProvider is 'custom'",
        "Provide a customPolicy value with the SPF record content.",
        'email',
      );
    }
    const normalizedPolicy = input.customPolicy.toLowerCase();
    if (!normalizedPolicy.startsWith('v=spf1 ') && normalizedPolicy !== 'v=spf1') {
      throw new AgentError(
        'INVALID_PARAMETER',
        "customPolicy must be a valid SPF record starting with 'v=spf1'",
        "Example: 'v=spf1 include:example.com ~all'",
        'email',
      );
    }
    spfValue = input.customPolicy;
  } else {
    spfValue = SPF_TEMPLATES[input.mailProvider];
    if (!spfValue) throw new AgentError(
      'INVALID_PARAMETER',
      `Unknown mail provider: ${input.mailProvider}`,
      `Use one of: ${Object.keys(SPF_TEMPLATES).join(', ')}, or 'custom' with a customPolicy.`,
      'email',
    );
  }

  // Prevent duplicate SPF records (RFC 7208 §3.2: exactly one SPF record required)
  const existing = await dnsProvider.listDNSRecords(input.domain);
  const existingSpf = existing.find(
    (r) => r.type === 'TXT' && isRootRecord(r.name, input.domain) && r.content.toLowerCase().startsWith('v=spf1'),
  );

  if (existingSpf) {
    if (existingSpf.content === spfValue) {
      return { success: true, record: existingSpf, spfValue };
    }
    const previous = existingSpf.content;
    const updated = await dnsProvider.updateDNSRecord(input.domain, { ...existingSpf, content: spfValue });
    return { success: true, record: updated, spfValue, previous };
  }

  const record: DNSRecord = {
    type: 'TXT',
    name: '@',
    content: spfValue,
    ttl: 300,
  };

  const created = await dnsProvider.createDNSRecord(input.domain, record);
  return { success: true, record: created, spfValue };
}

export async function handleSetupDkim(
  input: { domain: string; provider?: string; selector: string; publicKey: string; keyType?: 'rsa' | 'ed25519' },
  registry: ProviderRegistry,
) {
  const dnsProvider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnsWrite(dnsProvider.name(), (f) => dnsProvider.supports(f));

  const keyType = input.keyType ?? 'rsa';
  const dkimName = `${input.selector}._domainkey`;
  // Strip PEM headers/footers and all whitespace — DNS TXT records need raw base64 only
  const rawKey = input.publicKey
    .replace(/-----BEGIN[^-]*-----/, '')
    .replace(/-----END[^-]*-----/, '')
    .replace(/\s+/g, '');
  const dkimContent = `v=DKIM1; k=${keyType}; p=${rawKey}`;

  // Check for existing DKIM record at this selector to avoid duplicates
  const existing = await dnsProvider.listDNSRecords(input.domain);
  const existingDkim = existing.find(
    (r) => r.type === 'TXT' &&
      (r.name === dkimName || r.name === `${dkimName}.${input.domain}` || r.name === `${dkimName}.${input.domain}.`) &&
      r.content.includes('v=DKIM1'),
  );

  if (existingDkim) {
    if (existingDkim.content === dkimContent) {
      return { success: true, record: existingDkim };
    }
    const previous = existingDkim.content;
    const updated = await dnsProvider.updateDNSRecord(input.domain, { ...existingDkim, content: dkimContent });
    return { success: true, record: updated, previous };
  }

  const created = await dnsProvider.createDNSRecord(input.domain, {
    type: 'TXT',
    name: dkimName,
    content: dkimContent,
    ttl: 300,
  });
  return { success: true, record: created };
}

export async function handleSetupDmarc(
  input: { domain: string; provider?: string; policy: string; reportEmail?: string; pct: number },
  registry: ProviderRegistry,
) {
  const dnsProvider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnsWrite(dnsProvider.name(), (f) => dnsProvider.supports(f));

  let dmarcValue = `v=DMARC1; p=${input.policy}; pct=${input.pct}`;
  if (input.reportEmail) {
    dmarcValue += `; rua=mailto:${input.reportEmail}`;
  }

  const record: DNSRecord = {
    type: 'TXT',
    name: '_dmarc',
    content: dmarcValue,
    ttl: 300,
  };

  // Prevent duplicate DMARC records (RFC 7489 §6.1: exactly one DMARC record required)
  const existingRecords = await dnsProvider.listDNSRecords(input.domain);
  const existingDmarc = existingRecords.find(
    (r) => r.type === 'TXT' &&
      (r.name === '_dmarc' || r.name === `_dmarc.${input.domain}` || r.name === `_dmarc.${input.domain}.`) &&
      r.content.startsWith('v=DMARC1'),
  );

  if (existingDmarc) {
    if (existingDmarc.content === dmarcValue) {
      return { success: true, record: existingDmarc, dmarcValue };
    }
    const previous = existingDmarc.content;
    const updated = await dnsProvider.updateDNSRecord(input.domain, { ...existingDmarc, content: dmarcValue });
    return { success: true, record: updated, dmarcValue, previous };
  }

  const created = await dnsProvider.createDNSRecord(input.domain, record);
  return { success: true, record: created, dmarcValue };
}

export async function handleSetupMx(
  input: { domain: string; provider?: string; mailProvider: string; customRecords?: Array<{ exchange: string; priority: number }> },
  registry: ProviderRegistry,
) {
  const dnsProvider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnsWrite(dnsProvider.name(), (f) => dnsProvider.supports(f));

  let mxRecords: Array<{ exchange: string; priority: number }>;
  if (input.mailProvider === 'custom') {
    if (!input.customRecords || input.customRecords.length === 0) {
      throw new AgentError(
        'MISSING_PARAMETER',
        "customRecords is required when mailProvider is 'custom'",
        "Provide a customRecords array with exchange and priority fields.",
        'email',
      );
    }
    mxRecords = input.customRecords;
  } else {
    mxRecords = MX_TEMPLATES[input.mailProvider];
    if (!mxRecords) throw new AgentError(
      'INVALID_PARAMETER',
      `Unknown mail provider: ${input.mailProvider}`,
      `Use one of: ${Object.keys(MX_TEMPLATES).join(', ')}, or 'custom' with customRecords.`,
      'email',
    );
  }

  // Check for existing MX records — skip exchanges already present to be idempotent
  const existingRecords = await dnsProvider.listDNSRecords(input.domain);
  const existingExchanges = new Set(
    existingRecords
      .filter((r) => r.type === 'MX' && isRootRecord(r.name, input.domain))
      .map((r) => r.content.toLowerCase()),
  );

  // Use sequential execution to avoid race conditions with providers that use
  // read-modify-write (e.g., Namecheap), where parallel creates would race and
  // only the last write would win.
  const created = [];
  const skipped: string[] = [];
  for (const mx of mxRecords) {
    if (existingExchanges.has(mx.exchange.toLowerCase())) {
      skipped.push(mx.exchange);
      continue;
    }
    const record = await dnsProvider.createDNSRecord(input.domain, {
      type: 'MX',
      name: '@',
      content: mx.exchange,
      ttl: 300,
      priority: mx.priority,
    });
    created.push(record);
  }

  return { success: true, created, ...(skipped.length > 0 ? { alreadyPresent: skipped } : {}) };
}
