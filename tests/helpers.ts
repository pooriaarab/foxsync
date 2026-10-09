// Test doubles: an in-memory transport pair. A tap sees each frame on its
// way out, and can pass, drop, change, or repeat it.
import type { Transport } from "../src/link.js";

export type Tap = (frame: Uint8Array, deliver: (frame: Uint8Array) => void) => void;
export interface TestTransport extends Transport {
  tap: Tap;
  closed: boolean;
  onFrame: ((frame: Uint8Array) => void) | null;
  onClose: (() => void) | null;
}

export function transportPair(): [TestTransport, TestTransport] {
  const ends: TestTransport[] = [];
  const make = (index: number): TestTransport => ({
    onFrame: null,
    onClose: null,
    closed: false,
    listen(onFrame, onClose) {
      this.onFrame = onFrame;
      this.onClose = onClose;
    },
    tap: (frame, deliver) => deliver(frame),
    send(frame: Uint8Array) {
      if (this.closed) throw new Error("transport closed");
      const peer = ends[1 - index]!;
      this.tap(frame.slice(), (out) =>
        queueMicrotask(() => {
          if (!peer.closed) peer.onFrame?.(out);
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
