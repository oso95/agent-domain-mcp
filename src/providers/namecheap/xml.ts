import { XMLParser } from 'fast-xml-parser';
import { AgentError } from '../../errors.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  // 'Host': DNS records in getHosts response (preserves array when single record)
  // 'Domain': domain entries in getList response
  // 'Nameserver': nameserver entries in getInfo response
  // 'Error': error entries — always array to avoid manual Array.isArray checks throughout
  // 'ProductCategory', 'Product', 'Price': pricing table entries in getUserPricing
  // 'SSL': certificate entries in ssl.getList
  isArray: (name) => ['Host', 'Domain', 'Nameserver', 'Error', 'ProductCategory', 'Product', 'Price', 'SSL'].includes(name),
});

export function parseXML<T>(xml: string): T {
  try {
    return parser.parse(xml) as T;
  } catch (err) {
    throw new AgentError(
      'XML_PARSE_ERROR',
      'Failed to parse Namecheap XML response.',
      'This is likely a Namecheap API issue. Try again.',
      'namecheap',
      String(err),
    );
  }
}

export interface NamecheapEnvelope {
  ApiResponse: {
    '@_Status': string;
    Errors?: {
      Error?: Array<{ '#text': string; '@_Number': string }>;
    };
    CommandResponse?: {
      '@_Type': string;
      [key: string]: unknown;
    };
  };
}

export function checkNamecheapStatus(envelope: NamecheapEnvelope, operation: string): void {
  const status = envelope.ApiResponse['@_Status'];
  if (status === 'ERROR') {
    const errors = envelope.ApiResponse.Errors?.Error ?? [];

    if (errors.length > 0) {
      const code = String(errors[0]['@_Number']);
      const message = errors[0]['#text'] ?? 'Unknown error';
      throw translateNamecheapError(code, message);
    }

    throw new AgentError(
      'NAMECHEAP_ERROR',
      `Namecheap ${operation} failed with unknown error.`,
      'Check the Namecheap API status and your credentials.',
      'namecheap',
    );
  }
}

function translateNamecheapError(code: string, message: string): AgentError {
  // IP whitelist error
  if (code === '1011102' || message.includes('IP') || message.toLowerCase().includes('whitelist')) {
    return new AgentError(
      'IP_NOT_WHITELISTED',
      'Namecheap API authentication failed. Your server\'s IP address must be whitelisted in your Namecheap account under Profile → Tools → API Access → Whitelisted IPs.',
      'Log in to Namecheap, go to Profile → Tools → API Access, and add your current IP address to the whitelist.',
      'namecheap',
      message,
    );
  }

  // Auth errors
  if (code === '1011510' || code === '1011502' || message.toLowerCase().includes('invalid api key')) {
    return new AgentError(
      'AUTH_FAILED',
      'Namecheap authentication failed. Check that NAMECHEAP_API_KEY and NAMECHEAP_API_USER are correct.',
      'Verify your API key at https://ap.www.namecheap.com/settings/tools/apiaccess/',
      'namecheap',
      message,
    );
  }

  // Rate limit
  if (code === '500000' || message.toLowerCase().includes('too many requests')) {
    return new AgentError(
      'RATE_LIMIT',
      'Namecheap API rate limit reached (20 requests/minute). Retrying automatically with backoff.',
      'Wait a moment and try again.',
      'namecheap',
      message,
    );
  }

  // Domain not found
  if (code === '2019166' || message.toLowerCase().includes('not found') || message.toLowerCase().includes('domain not exist')) {
    return new AgentError(
      'DOMAIN_NOT_FOUND',
      `Domain not found in your Namecheap account: ${message}`,
      'Verify the domain is registered in your Namecheap account.',
      'namecheap',
      message,
    );
  }

  // Missing parameter
  if (message.toLowerCase().includes('parameter') || message.toLowerCase().includes('missing')) {
    return new AgentError(
      'INVALID_INPUT',
      `Namecheap API error: ${message}`,
      'Check that all required fields are provided correctly.',
      'namecheap',
      message,
    );
  }

  return new AgentError(
    'NAMECHEAP_ERROR',
    `Namecheap API error [${code}]: ${message}`,
    'Check the Namecheap API documentation or try again.',
    'namecheap',
    message,
  );
}
