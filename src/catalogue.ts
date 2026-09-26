/**
 * The published catalogue, `/services.json`, fetched lazily and kept briefly.
 *
 * It is the only source for every tool: nothing about a service is written
 * here by hand. Only the fields this server reads are typed; describe_service
 * passes the entry through whole, so a field the portal adds later reaches the
 * model without a release of this package.
 */

export interface Rail {
  readonly network: string;
  readonly tokenAddress: string;
  readonly tokenDecimals: number;
  readonly payToAddress: string;
}

export interface ServiceEntry {
  readonly serviceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly category?: string;
  readonly priceUsd: string;
  readonly serving?: boolean;
  readonly rails?: readonly Rail[];
  /** `"GET /path/{param}"` for REST operations, a bare name for JSON-RPC methods. */
  readonly methods?: Readonly<Record<string, string>>;
  readonly [field: string]: unknown;
}

export class CatalogueUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueUnavailable';
  }
}

const TTL_MS = 10 * 60 * 1000;

export class Catalogue {
  #entries: readonly ServiceEntry[] | undefined;
  #fetchedAt = 0;
  #inflight: Promise<readonly ServiceEntry[]> | undefined;

  constructor(
    private readonly portalUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async all(): Promise<readonly ServiceEntry[]> {
    if (this.#entries !== undefined && this.now() - this.#fetchedAt < TTL_MS) return this.#entries;
    this.#inflight ??= this.#load().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async find(serviceId: string): Promise<ServiceEntry | undefined> {
    return (await this.all()).find((entry) => entry.serviceId === serviceId);
  }

  async #load(): Promise<readonly ServiceEntry[]> {
    const url = `${this.portalUrl}/services.json`;
    let body: unknown;
    try {
      const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
    } catch (thrown) {
      // A stale copy beats none: the services rarely change within minutes.
      if (this.#entries !== undefined) return this.#entries;
      throw new CatalogueUnavailable(
        `Could not read the catalogue at ${url}: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      );
    }
    const services = (body as { services?: unknown } | null)?.services;
    if (!Array.isArray(services)) {
      throw new CatalogueUnavailable(`${url} has no "services" array.`);
    }
    this.#entries = services.filter(
      (entry): entry is ServiceEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ServiceEntry).serviceId === 'string',
    );
    this.#fetchedAt = this.now();
    return this.#entries;
  }
}

/**
 * The service's price on `network`, in that rail's atomic units, or undefined
 * when the service has no rail there.
 */
export function priceAtomic(entry: ServiceEntry, network: string): bigint | undefined {
  const rail = entry.rails?.find((r) => r.network === network);
  if (rail === undefined) return undefined;
  const [whole = '0', fraction = ''] = entry.priceUsd.split('.');
  const digits = fraction.padEnd(rail.tokenDecimals, '0').slice(0, rail.tokenDecimals);
  return BigInt(whole) * 10n ** BigInt(rail.tokenDecimals) + BigInt(digits === '' ? '0' : digits);
}
