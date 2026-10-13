// The relay client. The relay only stores sealed text in a box whose id
// comes from the pairing code or the pair key, so it cannot read or forge
// what it carries. Anything wrong in a box is skipped (failure-modes Y4, Y7).
import { deriveBytes } from "./crypto.js";
import { toB64url, utf8 } from "./encoding.js";
import { FoxsyncError, type FoxsyncErrorCode } from "./errors.js";

export type Slot = "o" | "a";
const SKIP = new Set<FoxsyncErrorCode>(["bad-input", "bad-mac", "bad-signature", "replay", "stale"]);
/** Wait ms, or less when the signal aborts. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((done) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });
const url = (base: string, box: string, slot: Slot) => `${base.replace(/\/+$/, "")}/v1/${box}/${slot}`;

/** The box id: 16 bytes from HKDF over the root and the pairing id. */
export async function relayBox(root: CryptoKey, id: string): Promise<string> {
  return toB64url(await deriveBytes(root, utf8(id), "fsy box", 16));
}

export async function relayPut(base: string, box: string, slot: Slot, text: string): Promise<void> {
  const response = await fetch(url(base, box, slot), { method: "PUT", body: text });
  if (!response.ok) throw new FoxsyncError("bad-input", `the relay refused the text: ${response.status}`);
}

/**
 * Poll the box until use(text) succeeds. Each text is deleted after it is
 * read. A text that fails as forged, replayed or stale is skipped. When
 * the signal aborts, the poll stops at once and rejects with its reason (Y10).
 */
export async function relayTake<T>(base: string, box: string, slot: Slot, use: (text: string) => Promise<T>, waitMs: number, pollMs: number, signal?: AbortSignal): Promise<T> {
  const deadline = Date.now() + waitMs;
  let last = "no text arrived";
  for (;;) {
    signal?.throwIfAborted();
    let text: string | null = null;
    try {
      const response = await fetch(url(base, box, slot), { signal });
      if (response.ok) {
        text = await response.text();
        await fetch(url(base, box, slot), { method: "DELETE" });
      }
    } catch (error) {
      signal?.throwIfAborted();
      last = `the relay is not reachable: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (text !== null) {
      try {
        return await use(text);
      } catch (error) {
        if (!(error instanceof FoxsyncError) || !SKIP.has(error.code)) throw error;
        last = `skipped a text from the relay: ${error.message}`;
      }
    }
    if (Date.now() + pollMs > deadline) throw new FoxsyncError("timeout", `nothing usable from the relay within ${waitMs} ms (${last})`);
    await sleep(pollMs, signal);
  }
}
