import { afterEach, describe, expect, it } from "vitest";
import { formatText, parseText } from "../src/blob.js";
import type { Link } from "../src/link.js";
import { pairDesktop, pairPhone } from "../src/pair.js";
import { MemoryStore, listPairs } from "../src/store.js";
import { memoryWire, sleep } from "./helpers.js";

const links: Link[] = [];
afterEach(() => {
  for (const link of links.splice(0)) link.close();
});
const keep = (...l: Link[]) => (links.push(...l), l);

function setup() {
  return { wire: memoryWire(), desk: new MemoryStore(), phone: new MemoryStore() };
}

async function paired() {
  const s = setup();
  const d = await pairDesktop({ wire: s.wire, store: s.desk, name: "Laptop" });
  const p = await pairPhone(d.qr!, { wire: s.wire, store: s.phone, name: "Pixel" });
  const [dl, pl] = keep(...(await Promise.all([d.waitForPhone(p.answer), p.waitForDesktop()])));
  return { ...s, d, p, dl: dl!, pl: pl! };
}

const received = (link: Link, type = "note") => {
  const got: unknown[] = [];
  link.on(type, (x) => got.push(x));
  return got;
};

// Change one character in the base64 body of foxsync text.
function flip(text: string): string {
  const at = text.length - 6;
  return text.slice(0, at) + (text[at] === "A" ? "B" : "A") + text.slice(at + 1);
}

describe("pairing", () => {
  it("P1 pairs a phone, and messages go both ways", async () => {
    const { dl, pl, desk, phone, d } = await paired();
    const atPhone = received(pl);
    const atDesk = received(dl);
    await dl.send("note", "from desktop");
    await pl.send("note", "from phone");
    await sleep(20);
    expect(atPhone).toEqual(["from desktop"]);
    expect(atDesk).toEqual(["from phone"]);
    expect(await listPairs({ store: desk })).toMatchObject([{ id: d.id, role: "desktop", name: "Laptop", peerName: "Pixel" }]);
    expect(await listPairs({ store: phone })).toMatchObject([{ id: d.id, role: "phone", name: "Pixel", peerName: "Laptop" }]);
    expect(d.code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){4}$/);
  });

  it("P2 rejects a replayed QR code after pairing", async () => {
    const { d, wire } = await paired();
    const late = await pairPhone(d.qr!, { wire, store: new MemoryStore() });
    await expect(d.waitForPhone(late.answer)).rejects.toMatchObject({ code: "used" });
  });

  it("P3 rejects an expired QR code on both ends", async () => {
    const s = setup();
    let now = 1_000_000;
    const d = await pairDesktop({ wire: s.wire, store: s.desk, ttlMs: 60_000, now: () => now });
    const p = await pairPhone(d.qr!, { wire: s.wire, store: s.phone, now: () => now });
    now += 61_000;
    await expect(d.waitForPhone(p.answer)).rejects.toMatchObject({ code: "expired" });
    now += 10 * 60_000;
    await expect(pairPhone(d.qr!, { wire: s.wire, store: s.phone, now: () => now })).rejects.toMatchObject({ code: "expired" });
  });

  it("P4 cancels the pairing after 3 answers with a wrong code", async () => {
    const s = setup();
    const d = await pairDesktop({ wire: s.wire, store: s.desk });
    const real = await pairPhone(d.qr!, { wire: s.wire, store: s.phone });
    for (let i = 0; i < 3; i++) {
      const guess = await pairDesktop({ wire: s.wire, store: new MemoryStore() });
      const forged = await pairPhone(guess.qr!, { wire: s.wire, store: new MemoryStore() });
      const answer = formatText("a", d.id, parseText(forged.answer).body);
      await expect(d.waitForPhone(answer)).rejects.toMatchObject({ code: "bad-mac" });
    }
    await expect(d.waitForPhone(real.answer)).rejects.toMatchObject({ code: "used" });
  });

  it("P5 rejects a changed or swapped offer and answer", async () => {
    const s = setup();
    const d = await pairDesktop({ wire: s.wire, store: s.desk });
    await expect(pairPhone({ code: d.code, offer: flip(d.offer) }, { wire: s.wire, store: s.phone })).rejects.toMatchObject({ code: "bad-mac" });
    const other = await pairDesktop({ wire: s.wire, store: new MemoryStore() });
    const swapped = formatText("o", d.id, parseText(other.offer).body);
    await expect(pairPhone({ code: d.code, offer: swapped }, { wire: s.wire, store: s.phone })).rejects.toMatchObject({ code: "bad-mac" });
    const p = await pairPhone({ code: d.code, offer: d.offer }, { wire: s.wire, store: s.phone });
    await expect(d.waitForPhone(flip(p.answer))).rejects.toMatchObject({ code: "bad-mac" });
    const [dl, pl] = keep(...(await Promise.all([d.waitForPhone(p.answer), p.waitForDesktop()])));
    expect(dl!.isOpen && pl!.isOpen).toBe(true);
  });

  it("P6 lets the first of two phones win, and runs two pairings at once", async () => {
    const s = setup();
    const d = await pairDesktop({ wire: s.wire, store: s.desk });
    const first = await pairPhone(d.qr!, { wire: s.wire, store: s.phone });
    const second = await pairPhone(d.qr!, { wire: s.wire, store: new MemoryStore() });
    keep(...(await Promise.all([d.waitForPhone(first.answer), first.waitForDesktop()])));
    await expect(d.waitForPhone(second.answer)).rejects.toMatchObject({ code: "used" });

    const d1 = await pairDesktop({ wire: s.wire, store: s.desk });
    const d2 = await pairDesktop({ wire: s.wire, store: s.desk });
    const p1 = await pairPhone(d1.qr!, { wire: s.wire, store: new MemoryStore() });
    const p2 = await pairPhone(d2.qr!, { wire: s.wire, store: new MemoryStore() });
    keep(...(await Promise.all([d2.waitForPhone(p2.answer), p2.waitForDesktop(), d1.waitForPhone(p1.answer), p1.waitForDesktop()])));
    expect((await listPairs({ store: s.desk })).length).toBe(3);
  });

  it("P7 gives no QR text when it is too large, and pairs with code plus offer", async () => {
    const s = setup();
    const d = await pairDesktop({ wire: s.wire, store: s.desk, qrMax: 40 });
    expect(d.qr).toBeNull();
    const p = await pairPhone({ code: d.code.toLowerCase(), offer: d.offer }, { wire: s.wire, store: s.phone });
    const [dl] = keep(...(await Promise.all([d.waitForPhone(p.answer), p.waitForDesktop()])));
    expect(dl!.isOpen).toBe(true);
  });

  it("puts the QR text in the phone page URL fragment", async () => {
    const s = setup();
    const d = await pairDesktop({ wire: s.wire, store: s.desk, phoneUrl: "https://example.org/phone/" });
    expect(d.qr!.startsWith("https://example.org/phone/#fsy1.q.")).toBe(true);
  });
});
