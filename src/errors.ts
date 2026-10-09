// One error type for every failure, with a stable code that apps can test.
export type FoxsyncErrorCode =
  | "bad-input" // malformed text, frame, or argument
  | "bad-mac" // AES-GCM authentication failed: tampered data or wrong key
  | "bad-signature" // an identity signature did not verify
  | "replay" // a frame or offer that was seen before
  | "reorder" // a frame arrived out of order
  | "stale" // a reconnect offer with a time too far from now
  | "too-large" // over the size limit
  | "timeout" // the peer went silent, or a wait ran out
  | "expired" // the pairing code is past its expiry time
  | "used" // the pairing was already used or cancelled
  | "unknown-pair" // no pair record with this id
  | "unsupported" // this browser lacks an algorithm the peer chose
  | "peer-closed" // the other end closed the channel
  | "closed"; // this end is closed

export class FoxsyncError extends Error {
  readonly code: FoxsyncErrorCode;
  constructor(code: FoxsyncErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "FoxsyncError";
    this.code = code;
  }
}
