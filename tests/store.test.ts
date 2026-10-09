import { describe, expect, it } from "vitest";
import { newIdentity, rootKey, sign, verify } from "../src/crypto.js";
import { utf8 } from "../src/encoding.js";
import { MemoryStore, listPairs, unpair, type PairRecord } from "../src/store.js";

async function record(id: string, peerName: string): Promise<PairRecord> {
  const me = await newIdentity();
  const peer = await newIdentity(me.alg);
  return {
    id,
    role: "desktop",
    name: "Laptop",
    peerName,
    alg: me.alg,
    keys: me.keys,
    peerPub: peer.pub,
    pairKey: await rootKey(crypto.getRandomValues(new Uint8Array(32))),
    lastPeerTs: 0,
    lastOwnTs: 0,
    createdAt: 1000,
  };
}

describe("pair store", () => {
  it("S1 unpair deletes the record and listPairs no longer shows it", async () => {
    const store = new MemoryStore();
    await store.put(await record("p1", "Phone A"));
    await store.put(await record("p2", "Phone B"));
    expect((await listPairs({ store })).map((p) => p.id).toSorted()).toEqual(["p1", "p2"]);
    expect(await unpair("p1", { store })).toBe(true);
    expect(await store.get("p1")).toBeUndefined();
    expect((await listPairs({ store })).map((p) => p.id)).toEqual(["p2"]);
    expect(await unpair("nope", { store })).toBe(false);
  });

  it("S2 listPairs returns no key material", async () => {
    const store = new MemoryStore();
    await store.put(await record("p1", "Phone A"));
    const [info] = await listPairs({ store });
    expect(Object.keys(info!).toSorted()).toEqual(["alg", "createdAt", "id", "name", "peerName", "role"]);
  });

  it("S3 the identity private key is not extractable", async () => {
    const { keys } = await newIdentity();
    expect(keys.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", keys.privateKey)).rejects.toThrow();
  });

  it("S4 ECDSA P-256 works when Ed25519 is missing", async () => {
    const id = await newIdentity("ECDSA-P256");
    expect(id.alg).toBe("ECDSA-P256");
    const sig = await sign(id.alg, id.keys.privateKey, utf8("offer"));
    expect(sig).toHaveLength(64);
    expect(await verify(id.alg, id.pub, sig, utf8("offer"))).toBe(true);
  });

  it("S5 verify fails for another key or other data", async () => {
    const a = await newIdentity();
    const b = await newIdentity(a.alg);
    expect(a.alg).toBe("Ed25519");
    const sig = await sign(a.alg, a.keys.privateKey, utf8("offer"));
    expect(sig).toHaveLength(64);
    expect(await verify(a.alg, a.pub, sig, utf8("offer"))).toBe(true);
    expect(await verify(a.alg, b.pub, sig, utf8("offer"))).toBe(false);
    expect(await verify(a.alg, a.pub, sig, utf8("offer!"))).toBe(false);
  });
});
