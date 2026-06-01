# arXiv MCP (Vercel)

Personal MCP server wrapping the arXiv API. Two tools: search_arxiv, get_arxiv_paper.

## Deploy

First-time setup (one-off):

    npm i -g vercel        # if not installed
    cd arxiv-mcp
    vercel deploy --prod   # follow prompts: link to your personal scope, new project

After first deploy, set the auth token and redeploy:

    vercel env add MCP_BEARER_TOKEN production
    # paste your own secret token (never commit it)
    vercel deploy --prod

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

Header required:  Authorization: Bearer <YOUR_TOKEN>

## Connect to Claude
Settings -> Connectors -> Add custom connector -> paste the /api/mcp URL and the bearer token.
