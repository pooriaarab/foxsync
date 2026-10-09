import { afterEach, describe, expect, it } from "vitest";
import { formatText, parseText } from "../src/blob.js";
import type { Link } from "../src/link.js";
import { pairDesktop, pairPhone } from "../src/pair.js";
import { acceptReconnect, reconnect } from "../src/reconnect.js";
import { MemoryStore, unpair } from "../src/store.js";
import { memoryWire, sleep } from "./helpers.js";

const links: Link[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.close();
});
const keep = (...l: Link[]) => (links.push(...l), l);

async function paired() {
  const s = { wire: memoryWire(), desk: new MemoryStore(), phone: new MemoryStore() };
  const d = await pairDesktop({ wire: s.wire, store: s.desk, name: "Laptop" });
  const p = await pairPhone(d.qr!, { wire: s.wire, store: s.phone, name: "Pixel" });
  const [dl, pl] = keep(...(await Promise.all([d.waitForPhone(p.answer), p.waitForDesktop()])));
  return { ...s, d, dl: dl!, pl: pl! };
}

const received = (link: Link, type = "note") => {
  const got: unknown[] = [];
  link.on(type, (x) => got.push(x));
  return got;
};

describe("reconnect", () => {
  it("R1 reconnects after the desktop page drops the link", async () => {
    const { dl, pl, wire, desk, phone, d } = await paired();
    dl.close();
    expect((await pl.closed)?.code).toBe("peer-closed");
    const r = await reconnect(d.id, { wire, store: phone });
    const a = await acceptReconnect(r.offer, { wire, store: desk });
    const [pl2, dl2] = keep(...(await Promise.all([r.waitForAnswer(a.answer), a.waitForLink()])));
    const got = received(dl2!);
    await pl2!.send("note", "back");
    await sleep(20);
    expect(got).toEqual(["back"]);
  });

  it("R2 rejects a replayed reconnect offer", async () => {
    const { wire, desk, phone, d } = await paired();
    const r = await reconnect(d.id, { wire, store: phone });
    await acceptReconnect(r.offer, { wire, store: desk });
    await expect(acceptReconnect(r.offer, { wire, store: desk })).rejects.toMatchObject({ code: "replay" });
  });

  it("R3 rejects a reconnect after unpair", async () => {
    const { wire, desk, phone, d } = await paired();
    expect(await unpair(d.id, { store: desk })).toBe(true);
    const r = await reconnect(d.id, { wire, store: phone });
    await expect(acceptReconnect(r.offer, { wire, store: desk })).rejects.toMatchObject({ code: "unknown-pair" });
    await expect(reconnect(d.id, { wire, store: desk })).rejects.toMatchObject({ code: "unknown-pair" });
  });

  it("R4 rejects an offer with a wrong signature, or a reflected offer", async () => {
    const { wire, desk, phone, d } = await paired();
    const r = await reconnect(d.id, { wire, store: phone });
    const body = parseText(r.offer).body;
    body[3]! ^= 0x01;
    await expect(acceptReconnect(formatText("ro", d.id, body), { wire, store: desk })).rejects.toMatchObject({ code: "bad-signature" });
    const own = await reconnect(d.id, { wire, store: desk });
    await expect(acceptReconnect(own.offer, { wire, store: desk })).rejects.toMatchObject({ code: "bad-signature" });
  });

  it("R5 rejects an offer with a time far from now", async () => {
    let now = Date.now();
    const s = { wire: memoryWire(), desk: new MemoryStore(), phone: new MemoryStore() };
    const d = await pairDesktop({ wire: s.wire, store: s.desk, now: () => now });
    const p = await pairPhone(d.qr!, { wire: s.wire, store: s.phone, now: () => now });
    keep(...(await Promise.all([d.waitForPhone(p.answer), p.waitForDesktop()])));
    const r = await reconnect(d.id, { wire: s.wire, store: s.phone, now: () => now });
    now += 60 * 60_000;
    await expect(acceptReconnect(r.offer, { wire: s.wire, store: s.desk, now: () => now })).rejects.toMatchObject({ code: "stale" });
  });

  it("R6 keeps the newest accepted time when a reconnect starts during gathering", async () => {
    const { wire, desk, phone, d } = await paired();
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));
    const slow = { ...wire, offer: async () => (await gate, wire.offer()) };
    const fromPhone = await reconnect(d.id, { wire, store: phone });
    const ownStarting = reconnect(d.id, { wire: slow, store: desk });
    await sleep(10);
    await acceptReconnect(fromPhone.offer, { wire, store: desk });
    release();
    await ownStarting;
    await expect(acceptReconnect(fromPhone.offer, { wire, store: desk })).rejects.toMatchObject({ code: "replay" });
  });

  it("R7 accepts one of two copies of an offer that arrive together", async () => {
    const { wire, desk, phone, d } = await paired();
    const r = await reconnect(d.id, { wire, store: phone });
    const results = await Promise.allSettled([acceptReconnect(r.offer, { wire, store: desk }), acceptReconnect(r.offer, { wire, store: desk })]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(results.find((x) => x.status === "rejected")).toMatchObject({ reason: { code: "replay" } });
  });
});
