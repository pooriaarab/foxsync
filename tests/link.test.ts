import { afterEach, describe, expect, it } from "vitest";
import { FoxsyncError } from "../src/errors.js";
import { Link } from "../src/link.js";
import { aesKey, sleep, transportPair, type TestTransport } from "./helpers.js";

const open: Link[] = [];
afterEach(() => {
  for (const link of open.splice(0)) link.close();
});

async function pair(options: { heartbeatMs?: number; timeoutMs?: number; maxBytes?: number } = {}, keys?: CryptoKey[]) {
  const [ta, tb] = transportPair();
  const [ab, ba, ab2, ba2] = keys ?? [await aesKey(), await aesKey()];
  const a = new Link(ta, { send: ab!, recv: ba! }, { pairId: "test", ...options });
  const b = new Link(tb, { send: ba2 ?? ba!, recv: ab2 ?? ab! }, { pairId: "test", ...options });
  open.push(a, b);
  return { a, b, ta, tb };
}

function inbox(link: Link, type = "note") {
  const got: unknown[] = [];
  link.on(type, (payload) => got.push(payload));
  return got;
}

const code = async (link: Link) => (await link.closed)?.code;

describe("link", () => {
  it("delivers a message from one end to the other", async () => {
    const { a, b } = await pair();
    const got = inbox(b);
    await a.send("note", { hello: "phone" });
    await sleep(20);
    expect(got).toEqual([{ hello: "phone" }]);
  });

  it("L1 rejects an app type that starts with fsy:", async () => {
    const { a, ta } = await pair();
    let sent = 0;
    ta.tap = () => sent++;
    await expect(a.send("fsy:hello", {})).rejects.toMatchObject({ code: "bad-input" });
    expect(sent).toBe(0);
  });

  it("L2 closes the link on a replayed frame", async () => {
    const { a, b, ta } = await pair();
    const got = inbox(b);
    ta.tap = (frame, deliver) => {
      deliver(frame);
      deliver(frame);
    };
    await a.send("note", 1);
    expect(await code(b)).toBe("replay");
    expect(got).toEqual([1]);
  });

  it("L3 closes the link on reordered frames", async () => {
    const { a, b, ta } = await pair();
    const got = inbox(b);
    const held: Uint8Array[] = [];
    ta.tap = (frame, deliver) => {
      held.push(frame);
      if (held.length === 2) {
        deliver(held[1]!);
        deliver(held[0]!);
      }
    };
    await a.send("note", 1);
    await a.send("note", 2);
    expect(await code(b)).toBe("reorder");
    expect(got).toEqual([]);
  });

  it("L4 closes the link on a changed byte", async () => {
    const { a, b, ta } = await pair();
    const got = inbox(b);
    ta.tap = (frame, deliver) => {
      frame[frame.length - 3]! ^= 0x01;
      deliver(frame);
    };
    await a.send("note", "approve");
    expect(await code(b)).toBe("bad-mac");
    expect(got).toEqual([]);
  });

  it("L5 closes the link when the keys differ", async () => {
    const k = await Promise.all([aesKey(), aesKey(), aesKey(), aesKey()]);
    const { a, b } = await pair({}, k);
    const got = inbox(b);
    await a.send("note", 1);
    expect(await code(b)).toBe("bad-mac");
    expect(got).toEqual([]);
  });

  it("L6 rejects a payload over the limit and stays open", async () => {
    const { a, b } = await pair({ maxBytes: 1024 });
    const got = inbox(b);
    const error = await a.send("note", "x".repeat(2000)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FoxsyncError);
    expect((error as FoxsyncError).code).toBe("too-large");
    expect(a.isOpen).toBe(true);
    await a.send("note", "small");
    await sleep(20);
    expect(got).toEqual(["small"]);
  });

  it("L7 closes with timeout when the peer goes silent", async () => {
    const { a, b, tb } = await pair({ heartbeatMs: 20, timeoutMs: 120 });
    (tb as TestTransport).tap = () => {};
    const started = Date.now();
    expect(await code(a)).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    b.close();
  });

  it("keeps a quiet but healthy link open with heartbeats", async () => {
    const { a, b } = await pair({ heartbeatMs: 20, timeoutMs: 120 });
    await sleep(300);
    expect(a.isOpen && b.isOpen).toBe(true);
  });

  it("L8 closes with peer-closed when the other end closes", async () => {
    const { a, b } = await pair();
    b.close();
    expect(await code(a)).toBe("peer-closed");
    expect(await b.closed).toBeNull();
    await expect(a.send("note", 1)).rejects.toMatchObject({ code: "closed" });
  });
});
