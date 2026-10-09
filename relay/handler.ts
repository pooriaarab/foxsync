// The relay's request handler, kept apart from Cloudflare types so tests
// can run it. It stores one foxsync text per box and slot for 10 minutes.
// It never sees a key: every text it stores is sealed by the two ends.
//
//   PUT    /v1/<box>/<slot>   store the body (foxsync text, at most 16 KiB)
//   GET    /v1/<box>/<slot>   200 with the text, or 404
//   DELETE /v1/<box>/<slot>   forget it
// box: 22 base64url characters (128 bits). slot: "o" (offer) or "a" (answer).

export interface Stored {
  text: string;
  at: number;
}

export interface BoxStore {
  get(key: string): Promise<Stored | undefined>;
  put(key: string, value: Stored): Promise<void>;
  delete(key: string): Promise<void>;
}

export const TTL_MS = 10 * 60_000;
export const MAX_BYTES = 16_384;
const ROUTE = /^\/v1\/([A-Za-z0-9_-]{22})\/(o|a)$/;
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, PUT, DELETE, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const reply = (status: number, body: string | null = null) =>
  new Response(body, { status, headers: { ...CORS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });

/** The box name for a request, or null when the path is not a relay route. */
export function boxOf(request: Request): string | null {
  return ROUTE.exec(new URL(request.url).pathname)?.[1] ?? null;
}

export async function handle(request: Request, store: BoxStore, now: number): Promise<Response> {
  const route = ROUTE.exec(new URL(request.url).pathname);
  if (!route) return reply(404, "not found");
  const key = `${route[1]}/${route[2]}`;
  switch (request.method) {
    case "OPTIONS":
      return reply(204);
    case "PUT": {
      const length = Number(request.headers.get("content-length") ?? 0);
      if (length > MAX_BYTES) return reply(413, "too large");
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_BYTES) return reply(413, "too large");
      if (!/^fsy1\.[a-z]{1,2}\.[A-Za-z0-9_-]{1,64}\.[A-Za-z0-9_-]+$/.test(text)) return reply(400, "only foxsync text");
      await store.put(key, { text, at: now });
      return reply(204);
    }
    case "GET": {
      const stored = await store.get(key);
      if (!stored) return reply(404, "empty");
      if (now - stored.at > TTL_MS) {
        await store.delete(key);
        return reply(404, "expired");
      }
      return reply(200, stored.text);
    }
    case "DELETE":
      await store.delete(key);
      return reply(204);
    default:
      return reply(405, "method not allowed");
  }
}
