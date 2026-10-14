# foxsync

[![npm version](https://img.shields.io/npm/v/foxsync)](https://www.npmjs.com/package/foxsync)
[![Downloads/month](https://img.shields.io/npm/dm/foxsync)](https://www.npmjs.com/package/foxsync)
[![License: MIT](https://img.shields.io/npm/l/foxsync)](https://github.com/pooriaarab/foxsync/blob/main/LICENSE)
[![Zero runtime dependencies](https://img.shields.io/badge/runtime_dependencies-0-blue)](https://www.npmjs.com/package/foxsync)

[Setup](#send-your-first-approval) · [API reference](#runtime-surfaces) · [Comparisons](#compare) · [Phone page](https://foxsync-phone.hello-fd1.workers.dev)

foxsync is an open-source browser pairing and encrypted messaging library for Firefox agents and second-screen approval flows.
It connects two browser pages through a WebRTC data channel.
It adds authenticated encryption, stored device pairs, and signed reconnects.

## Install

```bash
npm install foxsync
```

The package declares Node.js 24 or later. Bundle imports for a browser page with WebRTC, Web Crypto, and IndexedDB.
TypeScript declarations are included. There are zero runtime dependencies.

## Send your first approval

Use the shipped demo for a complete browser flow. No API keys or environment variables are required.

```bash
git clone https://github.com/pooriaarab/foxsync.git
cd foxsync
pnpm install --frozen-lockfile
pnpm build:ext
```

1. In Firefox, open `about:debugging`, then load `dist-ext/manifest.json` as a temporary add-on.
2. Open foxsync in the sidebar. Keep the sidebar open throughout pairing.
3. Open the [phone page](https://foxsync-phone.hello-fd1.workers.dev) in another Firefox browser on the same network.
4. Leave the relay field empty. Start pairing in the sidebar.
5. Copy the offer and code to the phone page. Press Pair.
6. Copy the phone's answer to the sidebar. Press Connect.
7. Send the sample approval request. Press Approve on the phone page.

Success shows `approve (authenticated)` in the sidebar.
The default connection uses host candidates only. Network rules can prevent a connection even on shared Wi-Fi.

For application code, bundle these imports into your own browser pages:

```js
import { askApproval, pairDesktop } from "foxsync";

const pairing = await pairDesktop({ name: "My laptop" });
console.log(pairing.code, pairing.offer); // copy both to the phone
const link = await pairing.waitForPhone(prompt("Paste the phone answer"));
console.log(await askApproval(link, { title: "Send the email?" }));
```

```js
import { onApprovalRequest, pairPhone } from "foxsync";

const pairing = await pairPhone({
  code: prompt("Desktop code"),
  offer: prompt("Desktop offer"),
});
console.log(pairing.answer); // copy to the desktop
const link = await pairing.waitForDesktop();
onApprovalRequest(link, request => confirm(request.title) ? "approve" : "deny");
```

## How it works

```text
Desktop page <-- WebRTC data channel + AES-GCM frames --> Phone page
     |                                                      |
 IndexedDB                                              IndexedDB
     |                                                      |
     +--- sealed offers / answers: copy-paste or relay ------+
```

Pairing uses a 100-bit one-time code with a ten-minute default lifetime.
Session keys combine the code, fresh elliptic-curve key exchange, and the offer/answer transcript.
Reconnects use stored pair keys and identity signatures.

## Why it exists

Browser agents need a way to ask a person on another device before they act.
foxsync supplies pairing and approval messages for that flow.
PeerJS and simple-peer provide general WebRTC connections; foxsync adds its device-pair and approval protocol.

## Compare

Checked on 2026-10-14 against [PeerJS's guide](https://peerjs.com/client/getting-started)
and [simple-peer's README](https://github.com/feross/simple-peer).

| Scope | foxsync | PeerJS | simple-peer |
|---|---|---|---|
| Main surface | Pairing, reconnects, approval messages | Peer data, audio, video connections | WebRTC data, voice, video channels |
| Connection setup | Sealed offer/answer text or optional relay | Peer IDs and signaling server | Application transfers signal data |
| Configuration | Pair options and browserWire | Peer configuration | Peer constructor options |

## Coverage

| Integration or surface | Status | Scope |
|---|---|---|
| Mozilla Firefox | ✓ | Extension sidebar and browser pairing demo |
| WebRTC / Web Crypto | ✓ | Data channel and application encryption |
| IndexedDB | ✓ | Default pair-record storage |
| Cloudflare Workers | ✓ | Optional relay and static phone-page host |
| Apple Safari / Google Chrome | — | No browser verification claimed |
| foxmate / foxgate | scaffold | Planned consumers; no runtime adapters exported |

Source inspection confirms four implemented surfaces and two planned consumers.
Local tests exercise protocol behavior. This rewrite does not claim real-phone or cross-network verification.
There is one built-in wire factory and two pair-store implementations. There is no provider registry.

## Common use cases

1. Firefox agent builders: ask for phone approval before a browser action.
2. WebRTC application authors: exchange typed messages between two paired browser pages.
3. QA teams: pause a browser workflow for an approve-or-deny response.
4. Extension authors: keep a paired connection in a Firefox sidebar.
5. Cloudflare users: deploy a relay for sealed signaling text.

## Features

- **Device pairing:** share a code and sealed offer with [the setup flow](#send-your-first-approval).
- **Authenticated messages:** send typed payloads through [Link](#runtime-surfaces).
- **Reconnects:** authenticate stored pairs with [reconnect and acceptReconnect](#runtime-surfaces).
- **Approvals:** use [askApproval and onApprovalRequest](#runtime-surfaces).
- **Pair storage:** choose [IndexedDB or MemoryStore](#runtime-surfaces).

## Runtime surfaces

foxsync is a library. It has no CLI and no MCP server.

| Export | What it does |
|---|---|
| `pairDesktop(options?)` | Starts pairing. Returns `{ id, code, offer, qr, expiresAt, waitForPhone(answer?), cancel() }`. `qr` is `null` when the text is longer than `qrMax` (default 1800). |
| `pairPhone(qrText \| { code, offer }, options?)` | Answers a pairing. Returns `{ id, answer, relayed, waitForDesktop(), cancel() }`. |
| `reconnect(pairId, options?)` | Starts a new session with a paired device. Returns `{ id, offer, relayed, waitForAnswer(answer?), cancel() }`. |
| `acceptReconnect(offerText \| { pairId }, options?)` | Answers a reconnect offer. With `{ pairId }`, it takes the offer from the relay. Returns `{ id, answer, relayed, waitForLink(), cancel() }`. |
| `link.send(type, payload)` | Encrypts and sends one message. Types that start with `fsy:` are reserved. The limit is 64 KiB. |
| `link.on(type, fn)` | Calls `fn(payload)` for each message of this type. Returns a function that removes it. |
| `link.close()` | Closes the link. `link.closed` resolves with `null`, or with the `FoxsyncError` that closed it. |
| `listPairs(options?)` | Lists paired devices: `{ id, role, name, peerName, alg, createdAt }`. No key material. |
| `unpair(id, options?)` | Deletes a pair record and its keys. Returns `false` for an unknown id. |
| `askApproval(link, { title, detail? }, { timeoutMs? })` | Asks the other end. Resolves with `"approve"` or `"deny"`. |
| `onApprovalRequest(link, handler)` | Answers requests. The handler returns the decision, or a promise of it. |
| `browserWire(rtcConfig?)` | The WebRTC connection that pairing uses by default. Give ICE servers here to add STUN or TURN. |
| `MemoryStore`, `IdbStore` | Pair stores. The default is `IdbStore` (IndexedDB database `foxsync`). |
| `FoxsyncError` | Every error. Read `error.code`, for example `bad-mac`, `replay`, `timeout`, `used`, `expired`, `unknown-pair`. |

Options for the pairing and reconnect functions:

| Option | Default | What it does |
|---|---|---|
| `name` | `"Desktop"` or `"Phone"` | The name that the other end shows. |
| `store` | `IdbStore` | Where pair records go. |
| `wire` | `browserWire()` | How to make the peer connection. |
| `phoneUrl` | none | `pairDesktop` only. The QR text becomes `<phoneUrl>#<pairing text>`, so a phone camera app opens the phone page. |
| `relay` | none | The relay URL. `pairDesktop` puts it in the sealed offer, and both ends store it for reconnects. |
| `ttlMs` | 600000 | `pairDesktop` only. How long the code works. |
| `handshakeMs` | 30000 | How long to wait for the channel and the hello messages. |
| `link` | `{}` | `heartbeatMs` (5000), `timeoutMs` (15000), `maxBytes` (65536). |


`newIdentity`, `supportsEd25519`, `formatCode`, `parseCode`, and the `Link` class are also public exports.
## Delivery/behavior limits

- **No server means the same network, or manual text.** With no ICE servers, WebRTC uses host candidates only. Both ends must reach each other directly, for example on one Wi-Fi network.
- **No STUN or TURN.** foxsync does not provide them. Across networks, give STUN servers to `browserWire`. Through a strict NAT, you need a TURN server.
- **The link lives in one page.** When the page closes, the link closes. Call `reconnect` to start a new one.
- **The phone page has no camera scanner.** A phone camera app opens the QR code only when `phoneUrl` points to a hosted phone page. Without it, paste the QR text. The desktop cannot scan a QR code from the phone either.
- **The add-on and the phone page reconnect by copy and paste only.** Reconnect through the relay works in the API, but the pages have no button for it.
- **Tested in Firefox only.** The E2E runs two Firefox 157 instances on one Mac, with the phone page at a phone-sized viewport. Safari, Chrome and real phones are not tested.
- **Reconnects from two pages at once.** Each page keeps the updates of a pair record in order. Two pages of one origin that reconnect the same pair at the same moment do not.
- **One link per pair at a time.** There is no fan-out to many phones in one call.
- **The relay limits each address to 600 requests a minute.** Above that, it answers 429.

## Integration guides

### Firefox sidebar and phone page

Build the extension with `pnpm build:ext`. Build the static phone page with `pnpm build:phone`.
Use a dedicated origin for the phone page. Same-origin scripts can use its stored keys.
The sidebar must stay open; a popup closes when it loses focus.
The phone page has no camera scanner. Paste the code and offer, or use a camera app with `phoneUrl`.

### Optional Cloudflare relay

A [public relay](https://foxsync-relay.hello-fd1.workers.dev/v1/AAAAAAAAAAAAAAAAAAAAAA/a) accepts sealed signaling text.
An empty box returns 404. Deploy your own Worker with `npx wrangler deploy` from `relay/`.
Set `relay` in `pairDesktop` options, or enter its URL in the demo's relay field.
The relay retains each text for ten minutes and accepts at most 16 KiB per text.
It sees box IDs, IP addresses, timing, and text sizes. It can drop, delay, or replace sealed text.
Messages travel through WebRTC. A signaling relay does not provide TURN connectivity.

### Custom WebRTC configuration

Provide `wire: browserWire({ iceServers: [...] })` with your own server configuration.
STUN means Session Traversal Utilities for NAT. TURN means Traversal Using Relays around NAT.
NAT means network address translation. Strict network rules can require a TURN server.

## Status

Version 0.1.4 is an early release. APIs and pairing formats can change before 1.0.
[Report issues on GitHub](https://github.com/pooriaarab/foxsync/issues).
Public case studies are not yet published in this repository.

## FAQ

### What is foxsync?

foxsync pairs two browser pages and exchanges encrypted messages over WebRTC.
It includes approval requests and signed reconnects.

### Which integrations are verified?

foxsync implements Firefox demos, WebRTC/Web Crypto transport, IndexedDB storage, and Cloudflare Worker deployment code.
This rewrite checks source and local tests; it does not verify Safari, Chrome, or physical phones.

### Does foxsync provide a managed TURN service?

foxsync does not provide STUN or TURN servers.
Supply your own ICE server configuration when the network requires it.

### How is foxsync different from PeerJS?

foxsync uses sealed offer/answer text for device pairing and includes an approval protocol.
PeerJS provides peer data, audio, and video connections using peer IDs and a signaling server.

### How is foxsync different from simple-peer?

foxsync stores paired-device records and signs reconnect messages.
simple-peer exposes WebRTC connections and signal events for application code to exchange.

### Does foxsync need a server?

foxsync can pair through manual text exchange without a signaling server.
Its default WebRTC configuration requires direct reachability between the two ends.

### Does foxsync approve an action automatically?

foxsync returns the remote handler's approve-or-deny response.
Your application must enforce that decision before it acts.

### Does foxsync keep a link when the page closes?

foxsync's connection ends when its page closes.
Use stored pair records and reconnect to start a new session.

### Can the relay read approval messages?

foxsync sends approval messages through the encrypted WebRTC link.
The optional relay receives sealed signaling text and connection metadata.

## Testing

`pnpm ci:local` runs lint, typecheck, tests, builds, extension lint, and listing checks.
`pnpm e2e` exercises pairing, approvals, tamper rejection, reconnects, unpairing, and a local relay in Firefox.

## License

[MIT](https://github.com/pooriaarab/foxsync/blob/main/LICENSE)
