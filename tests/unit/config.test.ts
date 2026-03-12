import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, getConfiguredProviderNames, getUnconfiguredProviderNames } from '../../src/config.js';

describe('loadConfig', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
    // Clear all provider env vars
    delete process.env.PORKBUN_API_KEY;
    delete process.env.PORKBUN_SECRET_API_KEY;
    delete process.env.NAMECHEAP_API_KEY;
    delete process.env.NAMECHEAP_API_USER;
    delete process.env.GODADDY_API_KEY;
    delete process.env.GODADDY_API_SECRET;
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('returns empty config when no env vars set', () => {
    const config = loadConfig();
    expect(config.porkbun).toBeUndefined();
    expect(config.namecheap).toBeUndefined();
    expect(config.godaddy).toBeUndefined();
    expect(config.cloudflare).toBeUndefined();
  });

  it('loads porkbun config when both keys are set', () => {
    process.env.PORKBUN_API_KEY = 'pk1_test';
    process.env.PORKBUN_SECRET_API_KEY = 'sk1_test';
    const config = loadConfig();
    expect(config.porkbun?.apiKey).toBe('pk1_test');
    expect(config.porkbun?.secretApiKey).toBe('sk1_test');
  });

  it('does not load porkbun with only one key', () => {
    process.env.PORKBUN_API_KEY = 'pk1_test';
    // No PORKBUN_SECRET_API_KEY
    const config = loadConfig();
    expect(config.porkbun).toBeUndefined();
  });

  it('loads cloudflare config', () => {
    process.env.CLOUDFLARE_API_TOKEN = 'cf_token';
    process.env.CLOUDFLARE_ACCOUNT_ID = 'acct_id';
    const config = loadConfig();
    expect(config.cloudflare?.apiToken).toBe('cf_token');
    expect(config.cloudflare?.accountId).toBe('acct_id');
  });

  it('loads namecheap config', () => {
    process.env.NAMECHEAP_API_KEY = 'nc_key';
    process.env.NAMECHEAP_API_USER = 'nc_user';
    const config = loadConfig();
    expect(config.namecheap?.apiKey).toBe('nc_key');
    expect(config.namecheap?.apiUser).toBe('nc_user');
  });

  it('loads godaddy config', () => {
    process.env.GODADDY_API_KEY = 'gd_key';
    process.env.GODADDY_API_SECRET = 'gd_secret';
    const config = loadConfig();
    expect(config.godaddy?.apiKey).toBe('gd_key');
    expect(config.godaddy?.apiSecret).toBe('gd_secret');
  });
});

describe('getConfiguredProviderNames', () => {
  it('returns empty array when no providers configured', () => {
    expect(getConfiguredProviderNames({})).toEqual([]);
  });

  it('returns names of configured providers', () => {
    const config = {
      porkbun: { apiKey: 'x', secretApiKey: 'y' },
      cloudflare: { apiToken: 'z' },
    };
    const names = getConfiguredProviderNames(config);
    expect(names).toContain('porkbun');
    expect(names).toContain('cloudflare');
    expect(names).not.toContain('namecheap');
    expect(names).not.toContain('godaddy');
  });
});

describe('getUnconfiguredProviderNames', () => {
  it('returns all providers when none configured', () => {
    const names = getUnconfiguredProviderNames({});
    expect(names).toContain('porkbun');
    expect(names).toContain('namecheap');
    expect(names).toContain('godaddy');
    expect(names).toContain('cloudflare');
  });

  it('excludes configured providers', () => {
    const config = { porkbun: { apiKey: 'x', secretApiKey: 'y' } };
    const names = getUnconfiguredProviderNames(config);
    expect(names).not.toContain('porkbun');
    expect(names).toContain('namecheap');
  });
});
