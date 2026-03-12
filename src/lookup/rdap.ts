import { AgentError } from '../errors.js';
import type { AvailabilityResult } from '../providers/types.js';

const RDAP_BASE = 'https://rdap.org/domain/';

export async function checkAvailabilityRDAP(domain: string): Promise<AvailabilityResult> {
  const url = `${RDAP_BASE}${encodeURIComponent(domain)}`;

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 404) {
      // 404 = not registered = available
      return {
        domain,
        available: true,
        premium: false,
        availabilitySource: 'rdap',
      };
    }

    if (res.status === 200) {
      // Domain exists = not available
      return {
        domain,
        available: false,
        premium: false,
        availabilitySource: 'rdap',
      };
    }

    // Other status codes — treat as inconclusive, let fallback handle
    throw new Error(`RDAP returned status ${res.status}`);
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new AgentError(
        'RDAP_TIMEOUT',
        `RDAP lookup timed out for domain '${domain}'.`,
        'Try again or use a configured provider for availability checking.',
        'rdap',
        String(err),
      );
    }
    throw err;
  }
}
