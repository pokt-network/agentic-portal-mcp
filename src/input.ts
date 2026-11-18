/**
 * Tool input, validated by the tool rather than by the SDK.
 *
 * The SDK checks arguments against `inputSchema` before a handler runs, and
 * answers a failure itself with plain text ("Input validation error: …"): no
 * code, so an agent cannot branch on it (pokt-network/agentic-portal-mcp#2).
 * Here the schema the client sees is unchanged, the SDK's check passes
 * everything through, and the handler runs the same check and refuses with
 * `INVALID_ARGUMENTS`.
 */
import { fromJsonSchema } from '@modelcontextprotocol/server';

type JsonSchema = Parameters<typeof fromJsonSchema>[0];
type Schema<T> = ReturnType<typeof fromJsonSchema<T>>;

export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

export interface ToolInput<T> {
  /** What `registerTool` gets: the real JSON Schema, a check that passes all. */
  readonly schema: Schema<T>;
  /** The real check, for the handler to run first. */
  check(args: unknown): Promise<Checked<T>>;
}

export function toolInput<T>(json: JsonSchema): ToolInput<T> {
  const strict = fromJsonSchema<T>(json)['~standard'];
  const schema = {
    '~standard': { ...strict, validate: (value: unknown) => ({ value: value as T }) },
  } as Schema<T>;
  return {
    schema,
    async check(args) {
      const result = await strict.validate(args ?? {});
      if (result.issues === undefined) return { ok: true, value: result.value };
      return { ok: false, message: result.issues.map((issue) => issue.message).join(', ') };
    },
  };
}
