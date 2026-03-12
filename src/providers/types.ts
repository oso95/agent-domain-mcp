export enum Feature {
  Registration = 'registration',
  Renewal = 'renewal',
  DnsWrite = 'dns_write',
  Transfer = 'transfer',
  SSL = 'ssl',
  WhoisContact = 'whois_contact',
  Pricing = 'pricing',
}

export interface Domain {
  name: string;
  provider: string;
  status: 'active' | 'expired' | 'pending' | 'locked';
  expiresAt: string; // ISO 8601
  autoRenew: boolean;
  locked: boolean;
  nameservers: string[];
}

export interface DNSRecord {
  id?: string;
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA';
  name: string;
  content: string;
  ttl: number;
  priority?: number;
}

export interface AvailabilityResult {
  domain: string;
  available: boolean;
  premium: boolean;
  price?: { registration: number; renewal: number; currency: string };
  priceSource?: string;
  /** Only present when 'error' (lookup failed); omitted on success to reduce token cost */
  availabilitySource?: 'rdap' | 'public' | 'whois' | 'error' | string;
  /** Set when all lookup methods failed; available:false in this case means "unknown", not "taken" */
  error?: { code: string; message: string; action?: string; provider?: string };
}

export interface Certificate {
  id: string;
  domain: string;
  status: 'pending' | 'active' | 'expired' | 'failed';
  expiresAt?: string;
  issuedAt?: string;
  /** PEM certificate chain (leaf + intermediates). Only returned by providers that expose certificate material (e.g. Porkbun). */
  certificateChain?: string;
  /** PEM private key. Treat as a secret — store securely and do not log. Only returned by providers that expose certificate material (e.g. Porkbun). */
  privateKey?: string;
}

export interface Transfer {
  domain: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed' | 'cancelled';
  initiatedAt?: string;
  completedAt?: string;
}

export interface Contact {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  address1: string;
  city: string;
  state: string;
  postalCode: string;
  country: string; // ISO 3166-1 alpha-2
}

export interface RegisterRequest {
  domain: string;
  years: number;
  contact: Contact;
  autoRenew: boolean;
  privacyProtection: boolean;
}

export interface Provider {
  name(): string;

  // Domain operations
  checkAvailability(domain: string): Promise<AvailabilityResult>;
  listDomains(): Promise<Domain[]>;
  getDomain(domain: string): Promise<Domain>;
  registerDomain(req: RegisterRequest): Promise<Domain>;
  renewDomain(domain: string, years: number): Promise<void>;

  // DNS operations
  listDNSRecords(domain: string): Promise<DNSRecord[]>;
  createDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord>;
  updateDNSRecord(domain: string, record: DNSRecord): Promise<DNSRecord>;
  deleteDNSRecord(domain: string, recordId: string): Promise<void>;

  // SSL operations
  listCertificates(domain: string): Promise<Certificate[]>;
  createCertificate(domain: string): Promise<Certificate>;
  getCertificateStatus(certId: string): Promise<Certificate>;

  // Transfer operations
  initiateTransfer(domain: string, authCode: string): Promise<Transfer>;
  getTransferStatus(domain: string): Promise<Transfer>;

  // Contact operations
  getWhoisContact(domain: string): Promise<Contact>;
  updateWhoisContact(domain: string, contact: Contact): Promise<void>;

  // Capability reporting
  supports(feature: Feature): boolean;

  // Optional: batch pricing table for efficient multi-domain checks.
  // Returns TLD → {registration, renewal, currency}. Implementing this avoids
  // N separate pricing API calls when checking multiple domains at once.
  getPricingTable?(): Promise<Record<string, { registration: number; renewal: number; currency: string }>>;
}
