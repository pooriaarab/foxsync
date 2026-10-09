import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatText, parseText } from "../src/blob.js";
import type { Link } from "../src/link.js";
import { pairDesktop, pairPhone } from "../src/pair.js";
import { acceptReconnect, reconnect } from "../src/reconnect.js";
import { MemoryStore } from "../src/store.js";
import { handle, type BoxStore } from "../relay/handler.js";
import { memoryWire } from "./helpers.js";

const RELAY = "https://relay.test";
let now = 1_000_000;
let boxes: Map<string, unknown>;
let up = true;
const store = (): BoxStore => ({
  get: async (key) => boxes.get(key) as never,
  put: async (key, value) => void boxes.set(key, value),
  delete: async (key) => void boxes.delete(key),
});
const relay = (path: string, init?: RequestInit) => handle(new Request(`${RELAY}${path}`, init), store(), now);
const box = "A".repeat(22);

beforeEach(() => {
  boxes = new Map();
  up = true;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!up) throw new TypeError("NetworkError when attempting to fetch resource.");
    return handle(new Request(input, init), store(), now);
  });
});
const links: Link[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const link of links.splice(0)) link.close();
});

describe("relay worker", () => {
  it("stores and returns one text per box and slot", async () => {
    expect((await relay(`/v1/${box}/a`, { method: "PUT", body: "fsy1.a.id.AAAA" })).status).toBe(204);
    const got = await relay(`/v1/${box}/a`);
    expect(got.status).toBe(200);
    expect(got.headers.get("access-control-allow-origin")).toBe("*");
    expect(await got.text()).toBe("fsy1.a.id.AAAA");
    expect((await relay(`/v1/${box}/a`, { method: "DELETE" })).status).toBe(204);
    expect((await relay(`/v1/${box}/a`)).status).toBe(404);
  });

  it("Y1 refuses text that is not foxsync text, and large bodies", async () => {
    expect((await relay(`/v1/${box}/a`, { method: "PUT", body: "hello" })).status).toBe(400);
    expect((await relay(`/v1/${box}/a`, { method: "PUT", body: `fsy1.a.id.${"A".repeat(20_000)}` })).status).toBe(413);
    expect(boxes.size).toBe(0);
  });

  it("Y2 refuses bad box ids, slots and methods", async () => {
    expect((await relay(`/v1/short/a`)).status).toBe(404);
    expect((await relay(`/v1/${box}/x`)).status).toBe(404);
    expect((await relay(`/v2/${box}/a`)).status).toBe(404);
    expect((await relay(`/v1/${box}/a`, { method: "POST", body: "fsy1.a.id.AAAA" })).status).toBe(405);
    expect((await relay(`/v1/${box}/a`, { method: "OPTIONS" })).status).toBe(204);
  });

  it("Y3 forgets a text after 10 minutes", async () => {
    await relay(`/v1/${box}/o`, { method: "PUT", body: "fsy1.ro.id.AAAA" });
    now += 10 * 60_000 + 1;
    expect((await relay(`/v1/${box}/o`)).status).toBe(404);
    expect(boxes.size).toBe(0);
  });
});

describe("pairing and reconnect through the relay", () => {
  it("Y6 pairs with no copy step back from the phone", async () => {
    const wire = memoryWire();
    const d = await pairDesktop({ wire, store: new MemoryStore(), relay: RELAY, now: () => now });
    const p = await pairPhone(d.qr!, { wire, store: new MemoryStore(), now: () => now });
    links.push(...(await Promise.all([d.waitForPhone(), p.waitForDesktop()])));
    expect(links.every((l) => l.isOpen)).toBe(true);
  });

  it("Y4 skips a forged answer in the box and pairs with the real one", async () => {
    const wire = memoryWire();
    const d = await pairDesktop({ wire, store: new MemoryStore(), relay: RELAY, relayPollMs: 50, now: () => now });
    const fake = await pairDesktop({ wire, store: new MemoryStore() });
    const forged = formatText("a", d.id, parseText((await pairPhone(fake.qr!, { wire, store: new MemoryStore() })).answer).body);
    const waiting = d.waitForPhone();
    const p = await pairPhone(d.qr!, { wire, store: new MemoryStore(), now: () => now });
    expect(p.relayed).toBe(true);
    const [key, real] = [...boxes.entries()][0]!;
    boxes.set(key, { text: forged, at: now });
    await vi.waitFor(() => expect(boxes.has(key)).toBe(false));
    boxes.set(key, real);
    links.push(...(await Promise.all([waiting, p.waitForDesktop()])));
    expect(links.every((l) => l.isOpen)).toBe(true);
  });

  it("Y5 fails with timeout when the relay is down", async () => {
    up = false;
    const d = await pairDesktop({ wire: memoryWire(), store: new MemoryStore(), relay: RELAY, relayWaitMs: 500, relayPollMs: 50 });
    await expect(d.waitForPhone()).rejects.toMatchObject({ code: "timeout" });
  });

  it("Y7 skips an old reconnect offer and connects with the new one", async () => {
    const wire = memoryWire();
    const [desk, phone] = [new MemoryStore(), new MemoryStore()];
    const o = { wire, relayPollMs: 50 };
    const d = await pairDesktop({ ...o, store: desk, relay: RELAY });
    const p = await pairPhone(d.qr!, { ...o, store: phone });
    for (const l of await Promise.all([d.waitForPhone(), p.waitForDesktop()])) l.close();
    const first = await reconnect(d.id, { ...o, store: phone });
    const answering = await acceptReconnect({ pairId: d.id }, { ...o, store: desk });
    for (const l of await Promise.all([first.waitForAnswer(), answering.waitForLink()])) l.close();
    const second = await reconnect(d.id, { ...o, store: phone });
    const [key, fresh] = [...boxes.entries()].find(([k]) => k.endsWith("/o"))!;
    boxes.set(key, { text: first.offer, at: now });
    const later = acceptReconnect({ pairId: d.id }, { ...o, store: desk });
    await vi.waitFor(() => expect(boxes.has(key)).toBe(false));
    boxes.set(key, fresh);
    const again = await later;
    links.push(...(await Promise.all([second.waitForAnswer(), again.waitForLink()])));
    expect(links.every((l) => l.isOpen)).toBe(true);
  });
});
