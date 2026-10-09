# Failure modes

This file lists every way foxsync can fail. Each row names the test that
proves the wanted behaviour. The rows and the tests come before the code in
the Git history.

foxsync links a desktop Firefox and a phone. The two ends pair once. Then
they talk over a WebRTC data channel. Each message is encrypted again in
the app layer, on top of DTLS, with keys from the pairing.

## Link (encrypted messages on an open channel)

A frame is `version | seq | AES-GCM ciphertext`. The channel is reliable
and ordered, so a correct peer never skips, repeats or reorders a sequence
number. Any such frame means an attack or a bug, so the link closes.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| L1 | An app sends a type that starts with `fsy:` and spoofs a system message | `send` rejects with `bad-input`; nothing goes on the wire | `tests/link.test.ts` L1 |
| L2 | An attacker replays a frame that it saw before | The receiver closes the link with `replay`; the handler runs once | `tests/link.test.ts` L2 |
| L3 | An attacker reorders two frames | The receiver closes the link with `reorder`; no handler runs for the out-of-order frame | `tests/link.test.ts` L3 |
| L4 | An attacker changes one byte of a frame | The receiver closes the link with `bad-mac`; no handler runs | `tests/link.test.ts` L4 |
| L5 | The two ends hold different keys (a wrong pairing or a MITM) | The first frame fails with `bad-mac` and the link closes | `tests/link.test.ts` L5 |
| L6 | An app sends a payload larger than the limit | `send` rejects with `too-large`; the link stays open | `tests/link.test.ts` L6 |
| L7 | The phone loses its network in the middle of a session, so frames stop with no close event | Heartbeats stop arriving; the link closes with `timeout` | `tests/link.test.ts` L7 |
| L8 | The other end closes the channel (for example, the desktop page unloads) | The link closes with `peer-closed`; a later `send` rejects with `closed` | `tests/link.test.ts` L8 |
