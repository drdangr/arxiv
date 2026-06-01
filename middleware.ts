import { NextRequest, NextResponse } from "next/server";

// Accepts the secret either as ?key=... in the URL (works with Claude's
// custom-connector form, which has no header field) or as a Bearer header.
export function middleware(req: NextRequest) {
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: "Server misconfigured: MCP_BEARER_TOKEN not set" }, { status: 500 });
  }
  const fromQuery = req.nextUrl.searchParams.get("key");
  const fromHeader = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (fromQuery !== expected && fromHeader !== expected) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
