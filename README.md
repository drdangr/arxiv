# arXiv MCP (Vercel)

Personal MCP server for searching scientific literature. Primary source is
**OpenAlex** (all scholarly literature — journals, books, preprints incl. arXiv);
arXiv's API is kept as a fallback. Deployed on Vercel.

## Tools

- **search_scientific_literature** — keyword search across all scholarly
  literature (via OpenAlex); matches title/abstract/full text. Params: `query`,
  `category?` (best-effort arXiv hint, used only by the arXiv fallback),
  `max_results?`, `sort_by?`.
- **semantic_search** — meaning-based search for complex / nuanced topics. Pulls
  a broad candidate set from OpenAlex, then reranks by cosine similarity of OpenAI
  embeddings (query vs title+abstract). Params: `query` (a rich natural-language
  description), `category?`, `top_k?`. Requires `OPENAI_API_KEY` (see Deploy).
- **get_arxiv_paper** — fetch one paper's metadata + abstract by arXiv id
  (e.g. `2401.12345` or `2401.12345v2`).

Search runs through one source-agnostic path: **OpenAlex first** (polite pool via
`mailto`), **arXiv only as an empty/error fallback**. A two-layer cache (in-memory
L1 + durable L2) and retry/backoff (bounded total time) wrap it. OpenAlex
abstracts arrive as an inverted index and are reconstructed to plain text.

## Deploy

First-time setup (one-off):

    npm i -g vercel        # if not installed
    cd arxiv-mcp
    vercel deploy --prod   # follow prompts: link to your personal scope, new project

After first deploy, set the environment variables:

    vercel env add MCP_BEARER_TOKEN production   # auth secret guarding the endpoint
    vercel env add OPENAI_API_KEY production      # only for semantic_search (embeddings)
    # paste each value when prompted — never commit secrets

Then redeploy: `vercel deploy --prod`, or just push to `main` (see Updating).
`OPENAI_API_KEY` is optional — without it, search_scientific_literature and
get_arxiv_paper still work; only semantic_search needs it. `OPENALEX_MAILTO` is
also optional (polite-pool contact; falls back to a default in the code).

### Updating

This project is connected to GitHub (`drdangr/arxiv`) through Vercel's git
integration, so pushing to `main` deploys to production automatically:

    git add -A
    git commit -m "your message"
    git push               # Vercel builds main -> production

A manual `vercel deploy --prod` still works as a fallback — it uploads the
local working directory directly, bypassing git.

## MCP endpoint

    https://<your-deployment>.vercel.app/api/mcp

Auth (either works — same secret as `MCP_BEARER_TOKEN`):
- URL query: append `?key=<YOUR_TOKEN>` to the endpoint
- Header: `Authorization: Bearer <YOUR_TOKEN>`

## Connect to Claude
Settings -> Connectors -> Add custom connector -> paste the endpoint URL.
Claude's connector form has no header field, so put the secret in the URL:

    https://<your-deployment>.vercel.app/api/mcp?key=<YOUR_TOKEN>

## Notes

- **New tools need a connector refresh.** After adding or renaming a tool,
  remove and re-add (or refresh) the connector in Claude — an existing
  connection caches the tool list from connect time and won't show new tools.
- **Why OpenAlex is primary.** arXiv's API throttles cloud/datacenter egress IPs
  (e.g. Vercel) with HTTP 429 regardless of request rate, so it can't be the
  primary source from serverless. OpenAlex serves datacenter IPs fine via its
  polite pool (always send `mailto`). arXiv stays as a thin empty/error fallback;
  its retry path is time-bounded (~15s) to stay within the 30s function limit.
