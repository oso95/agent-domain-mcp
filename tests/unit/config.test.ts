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
    delete process.env.WEBNIC_USERNAME;
    delete process.env.WEBNIC_PASSWORD;
    delete process.env.WEBNIC_SANDBOX;
    delete process.env.WEBNIC_DEFAULT_CONTACT_ID;
    delete process.env.WEBNIC_DEFAULT_REGISTRANT_USER_ID;
    delete process.env.WEBNIC_DEFAULT_NAMESERVERS;
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

  it('loads webnic config with credentials + sandbox + defaults', () => {
    process.env.WEBNIC_USERNAME = 'wn_user';
    process.env.WEBNIC_PASSWORD = 'wn_pass';
    process.env.WEBNIC_SANDBOX = 'true';
    process.env.WEBNIC_DEFAULT_CONTACT_ID = 'WN1234T';
    process.env.WEBNIC_DEFAULT_REGISTRANT_USER_ID = 'REG100015';
    process.env.WEBNIC_DEFAULT_NAMESERVERS = 'ns1.web.cc, ns2.web.cc';
    const config = loadConfig();
    expect(config.webnic?.username).toBe('wn_user');
    expect(config.webnic?.password).toBe('wn_pass');
    expect(config.webnic?.sandbox).toBe(true);
    expect(config.webnic?.defaultContactId).toBe('WN1234T');
    expect(config.webnic?.defaultRegistrantUserId).toBe('REG100015');
    expect(config.webnic?.defaultNameservers).toEqual(['ns1.web.cc', 'ns2.web.cc']);
  });

  it('does not load webnic with only username', () => {
    process.env.WEBNIC_USERNAME = 'wn_user';
    const config = loadConfig();
    expect(config.webnic).toBeUndefined();
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
    expect(names).toContain('webnic');
  });

  it('excludes configured providers', () => {
    const config = { porkbun: { apiKey: 'x', secretApiKey: 'y' } };
    const names = getUnconfiguredProviderNames(config);
    expect(names).not.toContain('porkbun');
    expect(names).toContain('namecheap');
  });
});
