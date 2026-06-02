// Semantic reranking via OpenAI embeddings + cosine similarity.
// We embed the query and the candidate documents in a single batched call,
// then order candidates by cosine similarity to the query. This is the
// "embed-then-cosine" rerank (OpenAI has no dedicated reranker endpoint).

const OPENAI_EMBEDDINGS_API = "https://api.openai.com/v1/embeddings";
const EMBEDDING_MODEL = "text-embedding-3-small"; // cheap + strong; -large for max quality

// Batch-embed texts in one request. OpenAI accepts an array input and returns
// one embedding per item; we sort by `index` to be robust to ordering.
async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch(OPENAI_EMBEDDINGS_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
    cache: "no-store",
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`OpenAI embeddings ${res.status} ${res.statusText} ${detail.slice(0, 200)}`);
  }

  const json = await res.json();
  return (json.data as Array<{ index: number; embedding: number[] }>)
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// Reorder `candidates` by semantic similarity of each to `query`, highest first.
// `toText` extracts the text to embed for a candidate (e.g. title + abstract).
export async function rerankBySimilarity<T>(
  query: string,
  candidates: T[],
  toText: (c: T) => string
): Promise<Array<{ item: T; score: number }>> {
  if (candidates.length === 0) return [];

  // One batched call: position 0 is the query, the rest are the candidates.
  const vectors = await embedTexts([query, ...candidates.map(toText)]);
  const queryVec = vectors[0];

  return candidates
    .map((item, i) => ({ item, score: cosine(queryVec, vectors[i + 1]) }))
    .sort((a, b) => b.score - a.score);
}
