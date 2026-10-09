// Reconnect with the stored pair keys. Either end can start. The text is
// sealed with the pair key and signed with the sender's identity key, and
// its time must grow. See docs/failure-modes.md R1-R5.
import { formatText, open, parseText, seal } from "./blob.js";
import { deriveAes, ecdh, newEphemeral, sign, verify } from "./crypto.js";
import { concat, fromB64url, toB64url, utf8, type Bytes } from "./encoding.js";
import { FoxsyncError } from "./errors.js";
import { nextMessage, sendSystem, type Link } from "./link.js";
import { clock, connect, field, sessionKeys, type CommonOptions } from "./pair.js";
import { defaultStore, type PairRecord, type Store } from "./store.js";

export interface Reconnecting {
  id: string;
  /** The signed, sealed reconnect offer. */
  offer: string;
  waitForAnswer(answer: string): Promise<Link>;
  cancel(): void;
}

export interface Answering {
  id: string;
  /** The signed, sealed reconnect answer. */
  answer: string;
  waitForLink(): Promise<Link>;
  cancel(): void;
}

const FRESH_MS = 15 * 60_000;

async function record(store: Store, id: string): Promise<PairRecord> {
  const rec = await store.get(id);
  if (!rec) throw new FoxsyncError("unknown-pair", `no paired device with id ${id}`);
  return rec;
}

/** Seal, then sign: body = signature(64) | sealed. */
async function signed(rec: PairRecord, store: Store, kind: "ro" | "ra", sdp: string, eph: Bytes, now: number) {
  const ts = Math.max(now, rec.lastOwnTs + 1);
  await store.put({ ...rec, lastOwnTs: ts });
  const sealed = await seal(await deriveAes(rec.pairKey, utf8(rec.id), `fsy ${kind}`), `fsy1.${kind}.${rec.id}`, { sdp, eph: toB64url(eph), ts });
  const sig = await sign(rec.alg, rec.keys.privateKey, concat(utf8(`fsy1.${kind}.${rec.id}.`), sealed));
  return formatText(kind, rec.id, concat(sig, sealed));
}

/** Check the signature, open, and check the time. Saves the new time, so a replay fails. */
async function checked(store: Store, text: string, kind: "ro" | "ra", id: string | undefined, now: number) {
  const parsed = parseText(text);
  if (parsed.kind !== kind || (id && parsed.id !== id)) throw new FoxsyncError("bad-input", `this is not a reconnect ${kind === "ro" ? "offer" : "answer"} for this pair`);
  const rec = await record(store, parsed.id);
  const sig = parsed.body.slice(0, 64);
  const sealed = parsed.body.slice(64);
  if (!(await verify(rec.alg, rec.peerPub, sig, concat(utf8(`fsy1.${kind}.${rec.id}.`), sealed)))) {
    throw new FoxsyncError("bad-signature", "the reconnect text is not signed by the paired device");
  }
  const value = await open(await deriveAes(rec.pairKey, utf8(rec.id), `fsy ${kind}`), `fsy1.${kind}.${rec.id}`, sealed);
  const ts = field<number>(value, "ts", "number");
  if (ts <= rec.lastPeerTs) throw new FoxsyncError("replay", "this reconnect text was used before");
  if (Math.abs(ts - now) > FRESH_MS) throw new FoxsyncError("stale", "the reconnect text is too old, or a clock is wrong");
  await store.put({ ...rec, lastPeerTs: ts });
  return { rec, text: formatText(kind, rec.id, parsed.body), sdp: field<string>(value, "sdp", "string"), eph: fromB64url(field(value, "eph", "string")) };
}

const confirm = (ms: number) => async (link: Link) => {
  await sendSystem(link, "fsy:hello", {});
  await nextMessage(link, "fsy:hello", ms);
};

/** Start a reconnect to a paired device. Either end can start. */
export async function reconnect(pairId: string, o: CommonOptions): Promise<Reconnecting> {
  const now = clock(o);
  const store = o.store ?? defaultStore();
  const rec = await record(store, pairId);
  const eph = await newEphemeral();
  const wire = await o.wire.offer();
  const offer = await signed(rec, store, "ro", wire.sdp, eph.pub, now());
  async function waitForAnswer(answerText: string): Promise<Link> {
    const got = await checked(store, answerText, "ra", pairId, now());
    const session = await sessionKeys(rec.pairKey, await ecdh(eph.key, got.eph), offer, got.text, rec.role);
    await wire.accept(got.sdp);
    return connect(wire, session.keys, pairId, o, confirm(o.handshakeMs ?? 30_000));
  }
  return { id: pairId, offer, waitForAnswer, cancel: () => wire.close() };
}

/** Answer a reconnect offer from a paired device. */
export async function acceptReconnect(offerText: string, o: CommonOptions): Promise<Answering> {
  const now = clock(o);
  const store = o.store ?? defaultStore();
  const got = await checked(store, offerText, "ro", undefined, now());
  const eph = await newEphemeral();
  const wire = await o.wire.answer(got.sdp);
  const answer = await signed(await record(store, got.rec.id), store, "ra", wire.sdp, eph.pub, now());
  const session = await sessionKeys(got.rec.pairKey, await ecdh(eph.key, got.eph), got.text, answer, got.rec.role);
  const waitForLink = () => connect(wire, session.keys, got.rec.id, o, confirm(o.handshakeMs ?? 30_000));
  return { id: got.rec.id, answer, waitForLink, cancel: () => wire.close() };
}
