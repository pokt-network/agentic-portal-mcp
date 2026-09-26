/**
 * The buyer: an x402 client that pays the Pocket Network agentic portal from
 * the outside, the way any agent would.
 *
 * Every payment-protocol operation here comes from the reference client:
 * `x402Client` from `@x402/core/client` with the EVM `exact` scheme from
 * `@x402/evm` — terms decoded by its HTTP helper, requirement selection by its
 * selector hook, EIP-3009 signing and payload construction by its scheme,
 * header encoding and receipt decoding by its codecs. That is the point, not a
 * convenience.
 *
 * The portal serves and parses with `@x402/core` too, and that is a weaker
 * separation than the one this buyer had on `x402@1.2.0` — a different
 * library, deliberately. What replaces it is stronger evidence, not weaker:
 * this IS the client real agents run. If our 402 is subtly non-conformant, or
 * our verify rejects a correctly-signed authorization, the reference client
 * fails against us the way every other agent's would. What stays hand-rolled
 * is the CONTROL around it — the spend ceiling, the receipt's absence being
 * meaningful, the address derivation — because those are this buyer's
 * opinions, not the protocol's.
 *
 * It therefore shares no code with the portal's seller side, and the portal
 * never imports it. A pass against the portal is evidence that the portal
 * interoperates, not that one codebase agrees with itself.
 */
import { x402Client, x402HTTPClient } from '@x402/core/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { PaymentRequiredSchema } from '@x402/core/schemas';
import type { PaymentRequirements } from '@x402/core/types';
import { registerExactEvmScheme } from '@x402/evm/exact/client';
import { privateKeyToAccount } from 'viem/accounts';
import type { Logger } from 'pino';

import { type AgentConfig, redactedConfig } from './config.js';

/** The receipt header on a paid response. Standard x402 v2. */
const PAYMENT_RESPONSE_HEADER = 'PAYMENT-RESPONSE';

export interface Quote {
  readonly network: string;
  readonly scheme: string;
  /** Atomic units — x402 v2 `amount`. */
  readonly amount: string;
  readonly asset: string;
  readonly payTo: string;
  readonly resource: string;
}

export interface Settlement {
  readonly success: boolean;
  readonly transaction?: string | undefined;
  readonly network?: string | undefined;
  readonly payer?: string | undefined;
}

export interface PaidRequestResult {
  readonly status: number;
  readonly body: unknown;
  readonly quote: Quote;
  /** Absent when the seller served without a receipt: see step 5 of `payForRequest`. */
  readonly settlement: Settlement | undefined;
  readonly payerAddress: string;
}

export class AgentError extends Error {
  readonly detail: Record<string, unknown>;

  constructor(message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AgentError';
    this.detail = detail;
  }
}

export interface PayForRequestInput {
  readonly config: AgentConfig;
  readonly logger: Logger;
  /** Injected for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /**
   * Called once, synchronously, the moment an authorization exists — after the
   * ceiling check passed and the scheme signed, before it is presented.
   *
   * From here the money is committed as far as the payer can know: under
   * `exact` the seller may settle the signature even if its answer never
   * arrives. A caller keeping a running total (the MCP server's per-process
   * budget) counts spend HERE, not on a 200, or a timeout after signing would
   * be free money the budget never saw.
   */
  readonly onSigned?: (quote: Quote) => void;
}

/**
 * Ask, get quoted, pay, receive.
 *
 * Two round trips by design: the unpaid request is what produces the
 * requirements to sign against. An agent cannot construct them itself — the
 * amount, asset, and EIP-712 domain all come from the seller.
 */
export async function payForRequest(input: PayForRequestInput): Promise<PaidRequestResult> {
  const { config, logger } = input;
  const doFetch = input.fetchImpl ?? fetch;
  const { url, httpMethod, payload, paymentRequired } = await fetchTerms(config, logger, doFetch);
  const { client, http, payerAddress } = buildClient(config);

  // ── 3. Select and sign. The selector enforces the ceiling BEFORE the scheme
  //       signs — under `exact` the signature authorizes precisely this amount,
  //       so checking after signing would be checking after the money is
  //       committed. The key never leaves `buildClient`.
  let signed: Awaited<ReturnType<x402Client['createPaymentPayload']>>;
  try {
    signed = await client.createPaymentPayload(paymentRequired);
  } catch (thrown) {
    if (thrown instanceof AgentError) throw thrown;
    throw new AgentError(
      `The reference client could not build a payment: ${thrown instanceof Error ? thrown.message : String(thrown)}. Nothing was signed.`,
      { accepts: paymentRequired.accepts },
    );
  }
  const selected = signed.accepted;
  const quote = quoteOf(selected, paymentRequired);
  input.onSigned?.(quote);

  logger.info(
    {
      payerAddress,
      amount: selected.amount,
      asset: selected.asset,
      payTo: selected.payTo,
      network: selected.network,
    },
    'Authorization signed. Presenting it.',
  );

  // ── 4. Pay. The header name and encoding are the library's. ───────────────
  const paid = await send(
    doFetch,
    httpMethod,
    url,
    payload,
    http.encodePaymentSignatureHeader(signed),
    config.timeoutMs,
  );

  if (paid.status !== 200) {
    throw new AgentError(`Payment was presented and the seller answered ${paid.status}.`, {
      status: paid.status,
      body: paid.body,
    });
  }

  // ── 5. Receipt. Its ABSENCE is meaningful, not an error. ───────────────────
  // The portal serves the response even when settlement failed,
  // and withholds the receipt when it has no transaction to name. A caller that
  // treated a missing receipt as success would be recording a payment that may
  // never have settled.
  const receipt = paid.headers.get(PAYMENT_RESPONSE_HEADER);
  const settlement = receipt === null ? undefined : decodeSettlement(receipt, logger);

  return {
    status: paid.status,
    body: paid.body,
    quote,
    settlement,
    payerAddress,
  };
}

type PaymentRequired = ReturnType<x402HTTPClient['getPaymentRequiredResponse']>;

interface Terms {
  readonly url: string;
  readonly httpMethod: string;
  readonly payload: string | undefined;
  readonly paymentRequired: PaymentRequired;
}

/**
 * Steps 1 and 2 of {@link payForRequest}: ask unpaid, decode and check the
 * terms. Nothing is signed here, which is what lets {@link requestQuote} share it.
 */
async function fetchTerms(
  config: AgentConfig,
  logger: Logger,
  doFetch: typeof fetch,
): Promise<Terms> {
  // Derived here, deliberately not shared with the portal's own code: a wrong
  // prefix shared by both sides would be wrong on both at once, and a test of
  // one against the other would still pass.
  // `AGENT_SUB_PATH=blocks` and `=/blocks` both mean `/v1/{serviceId}/blocks`.
  const subPath = config.subPath ?? '';
  const sep = subPath && !subPath.startsWith('/') ? '/' : '';
  const url = `${config.baseUrl}/v1/${config.serviceId}${sep}${subPath}`;
  const httpMethod = config.httpMethod ?? 'POST';

  // A verb that takes no body sends none. A GET carrying one is not a request
  // any server has to accept, and `fetch` refuses to construct it.
  // A COMPLETE JSON-RPC envelope. This used to send `{method, params}` alone and
  // it worked, because the portal once rebuilt the envelope on the way out.
  // It no longer does — the portal forwards the body it is given — so an
  // incomplete envelope reaches the supplier as-is.
  //
  // `eth` and `solana` tolerated it; Base answered -32600 Invalid request, which
  // is the correct response to a JSON-RPC message with no `jsonrpc` member. The
  // portal was right to forward it and the buyer was wrong to send it: an agent
  // has to compose its own request now, which is the whole point.
  //
  // And for a REST service the composed request IS `config.body`, verbatim —
  // the envelope is a JSON-RPC shape that a renderer or an index would refuse.
  const payload = BODYLESS.has(httpMethod)
    ? undefined
    : (config.body ??
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: config.method, params: config.params }));

  logger.info({ ...redactedConfig(config), url }, 'Agent starting a paid request.');

  // ── 1. Unpaid. Expect 402 with requirements. ───────────────────────────────
  const unpaid = await send(doFetch, httpMethod, url, payload, {}, config.timeoutMs);

  if (unpaid.status !== 402) {
    throw new AgentError(
      `Expected 402 with payment requirements, got ${unpaid.status}. Nothing was signed.`,
      { status: unpaid.status, body: unpaid.body },
    );
  }

  // ── 2. Decode the terms with the reference client. v2 terms travel in the
  //       PAYMENT-REQUIRED header and that is what it reads; the body is kept
  //       by the library as a v1 fallback only. A v2 body with no header is
  //       therefore refused here, exactly as every other reference client
  //       would refuse it — which is the interoperability this buyer exists
  //       to check.
  const http = new x402HTTPClient(new x402Client());
  let decoded: unknown;
  try {
    decoded = http.getPaymentRequiredResponse((name) => unpaid.headers.get(name), unpaid.body);
  } catch (thrown) {
    throw new AgentError(
      "The seller's 402 is not valid x402 v2 — the reference client rejected it. " +
        'Nothing was signed.',
      { reason: thrown instanceof Error ? thrown.message : String(thrown), body: unpaid.body },
    );
  }
  // The reference client's decode is a base64 and a JSON.parse, nothing more.
  // The schema is where the wire is checked — the library's own, so a 402
  // this buyer accepts is one every reference client would accept, which is
  // what this buyer is evidence of. Without it a malformed offer (no
  // `resource`, a numeric `amount`, no `accepts` at all) was signed for and
  // then crashed at `resource.url` AFTER the money was committed. The union
  // of v1 and v2, as the client itself reads either: a v1
  // seller is well-formed and is refused below by this buyer's own control,
  // the network, which is the honest reason.
  const parsed = PaymentRequiredSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new AgentError(
      "The seller's 402 is not valid x402 v2 — it fails the reference schema. " +
        'Nothing was signed.',
      { issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) },
    );
  }
  // Validated above; the library's own type for what its client consumes.
  const paymentRequired = decoded as ReturnType<x402HTTPClient['getPaymentRequiredResponse']>;
  return { url, httpMethod, payload, paymentRequired };
}

/**
 * Ask for the terms and apply this buyer's selection — the network and the
 * ceiling — without signing anything.
 *
 * The same selector as {@link payForRequest}, so a quote this returns is
 * exactly the option a paid call would sign, and a quote it refuses is one a
 * paid call would refuse. A "quote only" caller sees the real terms, not the
 * catalogue's advertised price.
 */
export async function requestQuote(input: PayForRequestInput): Promise<Quote> {
  const { config, logger } = input;
  const doFetch = input.fetchImpl ?? fetch;
  const { paymentRequired } = await fetchTerms(config, logger, doFetch);
  const selected = selectOption(config, paymentRequired.accepts);
  return quoteOf(selected, paymentRequired);
}

function quoteOf(selected: PaymentRequirements, paymentRequired: PaymentRequired): Quote {
  return {
    network: selected.network,
    scheme: selected.scheme,
    amount: selected.amount,
    asset: selected.asset,
    payTo: selected.payTo,
    resource: paymentRequired.resource.url,
  };
}

/**
 * The reference client, configured with this buyer's opinions.
 *
 * The SELECTOR is where the opinions live: it picks the `exact` option on the
 * configured network — a seller may offer several rails — and refuses, before
 * anything is signed, an amount above the ceiling. The library's own spend
 * controls are switched off deliberately: they cap in dollars on assets the
 * library recognises, and this buyer's ceiling is an atomic amount that must
 * hold whatever the asset is. One ceiling, stated once, in the units the
 * authorization is signed in.
 */
function buildClient(config: AgentConfig): {
  client: x402Client;
  http: x402HTTPClient;
  payerAddress: string;
} {
  const account = privateKeyToAccount(config.privateKey as `0x${string}`);

  const selector = (_version: number, options: PaymentRequirements[]): PaymentRequirements =>
    selectOption(config, options);

  const client = new x402Client(selector).setSpendControls(false);
  registerExactEvmScheme(client, { signer: account, paymentRequirementsSelector: selector });

  return { client, http: new x402HTTPClient(client), payerAddress: account.address };
}

/** The `exact` option on the configured network, refused above the ceiling. */
function selectOption(
  config: AgentConfig,
  options: readonly PaymentRequirements[],
): PaymentRequirements {
  const candidate = options.find(
    (option) => option.scheme === 'exact' && option.network === config.network,
  );
  if (candidate === undefined) {
    throw new AgentError(
      `The seller offers no \`exact\` option on ${config.network}. Nothing was signed.`,
      { offered: options.map((o) => `${o.scheme} on ${o.network}`) },
    );
  }
  if (BigInt(candidate.amount) > BigInt(config.maxAmountAtomic)) {
    throw new AgentError(
      `Quoted ${candidate.amount} atomic units, above the ${config.maxAmountAtomic} ` +
        'ceiling this agent will sign for. Nothing was signed.',
      { quoted: candidate.amount, ceiling: config.maxAmountAtomic },
    );
  }
  return candidate;
}

interface RawResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

/** Verbs that carry no request body. */
const BODYLESS = new Set(['GET', 'HEAD', 'DELETE']);

async function send(
  doFetch: typeof fetch,
  httpMethod: string,
  url: string,
  body: string | undefined,
  paymentHeaders: Record<string, string>,
  timeoutMs: number,
): Promise<RawResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(url, {
      method: httpMethod,
      headers: {
        // Only when something is being sent. Declaring a content type on a
        // bodyless GET describes a body that is not there.
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...paymentHeaders,
      },
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Leave it as text — a non-JSON body is itself the diagnostic.
    }

    return { status: response.status, body: parsed, headers: response.headers };
  } catch (thrown) {
    if (thrown instanceof Error && thrown.name === 'AbortError') {
      throw new AgentError(`No answer within ${timeoutMs}ms.`, { url });
    }
    throw thrown;
  } finally {
    clearTimeout(timer);
  }
}

function decodeSettlement(header: string, logger: Logger): Settlement | undefined {
  try {
    const decoded = decodePaymentResponseHeader(header);
    return {
      success: decoded.success,
      transaction: decoded.transaction,
      network: decoded.network,
      payer: decoded.payer,
    };
  } catch (thrown) {
    // A malformed receipt is worth reporting but must not discard a response
    // already delivered and possibly paid for.
    logger.warn(
      { err: thrown instanceof Error ? thrown.message : String(thrown) },
      'The settlement receipt could not be decoded.',
    );
    return undefined;
  }
}
