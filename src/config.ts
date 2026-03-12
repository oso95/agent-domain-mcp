export interface ProviderConfig {
  porkbun?: {
    apiKey: string;
    secretApiKey: string;
  };
  namecheap?: {
    apiKey: string;
    apiUser: string;
    clientIp?: string;
    sandbox?: boolean;
  };
  godaddy?: {
    apiKey: string;
    apiSecret: string;
    sandbox?: boolean;
  };
  cloudflare?: {
    apiToken: string;
    accountId?: string;
  };
}

export function loadConfig(): ProviderConfig {
  const config: ProviderConfig = {};

  if (process.env.PORKBUN_API_KEY && process.env.PORKBUN_SECRET_API_KEY) {
    config.porkbun = {
      apiKey: process.env.PORKBUN_API_KEY,
      secretApiKey: process.env.PORKBUN_SECRET_API_KEY,
    };
  }

  if (process.env.NAMECHEAP_API_KEY && process.env.NAMECHEAP_API_USER) {
    config.namecheap = {
      apiKey: process.env.NAMECHEAP_API_KEY,
      apiUser: process.env.NAMECHEAP_API_USER,
      clientIp: process.env.NAMECHEAP_CLIENT_IP,
      sandbox: process.env.NAMECHEAP_SANDBOX === 'true',
    };
  }

  if (process.env.GODADDY_API_KEY && process.env.GODADDY_API_SECRET) {
    config.godaddy = {
      apiKey: process.env.GODADDY_API_KEY,
      apiSecret: process.env.GODADDY_API_SECRET,
      sandbox: process.env.GODADDY_SANDBOX === 'true',
    };
  }

  if (process.env.CLOUDFLARE_API_TOKEN) {
    config.cloudflare = {
      apiToken: process.env.CLOUDFLARE_API_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    };
  }

  return config;
}

export function getConfiguredProviderNames(config: ProviderConfig): string[] {
  const names: string[] = [];
  if (config.porkbun) names.push('porkbun');
  if (config.namecheap) names.push('namecheap');
  if (config.godaddy) names.push('godaddy');
  if (config.cloudflare) names.push('cloudflare');
  return names;
}

export function getUnconfiguredProviderNames(config: ProviderConfig): string[] {
  const all = ['porkbun', 'namecheap', 'godaddy', 'cloudflare'];
  const configured = getConfiguredProviderNames(config);
  return all.filter((p) => !configured.includes(p));
}
