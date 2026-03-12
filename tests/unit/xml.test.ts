import { describe, it, expect } from 'vitest';
import { parseXML, checkNamecheapStatus, type NamecheapEnvelope } from '../../src/providers/namecheap/xml.js';
import { AgentError } from '../../src/errors.js';

describe('parseXML', () => {
  it('parses valid XML', () => {
    const xml = `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.check"><DomainCheckResult Domain="example.com" Available="true" /></CommandResponse></ApiResponse>`;
    const result = parseXML<NamecheapEnvelope>(xml);
    expect(result.ApiResponse['@_Status']).toBe('OK');
  });

  it('preserves XML tag casing for Host elements (regression: was accessed as .host)', () => {
    // Namecheap returns <Host .../> — fast-xml-parser preserves casing.
    // This test guards against the bug where .host (lowercase) was used instead of .Host.
    const xml = `<?xml version="1.0" encoding="utf-8"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.dns.getHosts"><DomainDNSGetHostsResult Domain="example.com" IsUsingOurDNS="true"><Host HostId="12" Name="@" Type="A" Address="1.2.3.4" MXPref="10" TTL="1800" /><Host HostId="14" Name="www" Type="A" Address="5.6.7.8" MXPref="10" TTL="1800" /></DomainDNSGetHostsResult></CommandResponse></ApiResponse>`;
    const result = parseXML<{
      ApiResponse: {
        CommandResponse?: {
          DomainDNSGetHostsResult?: {
            Host?: Array<{ '@_Name': string; '@_Type': string; '@_Address': string }>;
          };
        };
      };
    }>(xml);
    const hosts = result.ApiResponse.CommandResponse?.DomainDNSGetHostsResult?.Host;
    expect(Array.isArray(hosts)).toBe(true);
    expect(hosts).toHaveLength(2);
    expect(hosts?.[0]['@_Name']).toBe('@');
    expect(hosts?.[0]['@_Type']).toBe('A');
    expect(hosts?.[1]['@_Name']).toBe('www');
  });

  it('does NOT wrap DomainGetListResult in an array (regression: was in isArray list)', () => {
    // DomainGetListResult must NOT be in isArray — it's a single container element.
    // If it were in isArray, data.DomainGetListResult?.Domain would be undefined
    // because data.DomainGetListResult would be [{Domain:[...]}] (an array).
    const xml = `<?xml version="1.0"?><ApiResponse Status="OK"><CommandResponse Type="namecheap.domains.getList"><DomainGetListResult><Domain Name="example.com" /><Domain Name="test.com" /></DomainGetListResult></CommandResponse></ApiResponse>`;
    const result = parseXML<{
      ApiResponse: {
        CommandResponse?: {
          DomainGetListResult?: {
            Domain?: Array<{ '@_Name': string }>;
          };
        };
      };
    }>(xml);
    const listResult = result.ApiResponse.CommandResponse?.DomainGetListResult;
    // Must be an object, not an array
    expect(Array.isArray(listResult)).toBe(false);
    expect(Array.isArray(listResult?.Domain)).toBe(true);
    expect(listResult?.Domain).toHaveLength(2);
    expect(listResult?.Domain?.[0]['@_Name']).toBe('example.com');
  });

  it('parses even lenient/malformed XML without throwing (fast-xml-parser is permissive)', () => {
    // fast-xml-parser does not throw on most malformed XML - it parses leniently
    // parseXML only throws if the underlying parser itself throws
    expect(() => parseXML<unknown>('<root><child></child></root>')).not.toThrow();
  });
});

describe('checkNamecheapStatus', () => {
  it('does nothing on OK status', () => {
    const envelope: NamecheapEnvelope = {
      ApiResponse: { '@_Status': 'OK' },
    };
    expect(() => checkNamecheapStatus(envelope, 'test')).not.toThrow();
  });

  it('throws AgentError with IP_NOT_WHITELISTED for IP errors', () => {
    const envelope: NamecheapEnvelope = {
      ApiResponse: {
        '@_Status': 'ERROR',
        Errors: {
          Error: [{ '#text': 'IP not whitelisted', '@_Number': '1011102' }],
        },
      },
    };
    try {
      checkNamecheapStatus(envelope, 'test');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe('IP_NOT_WHITELISTED');
    }
  });

  it('throws AgentError with RATE_LIMIT for code 500000', () => {
    const envelope: NamecheapEnvelope = {
      ApiResponse: {
        '@_Status': 'ERROR',
        Errors: {
          Error: [{ '#text': 'Too many requests', '@_Number': '500000' }],
        },
      },
    };
    try {
      checkNamecheapStatus(envelope, 'test');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe('RATE_LIMIT');
    }
  });

  it('throws AgentError with AUTH_FAILED for auth errors', () => {
    const envelope: NamecheapEnvelope = {
      ApiResponse: {
        '@_Status': 'ERROR',
        Errors: {
          Error: [{ '#text': 'Invalid API key', '@_Number': '1011510' }],
        },
      },
    };
    try {
      checkNamecheapStatus(envelope, 'test');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe('AUTH_FAILED');
    }
  });

  it('throws generic NAMECHEAP_ERROR for unknown errors', () => {
    const envelope: NamecheapEnvelope = {
      ApiResponse: {
        '@_Status': 'ERROR',
        Errors: {
          Error: [{ '#text': 'Some unknown error', '@_Number': '9999' }],
        },
      },
    };
    try {
      checkNamecheapStatus(envelope, 'test');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).code).toBe('NAMECHEAP_ERROR');
    }
  });

  it('throws generic error when status is ERROR but no error details', () => {
    const envelope: NamecheapEnvelope = {
      ApiResponse: { '@_Status': 'ERROR' },
    };
    try {
      checkNamecheapStatus(envelope, 'myOperation');
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentError);
      expect((err as AgentError).provider).toBe('namecheap');
    }
  });
});
