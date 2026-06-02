import { XMLParser } from "fast-xml-parser";
import { unstable_cache } from "next/cache";

const ARXIV_API = "https://export.arxiv.org/api/query";
const USER_AGENT = "arxiv-mcp/1.0 (personal research assistant)";

// --- Tuning knobs -----------------------------------------------------------
// arXiv asks for ~1 req / 3s and answers bursts with 429/503. We layer two
// caches and a retrying fetch so a hot query never touches the network twice.
const MAX_RETRIES = 3;        // attempts after the first = 3 (so up to 4 calls)
const BASE_DELAY_MS = 600;    // backoff base; grows 600 -> 1200 -> 2400 ...
const MAX_DELAY_MS = 8_000;   // cap any single sleep so we stay within maxDuration
const L1_TTL_MS = 60_000;     // in-memory layer: dedupes repeats within a session
const L1_MAX_ENTRIES = 200;   // crude bound so a warm instance can't grow forever
const L2_TTL_SECONDS = 3_600; // durable Data Cache layer: survives cold starts
// ----------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

export interface ArxivPaper {
  arxiv_id: string;
  title: string;
  authors: string[];
  summary: string;
  published: string;
  updated: string;
  categories: string[];
  primary_category: string;
  pdf_url: string;
  abs_url: string;
  comment?: string;
}

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function cleanId(rawId: string): string {
  // entry id looks like http://arxiv.org/abs/2401.12345v2
  const m = rawId.match(/abs\/(.+)$/);
  return m ? m[1] : rawId;
}

function mapEntry(entry: any): ArxivPaper {
  const links = asArray(entry.link);
  const pdfLink = links.find((l: any) => l["@_title"] === "pdf");
  const absLink = links.find((l: any) => l["@_rel"] === "alternate");
  const cats = asArray(entry.category).map((c: any) => c["@_term"]).filter(Boolean);

  return {
    arxiv_id: cleanId(entry.id),
    title: String(entry.title ?? "").replace(/\s+/g, " ").trim(),
    authors: asArray(entry.author).map((a: any) => a.name).filter(Boolean),
    summary: String(entry.summary ?? "").replace(/\s+/g, " ").trim(),
    published: entry.published ?? "",
    updated: entry.updated ?? "",
    categories: cats,
    primary_category: entry["arxiv:primary_category"]?.["@_term"] ?? cats[0] ?? "",
    pdf_url: pdfLink?.["@_href"] ?? "",
    abs_url: absLink?.["@_href"] ?? cleanId(entry.id),
    comment: entry["arxiv:comment"]?.["#text"] ?? entry["arxiv:comment"],
  };
}

// HTTP statuses worth retrying: rate-limit + transient server errors. A 400
// (bad query) is the caller's fault and will never succeed on retry, so it is
// deliberately absent and fails fast.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// arXiv may send Retry-After as a seconds-count or an HTTP-date. Returns ms,
// or null if absent/unparseable (caller falls back to exponential backoff).
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

// Full jitter on top of exponential growth, so concurrent clients don't all
// wake at the same instant and re-stampede arXiv. A server-sent Retry-After,
// when present, wins over our own schedule. Everything is clamped to MAX_DELAY.
function backoffDelay(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, MAX_DELAY_MS);
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jittered = exp / 2 + Math.random() * (exp / 2);
  return Math.min(jittered, MAX_DELAY_MS);
}

// The raw network + parse layer, wrapped in retry/backoff. This is what the
// caches sit in front of, so a cache hit never reaches here.
async function fetchArxivWithRetry(params: Record<string, string>): Promise<ArxivPaper[]> {
  const url = `${ARXIV_API}?${new URLSearchParams(params).toString()}`;
  let lastErr: Error | null = null;
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(backoffDelay(attempt, retryAfterMs));
      retryAfterMs = null;
    }

    let res: Response;
    try {
      // cache:"no-store" because durability is handled one layer up by
      // unstable_cache; we don't want Next's fetch cache double-storing.
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, cache: "no-store" });
    } catch (e) {
      // Network/DNS/timeout — transient, retry.
      lastErr = e instanceof Error ? e : new Error(String(e));
      continue;
    }

    if (res.ok) {
      const xml = await res.text();
      const parsed = parser.parse(xml);
      return asArray(parsed?.feed?.entry).map(mapEntry);
    }

    if (RETRYABLE_STATUS.has(res.status)) {
      retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      lastErr = new Error(`arXiv API returned ${res.status} ${res.statusText}`);
      continue;
    }

    // Non-retryable HTTP error (e.g. 400): fail immediately.
    throw new Error(`arXiv API returned ${res.status} ${res.statusText}`);
  }

  throw lastErr ?? new Error("arXiv request failed after retries");
}

// L2: durable cache backed by Next's Data Cache. Keyed by ["arxiv-fetch"] plus
// the serialized params argument, so each distinct query gets its own entry.
// Only resolved values are cached — a thrown transient error is not stored.
// Unaffected by the route's force-dynamic setting (that only governs fetch).
const cachedFetchArxiv = unstable_cache(
  (params: Record<string, string>) => fetchArxivWithRetry(params),
  ["arxiv-fetch"],
  { revalidate: L2_TTL_SECONDS, tags: ["arxiv"] }
);

// L1: best-effort in-memory cache. Survives only within a warm serverless
// instance, but that's exactly where back-to-back identical queries in one
// research session land — so it absorbs the common case for free.
interface L1Entry {
  data: ArxivPaper[];
  expires: number;
}
const l1 = new Map<string, L1Entry>();

async function fetchArxiv(params: Record<string, string>): Promise<ArxivPaper[]> {
  const key = new URLSearchParams(params).toString();
  const now = Date.now();

  const hit = l1.get(key);
  if (hit && hit.expires > now) return hit.data;

  const data = await cachedFetchArxiv(params);

  if (l1.size >= L1_MAX_ENTRIES) l1.clear(); // simplest bound; fine for this scale
  l1.set(key, { data, expires: now + L1_TTL_MS });
  return data;
}

// arXiv's API supports field-prefixed, boolean queries — far sharper than a
// bare keyword match. If the caller already used that syntax (ti:, abs:, au:,
// cat:, AND/OR/ANDNOT, or "quoted phrases"), pass it through untouched;
// otherwise treat the text as free-text search across all fields.
const ARXIV_SYNTAX = /\b(?:ti|abs|au|co|jr|cat|rn|all):|\b(?:AND|OR|ANDNOT)\b|"/;

function buildSearchQuery(query: string, category?: string): string {
  const q = query.trim();
  const core = ARXIV_SYNTAX.test(q) ? q : `all:${q}`;
  return category ? `(${core}) AND cat:${category}` : core;
}

export async function searchArxiv(opts: {
  query: string;
  category?: string;
  maxResults?: number;
  sortBy?: "relevance" | "lastUpdatedDate" | "submittedDate";
}): Promise<ArxivPaper[]> {
  return fetchArxiv({
    search_query: buildSearchQuery(opts.query, opts.category),
    start: "0",
    max_results: String(Math.min(opts.maxResults ?? 10, 50)),
    sortBy: opts.sortBy ?? "relevance",
    sortOrder: "descending",
  });
}

export async function getArxivPaper(arxivId: string): Promise<ArxivPaper | null> {
  const cleaned = arxivId.replace(/^arxiv:/i, "").trim();
  const papers = await fetchArxiv({ id_list: cleaned, max_results: "1" });
  return papers[0] ?? null;
}
