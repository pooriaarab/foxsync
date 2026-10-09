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
| R6 | An end accepts a reconnect offer while its own reconnect waits for ICE gathering, and the late write puts back the old record | The newest accepted time stays; a replay of the accepted offer still fails with `replay` | `tests/reconnect.test.ts` R6 |
| R7 | The same reconnect offer arrives twice at the same moment | One is accepted; the other fails with `replay` | `tests/reconnect.test.ts` R7 |

## WebRTC wire and approvals

`browserWire` is the real Wire: one `RTCPeerConnection` with one ordered
data channel. With no ICE servers, it uses host candidates only. The
approval helpers send `approval.request` and wait for `approval.answer`.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| W1 | The data channel never opens (the ends are on different networks, or a strict NAT blocks them) | The wait fails with `timeout` after `handshakeMs`; it does not hang | `tests/approval.test.ts` W1 |
| W2 | ICE gathering never completes | The offer uses the candidates it has after 5 seconds | Firefox E2E (`pnpm e2e`) |
| W3 | A frame arrives before the Link listens (the phone sends its hello first) | The transport keeps the frame and gives it to the Link | Firefox E2E (`pnpm e2e`) |
| W4 | The peer page closes, so the data channel closes | The Link closes with `peer-closed` | Firefox E2E (`pnpm e2e`) |
| W5 | The pasted SDP is not valid | The answer side fails with `bad-input` | `tests/approval.test.ts` W5 |
| A1 | (Normal path) the desktop asks and the phone approves or denies | `askApproval` resolves with `approve` or `deny` | `tests/approval.test.ts` A1 |
| A2 | The link closes before the phone answers | `askApproval` rejects with the close reason | `tests/approval.test.ts` A2 |
| A3 | The phone does not answer in time | `askApproval` rejects with `timeout`; a late answer does nothing | `tests/approval.test.ts` A3 |
| A4 | An answer has an unknown id or a decision that is not `approve` or `deny` | It is ignored; no request resolves | `tests/approval.test.ts` A4 |
| A5 | Two requests wait at the same time | Each answer goes to its own request | `tests/approval.test.ts` A5 |

## End to end: two real Firefox instances

`pnpm e2e` starts two Firefox instances with separate profiles. The
"desktop" runs the demo extension page. The "phone" runs the phone page
from `file://` at a phone-sized viewport. They pair by copy and paste and
talk over a real WebRTC data channel on this machine.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| E1 | (Normal path) pair by copy and paste, send an approval request, approve on the phone | The desktop shows `approve (authenticated)`; both ends list the other device | `pnpm e2e` E1 |
| E2 | A byte of the phone's answer frame changes on the wire | The desktop rejects it (`bad-mac`) and closes the link; the request is not approved | `pnpm e2e` E2 |
| E3 | The desktop page closes (like an event page or sidebar that unloads) | The phone shows `closed: peer-closed` | `pnpm e2e` E3 |
| E4 | The user reconnects after E3 by copy and paste | A new link works; a deny arrives as `deny (authenticated)` | `pnpm e2e` E4 |
| E5 | The phone forgot the desktop, and the desktop tries to reconnect | The phone rejects the offer with `unknown-pair` | `pnpm e2e` E5 |
| E6 | The phone page opens from `file://` with no web server | Pairing, IndexedDB keys and WebRTC work | `pnpm e2e` (all checks use `file://`) |
| E7 | An attacker sends a link to the phone page with the attacker's pairing text in the fragment | The page does not pair by itself. It shows the code and waits; Cancel pairs nothing, and only Pair makes an answer | `pnpm e2e` E7 |
| E8 | The CI runner cannot resolve the mDNS names that Firefox puts in host candidates, so the channel never opens | The E2E sets `media.peerconnection.ice.obfuscate_host_addresses` to `false`, so candidates carry plain host addresses; real devices keep mDNS | `pnpm e2e` (both Firefox instances) |

## Optional relay

`relay/` is a small Cloudflare Worker. It keeps one sealed text per box
and slot for 10 minutes, so the phone does not have to copy its answer
back, and so a reconnect needs no copy and paste. The box id comes from
the pairing code or the pair key, so only the two ends know it.

| # | Failure mode | Wanted behaviour | Test |
|---|---|---|---|
| Y1 | Someone stores data that is not foxsync text, or a large body | The relay answers 400 or 413 and stores nothing | `tests/relay.test.ts` Y1 |
| Y2 | A request has a bad box id, slot or method | The relay answers 404 or 405 | `tests/relay.test.ts` Y2 |
| Y3 | A text stays in a box after 10 minutes | The relay answers 404 and deletes it | `tests/relay.test.ts` Y3 |
| Y4 | The relay, or anyone who knows the box id, puts a forged answer in the box | The desktop rejects it (`bad-mac`), keeps polling, and pairs when the real answer comes | `tests/relay.test.ts` Y4 |
| Y5 | The relay is down | The wait fails with `timeout`; it does not hang | `tests/relay.test.ts` Y5 |
| Y6 | (Normal path) pairing through the relay | The phone posts its answer; the desktop picks it up with no copy step | `tests/relay.test.ts` Y6 |
| Y7 | A reconnect through the relay finds an old offer in the box | The old offer fails as `replay` and is skipped; the new offer connects | `tests/relay.test.ts` Y7 |
| Y8 | (Normal path, real browsers) the demo pairs through a relay | The phone posts its answer; the desktop links with no pasted answer | `pnpm e2e` Y8 |

## Data collection declaration (`extension/manifest.json`)

| ID | Failure | Wanted result | How we check |
|---|---|---|---|
| DC1 | The add-on starts to send user data over the link or the relay, for example page text, the agent's planned action or form fields, while the manifest still declares `"none"` | The same change adds the matching AMO data types (`websiteContent`, `websiteActivity`) to `data_collection_permissions`, and asks Firefox's consent before the first send when they are optional | Review of each change to `extension/`; `docs/amo-data.md` lists what the add-on sends today |
| DC2 | The listing or the privacy policy says less than the add-on sends | `docs/amo-data.md`, the listing and the privacy policy name the same items | Review |

## AMO release build and listed submission (`scripts/amo-listing.mjs`)

`pnpm check:amo` reads `dist-ext/`, which is what `release.yml` signs. Each
row is a way that the listed build or the submission can go wrong.

| ID | Failure | Wanted result |
|---|---|---|
| AR1 | `dist-ext/` is missing, so the check reads nothing | The check stops and says to run `pnpm build:ext` |
| AR2 | A content script in the release manifest matches `127.0.0.1`, `localhost` or `*.localhost` (a test bridge) | The check stops and names the pattern |
| AR3 | A host permission for a local host exists only for tests | The check stops, unless `local_hosts` in the listing gives a reason for that exact pattern |
| AR4 | A file named for tests (`e2e`, `fixture`, `test`, `spec`) is in `dist-ext/` | The check stops and names the file |
| AR5 | `dist-ext/` came from `build-ext.mjs --e2e` | AR2 or AR4 stops it |
| AR6 | The `local_hosts` reasons go to AMO as an unknown field | `metadata` leaves them out, as it does the privacy policy |
| AR7 | A re-run submits a version that AMO already has as listed | `version-status` says `listed`, and the step skips web-ext sign and finishes the release |
| AR8 | AMO has the version as unlisted | `version-status` stops and says to bump the version |
| AR9 | The AMO version lookup fails (401, 500, network) | `version-status` stops; it never guesses `absent` |

| ID | Failure | Wanted result |
|---|---|---|
| AR-U1 | A `local_hosts` reason for a host permission also clears a test content script on the same pattern | Each reason names its use (`host_permission`, `content_script`, `web_accessible_resource`, `externally_connectable`); a use without its own reason stops the check |
| AR-U2 | `local_hosts` keeps a reason for a use that the release build does not have | The check stops and names the pattern and the use |
