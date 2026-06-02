import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { searchArxiv, getArxivPaper, ArxivPaper } from "../../arxiv";
import { rerankBySimilarity } from "../../rerank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function formatPaper(p: ArxivPaper): string {
  const meta = [
    p.arxiv_id ? `arXiv:${p.arxiv_id}` : p.doi ? `doi:${p.doi}` : null,
    p.source || null,
    p.primary_category || null,
    p.published ? `published ${p.published.slice(0, 10)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
  return [
    `**${p.title}**`,
    meta,
    `Authors: ${p.authors.join(", ")}`,
    p.comment ? `Comment: ${p.comment}` : "",
    ``,
    p.summary,
    ``,
    p.pdf_url ? `PDF: ${p.pdf_url}` : "",
    p.abs_url ? `Link: ${p.abs_url}` : "",
  ].filter(Boolean).join("\n");
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "search_scientific_literature",
      "Keyword search across scholarly literature (all fields, via OpenAlex; arXiv preprints and peer-reviewed work alike). Returns titles, authors, abstracts, and links. For meaning-based search on complex topics, prefer semantic_search.",
      {
        query: z.string().describe("Keywords or a short phrase matched across title, abstract and full text, e.g. 'retrieval augmented generation'."),
        category: z.string().optional().describe("Best-effort arXiv category hint (e.g. 'cs.CL'); only applied if the arXiv fallback is used."),
        max_results: z.number().int().min(1).max(50).optional().describe("Number of results, default 10, max 50"),
        sort_by: z.enum(["relevance", "lastUpdatedDate", "submittedDate"]).optional().describe("Sort order, default relevance. Use submittedDate for newest first."),
      },
      async ({ query, category, max_results, sort_by }) => {
        try {
          const papers = await searchArxiv({ query, category, maxResults: max_results, sortBy: sort_by });
          if (papers.length === 0) {
            return { content: [{ type: "text", text: `No arXiv papers found for "${query}"${category ? ` in ${category}` : ""}. Try broader terms or removing the category filter.` }] };
          }
          const text = papers.map((p, i) => `### ${i + 1}. ${formatPaper(p)}`).join("\n\n---\n\n");
          return { content: [{ type: "text", text }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `arXiv search failed: ${e.message}. The arXiv API may be temporarily unavailable; retry shortly.` }], isError: true };
        }
      }
    );

    server.tool(
      "get_arxiv_paper",
      "Fetch a single arXiv paper by its id (e.g. '2401.12345' or '2401.12345v2'). Returns full metadata and abstract.",
      {
        arxiv_id: z.string().describe("arXiv identifier, e.g. '2401.12345' or '2401.12345v2'"),
      },
      async ({ arxiv_id }) => {
        try {
          const paper = await getArxivPaper(arxiv_id);
          if (!paper) {
            return { content: [{ type: "text", text: `No paper found for id "${arxiv_id}". Check the id format (e.g. 2401.12345).` }] };
          }
          return { content: [{ type: "text", text: formatPaper(paper) }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Failed to fetch paper: ${e.message}` }], isError: true };
        }
      }
    );

    server.tool(
      "semantic_search",
      "Semantically search scholarly literature: pulls a broad candidate set (all fields, via OpenAlex), then reranks it by meaning using embeddings. Use for complex or nuanced topics where keyword matching misses relevant work or buries it under false matches. Phrase the query as a rich description.",
      {
        query: z.string().describe("A rich natural-language description of what you want, e.g. 'how language-model agents retain memory across long multi-step tasks'. Describe the concept in full — semantic rerank rewards detail, not keywords."),
        category: z.string().optional().describe("Optional arXiv category filter, e.g. 'cs.AI', 'cs.CL', 'cs.LG'"),
        top_k: z.number().int().min(1).max(20).optional().describe("How many reranked results to return, default 8"),
      },
      async ({ query, category, top_k }) => {
        try {
          const candidates = await searchArxiv({ query, category, maxResults: 60, sortBy: "relevance" });
          if (candidates.length === 0) {
            return { content: [{ type: "text", text: `No arXiv candidates found for "${query}"${category ? ` in ${category}` : ""}. Try broader terms or removing the category filter.` }] };
          }
          const ranked = await rerankBySimilarity(query, candidates, (p) => `${p.title}\n\n${p.summary}`);
          const top = ranked.slice(0, top_k ?? 8);
          const text = top
            .map((r, i) => `### ${i + 1}. [similarity ${r.score.toFixed(3)}] ${formatPaper(r.item)}`)
            .join("\n\n---\n\n");
          return { content: [{ type: "text", text }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Semantic search failed: ${e.message}. (Keyword search_arxiv still works.)` }], isError: true };
        }
      }
    );
  },
  {},
  { basePath: "/api" }
);

export { handler as GET, handler as POST };
