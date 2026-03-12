/**
 * Integration smoke test — runs against real Porkbun (production) and Namecheap (sandbox) APIs.
 * Usage: node scripts/smoke-test.mjs
 */
import { buildRegistry } from '../dist/registry.js';
import { loadConfig } from '../dist/config.js';

const config = loadConfig();
const registry = await buildRegistry(config);

const GREEN  = '\x1b[32m✓\x1b[0m';
const RED    = '\x1b[31m✗\x1b[0m';
const YELLOW = '\x1b[33m~\x1b[0m';
const BOLD   = '\x1b[1m';
const RESET  = '\x1b[0m';

let passed = 0, failed = 0, skipped = 0;

async function test(label, fn) {
  try {
    const result = await fn();
    console.log(`${GREEN} ${label}`);
    if (result !== undefined) {
      const lines = JSON.stringify(result, null, 2).split('\n');
      console.log('   ' + lines.slice(0, 10).join('\n   ') + (lines.length > 10 ? '\n   ...' : ''));
    }
    passed++;
  } catch (err) {
    if (err?.code === 'FEATURE_NOT_SUPPORTED' || err?.code === 'IP_NOT_WHITELISTED') {
      console.log(`${YELLOW} ${label} — skipped (${err.code}: ${err.message})`);
      skipped++;
    } else {
      console.log(`${RED} ${label}`);
      console.log(`   Error [${err?.code ?? err?.name}]: ${err?.message}`);
      if (err?.action) console.log(`   Action: ${err.action}`);
      if (err?.raw) console.log(`   Raw: ${err.raw}`);
      failed++;
    }
  }
}

function section(name) {
  console.log(`\n${BOLD}── ${name} ──${RESET}`);
}

// ── list_providers ───────────────────────────────────────────────────────────
section('list_providers');
await test('returns configured providers', async () => {
  const { handleListProviders } = await import('../dist/tools/providers.js');
  const result = handleListProviders(registry, config);
  return {
    configured: result.configured.map(p => `${p.name} (supports: ${p.supports.join(', ')})`),
    unconfigured: result.unconfigured,
  };
});

// ── Porkbun ──────────────────────────────────────────────────────────────────
section('Porkbun (production)');

if (!registry.has('porkbun')) {
  console.log(`${YELLOW} Porkbun not configured — skipping`);
  skipped += 5;
} else {
  await test('list_domains', async () => {
    const { handleListDomains } = await import('../dist/tools/domains.js');
    const result = await handleListDomains({ provider: 'porkbun' }, registry);
    return { count: result.domains.length, domains: result.domains.map(d => d.name) };
  });

  await test('check_availability — example.com (taken, with pricing)', async () => {
    const { handleCheckAvailability } = await import('../dist/tools/availability.js');
    const result = await handleCheckAvailability({ domain: 'example', tlds: ['com'], provider: 'porkbun' }, registry);
    return result;
  });

  await test('check_availability — random domain (should be available + price)', async () => {
    const { handleCheckAvailability } = await import('../dist/tools/availability.js');
    const rand = 'xq9ztestdomain' + Date.now();
    const result = await handleCheckAvailability({ domain: rand, tlds: ['com', 'io'], provider: 'porkbun' }, registry);
    return result;
  });

  await test('list_dns_records — first domain', async () => {
    const { handleListDomains } = await import('../dist/tools/domains.js');
    const { handleListDnsRecords } = await import('../dist/tools/dns.js');
    const { domains } = await handleListDomains({ provider: 'porkbun' }, registry);
    if (domains.length === 0) return { note: 'no domains in account' };
    const domain = domains[0].name;
    const result = await handleListDnsRecords({ domain, provider: 'porkbun' }, registry);
    return { domain, recordCount: result.records.length, types: [...new Set(result.records.map(r => r.type))] };
  });

  await test('get_domain — first domain details', async () => {
    const { handleListDomains } = await import('../dist/tools/domains.js');
    const { handleGetDomain } = await import('../dist/tools/domains.js');
    const { domains } = await handleListDomains({ provider: 'porkbun' }, registry);
    if (domains.length === 0) return { note: 'no domains in account' };
    return handleGetDomain({ domain: domains[0].name, provider: 'porkbun' }, registry);
  });
}

// ── Namecheap ────────────────────────────────────────────────────────────────
section('Namecheap (sandbox)');

if (!registry.has('namecheap')) {
  console.log(`${YELLOW} Namecheap not configured — skipping`);
  skipped += 3;
} else {
  await test('list_domains', async () => {
    const { handleListDomains } = await import('../dist/tools/domains.js');
    const result = await handleListDomains({ provider: 'namecheap' }, registry);
    return { count: result.domains.length, domains: result.domains.map(d => d.name) };
  });

  await test('check_availability — example.com', async () => {
    const { handleCheckAvailability } = await import('../dist/tools/availability.js');
    const result = await handleCheckAvailability({ domain: 'example', tlds: ['com'] }, registry);
    return result;
  });

  await test('list_dns_records — first domain', async () => {
    const { handleListDomains } = await import('../dist/tools/domains.js');
    const { handleListDnsRecords } = await import('../dist/tools/dns.js');
    const { domains } = await handleListDomains({ provider: 'namecheap' }, registry);
    if (domains.length === 0) return { note: 'no domains in Namecheap sandbox' };
    const domain = domains[0].name;
    const result = await handleListDnsRecords({ domain, provider: 'namecheap' }, registry);
    return { domain, recordCount: result.records.length, records: result.records.slice(0, 3) };
  });
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${BOLD}Results:${RESET} ${GREEN} ${passed} passed  ${RED} ${failed} failed  ${YELLOW} ${skipped} skipped\n`);
if (failed > 0) process.exit(1);
