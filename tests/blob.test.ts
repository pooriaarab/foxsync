import { describe, expect, it } from "vitest";
import { formatText, open, parseText, seal } from "../src/blob.js";
import { rootKey, deriveAes } from "../src/crypto.js";
import { formatCode, newCode, parseCode, utf8 } from "../src/encoding.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const key = async () => deriveAes(await rootKey(utf8("test secret material")), utf8("id1"), "fsy test");

describe("pairing code", () => {
  it("B1 has 20 characters from a 32-character set, so 100 random bits", () => {
    const codes = new Set(Array.from({ length: 200 }, () => newCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toHaveLength(20);
      for (const ch of code) expect(ALPHABET).toContain(ch);
    }
    expect(ALPHABET.length ** 20).toBe(2 ** 100);
  });

  it("B2 ignores dashes, spaces and case, and rejects typos", () => {
    const code = newCode();
    expect(parseCode(formatCode(code))).toBe(code);
    expect(parseCode(` ${formatCode(code).toLowerCase()} `)).toBe(code);
    expect(() => parseCode(code.slice(1))).toThrow(/bad-input/);
    expect(() => parseCode(`O${code.slice(1)}`)).toThrow(/bad-input/);
    expect(formatCode(code)).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  });
});

describe("sealed blobs", () => {
  it("round-trips a value", async () => {
    const k = await key();
    const body = await seal(k, "fsy1.o.id1", { sdp: "v=0", n: 1 });
    expect(await open(k, "fsy1.o.id1", body)).toEqual({ sdp: "v=0", n: 1 });
  });

  it("B3 rejects a changed byte", async () => {
    const k = await key();
    const body = await seal(k, "fsy1.o.id1", { sdp: "v=0" });
    body[body.length - 5]! ^= 0x10;
    await expect(open(k, "fsy1.o.id1", body)).rejects.toMatchObject({ code: "bad-mac" });
  });

  it("B4 rejects a blob moved to another id or kind", async () => {
    const k = await key();
    const body = await seal(k, "fsy1.o.id1", { sdp: "v=0" });
    await expect(open(k, "fsy1.o.id2", body)).rejects.toMatchObject({ code: "bad-mac" });
    await expect(open(k, "fsy1.a.id1", body)).rejects.toMatchObject({ code: "bad-mac" });
  });
});

describe("pairing text", () => {
  it("round-trips, also inside a URL fragment", () => {
    const body = new Uint8Array([1, 2, 3, 250, 251]);
    const text = formatText("q", "abc_-1", body, "ABCDEFGHJKLMNPQRSTUV");
    expect(text.startsWith("fsy1.q.abc_-1.ABCDEFGHJKLMNPQRSTUV.")).toBe(true);
    const parsed = parseText(`https://example.org/phone/#${text}`);
    expect(parsed).toMatchObject({ kind: "q", id: "abc_-1", code: "ABCDEFGHJKLMNPQRSTUV" });
    expect([...parsed.body]).toEqual([...body]);
    expect(parseText(`  ${formatText("a", "x1", body)}\n`)).toMatchObject({ kind: "a", id: "x1" });
  });

  it("B5 rejects text that is not foxsync text", () => {
    for (const bad of ["", "hello", "fsy2.o.id.AAAA", "fsy1.zz.id.AAAA", "fsy1.o.id", "fsy1.o.id.A*A", "fsy1.q.id.AAAA"]) {
      expect(() => parseText(bad), bad).toThrow(/bad-input/);
    }
  });

  it("B6 rejects very large text before it decodes it", () => {
    expect(() => parseText(`fsy1.o.id.${"A".repeat(40_000)}`)).toThrow(/too-large/);
  });
});
