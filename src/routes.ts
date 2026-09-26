/**
 * Is this request one the service lists? Answered BEFORE paying.
 *
 * The portal forwards whatever it is given and charges
 * for it. A path the service does not have is a paid 404, so a request that
 * matches none of the service's listed operations is refused here, with the
 * operations it does list, and nothing is spent.
 *
 * `methods` keys are `"VERB /path/{param}"` for REST operations and a bare
 * name for JSON-RPC methods (`eth_blockNumber`). A `{param}` matches one path
 * segment. The query string is not part of the match.
 */

export type RouteCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly listed: readonly string[] };

const LISTED_IN_ERROR = 25;

export function checkRoute(
  methods: Readonly<Record<string, string>> | undefined,
  request: {
    readonly httpMethod: string;
    readonly path: string | undefined;
    readonly body: unknown;
  },
): RouteCheck {
  // A service that publishes no operations cannot be checked; the portal decides.
  if (methods === undefined || Object.keys(methods).length === 0) return { ok: true };

  const keys = Object.keys(methods);
  const rest = keys.filter((key) => key.includes(' '));
  const rpc = keys.filter((key) => !key.includes(' '));

  if (request.path !== undefined && request.path !== '' && request.path !== '/') {
    const path = normalise(request.path);
    const wanted = `${request.httpMethod} ${path}`;
    if (rest.some((key) => matches(key, request.httpMethod, path))) return { ok: true };
    const samePath = rest.filter((key) => matches(key, key.split(' ')[0] ?? '', path));
    return {
      ok: false,
      reason:
        samePath.length > 0
          ? `${wanted} is not listed; that path takes ${samePath.map((k) => k.split(' ')[0]).join(', ')}.`
          : `${wanted} is not an operation this service lists.`,
      listed: nearest(rest, path),
    };
  }

  // No path: the service root, which is where JSON-RPC requests go.
  const method = (request.body as { method?: unknown } | undefined)?.method;
  if (rpc.length === 0) {
    return {
      ok: false,
      reason: 'This service takes REST operations; pass `path` (and `httpMethod` for a GET).',
      listed: rest.slice(0, LISTED_IN_ERROR),
    };
  }
  if (typeof method !== 'string') {
    return {
      ok: false,
      reason: 'A JSON-RPC call needs `body.method` (and `body.params`).',
      listed: rpc.slice(0, LISTED_IN_ERROR),
    };
  }
  if (rpc.includes(method)) return { ok: true };
  return {
    ok: false,
    reason: `${method} is not a method this service lists.`,
    listed: rpc.filter((m) => m.split('_')[0] === method.split('_')[0]).slice(0, LISTED_IN_ERROR),
  };
}

function normalise(path: string): string {
  const withoutQuery = path.split('?')[0] ?? '';
  return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
}

function matches(key: string, verb: string, path: string): boolean {
  const [keyVerb, keyPath] = key.split(' ', 2);
  if (keyVerb !== verb || keyPath === undefined) return false;
  const want = keyPath.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return false;
  return want.every((segment, i) =>
    segment.startsWith('{') && segment.endsWith('}') ? (got[i] ?? '') !== '' : segment === got[i],
  );
}

/** The listed operations sharing the longest leading run of segments with `path`. */
function nearest(rest: readonly string[], path: string): readonly string[] {
  const got = path.split('/');
  const shared = (key: string): number => {
    const want = (key.split(' ', 2)[1] ?? '').split('/');
    let n = 0;
    while (n < want.length && n < got.length && want[n] === got[n]) n += 1;
    return n;
  };
  return [...rest].sort((a, b) => shared(b) - shared(a)).slice(0, LISTED_IN_ERROR);
}
