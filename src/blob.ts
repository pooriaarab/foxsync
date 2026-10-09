// The text that moves between the two ends: in a QR code, by copy and
// paste, or through a relay.
//
//   fsy1.q.<id>.<code>.<body>   QR code: pairing code plus sealed offer
//   fsy1.o.<id>.<body>          sealed pairing offer (safe to send anywhere)
//   fsy1.a.<id>.<body>          sealed pairing answer
//   fsy1.ro.<id>.<body>         signed, sealed reconnect offer
//   fsy1.ra.<id>.<body>         signed, sealed reconnect answer
//
// A sealed body is nonce(12) | AES-GCM(deflate-raw(JSON)). The text before
// the body ("fsy1.o.<id>") is the additional data, so a body cannot move to
// another id or kind (docs/failure-modes.md B3, B4).
import { FoxsyncError } from "./errors.js";
import { concat, fromB64url, parseCode, randomBytes, toB64url, utf8, type Bytes } from "./encoding.js";

export type Kind = "q" | "o" | "a" | "ro" | "ra";
const KINDS = new Set<string>(["q", "o", "a", "ro", "ra"]);
const MAX_TEXT = 32_768;

export interface ParsedText {
  kind: Kind;
  id: string;
  code?: string;
  body: Bytes;
}

export function formatText(kind: Kind, id: string, body: Uint8Array, code?: string): string {
  return ["fsy1", kind, id, ...(code ? [code] : []), toB64url(body)].join(".");
}

const bad = (why: string) => new FoxsyncError("bad-input", `this is not foxsync text: ${why}`);

/** Parse foxsync text. Accepts a URL whose fragment holds the text. */
export function parseText(input: string): ParsedText {
  if (input.length > MAX_TEXT) throw new FoxsyncError("too-large", `foxsync text is at most ${MAX_TEXT} characters`);
  const text = input.trim().slice(input.trim().lastIndexOf("#") + 1);
  const parts = text.split(".");
  const [version, kind, id] = parts;
  if (version !== "fsy1") throw bad("it does not start with fsy1");
  if (!kind || !KINDS.has(kind)) throw bad("unknown kind");
  if (parts.length !== (kind === "q" ? 5 : 4)) throw bad("wrong number of parts; is it cut short?");
  if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw bad("bad id");
  const body = fromB64url(parts.at(-1)!);
  if (!body.length) throw bad("empty body");
  return { kind: kind as Kind, id, ...(kind === "q" ? { code: parseCode(parts[3]!) } : {}), body };
}

async function pipe(data: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  return new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer());
}

export async function seal(key: CryptoKey, aad: string, value: unknown): Promise<Bytes> {
  const plain = await pipe(utf8(JSON.stringify(value)), new CompressionStream("deflate-raw"));
  const iv = randomBytes(12);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, plain);
  return concat(iv, new Uint8Array(sealed));
}

export async function open(key: CryptoKey, aad: string, body: Bytes): Promise<unknown> {
  let plain: Bytes;
  try {
    const iv = body.slice(0, 12);
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: utf8(aad) }, key, body.slice(12)));
  } catch {
    throw new FoxsyncError("bad-mac", "the text failed authentication: it was changed, or the code or pair is wrong");
  }
  try {
    return JSON.parse(new TextDecoder().decode(await pipe(plain, new DecompressionStream("deflate-raw"))));
  } catch {
    throw new FoxsyncError("bad-input", "the sealed text does not hold JSON");
  }
}
