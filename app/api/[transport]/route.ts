import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { searchArxiv, getArxivPaper, ArxivPaper } from "../../arxiv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

function formatPaper(p: ArxivPaper): string {
  return [
    `**${p.title}**`,
    `arXiv:${p.arxiv_id} | ${p.primary_category} | published ${p.published?.slice(0, 10)}`,
    `Authors: ${p.authors.join(", ")}`,
    p.comment ? `Comment: ${p.comment}` : "",
    ``,
    p.summary,
    ``,
    `PDF: ${p.pdf_url}`,
    `Abstract page: ${p.abs_url}`,
  ].filter(Boolean).join("\n");
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "search_arxiv",
      "Search arXiv preprints by free-text query. Best for CS/ML/physics/math research (e.g. cs.AI, cs.CL, cs.LG). Returns titles, authors, abstracts, and PDF links.",
      {
        query: z.string().describe("Free-text search query, e.g. 'memory in LLM agents' or 'retrieval augmented generation'"),
        category: z.string().optional().describe("Optional arXiv category filter, e.g. 'cs.AI', 'cs.CL', 'cs.LG'"),
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
  },
  {},
  { basePath: "/api" }
);

export { handler as GET, handler as POST };
