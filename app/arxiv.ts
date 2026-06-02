import { XMLParser } from "fast-xml-parser";
import { unstable_cache } from "next/cache";

// --- Data sources -----------------------------------------------------------
// PRIMARY: OpenAlex — indexes ALL scholarly literature (not just arXiv), needs
// no API key, and serves datacenter IPs fine via its polite pool (send mailto).
// FALLBACK: arXiv's Atom API — only when OpenAlex returns empty/errors, or for
// fetching a paper by arXiv id. (arXiv throttles Vercel's egress IPs with 429,
// so it can't be primary from serverless.)
const ARXIV_API = "https://export.arxiv.org/api/query";
const OPENALEX_WORKS = "https://api.openalex.org/works";
const MAILTO = process.env.OPENALEX_MAILTO ?? "drdangr@gmail.com"; // polite pool contact
const USER_AGENT = `arxiv-mcp/1.0 (mailto:${MAILTO})`;

// --- Tuning knobs -----------------------------------------------------------
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 600;
const MAX_DELAY_MS = 8_000;
const RETRY_BUDGET_MS = 15_000; // ceiling on total arXiv retry time, under Vercel's 30s
const L1_TTL_MS = 60_000;
const L1_MAX_ENTRIES = 200;
const L2_TTL_SECONDS = 3_600;
// ----------------------------------------------------------------------------

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

export interface ArxivPaper {
  arxiv_id: string; // "" when the work is not on arXiv
  doi?: string;
  source?: string; // venue / repository, e.g. "arXiv", a journal name
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

// arXiv-native query syntax (field prefixes / booleans / quotes). Used to build
// the arXiv fallback query, and to strip down to plain terms for OpenAlex.
const ARXIV_SYNTAX = /\b(?:ti|abs|au|co|jr|cat|rn|all):|\b(?:AND|OR|ANDNOT)\b|"/;

// OpenAlex has no arXiv-native syntax. If a query arrives with it, reduce it to
// bare content terms so OpenAlex doesn't search for literal "ti:" / "AND".
function toPlainTerms(q: string): string {
  return q
    .replace(/\b(?:ti|abs|au|co|jr|cat|rn|all):/gi, " ")
    .replace(/\b(?:AND|OR|ANDNOT)\b/g, " ")
    .replace(/[()"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ============================================================================
// Source A: OpenAlex (primary) — all scholarly literature
// ============================================================================

// OpenAlex returns abstracts as an inverted index { word -> [positions] }.
function abstractFromInverted(inv?: Record<string, number[]>): string {
  if (!inv) return "";
  const slots: string[] = [];
  for (const [word, positions] of Object.entries(inv))
    for (const p of positions) slots[p] = word;
  return tidy(slots.join(" "));
}

// OpenAlex data occasionally carries literal "\n"/"\t" escapes in titles/tokens.
function tidy(s: string): string {
  return s.replace(/\\[nrt]/g, " ").replace(/\s+/g, " ").trim();
}

// Derive an arXiv id when the work happens to be on arXiv (else ""):
// from the DOI (10.48550/arxiv.<id>) or the landing page URL (.../abs/<id>).
function arxivIdFromWork(w: any): string {
  const doi: string = w?.doi ?? "";
  const fromDoi = doi.match(/arxiv\.([^/]+)$/i);
  if (fromDoi) return fromDoi[1];
  const landing: string = w?.primary_location?.landing_page_url ?? "";
  const fromUrl = landing.match(/abs\/(.+)$/i);
  if (fromUrl) return fromUrl[1];
  return "";
}

function openAlexToWork(w: any): ArxivPaper | null {
  const title = tidy(String(w?.display_name ?? w?.title ?? ""));
  if (!title) return null; // unusable record
  const arxivId = arxivIdFromWork(w);
  const doi = (w?.doi ?? "").replace(/^https?:\/\/doi\.org\//i, "");
  const loc = w?.primary_location ?? {};
  const oa = w?.best_oa_location ?? {};
  const topic: string = w?.primary_topic?.display_name ?? "";
  const landing: string = loc?.landing_page_url ?? (doi ? `https://doi.org/${doi}` : "");
  return {
    arxiv_id: arxivId,
    doi: doi || undefined,
    source: loc?.source?.display_name ?? undefined,
    title,
    authors: asArray<any>(w?.authorships).map((a) => a?.author?.display_name).filter(Boolean),
    summary: abstractFromInverted(w?.abstract_inverted_index),
    published: w?.publication_date ?? "",
    updated: w?.publication_date ?? "",
    categories: topic ? [topic] : [],
    primary_category: topic,
    pdf_url: loc?.pdf_url ?? oa?.pdf_url ?? "",
    abs_url: landing,
  };
}

// Light fetch+parse with a couple retries on 5xx/network. 4xx fails fast.
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
  const terms = toPlainTerms((req.query ?? "").trim());
  const perPage = Math.min(req.maxResults ?? 10, 200);
  const url =
    `${OPENALEX_WORKS}?filter=default.search:${encodeURIComponent(terms)}` +
    `&sort=${openAlexSort(req.sortBy)}` +
    `&per-page=${perPage}` +
    `&mailto=${encodeURIComponent(MAILTO)}`;

  const json = await fetchJson(url);
  const seen = new Set<string>();
  const works: ArxivPaper[] = [];
  for (const w of asArray<any>(json?.results)) {
    const p = openAlexToWork(w);
    if (!p) continue;
    const dedupKey = p.arxiv_id || p.doi || p.title;
    if (seen.has(dedupKey)) continue; // OpenAlex sometimes holds duplicate works
    seen.add(dedupKey);
    works.push(p);
  }
  return works;
}

async function getByIdOnOpenAlex(arxivId: string): Promise<ArxivPaper | null> {
  const base = arxivId.replace(/v\d+$/i, ""); // arXiv DOIs are versionless
  const url = `${OPENALEX_WORKS}/doi:10.48550/arxiv.${base}?mailto=${encodeURIComponent(MAILTO)}`;
  try {
    return openAlexToWork(await fetchJson(url, 1));
  } catch {
    return null; // 404 / not found → caller falls back to arXiv
  }
}

// ============================================================================
// Source B: arXiv Atom API (fallback)
// ============================================================================

function cleanId(rawId: string): string {
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
    source: "arXiv",
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
      if (Date.now() + delay > deadline) break;
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
      const parsed = parser.parse(await res.text());
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
}

function reqKey(r: WorksReq): string {
  return r.mode === "byId"
    ? `byId:${r.arxivId}`
    : `search:${r.sortBy}:${r.maxResults}:${r.category ?? ""}:${r.query}`;
}

// Source-agnostic core: OpenAlex first (all literature), arXiv only as a
// last resort when OpenAlex is empty/errors. Cache + retry wrap THIS.
async function fetchWorks(req: WorksReq): Promise<ArxivPaper[]> {
  if (req.mode === "byId") {
    const fromOpenAlex = await getByIdOnOpenAlex(req.arxivId ?? "");
    if (fromOpenAlex) return [fromOpenAlex];
    return getByIdOnArxiv(req.arxivId ?? "");
  }
  try {
    const oa = await searchOnOpenAlex(req);
    if (oa.length > 0) return oa;
  } catch {
    // OpenAlex failed → try arXiv (best-effort; may 429 from serverless).
  }
  try {
    return await searchOnArxiv(req);
  } catch {
    return [];
  }
}

// L2: durable Data Cache. Key bumped to works-v3 (ArxivPaper shape changed).
const cachedWorks = unstable_cache((req: WorksReq) => fetchWorks(req), ["works-v3"], {
  revalidate: L2_TTL_SECONDS,
  tags: ["arxiv"],
});

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
  return fetchWorksCached({
    mode: "search",
    query: opts.query.trim(),
    category: opts.category,
    maxResults: opts.maxResults,
    sortBy: opts.sortBy ?? "relevance",
  });
}

export async function getArxivPaper(arxivId: string): Promise<ArxivPaper | null> {
  const cleaned = arxivId.replace(/^arxiv:/i, "").trim();
  const results = await fetchWorksCached({ mode: "byId", arxivId: cleaned });
  return results[0] ?? null;
}
