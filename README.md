# arXiv MCP (Vercel)

Personal MCP server wrapping the arXiv API.

## Tools

- **search_arxiv** — keyword search. Accepts plain text (matched across all
  fields) or arXiv's native query syntax for precision: field prefixes `ti:`
  `abs:` `au:` `cat:`, boolean `AND`/`OR`/`ANDNOT` (uppercase), parentheses,
  and `"quoted phrases"`. Params: `query`, `category?`, `max_results?`, `sort_by?`.
- **get_arxiv_paper** — fetch one paper's full metadata + abstract by id
  (e.g. `2401.12345` or `2401.12345v2`).
- **semantic_search** — meaning-based search for complex / nuanced topics. Pulls
  a broad candidate set from arXiv, then reranks by cosine similarity of OpenAI
  embeddings (query vs title+abstract). Params: `query` (a rich natural-language
  description), `category?`, `top_k?`. Requires `OPENAI_API_KEY` (see Deploy).

All arXiv calls share one path with retry+backoff (respects `Retry-After`,
total retry time bounded to stay within the serverless limit) and a two-layer
cache (in-memory L1 + durable L2).

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
`OPENAI_API_KEY` is optional — without it, search_arxiv and get_arxiv_paper
still work; only semantic_search needs it.

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
- **arXiv rate-limits bursts.** It asks for ~1 request / 3s and answers bursts
  with HTTP 429 (cooldown lengthens under repeated violations). `semantic_search`
  pulls ~60 candidates in a single request; the retry path honors `Retry-After`
  and is capped at ~15s total so it stays within the 30s function limit. Don't
  hammer it in tight loops.
