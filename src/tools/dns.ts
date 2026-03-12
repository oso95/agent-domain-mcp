import type { ProviderRegistry } from '../registry.js';
import type { DNSRecord } from '../providers/types.js';
import { assertDnsWrite } from './guards.js';

export async function handleListDnsRecords(input: { domain: string; provider?: string }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  const records = await provider.listDNSRecords(input.domain);
  return { records: records.map(stripRecord) };
}


function stripRecord(r: DNSRecord): Record<string, unknown> {
  const clean: Record<string, unknown> = { type: r.type, name: r.name, content: r.content, ttl: r.ttl };
  if (r.id !== undefined) clean.id = r.id;
  if (r.priority !== undefined) clean.priority = r.priority;
  return clean;
}

export async function handleCreateDnsRecord(
  input: { domain: string; provider?: string } & DNSRecord,
  registry: ProviderRegistry,
) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnsWrite(provider.name(), (f) => provider.supports(f));
  const record: DNSRecord = { type: input.type, name: input.name, content: input.content, ttl: input.ttl, priority: input.priority };
  const created = await provider.createDNSRecord(input.domain, record);
  return stripRecord(created);
}

export async function handleUpdateDnsRecord(
  input: { domain: string; provider?: string; id: string } & DNSRecord,
  registry: ProviderRegistry,
) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnsWrite(provider.name(), (f) => provider.supports(f));
  const record: DNSRecord = { id: input.id, type: input.type, name: input.name, content: input.content, ttl: input.ttl, priority: input.priority };
  const updated = await provider.updateDNSRecord(input.domain, record);
  return stripRecord(updated);
}

export async function handleDeleteDnsRecord(input: { domain: string; id: string; provider?: string }, registry: ProviderRegistry) {
  const provider = input.provider ? registry.get(input.provider) : await registry.resolveProviderForDomain(input.domain);
  assertDnsWrite(provider.name(), (f) => provider.supports(f));
  await provider.deleteDNSRecord(input.domain, input.id);
  return { success: true, id: input.id, domain: input.domain };
}
