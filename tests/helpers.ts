// Test doubles: an in-memory transport pair. A tap sees each frame on its
// way out, and can pass, drop, change, or repeat it.
import type { Transport } from "../src/link.js";
import type { Wire, WireFactory } from "../src/pair.js";

export type Tap = (frame: Uint8Array, deliver: (frame: Uint8Array) => void) => void;
export interface TestTransport extends Transport {
  tap: Tap;
  closed: boolean;
  onFrame: ((frame: Uint8Array) => void) | null;
  onClose: (() => void) | null;
}

export function transportPair(): [TestTransport, TestTransport] {
  const ends: TestTransport[] = [];
  const queues: Uint8Array[][] = [[], []];
  const make = (index: number): TestTransport => ({
    onFrame: null,
    onClose: null,
    closed: false,
    listen(onFrame, onClose) {
      this.onFrame = onFrame;
      this.onClose = onClose;
      for (const frame of queues[index]!.splice(0)) onFrame?.(frame);
    },
    tap: (frame, deliver) => deliver(frame),
    send(frame: Uint8Array) {
      if (this.closed) throw new Error("transport closed");
      const peer = ends[1 - index]!;
      this.tap(frame.slice(), (out) =>
        queueMicrotask(() => {
          if (peer.closed) return;
          if (peer.onFrame) peer.onFrame(out);
          else queues[1 - index]!.push(out);
        }),
      );
    },
    close() {
      if (this.closed) return;
      this.closed = true;
      const peer = ends[1 - index]!;
      peer.closed = true;
      queueMicrotask(() => peer.onClose?.());
    },
  });
  ends.push(make(0), make(1));
  return [ends[0]!, ends[1]!];
}

export async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function pending() {
  let open!: (t: Transport) => void;
  const promise = new Promise<Transport>((done) => (open = done));
  return { open, promise };
}

/**
 * A fake WebRTC: one factory stands for the network between the two ends.
 * The "SDP" is a token. accept() on the offer side opens both channels.
 */
export function memoryWire(): WireFactory & { ends: TestTransport[] } {
  const answers = new Map<string, { offer: string; open: (t: Transport) => void }>();
  const ends: TestTransport[] = [];
  let n = 0;
  return {
    ends,
    async offer(): Promise<Wire> {
      const sdp = `offer-${++n}`;
      const p = pending();
      return {
        sdp,
        open: p.promise,
        close() {},
        async accept(answerSdp: string) {
          const answer = answers.get(answerSdp);
          if (answer?.offer !== sdp) throw new Error("this answer is not for this offer");
          const [a, b] = transportPair();
          ends.push(a, b);
          p.open(a);
          answer.open(b);
        },
      };
    },
    async answer(offerSdp: string): Promise<Wire> {
      const sdp = `answer-${++n}`;
      const p = pending();
      answers.set(sdp, { offer: offerSdp, open: p.open });
      return { sdp, open: p.promise, close() {}, async accept() {} };
    },
  };
}
