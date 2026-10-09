# What the foxsync add-on sends, and its AMO data declaration

The manifest declares `data_collection_permissions: { "required": ["none"] }`.
This page lists everything that the add-on in `extension/` sends out of the
browser, and why no AMO data type applies to it today.

## The rule we apply

AMO's add-on policies, section 6, define data transmission:

> For the purposes of this policy, data transmission refers to any data that
> is collected, used, transferred, shared, or handled outside of the add-on or
> the local browser.

The page "Firefox built-in consent for data collection and transmission"
(https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/)
gives the data types that the manifest key declares, and says:

> You specify the data types your extension transmits in the
> `browser_specific_settings.gecko.data_collection_permissions` key in the
> `manifest.json` file.

> If your extension doesn't collect or transmit any data, you indicate that by
> specifying the `none` required permission in the manifest.

So the question for each item below is: is it one of the data types in that
taxonomy (personal data such as website content, website activity,
personal communications, or technical and interaction data)?

## What leaves the browser

| What | To whom | When | AMO data type |
|---|---|---|---|
| The sample approval request: the fixed title "Sample approval" and the text "Sent at" plus the local time | The device that the user paired | Only when the user presses "Send a sample approval request" | None. The add-on writes this text. It holds nothing that the user typed and nothing from a web page. |
| Pairing messages: public keys, a random pair id, the fixed device name "Firefox desktop", and the WebRTC session data (SDP, with the ICE candidates that WebRTC makes) | The paired device, and the relay as sealed text if the user typed a relay URL | Only when the user presses Pair or Reconnect | None. These are protocol values that the add-on makes for the link. They describe no user, no web page and no use of Firefox. |
| The IP address of this computer | The paired device and the relay | As part of any network connection | None. Every network request shows it; the taxonomy does not list it. |

Nothing goes to the authors. The add-on has no analytics, no error reports
and no server. The relay is a server that the user runs and types in.

## Decision

The add-on transfers data outside the browser, but none of that data is in
an AMO data type, so `"none"` is the true declaration. The listing and the
privacy policy still say what leaves the browser and when.

## When this changes

foxmate and other apps send real approvals over foxsync: the agent's planned
action and the form fields that it sends. Those are `websiteActivity` and
`websiteContent`. If this add-on starts to send such data (failure mode DC1),
the same change must declare those types and ask Firefox's consent before the
first send.
