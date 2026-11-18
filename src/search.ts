/**
 * Ranked catalogue search for `search_services`.
 *
 * It used to keep a service only when EVERY query word was a literal
 * substring of its text, so a model's natural phrasing ("scholarly papers",
 * "korean apartment prices") found nothing although the catalogue had an exact
 * fit, and the empty answer read as "no such service"
 * (pokt-network/agentic-portal-mcp#1).
 *
 * Now every service that matches ANY query word is returned, best first:
 *
 * - Words are compared by a light stem (plurals and -ing), and a query word
 *   also matches a longer word it starts ("korea" finds "korean").
 * - A word counts by how rare it is in the catalogue (inverse document
 *   frequency), and a word in more than half of it counts for nothing. The
 *   listing boilerplate every description shares ("pay per request in USDC")
 *   and words like "a" and "for" drop out, with no stopword list to keep.
 * - A match in the id or name counts three times one in the description, and
 *   one in the category twice.
 *
 * Deterministic, and small enough to run per call: the catalogue is a few
 * hundred entries. A copy lives in `apps/resource-server/src/mcp/search.ts`;
 * the npm package is mirrored on its own and cannot import from that app.
 */

export interface Searchable {
  readonly serviceId: string;
  readonly displayName: string;
  readonly description: string;
  readonly category?: string | null | undefined;
}

export interface Ranked<T> {
  readonly entry: T;
  /** The query words that matched, as the caller wrote them. */
  readonly matchedTerms: readonly string[];
  readonly score: number;
}

const WEIGHT = { title: 3, category: 2, description: 1 } as const;

/** A query word this short only matches a whole word, never a longer one it starts. */
const MIN_PREFIX = 4;

/** Lowercase words, split on anything that is not a letter or digit. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Plurals and -ing, nothing cleverer: "prices" → "price", "screening" → "screen". */
export function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && /(?:sh|ch|x|z|ss)es$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !/(?:ss|us|is)$/.test(word)) {
    return word.slice(0, -1);
  }
  return word;
}

interface Fields {
  readonly title: ReadonlySet<string>;
  readonly category: ReadonlySet<string>;
  readonly description: ReadonlySet<string>;
}

const stems = (text: string): ReadonlySet<string> => new Set(words(text).map(stem));

function fieldsOf(entry: Searchable): Fields {
  return {
    title: stems(`${entry.serviceId} ${entry.displayName}`),
    category: stems(entry.category ?? ''),
    description: stems(entry.description),
  };
}

function matchesIn(term: string, field: ReadonlySet<string>): boolean {
  if (field.has(term)) return true;
  if (term.length < MIN_PREFIX) return false;
  for (const word of field) if (word.startsWith(term)) return true;
  return false;
}

/** The weight of the best field `term` matches in, or 0. */
function bestWeight(term: string, fields: Fields): number {
  if (matchesIn(term, fields.title)) return WEIGHT.title;
  if (matchesIn(term, fields.category)) return WEIGHT.category;
  if (matchesIn(term, fields.description)) return WEIGHT.description;
  return 0;
}

/**
 * Every entry that matches at least one informative query word, best first;
 * ties keep catalogue order. An empty query ranks nothing: the caller lists.
 */
export function rank<T extends Searchable>(entries: readonly T[], query: string): Ranked<T>[] {
  const asWritten = new Map<string, string>();
  for (const word of words(query)) {
    const term = stem(word);
    if (!asWritten.has(term)) asWritten.set(term, word);
  }
  if (asWritten.size === 0 || entries.length === 0) return [];

  const fields = entries.map(fieldsOf);
  const weights = [...asWritten.keys()].map((term) => fields.map((f) => bestWeight(term, f)));
  // How rare each word is. A word in more than half the catalogue ("a", "for",
  // the shared "pay per request in USDC") tells nothing and weighs 0.
  const idf = weights.map((row) => {
    const rarity = Math.log(entries.length / Math.max(1, row.filter((w) => w > 0).length));
    // In exactly half is kept; the epsilon absorbs rounding in the division.
    return rarity >= Math.LN2 - 1e-9 ? rarity : 0;
  });
  const written = [...asWritten.values()];

  const ranked: Ranked<T>[] = [];
  entries.forEach((entry, i) => {
    let score = 0;
    const matchedTerms: string[] = [];
    weights.forEach((row, t) => {
      if (row[i]! > 0 && idf[t]! > 0) {
        score += row[i]! * idf[t]!;
        matchedTerms.push(written[t]!);
      }
    });
    if (score > 0) ranked.push({ entry, matchedTerms, score });
  });
  // Array.prototype.sort is stable, so equal scores keep catalogue order.
  return ranked.sort((a, b) => b.score - a.score);
}
