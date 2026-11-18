/**
 * The three tools, as plain functions over injected dependencies.
 *
 * Kept apart from the MCP wiring so each refusal can be tested for what
 * matters: that it happened before anything was signed or sent.
 *
 * Every refusal before signing says so in words ("Nothing was signed."). A
 * failure after signing says the opposite, because from then on the user may
 * have paid and the model should not retry blindly.
 *
 * ## Errors
 *
 * Every refusal is `{ error: { code, message, retryable } }`, the portal's own
 * shape, so an agent branches on `code` here as it does against the portal
 * and the hosted `/mcp` (pokt-network/agentic-portal-mcp#2). The codes are:
 *
 * - the portal's, where the condition is the same one (`SERVICE_UNKNOWN`,
 *   `SERVICE_UNAVAILABLE`, `REQUEST_UNSUPPORTED`), and passed through
 *   unchanged when the portal itself refused;
 * - this server's own, for what only it has: its settings, wallet and spend
 *   limit, and its view of the portal (`LOCAL_ERROR_CODES`).
 *
 * After a payment was signed, `retryable` is always false, whatever the portal
 * said: a retry signs a second payment.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  AgentError,
  type AgentErrorKind,
  payForRequest,
  requestQuote,
  type Quote,
} from './buyer/index.js';
import type { Logger } from 'pino';

import { Budget, BudgetExhausted } from './budget.js';
import {
  type Catalogue,
  CatalogueUnavailable,
  priceAtomic,
  type ServiceEntry,
} from './catalogue.js';
import type { Checked } from './input.js';
import { checkRoute } from './routes.js';
import { rank, words } from './search.js';
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

/** The codes only this server produces. Listed in the agent integration guide. */
export const LOCAL_ERROR_CODES = [
  'INVALID_ARGUMENTS',
  'CATALOGUE_UNAVAILABLE',
  'SETTINGS_INVALID',
  'WALLET_NOT_CONFIGURED',
  'SPEND_LIMIT_NOT_SET',
  'BUDGET_EXHAUSTED',
  'PRICE_ABOVE_LIMIT',
  'TERMS_INVALID',
  'NETWORK_NOT_OFFERED',
  'UNEXPECTED_RESPONSE',
  'PORTAL_TIMEOUT',
  'PORTAL_UNREACHABLE',
] as const;

/** The portal's codes this server produces itself, for the same condition. */
type SharedCode = 'SERVICE_UNKNOWN' | 'SERVICE_UNAVAILABLE' | 'REQUEST_UNSUPPORTED';

export type ErrorCode = (typeof LOCAL_ERROR_CODES)[number] | SharedCode;

/**
 * `code` is one this server chose, or (as a plain string) one the portal
 * answered with, passed through: the portal's set is the portal's to extend.
 */
const refuse = (
  code: ErrorCode | (string & {}),
  message: string,
  retryable: boolean,
  detail: Record<string, unknown> = {},
): ToolResult => {
  const value = { error: { code, message, retryable }, ...detail };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: true,
  };
};

/** Run `run` on arguments that passed the tool's input schema, or refuse. */
export async function withArgs<T>(
  tool: string,
  checked: Promise<Checked<T>>,
  run: (args: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  const result = await checked;
  if (result.ok) return run(result.value);
  return refuse(
    'INVALID_ARGUMENTS',
    `Invalid arguments for tool ${tool}: ${result.message}. Nothing was signed.`,
    false,
  );
}

function unknownService(serviceId: string): ToolResult {
  return refuse(
    'SERVICE_UNKNOWN',
    `There is no service "${serviceId}". Use search_services to find one. Nothing was signed.`,
    false,
  );
}

async function guarded(run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (thrown) {
    // The catalogue is fetched again on the next call, so this may pass then.
    if (thrown instanceof CatalogueUnavailable)
      return refuse('CATALOGUE_UNAVAILABLE', `${thrown.message}. Nothing was signed.`, true);
    throw thrown;
  }
}

// ── search_services ──────────────────────────────────────────────────────────

export interface SearchArgs {
  readonly query?: string | undefined;
  readonly category?: string | undefined;
  readonly limit?: number | undefined;
}

/** No query: the catalogue, in its order. A query: ranked, best first (`search.ts`). */
export function searchServices(deps: Deps, args: SearchArgs): Promise<ToolResult> {
  return guarded(async () => {
    const entries = await deps.catalogue.all();
    const inCategory = entries.filter(
      (e) => args.category === undefined || e.category === args.category,
    );
    const limit = args.limit ?? 20;
    const categories = [...new Set(entries.map((e) => e.category).filter(Boolean))].sort();
    const card = (e: ServiceEntry) => ({
      serviceId: e.serviceId,
      name: e.displayName,
      description: firstSentence(e.description),
      category: e.category ?? null,
      priceUsd: e.priceUsd,
      serving: e.serving ?? null,
    });

    if (words(args.query ?? '').length === 0) {
      const services = inCategory.slice(0, limit).map(card);
      return ok({ count: services.length, total: inCategory.length, services, categories });
    }
    const ranked = rank(inCategory, args.query ?? '');
    const services = ranked
      .slice(0, limit)
      .map((r) => ({ ...card(r.entry), matchedTerms: r.matchedTerms }));
    return ok({
      count: services.length,
      total: ranked.length,
      services,
      categories,
      ...(ranked.length === 0 ? { hint: NO_MATCH_HINT } : {}),
    });
  });
}

/** Shared with the hosted server, word for word: an empty result is not "no such service". */
export const NO_MATCH_HINT =
  'No service matches these words. Try other words for what you need, or list one of the ' +
  'categories: call search_services with that category and no query.';

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
      return refuse(
        'SERVICE_UNAVAILABLE',
        `${entry.serviceId} is not serving right now. Nothing was signed.`,
        true,
      );
    }

    // 2. The request, against what the service lists.
    const httpMethod = args.httpMethod ?? (args.body === undefined ? 'GET' : 'POST');
    const body = httpMethod === 'GET' ? undefined : withJsonRpcEnvelope(args.body, args.path);
    const route = checkRoute(entry.methods, { httpMethod, path: args.path, body });
    if (!route.ok) {
      return refuse('REQUEST_UNSUPPORTED', `${route.reason} Nothing was signed.`, false, {
        listedOperations: route.listed,
        hint: 'describe_service shows every operation and a real captured example.',
      });
    }

    // 3. The configuration. Every problem is reported, none guessed around.
    if (settings.problems.length > 0) {
      return refuse(
        'SETTINGS_INVALID',
        `The server's settings need fixing. Nothing was signed.`,
        false,
        { problems: settings.problems },
      );
    }
    const perCall = settings.maxPerCallAtomic ?? (await highestPrice(deps));
    if (perCall === undefined) {
      return refuse(
        'SETTINGS_INVALID',
        `No service in the catalogue is priced on ${settings.network}, so there is no default per-call limit. ` +
          'Set POCKET_MAX_PER_CALL_ATOMIC or POCKET_NETWORK. Nothing was signed.',
        false,
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
        'WALLET_NOT_CONFIGURED',
        'No wallet is configured, so this server cannot pay. Set POCKET_PRIVATE_KEY (and ' +
          'POCKET_MAX_TOTAL_ATOMIC) in the env block of this MCP server in your client config. ' +
          'Nothing was signed.',
        false,
      );
    }
    if (deps.budget === undefined) {
      return refuse(
        'SPEND_LIMIT_NOT_SET',
        'No spend limit is set, and this server will not sign without one. Set ' +
          'POCKET_MAX_TOTAL_ATOMIC (atomic units for the session; USDC has 6 decimals, so ' +
          '1000000 is $1.00) in the env block of this MCP server. Nothing was signed.',
        false,
      );
    }

    // 5. Reserve, pay, release. The signer refuses above the reservation.
    let reservation;
    try {
      reservation = deps.budget.reserve(perCall);
    } catch (thrown) {
      if (thrown instanceof BudgetExhausted) {
        return refuse('BUDGET_EXHAUSTED', thrown.message, false);
      }
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

const CODE_OF_KIND: Readonly<Record<AgentErrorKind, readonly [ErrorCode, boolean]>> = {
  'terms-invalid': ['TERMS_INVALID', false],
  'network-not-offered': ['NETWORK_NOT_OFFERED', false],
  'price-above-limit': ['PRICE_ABOVE_LIMIT', false],
  'unexpected-status': ['UNEXPECTED_RESPONSE', false],
  timeout: ['PORTAL_TIMEOUT', true],
};

/** The portal's own `{ error: { code, retryable } }`, when its answer carried one. */
function portalCode(body: unknown): readonly [string, boolean] | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error: unknown = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, retryable } = error as { code?: unknown; retryable?: unknown };
  return typeof code === 'string' && code !== '' ? [code, retryable === true] : undefined;
}

/** The portal's code when it gave one, else this server's for what happened. */
function codeOf(thrown: unknown): readonly [string, boolean] {
  // Not the buyer's own error: the request never got an answer (DNS, refused).
  if (!(thrown instanceof AgentError)) return ['PORTAL_UNREACHABLE', true];
  return portalCode(thrown.detail.body) ?? CODE_OF_KIND[thrown.kind];
}

function failure(thrown: unknown, afterSigning: boolean): ToolResult {
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  const detail = thrown instanceof AgentError ? thrown.detail : {};
  const [code, retryable] = codeOf(thrown);
  if (!afterSigning) {
    return refuse(
      code,
      message.includes('Nothing was signed') ? message : `${message} Nothing was signed.`,
      retryable,
      { detail },
    );
  }
  // Never retryable once signed, whatever the portal said: a retry signs again.
  return refuse(
    code,
    `${message} A payment WAS signed for this call, so it may have been charged. Do not retry ` +
      'without checking with the user.',
    false,
    { detail, paymentSigned: true },
  );
}

export type { ServiceEntry };
