import Bottleneck from 'bottleneck';
import { AgentError } from '../../errors.js';
import { parseXML, checkNamecheapStatus, type NamecheapEnvelope } from './xml.js';

interface NamecheapConfig {
  apiKey: string;
  apiUser: string;
  clientIp?: string;
  sandbox?: boolean;
}

async function detectPublicIp(): Promise<string> {
  // Try two services in sequence — if the first fails, fall back to the second
  const services = [
    { url: 'https://api.ipify.org?format=json', parse: (d: unknown) => (d as { ip: string }).ip },
    { url: 'https://api4.my-ip.io/v2/ip.json', parse: (d: unknown) => (d as { ip: string }).ip },
  ];
  for (const svc of services) {
    try {
      const res = await fetch(svc.url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      const ip = svc.parse(data);
      if (ip && ip !== '127.0.0.1') return ip;
    } catch {
      // Try next service
    }
  }
  // Return empty string rather than 127.0.0.1 — Namecheap will reject it with a clear
  // IP_NOT_WHITELISTED error that tells the user to whitelist their IP, which is
  // more actionable than silently using a loopback address that is clearly wrong.
  return '';
}

export class NamecheapClient {
  private config: NamecheapConfig;
  private baseUrl: string;
  private resolvedClientIp: string | null = null;
  // 20 req/min = minTime 3000ms
  private limiter: Bottleneck;

  constructor(config: NamecheapConfig) {
    this.config = config;
    this.baseUrl = config.sandbox
      ? 'https://api.sandbox.namecheap.com/xml.response'
      : 'https://api.namecheap.com/xml.response';
    this.limiter = new Bottleneck({ minTime: 3000, maxConcurrent: 1 });
  }

  private async getClientIp(): Promise<string> {
    if (this.config.clientIp) return this.config.clientIp;
    if (this.resolvedClientIp) return this.resolvedClientIp;
    this.resolvedClientIp = await detectPublicIp();
    return this.resolvedClientIp;
  }

  private async buildParams(command: string, extra: Record<string, string> = {}): Promise<URLSearchParams> {
    const clientIp = await this.getClientIp();
    const params = new URLSearchParams({
      ApiUser: this.config.apiUser,
      ApiKey: this.config.apiKey,
      UserName: this.config.apiUser,
      Command: command,
      ClientIp: clientIp,
      ...extra,
    });
    return params;
  }

  async call<T extends object>(
    command: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    return this.limiter.schedule(async () => {
      // attemptsRemaining: retry budget shared between rate-limit (500000) and network failures.
      // Non-retryable errors (auth, domain-not-found) throw immediately from checkNamecheapStatus.
      let attemptsRemaining = 3;
      let delay = 3000;

      while (attemptsRemaining > 0) { // decremented by network failures and rate-limit errors
        const urlParams = await this.buildParams(command, params);
        const url = `${this.baseUrl}?${urlParams.toString()}`;

        let res: Response;
        try {
          res = await fetch(url, {
            method: 'GET',
            signal: AbortSignal.timeout(30000),
          });
        } catch (err) {
          // Network failure or timeout — retry with backoff
          attemptsRemaining--;
          if (attemptsRemaining > 0) {
            await sleep(delay);
            delay *= 2;
            continue;
          }
          const isTimeout = err instanceof Error && err.name === 'TimeoutError';
          throw new AgentError(
            isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
            isTimeout
              ? `Namecheap API request timed out after 30 seconds (command: ${command}).`
              : `Namecheap API network error: ${err instanceof Error ? err.message : String(err)}`,
            'Check your internet connection and try again.',
            'namecheap',
          );
        }

        const xml = await res.text();
        const envelope = parseXML<NamecheapEnvelope>(xml);

        // Check for rate limit (code 500000)
        const errors = envelope.ApiResponse.Errors?.Error ?? [];
        if (errors.some((e) => String(e['@_Number']) === '500000')) {
          attemptsRemaining--;
          if (attemptsRemaining > 0) {
            await sleep(delay);
            delay *= 2;
            continue;
          }
          break; // exhausted retries — fall through to throw RATE_LIMIT
        }

        checkNamecheapStatus(envelope, command);
        return envelope.ApiResponse.CommandResponse as T;
      }

      throw new AgentError(
        'RATE_LIMIT',
        'Namecheap API rate limit reached (20 requests/minute). Retrying automatically with backoff.',
        'Wait a moment and try again.',
        'namecheap',
      );
    });
  }

  async listDomains(): Promise<NamecheapDomainItem[]> {
    interface Response {
      // 'Domain' is in isArray so always an array
      DomainGetListResult?: { Domain?: NamecheapDomainItem[] };
      Paging?: { TotalItems?: number; CurrentPage?: number; PageSize?: number };
    }
    const PAGE_SIZE = 100; // Namecheap max
    const all: NamecheapDomainItem[] = [];
    let page = 1;

    while (true) {
      const data = await this.call<Response>('namecheap.domains.getList', {
        PageSize: String(PAGE_SIZE),
        Page: String(page),
      });

      const items = data.DomainGetListResult?.Domain ?? [];
      all.push(...items);

      const totalItems = data.Paging?.TotalItems ?? items.length;
      if (all.length >= totalItems || items.length < PAGE_SIZE) break;
      page++;
    }

    return all;
  }

  async getDomainInfo(domain: string): Promise<NamecheapDomainInfo> {
    interface Response {
      DomainGetInfoResult?: NamecheapDomainInfo;
    }
    const data = await this.call<Response>('namecheap.domains.getInfo', { DomainName: domain });
    if (!data.DomainGetInfoResult) {
      throw new AgentError('DOMAIN_NOT_FOUND', `Domain '${domain}' not found.`, 'Verify the domain is in your Namecheap account.', 'namecheap');
    }
    return data.DomainGetInfoResult;
  }

  async registerDomain(params: {
    domain: string; years: number;
    contact: { firstName: string; lastName: string; email: string; phone: string; address1: string; city: string; state: string; postalCode: string; country: string };
    autoRenew: boolean; privacyProtection: boolean;
  }): Promise<void> {
    const [sld, ...tldParts] = params.domain.split('.');
    const tld = tldParts.join('.');

    const contactFields = (prefix: string) => ({
      [`${prefix}FirstName`]: params.contact.firstName,
      [`${prefix}LastName`]: params.contact.lastName,
      [`${prefix}EmailAddress`]: params.contact.email,
      [`${prefix}Phone`]: params.contact.phone,
      [`${prefix}Address1`]: params.contact.address1,
      [`${prefix}City`]: params.contact.city,
      [`${prefix}StateProvince`]: params.contact.state,
      [`${prefix}PostalCode`]: params.contact.postalCode,
      [`${prefix}Country`]: params.contact.country,
    });

    await this.call('namecheap.domains.create', {
      DomainName: params.domain,
      SLD: sld,
      TLD: tld,
      Years: String(params.years),
      AutoRenew: params.autoRenew ? 'yes' : 'no',
      AddFreeWhoisguard: params.privacyProtection ? 'yes' : 'no',
      WGEnabled: params.privacyProtection ? 'yes' : 'no',
      ...contactFields('Registrant'),
      ...contactFields('Admin'),
      ...contactFields('Tech'),
      ...contactFields('AuxBilling'),
    });
  }

  async renewDomain(domain: string, years: number): Promise<void> {
    const [sld, ...tldParts] = domain.split('.');
    await this.call('namecheap.domains.renew', {
      DomainName: domain,
      SLD: sld,
      TLD: tldParts.join('.'),
      Years: String(years),
    });
  }

  // DNS: Read all records
  async getDNSRecords(sld: string, tld: string): Promise<NamecheapHostRecord[]> {
    interface Response {
      DomainDNSGetHostsResult?: {
        // Namecheap XML returns <Host .../> — 'Host' is in isArray so always an array
        Host?: NamecheapHostRecord[];
      };
    }
    const data = await this.call<Response>('namecheap.domains.dns.getHosts', { SLD: sld, TLD: tld });
    return data.DomainDNSGetHostsResult?.Host ?? [];
  }

  // DNS: Write all records at once (Namecheap set-all pattern)
  async setDNSRecords(sld: string, tld: string, records: NamecheapHostRecord[]): Promise<void> {
    const params: Record<string, string> = { SLD: sld, TLD: tld };
    records.forEach((r, i) => {
      params[`HostName${i + 1}`] = r['@_Name'];
      params[`RecordType${i + 1}`] = r['@_Type'];
      params[`Address${i + 1}`] = r['@_Address'];
      params[`TTL${i + 1}`] = String(r['@_TTL'] ?? 300);
      if (r['@_MXPref']) params[`MXPref${i + 1}`] = String(r['@_MXPref']);
    });
    await this.call('namecheap.domains.dns.setHosts', params);
  }

  async getWhoisContact(domain: string): Promise<NamecheapContact> {
    interface Response {
      DomainContactsResult?: { Registrant?: NamecheapContact };
    }
    const data = await this.call<Response>('namecheap.domains.getContacts', { DomainName: domain });
    return data.DomainContactsResult?.Registrant ?? {} as NamecheapContact;
  }

  async updateWhoisContact(domain: string, contact: NamecheapContact): Promise<void> {
    await this.call('namecheap.domains.setContacts', {
      DomainName: domain,
      RegistrantFirstName: contact.FirstName ?? '',
      RegistrantLastName: contact.LastName ?? '',
      RegistrantEmailAddress: contact.EmailAddress ?? '',
      RegistrantPhone: contact.Phone ?? '',
      RegistrantAddress1: contact.Address1 ?? '',
      RegistrantCity: contact.City ?? '',
      RegistrantStateProvince: contact.StateProvince ?? '',
      RegistrantPostalCode: contact.PostalCode ?? '',
      RegistrantCountry: contact.Country ?? '',
      // Namecheap requires all contact types; repeat for admin/tech/billing
      AdminFirstName: contact.FirstName ?? '',
      AdminLastName: contact.LastName ?? '',
      AdminEmailAddress: contact.EmailAddress ?? '',
      AdminPhone: contact.Phone ?? '',
      AdminAddress1: contact.Address1 ?? '',
      AdminCity: contact.City ?? '',
      AdminStateProvince: contact.StateProvince ?? '',
      AdminPostalCode: contact.PostalCode ?? '',
      AdminCountry: contact.Country ?? '',
      TechFirstName: contact.FirstName ?? '',
      TechLastName: contact.LastName ?? '',
      TechEmailAddress: contact.EmailAddress ?? '',
      TechPhone: contact.Phone ?? '',
      TechAddress1: contact.Address1 ?? '',
      TechCity: contact.City ?? '',
      TechStateProvince: contact.StateProvince ?? '',
      TechPostalCode: contact.PostalCode ?? '',
      TechCountry: contact.Country ?? '',
      AuxBillingFirstName: contact.FirstName ?? '',
      AuxBillingLastName: contact.LastName ?? '',
      AuxBillingEmailAddress: contact.EmailAddress ?? '',
      AuxBillingPhone: contact.Phone ?? '',
      AuxBillingAddress1: contact.Address1 ?? '',
      AuxBillingCity: contact.City ?? '',
      AuxBillingStateProvince: contact.StateProvince ?? '',
      AuxBillingPostalCode: contact.PostalCode ?? '',
      AuxBillingCountry: contact.Country ?? '',
    });
  }

  // Pricing: returns TLD → { registration, renewal, currency } for all domain TLDs in one call
  async getPricingTable(): Promise<Record<string, { registration: number; renewal: number; currency: string }>> {
    interface PriceAttr {
      '@_Duration': number;
      '@_DurationType': string;
      '@_Price': number;
      '@_Currency': string;
    }
    interface ProductAttr {
      '@_Name': string;
      // Price is in isArray — always an array
      Price?: PriceAttr[];
    }
    interface CategoryAttr {
      '@_Name': string;
      // Product is in isArray — always an array
      Product?: ProductAttr[];
    }
    interface Response {
      UserGetPricingResult?: {
        ProductType?: {
          '@_Name': string;
          // ProductCategory is in isArray — always an array
          ProductCategory?: CategoryAttr[];
        };
      };
    }

    const data = await this.call<Response>('namecheap.users.getPricing', { ProductType: 'DOMAIN' });
    const productType = data.UserGetPricingResult?.ProductType;
    if (!productType) return {};

    // ProductCategory/Product/Price are in xml.ts isArray — no defensive Array.isArray needed
    const categories = productType.ProductCategory ?? [];

    // Build maps: TLD → price for REGISTER and RENEW categories
    const regPrices: Record<string, { price: number; currency: string }> = {};
    const renewPrices: Record<string, { price: number; currency: string }> = {};

    for (const category of categories) {
      const target = category['@_Name']?.toUpperCase() === 'REGISTER' ? regPrices : category['@_Name']?.toUpperCase() === 'RENEW' ? renewPrices : null;
      if (!target) continue;
      const products = category.Product ?? [];
      for (const product of products) {
        const tld = product['@_Name']?.toLowerCase();
        if (!tld) continue;
        // Take the 1-year price (Duration=1, DurationType=YEAR)
        const prices = product.Price ?? [];
        const yearPrice = prices.find((p) => Number(p['@_Duration']) === 1 && p['@_DurationType']?.toUpperCase() === 'YEAR');
        if (yearPrice) {
          target[tld] = { price: yearPrice['@_Price'], currency: yearPrice['@_Currency'] };
        }
      }
    }

    // Include TLDs from both reg and renew sets (union). Renewal-only TLDs get no registration price.
    const allTlds = new Set([...Object.keys(regPrices), ...Object.keys(renewPrices)]);
    const table: Record<string, { registration: number; renewal: number; currency: string }> = {};
    for (const tld of allTlds) {
      const reg = regPrices[tld];
      const renew = renewPrices[tld];
      // Only include in results if we have at least a registration price (needed for availability enrichment)
      if (!reg) continue;
      table[tld] = {
        registration: reg.price,
        // Use actual renewal price when available; fall back to registration only as last resort
        renewal: renew?.price ?? reg.price,
        currency: reg.currency,
      };
    }
    return table;
  }

  // SSL (Namecheap has basic SSL product API)
  async listSSLCerts(): Promise<unknown[]> {
    interface Response {
      // SSL is in isArray — always an array
      SSLListResult?: { SSL?: unknown[] };
    }
    const data = await this.call<Response>('namecheap.ssl.getList');
    return data.SSLListResult?.SSL ?? [];
  }
}

export interface NamecheapDomainItem {
  '@_Name': string;
  '@_User': string;
  '@_Created': string;
  '@_Expires': string;
  '@_IsExpired': string;
  '@_IsLocked': string;
  '@_AutoRenew': string;
}

export interface NamecheapDomainInfo {
  '@_DomainName': string;
  '@_Status': string;
  '@_IsLocked'?: string;
  DomainDetails?: {
    CreatedDate?: string;
    ExpiredDate?: string;
    NumYears?: string;
    AutoRenew?: string;
  };
  DnsDetails?: {
    Nameserver?: string | string[];
    '@_IsUsingOurDNS': string;
    '@_ProviderType': string;
  };
  Modificationrights?: { '@_All': string };
}

export interface NamecheapHostRecord {
  '@_Name': string;
  '@_Type': string;
  '@_Address': string;
  '@_MXPref'?: number;
  '@_TTL'?: number;
  '@_AssociatedAppTitle'?: string;
  '@_FriendlyName'?: string;
  '@_IsActive'?: string;
  '@_IsDDNSEnabled'?: string;
  '@_HostId'?: string | number; // XMLParser with parseAttributeValue:true may return number
}

export interface NamecheapContact {
  FirstName?: string;
  LastName?: string;
  EmailAddress?: string;
  Phone?: string;
  Address1?: string;
  City?: string;
  StateProvince?: string;
  PostalCode?: string;
  Country?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
