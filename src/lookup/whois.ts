import type { AvailabilityResult } from '../providers/types.js';
import { AgentError } from '../errors.js';

// Use whoisjson.com free API as WHOIS fallback
const WHOIS_API = 'https://whoisjson.com/api/v1/whois';

export async function checkAvailabilityWhois(domain: string): Promise<AvailabilityResult> {
  const url = `${WHOIS_API}?domain=${encodeURIComponent(domain)}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new AgentError(
      isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      isTimeout ? 'WHOIS lookup timed out after 15 seconds.' : `WHOIS lookup network error: ${err instanceof Error ? err.message : String(err)}`,
      'Try again or check your internet connection.',
      'whois',
    );
  }

  if (!res.ok) {
    throw new AgentError(
      'WHOIS_ERROR',
      `WHOIS lookup failed with status ${res.status}.`,
      'Try again or check your internet connection.',
      'whois',
    );
  }

  const data = await res.json() as { status?: string; domain?: string };

  // whoisjson.com returns no status field for unregistered (available) domains.
  // Registered domains always have a non-empty status like "REGISTERED" or "clientTransferProhibited".
  const available = !data.status ||
    data.status.toLowerCase().includes('available') ||
    data.status.toLowerCase().includes('free');

  return {
    domain,
    available,
    premium: false,
    availabilitySource: 'whois',
  };
}
