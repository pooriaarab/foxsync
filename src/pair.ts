// Pairing. It runs over a Wire (one WebRTC connection) and moves sealed
// text between the ends. See docs/failure-modes.md P1-P7.
//
// Keys: the pairing root is HKDF(code). The reconnect root is the stored
// pair key. Each session adds a fresh ECDH P-256 exchange, and the hash of
// the offer and answer text, so a session key is new every time and is
// bound to the exact SDP (with its DTLS fingerprints) that both ends saw.
import { formatText, open, parseText, seal } from "./blob.js";
import { deriveAes, deriveBytes, ecdh, newEphemeral, newIdentity, rootKey, sha256, type IdentityAlg } from "./crypto.js";
import { formatCode, fromB64url, newCode, parseCode, randomId, toB64url, utf8, type Bytes } from "./encoding.js";
import { FoxsyncError } from "./errors.js";
import { Link, nextMessage, sendSystem, type LinkOptions, type Transport } from "./link.js";
import { browserWire } from "./rtc.js";
import { defaultStore, type Store } from "./store.js";

/** One peer connection. In the browser this is an RTCPeerConnection with one data channel. */
export interface Wire {
  /** This end's session description, after ICE gathering. */
  sdp: string;
  /** Apply the other end's answer. The answer side does nothing here. */
  accept(answerSdp: string): Promise<void>;
  /** Resolves when the data channel is open. */
  open: Promise<Transport>;
  close(): void;
}

export interface WireFactory {
  offer(): Promise<Wire>;
  answer(offerSdp: string): Promise<Wire>;
}

export interface CommonOptions {
  /** This device's name, as the peer sees it. */
  name?: string;
  store?: Store;
  /** How to make the peer connection. Default: browserWire() (WebRTC, no ICE servers). */
  wire?: WireFactory;
  link?: LinkOptions;
  /** How long to wait for the channel and the hello messages. Default 30000 ms. */
  handshakeMs?: number;
  now?: () => number;
}

export interface PairDesktopOptions extends CommonOptions {
  /** The phone page URL. The QR text becomes `<phoneUrl>#<pairing text>`. */
  phoneUrl?: string;
  /** How long the code is valid. Default 600000 ms (10 minutes). */
  ttlMs?: number;
  /** The longest QR text. Longer gives `qr: null`. Default 1800. */
  qrMax?: number;
  /** Wrong answers before the pairing is cancelled. Default 3. */
  maxAttempts?: number;
}

export interface DesktopPairing {
  id: string;
  /** The one-time code, in groups of four. Show it, or put it in the QR code. */
  code: string;
  /** The sealed offer. It is safe to send over any channel; it is useless without the code. */
  offer: string;
  /** The text for the QR code (code plus offer), or null when it is too long. */
  qr: string | null;
  expiresAt: number;
  /** Give the phone's answer text. Resolves with the open Link. */
  waitForPhone(answer: string): Promise<Link>;
  cancel(): void;
}

export interface PhonePairing {
  id: string;
  /** The sealed answer. Give it to the desktop. */
  answer: string;
  waitForDesktop(): Promise<Link>;
  cancel(): void;
}

type Role = "desktop" | "phone";
const SKEW_MS = 2 * 60_000;
/** Internal. */
export const clock = (o: CommonOptions) => o.now ?? Date.now;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FoxsyncError("timeout", `${what} did not happen within ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** Internal: read a typed field from opened JSON. */
export function field<T>(value: unknown, key: string, type: "string" | "number"): T {
  const v = (value as Record<string, unknown> | null)?.[key];
  if (typeof v !== type) throw new FoxsyncError("bad-input", `the sealed text has no ${type} "${key}"`);
  return v as T;
}

/** Internal: session keys from the root, a fresh ECDH secret and the offer and answer text. */
export async function sessionKeys(root: CryptoKey, shared: Bytes, offer: string, answer: string, role: Role) {
  const transcript = await sha256(utf8(`${offer}\n${answer}`));
  const salt = await deriveBytes(await rootKey(shared), transcript, "fsy mix");
  const d2p = await deriveAes(root, salt, "fsy d2p");
  const p2d = await deriveAes(root, salt, "fsy p2d");
  return {
    keys: role === "desktop" ? { send: d2p, recv: p2d } : { send: p2d, recv: d2p },
    pairKey: () => deriveBytes(root, salt, "fsy pair").then(rootKey),
  };
}

/** Internal: open the channel, make the Link, and run fn (the hello exchange). Close all on failure. */
export async function connect(wire: Wire, keys: { send: CryptoKey; recv: CryptoKey }, id: string, o: CommonOptions, fn: (link: Link) => Promise<void>) {
  const ms = o.handshakeMs ?? 30_000;
  try {
    const link = new Link(await within(wire.open, ms, "the channel open"), keys, { ...o.link, pairId: id });
    try {
      await fn(link);
      return link;
    } catch (error) {
      link.close();
      throw error;
    }
  } catch (error) {
    wire.close();
    throw error;
  }
}

interface Hello {
  alg: IdentityAlg;
  pub: Bytes;
  name: string;
}
async function readHello(link: Link, ms: number): Promise<Hello> {
  const hello = await nextMessage(link, "fsy:hello", ms);
  const alg = field<string>(hello, "alg", "string");
  if (alg !== "Ed25519" && alg !== "ECDSA-P256") throw new FoxsyncError("bad-input", `unknown identity algorithm ${alg}`);
  return { alg, pub: fromB64url(field(hello, "pub", "string")), name: field(hello, "name", "string") };
}
const sendHello = (link: Link, alg: IdentityAlg, pub: Bytes, name: string) => sendSystem(link, "fsy:hello", { alg, pub: toB64url(pub), name });

/** Start pairing on the desktop: make the code, the sealed offer and the QR text. */
export async function pairDesktop(o: PairDesktopOptions = {}): Promise<DesktopPairing> {
  const now = clock(o);
  const store = o.store ?? defaultStore();
  const name = o.name ?? "Desktop";
  const id = randomId();
  const code = newCode();
  const root = await rootKey(utf8(code));
  const eph = await newEphemeral();
  const wire = await (o.wire ?? browserWire()).offer();
  const expiresAt = now() + (o.ttlMs ?? 600_000);
  const body = await seal(await deriveAes(root, utf8(id), "fsy offer"), `fsy1.o.${id}`, { sdp: wire.sdp, eph: toB64url(eph.pub), exp: expiresAt, name });
  const offer = formatText("o", id, body);
  const qrText = formatText("q", id, body, code);
  const qr = o.phoneUrl ? `${o.phoneUrl}#${qrText}` : qrText;
  let attempts = 0;
  let used = false;
  const cancel = () => {
    used = true;
    wire.close();
  };

  async function waitForPhone(answerText: string): Promise<Link> {
    if (used) throw new FoxsyncError("used", "this pairing was already used or cancelled; start a new one");
    if (now() > expiresAt) {
      cancel();
      throw new FoxsyncError("expired", "the pairing code expired; start a new one");
    }
    const parsed = parseText(answerText);
    if (parsed.kind !== "a" || parsed.id !== id) throw new FoxsyncError("bad-input", "this is not the answer for this pairing");
    const answer = formatText("a", id, parsed.body);
    let value: unknown;
    try {
      value = await open(await deriveAes(root, utf8(id), "fsy answer"), `fsy1.a.${id}`, parsed.body);
    } catch (error) {
      if (++attempts >= (o.maxAttempts ?? 3)) cancel();
      throw error;
    }
    if (used) throw new FoxsyncError("used", "this pairing was already used or cancelled; start a new one");
    used = true;
    const peerEph = fromB64url(field(value, "eph", "string"));
    const session = await sessionKeys(root, await ecdh(eph.key, peerEph), offer, answer, "desktop");
    await wire.accept(field(value, "sdp", "string"));
    return connect(wire, session.keys, id, o, async (link) => {
      const phone = await readHello(link, o.handshakeMs ?? 30_000);
      const me = await newIdentity(phone.alg);
      await sendHello(link, me.alg, me.pub, name);
      await store.put({ id, role: "desktop", name, peerName: phone.name, alg: me.alg, keys: me.keys, peerPub: phone.pub, pairKey: await session.pairKey(), lastPeerTs: 0, lastOwnTs: 0, createdAt: now() });
    });
  }

  return { id, code: formatCode(code), offer, qr: qr.length > (o.qrMax ?? 1800) ? null : qr, expiresAt, waitForPhone, cancel };
}

/** Answer a pairing on the phone, from the QR text or from the code plus the offer. */
export async function pairPhone(input: string | { code: string; offer: string }, o: CommonOptions = {}): Promise<PhonePairing> {
  const now = clock(o);
  const store = o.store ?? defaultStore();
  const name = o.name ?? "Phone";
  const parsed = parseText(typeof input === "string" ? input : input.offer);
  const code = typeof input === "string" ? parsed.code : parseCode(input.code);
  if (!code || parsed.kind !== (typeof input === "string" ? "q" : "o")) throw new FoxsyncError("bad-input", "give the QR text, or the code and the offer");
  const id = parsed.id;
  const offer = formatText("o", id, parsed.body);
  const root = await rootKey(utf8(code));
  const value = await open(await deriveAes(root, utf8(id), "fsy offer"), `fsy1.o.${id}`, parsed.body);
  const exp = field<number>(value, "exp", "number");
  if (now() > exp + SKEW_MS) throw new FoxsyncError("expired", "the pairing code expired; ask the desktop for a new one");
  const eph = await newEphemeral();
  const wire = await (o.wire ?? browserWire()).answer(field(value, "sdp", "string"));
  const body = await seal(await deriveAes(root, utf8(id), "fsy answer"), `fsy1.a.${id}`, { sdp: wire.sdp, eph: toB64url(eph.pub), name });
  const answer = formatText("a", id, body);
  const shared = await ecdh(eph.key, fromB64url(field(value, "eph", "string")));
  const session = await sessionKeys(root, shared, offer, answer, "phone");

  const waitForDesktop = () =>
    connect(wire, session.keys, id, { ...o, handshakeMs: o.handshakeMs ?? Math.max(exp + SKEW_MS - now(), 1000) }, async (link) => {
      const me = await newIdentity();
      await sendHello(link, me.alg, me.pub, name);
      const desk = await readHello(link, o.handshakeMs ?? 30_000);
      if (desk.alg !== me.alg) throw new FoxsyncError("bad-input", "the desktop chose another identity algorithm");
      await store.put({ id, role: "phone", name, peerName: desk.name, alg: me.alg, keys: me.keys, peerPub: desk.pub, pairKey: await session.pairKey(), lastPeerTs: 0, lastOwnTs: 0, createdAt: now() });
    });
  return { id, answer, waitForDesktop, cancel: () => wire.close() };
}
