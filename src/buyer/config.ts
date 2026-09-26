/**
 * Everything the buyer needs, injected.
 *
 * Nothing in this package reaches for a global, a literal endpoint, or a
 * default service. A buyer with a baked-in target can only ever reach the
 * thing it was born pointing at; this one is aimed by its caller.
 */
import { z } from 'zod';
import { NetworkSchemaV2 } from '@x402/core/schemas';

export interface AgentConfig {
  /** Portal origin, no trailing path. */
  readonly baseUrl: string;
  readonly serviceId: string;
  readonly method: string;
  readonly params: readonly unknown[];

  /**
   * REST addressing, for a service whose operation is a verb and a path rather
   * than a name in the body.
   *
   * Both OPTIONAL, and absent keeps the JSON-RPC behaviour this buyer had from
   * the start: POST to the service root with `{method, params}`. Present, the
   * buyer sends `httpMethod` to `/v1/{serviceId}{subPath}` — and sends no body
   * at all for a verb that takes none, because a GET with a body is not a
   * request any server has to accept.
   *
   * The buyer needs these for the same reason the portal does. It is the
   * evidence that a service can actually be BOUGHT FROM, and a buyer that can
   * only speak JSON-RPC cannot produce that evidence for the REST half of the
   * catalogue.
   */
  readonly httpMethod?: string | undefined;
  readonly subPath?: string | undefined;
  /**
   * The request body, verbatim, for a REST operation that takes one.
   *
   * Absent, the buyer sends the JSON-RPC envelope built from `method` and
   * `params`, which is right for every blockchain service and wrong for every
   * REST one: a renderer or a search index has its own body shape, and an
   * envelope it never asked for is a 400 at best. So the REST half of the
   * catalogue needs the buyer to send what the agent composed, exactly, and
   * this is where it goes. Ignored for a verb that carries no body.
   */
  readonly body?: string | undefined;
  /**
   * x402 v2 network id — CAIP-2, e.g. `eip155:84532`. Must match the rail's.
   *
   * Validated at load with the reference library's own v2 network schema, so
   * a v1 spelling (`base-sepolia`) or a typo is refused before the run starts
   * rather than inside the signer after it has.
   */
  readonly network: string;
  /**
   * The payer's key. Supplied by the caller from its environment or secret
   * store — never a literal in code, never logged (see `redactedConfig`).
   */
  readonly privateKey: string;
  /**
   * Refuse to sign for more than this, in atomic units.
   *
   * An agent that signs whatever it is quoted has no defence against a
   * misconfigured or hostile server: under `exact` the authorization is for the
   * amount the server names. Required rather than defaulted — a spend ceiling
   * that quietly defaults is one nobody chose.
   */
  readonly maxAmountAtomic: string;
  readonly timeoutMs: number;
}

const envSchema = z.object({
  AGENT_BASE_URL: z.string().url(),
  AGENT_SERVICE_ID: z.string().min(1),
  AGENT_METHOD: z.string().min(1),
  AGENT_PARAMS: z.string().default('[]'),
  /**
   * REST addressing. Absent keeps the JSON-RPC shape this buyer started with.
   *
   * `AGENT_METHOD` stays required even for a REST call: it is what the buyer
   * would put in a JSON-RPC body, and it is ignored when `AGENT_HTTP_METHOD`
   * says GET. Making it conditionally required would trade a harmless unused
   * value for a config schema that has to be read twice to understand.
   */
  AGENT_HTTP_METHOD: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  AGENT_SUB_PATH: z.string().optional(),
  /**
   * A REST body, sent as-is. Must at least be JSON, because the portal and
   * every service behind it speak JSON and a body that is not would fail
   * after the payment was signed — the wrong side of the ceiling check.
   */
  AGENT_BODY: z
    .string()
    .refine(
      (value) => {
        try {
          JSON.parse(value);
          return true;
        } catch {
          return false;
        }
      },
      { message: 'must be valid JSON, e.g. {"data":{...},"chart":{...}}' },
    )
    .optional(),
  AGENT_NETWORK: NetworkSchemaV2.default('eip155:84532'),
  /**
   * Accepted with or without the `0x` prefix, and normalised to carry it.
   *
   * The prefix is presentation, not information: 64 hex characters is
   * unambiguously a 32-byte key either way, and wallets disagree about which
   * form to export — MetaMask omits it. Insisting on one spelling makes a
   * correct key look invalid and sends someone back to edit a vault entry for
   * no reason. Everything else stays strict: exactly 64 hex characters, no
   * whitespace, no truncation.
   */
  AGENT_PRIVATE_KEY: z
    .string()
    .trim()
    .regex(/^(0x)?[a-fA-F0-9]{64}$/, 'must be 64 hex characters, with or without a 0x prefix')
    .transform((value) => (value.startsWith('0x') ? value : `0x${value}`)),
  AGENT_MAX_AMOUNT_ATOMIC: z
    .string()
    .regex(/^\d+$/, 'must be an integer in atomic units')
    .default('10000'),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),
});

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

/**
 * Read config from an environment.
 *
 * Throws rather than degrading: a buyer that cannot pay
 * has no useful reduced mode — it would spend a relay to discover it.
 */
export function loadAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const parsed = envSchema.safeParse(env);

  if (!parsed.success) {
    // Field names only. The values include a private key.
    const fields = parsed.error.issues.map(
      (issue: z.ZodIssue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new AgentConfigError(`Agent configuration is invalid — ${fields.join('; ')}`);
  }

  let params: unknown;
  try {
    params = JSON.parse(parsed.data.AGENT_PARAMS);
  } catch {
    throw new AgentConfigError('AGENT_PARAMS must be valid JSON, e.g. [] or ["latest"]');
  }

  if (!Array.isArray(params)) {
    throw new AgentConfigError('AGENT_PARAMS must be a JSON array');
  }

  return {
    baseUrl: parsed.data.AGENT_BASE_URL.replace(/\/+$/, ''),
    serviceId: parsed.data.AGENT_SERVICE_ID,
    method: parsed.data.AGENT_METHOD,
    params,
    ...(parsed.data.AGENT_HTTP_METHOD === undefined
      ? {}
      : { httpMethod: parsed.data.AGENT_HTTP_METHOD }),
    ...(parsed.data.AGENT_SUB_PATH === undefined ? {} : { subPath: parsed.data.AGENT_SUB_PATH }),
    ...(parsed.data.AGENT_BODY === undefined ? {} : { body: parsed.data.AGENT_BODY }),
    network: parsed.data.AGENT_NETWORK,
    privateKey: parsed.data.AGENT_PRIVATE_KEY,
    maxAmountAtomic: parsed.data.AGENT_MAX_AMOUNT_ATOMIC,
    timeoutMs: parsed.data.AGENT_TIMEOUT_MS,
  };
}

/** Config minus the key, for logging. */
export function redactedConfig(config: AgentConfig): Record<string, unknown> {
  const { privateKey: _privateKey, ...rest } = config;
  return rest;
}
