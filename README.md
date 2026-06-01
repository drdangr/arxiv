# arXiv MCP (Vercel)

Personal MCP server wrapping the arXiv API. Two tools: search_arxiv, get_arxiv_paper.

## Deploy

    npm i -g vercel        # if not installed
    cd arxiv-mcp
    vercel deploy --prod   # follow prompts: link to your personal scope, new project

After first deploy, set the auth token and redeploy:

    vercel env add MCP_BEARER_TOKEN production
    # paste: <YOUR_TOKEN>
    vercel deploy --prod

## MCP endpoint

    https://<your-deployment>.vercel.app/api/mcp

Header required:  Authorization: Bearer <YOUR_TOKEN>

## Connect to Claude
Settings -> Connectors -> Add custom connector -> paste the /api/mcp URL and the bearer token.
