import type { AvailabilityResult } from '../providers/types.js';
import { AgentError } from '../errors.js';

const GODADDY_PUBLIC_BASE = 'https://api.godaddy.com/v1/domains/available';

export async function checkAvailabilityPublic(domain: string): Promise<AvailabilityResult> {
  const url = `${GODADDY_PUBLIC_BASE}?domain=${encodeURIComponent(domain)}&checkType=FAST&forTransfer=false`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    throw new AgentError(
      isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
      isTimeout ? 'Domain availability check timed out after 10 seconds.' : `Network error: ${err instanceof Error ? err.message : String(err)}`,
      'Try again or check your internet connection.',
      'public',
    );
  }

  if (!res.ok) {
    throw new AgentError(
      'AVAILABILITY_ERROR',
      `Domain availability check failed with status ${res.status}.`,
      'Try again or check your internet connection.',
      'public',
    );
  }

  const data = await res.json() as {
    available: boolean;
    definitive: boolean;
    domain: string;
    premium?: boolean;
    price?: number;
    currency?: string;
  };

  return {
    domain,
    available: data.available,
    premium: data.premium ?? false,
    availabilitySource: 'public',
  };
}
