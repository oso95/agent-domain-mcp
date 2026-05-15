export enum Feature {
  Registration = 'registration',
  Renewal = 'renewal',
  DnsWrite = 'dns_write',
  NameserverWrite = 'nameserver_write',
  Transfer = 'transfer',
  SSL = 'ssl',
  WhoisContact = 'whois_contact',
  Pricing = 'pricing',
  Dnssec = 'dnssec',
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
  type: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS' | 'SRV' | 'CAA'
      | 'ALIAS' | 'HTTPS' | 'SVCB' | 'TLSA' | 'PTR' | 'SSHFP' | 'NAPTR'
      | 'SOA' | 'DS' | 'CDS' | 'CDNSKEY' | 'CERT' | 'LOC' | 'SMIMEA' | 'URI';
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

/**
 * A single DS (Delegation Signer) record, as published at the parent registry.
 * Field semantics follow RFC 4034 §5.
 */
export interface DnssecDS {
  /** Identifier (0-65535) of the DNSKEY this DS references. */
  keyTag: number;
  /** DNSKEY algorithm. Common values: 8 = RSASHA256, 13 = ECDSAP256SHA256, 14 = ECDSAP384SHA384, 15 = ED25519. */
  algorithm: number;
  /** Digest algorithm: 1 = SHA-1, 2 = SHA-256, 3 = GOST R 34.11-94, 4 = SHA-384. */
  digestType: number;
  /** Hex-encoded digest of the referenced DNSKEY (lowercase by convention). */
  digest: string;
}

/**
 * Aggregated DNSSEC status for a domain.
 *
 * DNSSEC can be configured at two distinct layers and a provider may expose
 * one, both, or none of them:
 *
 *   - **registry**: DS records published at the parent registry (TLD operator).
 *     Required to anchor the chain of trust regardless of where the zone is signed.
 *   - **zone**: the provider's authoritative DNS signs the zone and exposes the
 *     resulting DNSKEY/DS for publication elsewhere.
 *
 * The `scope` field reports which layer(s) are currently active.
 */
export interface DnssecStatus {
  domain: string;
  /** True when at least one of `scope`'s layers is active. */
  enabled: boolean;
  /** DS records currently published at the parent registry, if any. */
  dsRecords?: DnssecDS[];
  /** DNSKEY record if the zone is signed on the provider's DNS (informational). */
  dnsKey?: { flags: number; protocol: number; algorithm: number; publicKey: string };
  /**
   * Where DNSSEC is configured:
   * - 'registry' : DS published at parent only (zone hosted elsewhere)
   * - 'zone'     : provider's DNS signs the zone (DS not yet published or published elsewhere)
   * - 'both'     : zone is signed AND DS is published at the registry
   * - 'none'     : DNSSEC is not active
   */
  scope: 'registry' | 'zone' | 'both' | 'none';
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

  // Nameserver operations (delegation at registrar level — different from DNS records on a zone)
  updateNameservers(domain: string, nameservers: string[]): Promise<void>;

  // DNSSEC operations (optional — providers without DNSSEC support omit them.
  // The MCP tools layer guards on supports(Feature.Dnssec) before invoking.)
  getDnssec?(domain: string): Promise<DnssecStatus>;
  /**
   * Enable DNSSEC for `domain`.
   *
   * Behaviour depends on what the provider exposes and what the caller passes:
   * - If `opts.dsRecords` is provided, the provider publishes those DS records
   *   at the parent registry (registry-side enablement — zone hosted elsewhere).
   * - If `opts.dsRecords` is omitted, the provider activates zone-side DNSSEC
   *   (signs the zone, returns the generated DS/DNSKEY in the status) and may
   *   additionally publish the DS at the registry when both layers are wired.
   */
  enableDnssec?(domain: string, opts?: { dsRecords?: DnssecDS[] }): Promise<DnssecStatus>;
  disableDnssec?(domain: string): Promise<void>;

  // Capability reporting
  supports(feature: Feature): boolean;

  // Optional: batch pricing table for efficient multi-domain checks.
  // Returns TLD → {registration, renewal, currency}. Implementing this avoids
  // N separate pricing API calls when checking multiple domains at once.
  getPricingTable?(): Promise<Record<string, { registration: number; renewal: number; currency: string }>>;
}
