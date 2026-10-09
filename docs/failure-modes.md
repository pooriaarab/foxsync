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

## Pairing text, keys and the pair store

Pairing and reconnect move text between the two ends: a QR code, a short
code, and sealed offer and answer blobs. A blob is AES-GCM sealed. Its
kind and pairing id are the additional data.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| B1 | An attacker guesses the pairing code | The code has 100 random bits (20 characters from a 32-character set), so a guess fails | `tests/blob.test.ts` B1 |
| B2 | A person types the code with dashes, spaces, or lower case, or makes a typo | Dashes, spaces and case are ignored; a wrong character or length gives `bad-input` | `tests/blob.test.ts` B2 |
| B3 | Someone changes one byte of a sealed blob in transit | `open` fails with `bad-mac` | `tests/blob.test.ts` B3 |
| B4 | Someone moves a sealed blob to another pairing id or kind | `open` fails with `bad-mac`, because the id and kind are authenticated | `tests/blob.test.ts` B4 |
| B5 | The input is not foxsync text, is cut short, or has bad base64 | `parseText` fails with `bad-input` | `tests/blob.test.ts` B5 |
| B6 | The input text is very large | `parseText` fails with `too-large` before it decodes anything | `tests/blob.test.ts` B6 |
| S1 | The user unpairs a device | `unpair` deletes the record and its keys; `listPairs` no longer shows it; an unknown id gives `false` | `tests/store.test.ts` S1 |
| S2 | UI code reads key material through `listPairs` | `listPairs` returns only the id, names, role, algorithm and dates | `tests/store.test.ts` S2 |
| S3 | Script in the page tries to export an identity private key | `exportKey` rejects, because the key is not extractable | `tests/store.test.ts` S3 |
| S4 | The browser has no Ed25519 | `newIdentity` uses ECDSA P-256, and sign and verify still work | `tests/store.test.ts` S4 |
| S5 | A signature from another key, or over other data, is checked | `verify` returns `false` | `tests/store.test.ts` S5 |
