// Bytes, base64url, ids and the human pairing code.
import { FoxsyncError } from "./errors.js";

export type Bytes = Uint8Array<ArrayBuffer>;

const encoder = new TextEncoder();
export const utf8 = (text: string): Bytes => encoder.encode(text) as Bytes;

export function concat(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function toB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromB64url(text: string): Bytes {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) throw new FoxsyncError("bad-input", "the text is not base64url");
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export const randomBytes = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n));
export const randomId = (): string => toB64url(randomBytes(16));

// 24 letters without I and O, and the digits 2-9: 32 symbols, 5 bits each.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 20;

/** A new one-time pairing code: 20 symbols, 100 random bits. */
export function newCode(): string {
  return Array.from(randomBytes(CODE_LENGTH), (b) => ALPHABET[b & 31]).join("");
}

/** The code in groups of four, for a person to read: ABCD-EFGH-JKLM-NPQR-STUV. */
export const formatCode = (code: string): string => code.match(/.{1,4}/g)!.join("-");

/** Normalize a typed code. Ignores spaces, dashes and case. */
export function parseCode(input: string): string {
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CODE_LENGTH || [...code].some((c) => !ALPHABET.includes(c))) {
    throw new FoxsyncError("bad-input", `a pairing code has ${CODE_LENGTH} characters from ${ALPHABET}`);
  }
  return code;
}
