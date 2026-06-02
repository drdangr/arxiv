import { XMLParser } from "fast-xml-parser";
import { unstable_cache } from "next/cache";

// --- Data sources -----------------------------------------------------------
// PRIMARY: OpenAlex. It indexes all arXiv preprints, needs no API key, and —
// crucially — serves datacenter IPs fine via its "polite pool" (send `mailto`).
// arXiv's own API throttles cloud egress IPs (Vercel) with 429 regardless of
// our rate, so it can't be the primary source from serverless.
// FALLBACK: arXiv's Atom API — used when OpenAlex is empty/errors, or when the
// query needs arXiv-native syntax / a precise arXiv category filter.
const ARXIV_API = "https://export.arxiv.org/api/query";
const OPENALEX_WORKS = "https://api.openalex.org/works";
const ARXIV_SOURCE_ID = "S4306400194"; // OpenAlex source "arXiv (Cornell University)"
const MAILTO = process.env.OPENALEX_MAILTO ?? "drdangr@gmail.com"; // polite pool contact
const USER_AGENT = `arxiv-mcp/1.0 (mailto:${MAILTO})`;

// --- Tuning knobs -----------------------------------------------------------
const MAX_RETRIES = 3;        // arXiv path: attempts after the first
const BASE_DELAY_MS = 600;    // backoff base; grows 600 -> 1200 -> 2400 ...
const MAX_DELAY_MS = 8_000;   // cap any single sleep
const RETRY_BUDGET_MS = 15_000; // ceiling on TOTAL arXiv retry time, stays under Vercel's 30s
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

type SortBy = "relevance" | "lastUpdatedDate" | "submittedDate";

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// arXiv's API supports field-prefixed, boolean queries — far sharper than a
// bare keyword match. If the caller already used that syntax (ti:, abs:, au:,
// cat:, AND/OR/ANDNOT, or "quoted phrases"), pass it through untouched;
// otherwise treat the text as free-text search across all fields. Presence of
// this syntax also routes a search straight to arXiv (OpenAlex can't honor it).
const ARXIV_SYNTAX = /\b(?:ti|abs|au|co|jr|cat|rn|all):|\b(?:AND|OR|ANDNOT)\b|"/;

// ============================================================================
// Source A: OpenAlex (primary)
// ============================================================================

// OpenAlex returns abstracts as an inverted index { word -> [positions] }.
// Rebuild the linear text before storing it in `summary` / embedding it.
// OpenAlex source data occasionally carries literal "\n"/"\t" escape sequences
// inside titles and tokens; strip those and collapse real whitespace.
function tidy(s: string): string {
  return s.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
}

function abstractFromInverted(inv?: Record<string, number[]>): string {
  if (!inv) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(inv))
    for (const p of positions) slots[p] = word;
  return tidy(slots.join(" "));
}

// OpenAlex has no `ids.arxiv` field; derive the arXiv id from the DOI
// (10.48550/arxiv.<id>) or the landing page URL (.../abs/<id>).
function arxivIdFromWork(w: any): string {
  const doi: string = w?.doi ?? "";
  const fromDoi = doi.match(/arxiv\.([^/]+)$/i);
  if (fromDoi) return fromDoi[1];
  const landing: string = w?.primary_location?.landing_page_url ?? "";
  const fromUrl = landing.match(/abs\/(.+)$/i);
  if (fromUrl) return fromUrl[1];
  return "";
}

function openAlexToArxivPaper(w: any): ArxivPaper | null {
  const arxivId = arxivIdFromWork(w);
  if (!arxivId) return null; // not an arXiv-addressable work — skip
  const topic: string = w?.primary_topic?.display_name ?? "";
  return {
    arxiv_id: arxivId,
    title: tidy(String(w?.display_name ?? w?.title ?? "")),
    authors: asArray<any>(w?.authorships).map((a) => a?.author?.display_name).filter(Boolean),
    summary: abstractFromInverted(w?.abstract_inverted_index),
    published: w?.publication_date ?? "",
    updated: w?.publication_date ?? "", // OpenAlex has no separate "updated"
    categories: topic ? [topic] : [], // OpenAlex topics ≠ arXiv categories — best-effort label
    primary_category: topic,
    pdf_url: w?.primary_location?.pdf_url ?? w?.best_oa_location?.pdf_url ?? `https://arxiv.org/pdf/${arxivId}`,
    abs_url: w?.primary_location?.landing_page_url ?? `https://arxiv.org/abs/${arxivId}`,
  };
}

// Light fetch+parse with a couple of retries on 5xx/network. OpenAlex doesn't
// throttle the polite pool, so no elaborate backoff is needed. 4xx fails fast.
async function fetchJson(url: string, retries = 2): Promise<any> {
  let lastErr: Error | null = null;
  for (let i = 0; i <= retries; i++) {
    if (i > 0) await sleep(300 * i);
    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, cache: "no-store" });
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
      continue;
    }
    if (res.status >= 500) {
      lastErr = new Error(`OpenAlex ${res.status} ${res.statusText}`);
      continue;
    }
    if (!res.ok) throw new Error(`OpenAlex ${res.status} ${res.statusText}`);
    return res.json();
  }
  throw lastErr ?? new Error("OpenAlex request failed");
}

function openAlexSort(sortBy?: SortBy): string {
  return sortBy === "submittedDate" || sortBy === "lastUpdatedDate"
    ? "publication_date:desc"
    : "relevance_score:desc";
}

async function searchOnOpenAlex(req: WorksReq): Promise<ArxivPaper[]> {
  const query = (req.query ?? "").trim();
  // Full-text search AND restrict to the arXiv source, combined in one filter.
  // The query value is encoded so commas/colons in it don't split the filter.
  const filter = `default.search:${encodeURIComponent(query)},locations.source.id:${ARXIV_SOURCE_ID}`;
  const perPage = Math.min(req.maxResults ?? 10, 200);
  const url =
    `${OPENALEX_WORKS}?filter=${filter}` +
    `&sort=${openAlexSort(req.sortBy)}` +
    `&per-page=${perPage}` +
    `&mailto=${encodeURIComponent(MAILTO)}`;

  const json = await fetchJson(url);
  const seen = new Set<string>();
  const papers: ArxivPaper[] = [];
  for (const w of asArray<any>(json?.results)) {
    const p = openAlexToArxivPaper(w);
    if (p && !seen.has(p.arxiv_id)) {
      seen.add(p.arxiv_id); // OpenAlex sometimes holds duplicate works per paper
      papers.push(p);
    }
  }
  return papers;
}

async function getByIdOnOpenAlex(arxivId: string): Promise<ArxivPaper | null> {
  const base = arxivId.replace(/v\d+$/i, ""); // arXiv DOIs are versionless
  const url = `${OPENALEX_WORKS}/doi:10.48550/arxiv.${base}?mailto=${encodeURIComponent(MAILTO)}`;
  try {
    const work = await fetchJson(url, 1);
    return openAlexToArxivPaper(work);
  } catch {
    return null; // 404 / not found → caller falls back to arXiv
  }
}

// ============================================================================
// Source B: arXiv Atom API (fallback)
// ============================================================================

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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

// Full jitter on exponential growth; a server-sent Retry-After wins; clamped.
function backoffDelay(attempt: number, retryAfterMs: number | null): number {
  if (retryAfterMs != null) return Math.min(retryAfterMs, MAX_DELAY_MS);
  const exp = BASE_DELAY_MS * 2 ** (attempt - 1);
  const jittered = exp / 2 + Math.random() * (exp / 2);
  return Math.min(jittered, MAX_DELAY_MS);
}

async function fetchArxivWithRetry(params: Record<string, string>): Promise<ArxivPaper[]> {
  const url = `${ARXIV_API}?${new URLSearchParams(params).toString()}`;
  const deadline = Date.now() + RETRY_BUDGET_MS;
  let lastErr: Error | null = null;
  let retryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt, retryAfterMs);
      if (Date.now() + delay > deadline) break; // don't blow maxDuration
      await sleep(delay);
      retryAfterMs = null;
    }

    let res: Response;
    try {
      res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, cache: "no-store" });
    } catch (e) {
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

    throw new Error(`arXiv API returned ${res.status} ${res.statusText}`);
  }

  throw lastErr ?? new Error("arXiv request failed after retries");
}

function buildSearchQuery(query: string, category?: string): string {
  const q = query.trim();
  const core = ARXIV_SYNTAX.test(q) ? q : `all:${q}`;
  return category ? `(${core}) AND cat:${category}` : core;
}

function searchOnArxiv(req: WorksReq): Promise<ArxivPaper[]> {
  return fetchArxivWithRetry({
    search_query: buildSearchQuery(req.query ?? "", req.category),
    start: "0",
    max_results: String(Math.min(req.maxResults ?? 10, 100)),
    sortBy: req.sortBy ?? "relevance",
    sortOrder: "descending",
  });
}

function getByIdOnArxiv(arxivId: string): Promise<ArxivPaper[]> {
  return fetchArxivWithRetry({ id_list: arxivId, max_results: "1" });
}

// ============================================================================
// Provider dispatch + caching
// ============================================================================

interface WorksReq {
  mode: "search" | "byId";
  query?: string;
  category?: string;
  maxResults?: number;
  sortBy?: SortBy;
  arxivId?: string;
  forceArxiv?: boolean; // native syntax or category present → skip OpenAlex
}

function reqKey(r: WorksReq): string {
  return r.mode === "byId"
    ? `byId:${r.arxivId}`
    : `search:${r.forceArxiv ? "arxiv" : "auto"}:${r.sortBy}:${r.maxResults}:${r.category ?? ""}:${r.query}`;
}

// Source-agnostic core: OpenAlex first, arXiv as fallback. Cache + retry wrap
// THIS, not a specific source, so switching/falling back is transparent.
async function fetchWorks(req: WorksReq): Promise<ArxivPaper[]> {
  if (req.mode === "byId") {
    const fromOpenAlex = await getByIdOnOpenAlex(req.arxivId ?? "");
    if (fromOpenAlex) return [fromOpenAlex];
    return getByIdOnArxiv(req.arxivId ?? "");
  }

  if (!req.forceArxiv) {
    try {
      const oa = await searchOnOpenAlex(req);
      if (oa.length > 0) return oa;
    } catch {
      // OpenAlex failed → fall through to arXiv.
    }
  }
  return searchOnArxiv(req);
}

// L2: durable Data Cache (survives cold starts; unaffected by force-dynamic).
const cachedWorks = unstable_cache((req: WorksReq) => fetchWorks(req), ["works-v2"], {
  revalidate: L2_TTL_SECONDS,
  tags: ["arxiv"],
});

// L1: best-effort in-memory cache within a warm serverless instance.
interface L1Entry {
  data: ArxivPaper[];
  expires: number;
}
const l1 = new Map<string, L1Entry>();

async function fetchWorksCached(req: WorksReq): Promise<ArxivPaper[]> {
  const key = reqKey(req);
  const now = Date.now();

  const hit = l1.get(key);
  if (hit && hit.expires > now) return hit.data;

  const data = await cachedWorks(req);

  if (l1.size >= L1_MAX_ENTRIES) l1.clear();
  l1.set(key, { data, expires: now + L1_TTL_MS });
  return data;
}

// ============================================================================
// Public API (unchanged signatures)
// ============================================================================

export async function searchArxiv(opts: {
  query: string;
  category?: string;
  maxResults?: number;
  sortBy?: SortBy;
}): Promise<ArxivPaper[]> {
  const q = opts.query.trim();
  // Route to arXiv when the query needs arXiv-native syntax or a precise
  // category filter; otherwise OpenAlex is primary (with arXiv fallback).
  const forceArxiv = !!opts.category || ARXIV_SYNTAX.test(q);
  return fetchWorksCached({
    mode: "search",
    query: q,
    category: opts.category,
    maxResults: opts.maxResults,
    sortBy: opts.sortBy ?? "relevance",
    forceArxiv,
  });
}

export async function getArxivPaper(arxivId: string): Promise<ArxivPaper | null> {
  const cleaned = arxivId.replace(/^arxiv:/i, "").trim();
  const results = await fetchWorksCached({ mode: "byId", arxivId: cleaned });
  return results[0] ?? null;
}
