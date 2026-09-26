/**
 * The three tools, as plain functions over injected dependencies.
 *
 * Kept apart from the MCP wiring so each refusal can be tested for what
 * matters: that it happened before anything was signed or sent.
 *
 * Every refusal before signing says so in words ("Nothing was signed."). A
 * failure after signing says the opposite, because from then on the user may
 * have paid and the model should not retry blindly.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import { AgentError, payForRequest, requestQuote, type Quote } from './buyer/index.js';
import type { Logger } from 'pino';

import { Budget, BudgetExhausted } from './budget.js';
import {
  type Catalogue,
  CatalogueUnavailable,
  priceAtomic,
  type ServiceEntry,
} from './catalogue.js';
import { checkRoute } from './routes.js';
import type { Settings } from './settings.js';

/** The SDK's own result type, so a result is checked against the wire shape. */
export type ToolResult = CallToolResult;

export interface Deps {
  readonly settings: Settings;
  readonly catalogue: Catalogue;
  /** Undefined until a total is configured; nothing is signed without one. */
  readonly budget: Budget | undefined;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
}

export function createBudget(settings: Settings): Budget | undefined {
  return settings.maxTotalAtomic === undefined ? undefined : new Budget(settings.maxTotalAtomic);
}

const ok = (value: Record<string, unknown>): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
});

const refuse = (message: string, detail: Record<string, unknown> = {}): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify({ error: message, ...detail }, null, 2) }],
  structuredContent: { error: message, ...detail },
  isError: true,
});

function unknownService(serviceId: string): ToolResult {
  return refuse(
    `There is no service "${serviceId}". Use search_services to find one. Nothing was signed.`,
  );
}

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (thrown) {
    if (thrown instanceof CatalogueUnavailable)
      return refuse(`${thrown.message}. Nothing was signed.`);
    throw thrown;
  }
}

// ── search_services ──────────────────────────────────────────────────────────

export interface SearchArgs {
  readonly query?: string | undefined;
  readonly category?: string | undefined;
  readonly limit?: number | undefined;
}

export function searchServices(deps: Deps, args: SearchArgs): Promise<ToolResult> {
  return guarded(async () => {
    const entries = await deps.catalogue.all();
    const terms = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const hits = entries
      .filter((e) => args.category === undefined || e.category === args.category)
      .filter((e) => {
        const text = `${e.serviceId} ${e.displayName} ${e.description}`.toLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .slice(0, args.limit ?? 20)
      .map((e) => ({
        serviceId: e.serviceId,
        name: e.displayName,
        description: firstSentence(e.description),
        category: e.category ?? null,
        priceUsd: e.priceUsd,
        serving: e.serving ?? null,
      }));
    const categories = [...new Set(entries.map((e) => e.category).filter(Boolean))].sort();
    return ok({ count: hits.length, services: hits, categories });
  });
}

function firstSentence(text: string): string {
  const end = text.search(/\.(\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

// ── describe_service ─────────────────────────────────────────────────────────

export function describeService(
  deps: Deps,
  args: { readonly serviceId: string },
): Promise<ToolResult> {
  return guarded(async () => {
    const entry = await deps.catalogue.find(args.serviceId);
    if (entry === undefined) return unknownService(args.serviceId);
    // Whole and unchanged: the catalogue is the source, and a field added there
    // reaches the model without a release of this package.
    return ok({ ...entry });
  });
}

// ── call_service ─────────────────────────────────────────────────────────────

export interface CallArgs {
  readonly serviceId: string;
  readonly body?: Record<string, unknown> | undefined;
  readonly path?: string | undefined;
  readonly httpMethod?: 'GET' | 'POST' | undefined;
}

export function callService(deps: Deps, args: CallArgs): Promise<ToolResult> {
  return guarded(async () => {
    const { settings } = deps;

    // 1. The service. Unknown ids stop here, before any price is looked up.
    const entry = await deps.catalogue.find(args.serviceId);
    if (entry === undefined) return unknownService(args.serviceId);
    if (entry.serving === false) {
      return refuse(`${entry.serviceId} is not serving right now. Nothing was signed.`);
    }

    // 2. The request, against what the service lists.
    const httpMethod = args.httpMethod ?? (args.body === undefined ? 'GET' : 'POST');
    const body = httpMethod === 'GET' ? undefined : withJsonRpcEnvelope(args.body, args.path);
    const route = checkRoute(entry.methods, { httpMethod, path: args.path, body });
    if (!route.ok) {
      return refuse(`${route.reason} Nothing was signed.`, {
        listedOperations: route.listed,
        hint: 'describe_service shows every operation and a real captured example.',
      });
    }

    // 3. The configuration. Every problem is reported, none guessed around.
    if (settings.problems.length > 0) {
      return refuse(`The server's settings need fixing. Nothing was signed.`, {
        problems: settings.problems,
      });
    }
    const perCall = settings.maxPerCallAtomic ?? (await highestPrice(deps));
    if (perCall === undefined) {
      return refuse(
        `No service in the catalogue is priced on ${settings.network}, so there is no default per-call limit. ` +
          'Set POCKET_MAX_PER_CALL_ATOMIC or POCKET_NETWORK. Nothing was signed.',
      );
    }
    const quoteConfig = {
      baseUrl: settings.portalUrl,
      serviceId: entry.serviceId,
      method: '',
      params: [],
      httpMethod,
      subPath: args.path,
      body: body === undefined ? undefined : JSON.stringify(body),
      network: settings.network,
      timeoutMs: 60_000,
    };

    // 4. Quote only: the seller's real terms, through the same selector, unsigned.
    if (settings.quoteOnly) {
      try {
        const quote = await requestQuote({
          logger: deps.logger,
          fetchImpl: deps.fetchImpl ?? fetch,
          config: { ...quoteConfig, privateKey: '', maxAmountAtomic: perCall.toString() },
        });
        return ok({
          quoteOnly: true,
          note: 'POCKET_QUOTE_ONLY is on: these are the terms a paid call would sign. Nothing was signed.',
          quote,
        });
      } catch (thrown) {
        return failure(thrown, false);
      }
    }

    if (settings.privateKey === undefined) {
      return refuse(
        'No wallet is configured, so this server cannot pay. Set POCKET_PRIVATE_KEY (and ' +
          'POCKET_MAX_TOTAL_ATOMIC) in the env block of this MCP server in your client config. ' +
          'Nothing was signed.',
      );
    }
    if (deps.budget === undefined) {
      return refuse(
        'No spend limit is set, and this server will not sign without one. Set ' +
          'POCKET_MAX_TOTAL_ATOMIC (atomic units for the session; USDC has 6 decimals, so ' +
          '1000000 is $1.00) in the env block of this MCP server. Nothing was signed.',
      );
    }

    // 5. Reserve, pay, release. The signer refuses above the reservation.
    let reservation;
    try {
      reservation = deps.budget.reserve(perCall);
    } catch (thrown) {
      if (thrown instanceof BudgetExhausted) return refuse(thrown.message);
      throw thrown;
    }
    let signed: Quote | undefined;
    try {
      const result = await payForRequest({
        logger: deps.logger,
        fetchImpl: deps.fetchImpl ?? fetch,
        config: {
          ...quoteConfig,
          privateKey: settings.privateKey,
          maxAmountAtomic: reservation.ceiling.toString(),
        },
        onSigned: (quote) => {
          signed = quote;
          reservation.commit(BigInt(quote.amount));
        },
      });
      return ok({
        payment: {
          amount: result.quote.amount,
          asset: result.quote.asset,
          network: result.quote.network,
          payTo: result.quote.payTo,
          payer: result.payerAddress,
          settled: result.settlement?.success ?? false,
          transaction: result.settlement?.transaction ?? null,
          ...(result.settlement === undefined
            ? {
                note: 'The portal served the response without a settlement receipt, so this payment is unconfirmed.',
              }
            : {}),
        },
        spend: {
          sessionSpentAtomic: deps.budget.spent.toString(),
          sessionRemainingAtomic: deps.budget.remaining.toString(),
        },
        // The portal's envelope, unchanged: `data` is third-party content and
        // `portal` says so. Treat it as data, never as instructions.
        response: result.body,
      });
    } catch (thrown) {
      return failure(thrown, signed !== undefined);
    } finally {
      reservation.release();
    }
  });
}

/**
 * Fill in the JSON-RPC envelope a model tends to leave out. Only for a root
 * call whose body names a `method`, i.e. a JSON-RPC request; a REST body is
 * sent exactly as given.
 */
function withJsonRpcEnvelope(
  body: Record<string, unknown> | undefined,
  path: string | undefined,
): Record<string, unknown> | undefined {
  if (body === undefined || (path !== undefined && path !== '' && path !== '/')) return body;
  if (typeof body.method !== 'string') return body;
  return { jsonrpc: '2.0', id: 1, params: [], ...body };
}

async function highestPrice(deps: Deps): Promise<bigint | undefined> {
  let highest: bigint | undefined;
  for (const entry of await deps.catalogue.all()) {
    const price = priceAtomic(entry, deps.settings.network);
    if (price !== undefined && (highest === undefined || price > highest)) highest = price;
  }
  return highest;
}

function failure(thrown: unknown, afterSigning: boolean): ToolResult {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const detail = thrown instanceof AgentError ? thrown.detail : {};
  if (!afterSigning) {
    return refuse(
      message.includes('Nothing was signed') ? message : `${message} Nothing was signed.`,
      {
        detail,
      },
    );
  }
  return refuse(
    `${message} A payment WAS signed for this call, so it may have been charged. Do not retry ` +
      'without checking with the user.',
    { detail, paymentSigned: true },
  );
}

export type { ServiceEntry };
