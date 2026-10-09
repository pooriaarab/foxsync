// A Link is an open, paired channel. Every message is encrypted with
// AES-256-GCM on top of the channel's own DTLS, with one key per direction.
//
// Frame: [version 1 byte][seq 8 bytes, big-endian][ciphertext + tag].
// The first 9 bytes are the AES-GCM additional data. The nonce is 4 zero
// bytes plus seq, so a key never sees the same nonce twice. The channel is
// reliable and ordered, so a correct peer always sends seq = last + 1. Any
// other seq, or a tag that fails, closes the link (docs/failure-modes.md L2-L5).
import { FoxsyncError } from "./errors.js";

/** One end of a reliable, ordered byte channel, such as an RTCDataChannel. */
export interface Transport {
  send(frame: Uint8Array): void;
  close(): void;
  /** Set the receivers for frames and for a close by the other end. Null stops them. */
  listen(onFrame: ((frame: Uint8Array) => void) | null, onClose: (() => void) | null): void;
}

export interface LinkKeys {
  send: CryptoKey;
  recv: CryptoKey;
}

export interface LinkOptions {
  /** Send a heartbeat when nothing was sent for this long. Default 5000 ms. */
  heartbeatMs?: number;
  /** Close with `timeout` when nothing arrived for this long. Default 15000 ms. */
  timeoutMs?: number;
  /** The largest encoded message, in bytes. Default 65536. */
  maxBytes?: number;
}

const VERSION = 1;
const HEADER = 9;
const TAG = 16;
const SYSTEM = "fsy:";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Internal: send a system message such as `fsy:hello`. Not exported from the package. */
export const sendSystem = (link: Link, type: string, payload: unknown) => link[SEND](type, payload);
const SEND = Symbol("send");

export class Link {
  readonly pairId: string;
  /** Resolves when the link closes: `null` for a local close(), else the reason. */
  readonly closed: Promise<FoxsyncError | null>;
  private readonly transport: Transport;
  private readonly keys: LinkKeys;
  private readonly maxBytes: number;
  private readonly handlers = new Map<string, Set<(payload: unknown) => void>>();
  private sendSeq = 0n;
  private recvSeq = 0n;
  private tx: Promise<void> = Promise.resolve();
  private rx: Promise<void> = Promise.resolve();
  private lastSent = Date.now();
  private lastRecv = Date.now();
  private timer: ReturnType<typeof setInterval>;
  private finish!: (reason: FoxsyncError | null) => void;
  private reason: FoxsyncError | null | undefined;

  constructor(transport: Transport, keys: LinkKeys, options: LinkOptions & { pairId: string }) {
    this.pairId = options.pairId;
    this.transport = transport;
    this.keys = keys;
    this.maxBytes = options.maxBytes ?? 65536;
    this.closed = new Promise((done) => (this.finish = done));
    const heartbeatMs = options.heartbeatMs ?? 5000;
    const timeoutMs = options.timeoutMs ?? 15000;
    transport.listen(
      (frame) => {
        this.lastRecv = Date.now();
        const copy = new Uint8Array(frame);
        this.rx = this.rx.then(() => this.receive(copy));
      },
      () => this.shut(new FoxsyncError("peer-closed", "the other end closed the channel")),
    );
    this.timer = setInterval(() => {
      const now = Date.now();
      if (now - this.lastRecv > timeoutMs) this.shut(new FoxsyncError("timeout", `nothing arrived for ${timeoutMs} ms`));
      else if (now - this.lastSent >= heartbeatMs) this[SEND]("fsy:ping", null).catch(() => {});
    }, Math.max(10, Math.min(heartbeatMs, timeoutMs) / 2));
  }

  get isOpen(): boolean {
    return this.reason === undefined;
  }

  /** Encrypt and send one message. Types that start with `fsy:` are reserved. */
  send(type: string, payload?: unknown): Promise<void> {
    if (typeof type !== "string" || !type || type.startsWith(SYSTEM)) {
      return Promise.reject(new FoxsyncError("bad-input", `the type must be a non-empty string that does not start with "${SYSTEM}"`));
    }
    return this[SEND](type, payload);
  }

  /** Call fn for each message of this type. Returns a function that removes it. */
  on(type: string, fn: (payload: unknown) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  close(): void {
    this.shut(null);
  }

  [SEND](type: string, payload: unknown): Promise<void> {
    if (this.reason !== undefined) return Promise.reject(new FoxsyncError("closed", "the link is closed"));
    const plain = encoder.encode(JSON.stringify({ t: type, p: payload ?? null }));
    if (plain.length > this.maxBytes) {
      return Promise.reject(new FoxsyncError("too-large", `the message is ${plain.length} bytes; the limit is ${this.maxBytes}`));
    }
    const seq = this.sendSeq++;
    this.lastSent = Date.now();
    const sent = this.tx.then(async () => {
      const header = headerFor(seq);
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonceFor(seq), additionalData: header }, this.keys.send, plain),
      );
      if (this.reason !== undefined) throw new FoxsyncError("closed", "the link closed before the message was sent");
      const frame = new Uint8Array(HEADER + sealed.length);
      frame.set(header);
      frame.set(sealed, HEADER);
      this.transport.send(frame);
    });
    this.tx = sent.catch(() => {});
    return sent;
  }

  private async receive(frame: Uint8Array<ArrayBuffer>): Promise<void> {
    if (this.reason !== undefined) return;
    if (frame.length < HEADER + TAG || frame.length > this.maxBytes + HEADER + TAG || frame[0] !== VERSION) {
      return this.shut(new FoxsyncError(frame.length > this.maxBytes ? "too-large" : "bad-input", "a frame has the wrong size or version"));
    }
    const seq = new DataView(frame.buffer, frame.byteOffset + 1, 8).getBigUint64(0);
    if (seq < this.recvSeq) return this.shut(new FoxsyncError("replay", `frame ${seq} arrived again`));
    if (seq > this.recvSeq) return this.shut(new FoxsyncError("reorder", `frame ${seq} arrived before frame ${this.recvSeq}`));
    let message: { t: unknown; p: unknown };
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonceFor(seq), additionalData: frame.subarray(0, HEADER) },
        this.keys.recv,
        frame.subarray(HEADER),
      );
      message = JSON.parse(decoder.decode(plain));
    } catch {
      return this.shut(new FoxsyncError("bad-mac", `frame ${seq} failed authentication`));
    }
    if (this.reason !== undefined) return;
    this.recvSeq = seq + 1n;
    if (typeof message?.t !== "string") return this.shut(new FoxsyncError("bad-input", "a message has no type"));
    for (const fn of this.handlers.get(message.t) ?? []) fn(message.p);
  }

  private shut(reason: FoxsyncError | null): void {
    if (this.reason !== undefined) return;
    this.reason = reason;
    clearInterval(this.timer);
    this.transport.listen(null, null);
    try {
      this.transport.close();
    } catch {
      // The transport is already closed.
    }
    this.finish(reason);
  }
}

function headerFor(seq: bigint): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(HEADER);
  header[0] = VERSION;
  new DataView(header.buffer).setBigUint64(1, seq);
  return header;
}

function nonceFor(seq: bigint): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, seq);
  return nonce;
}

/** Internal: wait for the next system message of this type, or fail. */
export function nextMessage(link: Link, type: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const off = link.on(type, (payload) => {
      clearTimeout(timer);
      off();
      resolve(payload);
    });
    const timer = setTimeout(() => {
      off();
      reject(new FoxsyncError("timeout", `no ${type} within ${timeoutMs} ms`));
    }, timeoutMs);
    void link.closed.then((reason) => {
      clearTimeout(timer);
      off();
      reject(reason ?? new FoxsyncError("closed", "the link is closed"));
    });
  });
}
