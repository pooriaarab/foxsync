// Reconnect with the stored pair keys. Either end can start. The text is
// sealed with the pair key and signed with the sender's identity key, and
// its time must grow. See docs/failure-modes.md R1-R5.
import { formatText, open, parseText, seal } from "./blob.js";
import { deriveAes, ecdh, newEphemeral, sign, verify } from "./crypto.js";
import { concat, fromB64url, toB64url, utf8, type Bytes } from "./encoding.js";
import { FoxsyncError } from "./errors.js";
import { nextMessage, sendSystem, type Link } from "./link.js";
import { clock, connect, field, sessionKeys, type CommonOptions } from "./pair.js";
import { relayBox, relayPut, relayTake } from "./relay.js";
import { browserWire } from "./rtc.js";
import { defaultStore, type PairRecord, type Store } from "./store.js";

export interface Reconnecting {
  id: string;
  /** The signed, sealed reconnect offer. */
  offer: string;
  /** True when the offer went to the relay. */
  relayed: boolean;
  /** Give the answer text, or nothing to poll the relay. */
  waitForAnswer(answer?: string): Promise<Link>;
  cancel(): void;
}

export interface Answering {
  id: string;
  /** The signed, sealed reconnect answer. */
  answer: string;
  /** True when the answer went to the relay. */
  relayed: boolean;
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
/**
 * Run a read-modify-write of one pair record in a queue per store and pair,
 * so two reconnects in this page cannot write back an old record and undo
 * the newest time (docs/failure-modes.md R6, R7). The queue lives in this
 * JavaScript realm: two pages that reconnect the same pair at the same
 * moment are not serialized.
 */
const queues = new WeakMap<Store, Map<string, Promise<unknown>>>();
function update<T>(store: Store, id: string, fn: (rec: PairRecord) => Promise<T>): Promise<T> {
  let byId = queues.get(store);
  if (!byId) queues.set(store, (byId = new Map()));
  const run = (byId.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => fn(await record(store, id)));
  byId.set(id, run);
  return run;
}

async function signed(rec: PairRecord, store: Store, kind: "ro" | "ra", sdp: string, eph: Bytes, now: number) {
  const ts = await update(store, rec.id, async (fresh) => {
    const next = Math.max(now, fresh.lastOwnTs + 1);
    await store.put({ ...fresh, lastOwnTs: next });
    return next;
  });
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
  if (Math.abs(ts - now) > FRESH_MS) throw new FoxsyncError("stale", "the reconnect text is too old, or a clock is wrong");
  await update(store, rec.id, async (fresh) => {
    if (ts <= fresh.lastPeerTs) throw new FoxsyncError("replay", "this reconnect text was used before");
    await store.put({ ...fresh, lastPeerTs: ts });
  });
  return { rec, text: formatText(kind, rec.id, parsed.body), sdp: field<string>(value, "sdp", "string"), eph: fromB64url(field(value, "eph", "string")) };
}

const confirm = (ms: number) => async (link: Link) => {
  await sendSystem(link, "fsy:hello", {});
  await nextMessage(link, "fsy:hello", ms);
};

const relayOf = (o: CommonOptions, rec: PairRecord) => o.relay ?? rec.relay;
const post = async (relay: string | undefined, rec: PairRecord, slot: "o" | "a", text: string) =>
  relay ? relayPut(relay, await relayBox(rec.pairKey, rec.id), slot, text).then(() => true, () => false) : false;

/** Start a reconnect to a paired device. Either end can start. */
export async function reconnect(pairId: string, o: CommonOptions = {}): Promise<Reconnecting> {
  const now = clock(o);
  const store = o.store ?? defaultStore();
  const rec = await record(store, pairId);
  const relay = relayOf(o, rec);
  const eph = await newEphemeral();
  const wire = await (o.wire ?? browserWire()).offer();
  const offer = await signed(rec, store, "ro", wire.sdp, eph.pub, now());
  const relayed = await post(relay, rec, "o", offer);
  async function answerWith(answerText: string): Promise<Link> {
    const got = await checked(store, answerText, "ra", pairId, now());
    const session = await sessionKeys(rec.pairKey, await ecdh(eph.key, got.eph), offer, got.text, rec.role);
    await wire.accept(got.sdp);
    return connect(wire, session.keys, pairId, o, confirm(o.handshakeMs ?? 30_000));
  }
  async function waitForAnswer(answerText?: string): Promise<Link> {
    if (answerText !== undefined) return answerWith(answerText);
    if (!relay) throw new FoxsyncError("bad-input", "give the answer text, or set a relay");
    return relayTake(relay, await relayBox(rec.pairKey, pairId), "a", answerWith, o.relayWaitMs ?? 600_000, o.relayPollMs ?? 1500);
  }
  return { id: pairId, offer, relayed, waitForAnswer, cancel: () => wire.close() };
}

/** Answer a reconnect offer: from its text, or from the relay with { pairId }. */
export async function acceptReconnect(input: string | { pairId: string }, o: CommonOptions = {}): Promise<Answering> {
  const store = o.store ?? defaultStore();
  if (typeof input === "string") return answerOffer(input, undefined, store, o);
  const rec = await record(store, input.pairId);
  const relay = relayOf(o, rec);
  if (!relay) throw new FoxsyncError("bad-input", "this pair has no relay; give the offer text");
  return relayTake(relay, await relayBox(rec.pairKey, rec.id), "o", (text) => answerOffer(text, rec.id, store, o), o.relayWaitMs ?? 600_000, o.relayPollMs ?? 1500);
}

async function answerOffer(offerText: string, pairId: string | undefined, store: Store, o: CommonOptions): Promise<Answering> {
  const now = clock(o);
  const got = await checked(store, offerText, "ro", pairId, now());
  const eph = await newEphemeral();
  const wire = await (o.wire ?? browserWire()).answer(got.sdp);
  const rec = await record(store, got.rec.id);
  const answer = await signed(rec, store, "ra", wire.sdp, eph.pub, now());
  const relayed = await post(relayOf(o, rec), rec, "a", answer);
  const session = await sessionKeys(rec.pairKey, await ecdh(eph.key, got.eph), got.text, answer, rec.role);
  const waitForLink = () => connect(wire, session.keys, rec.id, o, confirm(o.handshakeMs ?? 30_000));
  return { id: rec.id, answer, relayed, waitForLink, cancel: () => wire.close() };
}
