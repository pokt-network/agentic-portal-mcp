/**
 * What the user configured, read once from the environment.
 *
 * The desktop clients start a stdio server with a STRIPPED environment — no
 * user variables, a minimal PATH — so everything here arrives
 * through the `env` block of the client's server config, and nothing is
 * looked up anywhere else.
 *
 * A setting that is wrong does not stop the server. A desktop client shows a
 * server that exits at start as a bare failure with no reason, so a bad value
 * is recorded here and refused on the first call that needs it, where the
 * model can read the reason and tell the user. The free tools never need a
 * key and keep working.
 */

export interface Settings {
  readonly portalUrl: string;
  /** CAIP-2. The only network this server will sign on. */
  readonly network: string;
  /** Absent: the free tools work and `call_service` explains how to add one. */
  readonly privateKey: `0x${string}` | undefined;
  /** Atomic units. Absent: the highest price in the catalogue on `network`. */
  readonly maxPerCallAtomic: bigint | undefined;
  /** Atomic units, for the life of this process. Required before anything is signed. */
  readonly maxTotalAtomic: bigint | undefined;
  /** Return the terms without signing. */
  readonly quoteOnly: boolean;
  /** Each setting that could not be read, and why. Refused at the first paid call. */
  readonly problems: readonly string[];
}

export const DEFAULT_PORTAL_URL = 'https://agent.pocket.network';
export const DEFAULT_NETWORK = 'eip155:8453';

const KEY = /^(0x)?[a-fA-F0-9]{64}$/;
const ATOMIC = /^[0-9]+$/;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;

export function readSettings(env: Readonly<Record<string, string | undefined>>): Settings {
  const problems: string[] = [];
  const value = (name: string): string | undefined => {
    const raw = env[name]?.trim();
    return raw === undefined || raw === '' ? undefined : raw;
  };

  const atomic = (name: string): bigint | undefined => {
    const raw = value(name);
    if (raw === undefined) return undefined;
    if (!ATOMIC.test(raw)) {
      problems.push(
        `${name} must be a whole number of atomic units (USDC has 6 decimals: 1000000 is $1.00), got "${raw}".`,
      );
      return undefined;
    }
    return BigInt(raw);
  };

  let privateKey: `0x${string}` | undefined;
  const rawKey = value('POCKET_PRIVATE_KEY');
  if (rawKey !== undefined) {
    if (KEY.test(rawKey)) {
      privateKey = (rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`) as `0x${string}`;
    } else {
      // Never echo it: a malformed key is still most of a key.
      problems.push('POCKET_PRIVATE_KEY must be 64 hex characters, with or without 0x.');
    }
  }

  const network = value('POCKET_NETWORK') ?? DEFAULT_NETWORK;
  if (!CAIP2.test(network)) {
    problems.push(
      `POCKET_NETWORK must be a CAIP-2 id such as ${DEFAULT_NETWORK}, got "${network}".`,
    );
  }

  let portalUrl = value('POCKET_PORTAL_URL') ?? DEFAULT_PORTAL_URL;
  try {
    const parsed = new URL(portalUrl);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
      problems.push(`POCKET_PORTAL_URL must be https (or localhost), got "${portalUrl}".`);
    }
    portalUrl = parsed.origin;
  } catch {
    problems.push(`POCKET_PORTAL_URL is not a URL: "${portalUrl}".`);
  }

  const quoteOnlyRaw = value('POCKET_QUOTE_ONLY')?.toLowerCase();
  if (quoteOnlyRaw !== undefined && !['true', 'false', '1', '0'].includes(quoteOnlyRaw)) {
    problems.push(`POCKET_QUOTE_ONLY must be true or false, got "${quoteOnlyRaw}".`);
  }

  return {
    portalUrl,
    network,
    privateKey,
    maxPerCallAtomic: atomic('POCKET_MAX_PER_CALL_ATOMIC'),
    maxTotalAtomic: atomic('POCKET_MAX_TOTAL_ATOMIC'),
    quoteOnly: quoteOnlyRaw === 'true' || quoteOnlyRaw === '1',
    problems,
  };
}
