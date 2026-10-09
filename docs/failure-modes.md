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

## Pairing

Pairing needs no server. The desktop shows a QR code with a one-time code
and a sealed offer. The phone sends back a sealed answer. After the
channel opens, both ends make per-pair identity keys and store a shared
pair key.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| P1 | (Normal path) a phone pairs and the two ends talk | Both ends get a Link and a pair record; messages go both ways | `tests/pair.test.ts` P1 |
| P2 | Someone replays the QR code after the pairing finished | The desktop rejects the second answer with `used` | `tests/pair.test.ts` P2 |
| P3 | Someone uses the QR code after it expired | The phone and the desktop reject it with `expired` | `tests/pair.test.ts` P3 |
| P4 | An attacker guesses the code and sends answers | Each answer fails with `bad-mac`; after 3 failures the pairing is cancelled and even the real answer gets `used` | `tests/pair.test.ts` P4 |
| P5 | A MITM on the copy and paste path swaps or changes the offer or the answer (the SDP) | The other end rejects it with `bad-mac`, so the MITM cannot read or inject | `tests/pair.test.ts` P5 |
| P6 | Two phones scan one QR code at the same time | The first answer wins; the second gets `used`. Two separate pairings at once both work | `tests/pair.test.ts` P6 |
| P7 | The offer is too large for a QR code | `qr` is `null`; the phone pairs with the typed code plus the pasted offer | `tests/pair.test.ts` P7 |

## Reconnect

After pairing, either end can start a new session with the stored keys. A
reconnect offer or answer is sealed with the pair key and signed with the
sender's identity key. Its time must be newer than the last one accepted.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| R1 | The desktop page unloads (for example, the event page or the sidebar closes), so the link drops | The phone link closes with `peer-closed`; a reconnect with the stored keys gives a new working link | `tests/reconnect.test.ts` R1 |
| R2 | Someone replays an old reconnect offer | The receiver rejects it with `replay` | `tests/reconnect.test.ts` R2 |
| R3 | One end unpaired, and the other end tries to reconnect | The unpaired end rejects the offer with `unknown-pair` | `tests/reconnect.test.ts` R3 |
| R4 | An attacker sends a reconnect offer signed with another key, or reflects a device's own offer back to it | The receiver rejects it with `bad-signature` | `tests/reconnect.test.ts` R4 |
| R5 | A reconnect offer carries a time far from now (a held-back offer, or a wrong clock) | The receiver rejects it with `stale` | `tests/reconnect.test.ts` R5 |
