// The E2E test: two real Firefox instances on this machine. The "desktop"
// runs the demo extension page; the "phone" runs dist-phone/ from file://
// at a phone-sized viewport. They pair by copy and paste, then talk over a
// real WebRTC data channel. Writes artifacts/e2e-<date>.json.
//
// Usage: pnpm e2e [--headed] [--shots <dir>]
//   --shots <dir>  open the desktop page over http instead (WebDriver BiDi
//                  cannot screenshot moz-extension: pages) and save PNGs.
// Env: FIREFOX (the Firefox binary).
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launch, poll, serve, writeArtifact } from "create-foxkit/e2e";

const args = process.argv.slice(2);
const shots = args.includes("--shots") ? resolve(args[args.indexOf("--shots") + 1]) : null;
const headless = !args.includes("--headed");
const record = { startedAt: new Date().toISOString(), desktop: shots ? "http page" : "moz-extension page", phone: "file:// page", checks: [] };
const check = (name, expected, actual) => record.checks.push({ name, expected, actual, ok: actual === expected });
const shot = async (page, name) => shots && (mkdirSync(shots, { recursive: true }), page.screenshot({ path: `${shots}/${name}.png`, fullPage: true }));

// Clicks and inputs go through evaluate: BiDi input actions do not reach moz-extension pages.
const click = (page, selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
const fill = (page, id, value) => page.evaluate((a) => (document.getElementById(a[0]).value = a[1]), [id, value]);
const read = (page, id) => page.evaluate((i) => document.getElementById(i).value ?? document.getElementById(i).textContent, id);
const text = (page, id, prefix) => poll(page, (a) => { const t = document.getElementById(a[0]).textContent; return t.startsWith(a[1]) && t; }, [id, prefix]);
const phoneHas = (page, selector) => poll(page, (s) => document.querySelectorAll(s).length, selector);

let desk;
let phone;
let site;
try {
  desk = await launch({ extension: "dist-ext", headless });
  phone = await launch({ extension: "dist-ext", headless });
  record.firefox = await desk.browser.version();
  const openDesk = async () => {
    if (!shots) return desk.openExtensionPage("popup.html");
    site ??= await serve("dist-ext");
    const page = await desk.open(`${site.url}/popup.html`);
    await page.setViewport({ width: 420, height: 600 });
    return page;
  };
  let D = await openDesk();
  const P = await phone.browser.newPage();
  await P.setViewport({ width: 390, height: 844 });
  await P.goto(pathToFileURL(resolve("dist-phone/index.html")).href, { waitUntil: "load" });

  // E1: pair by copy and paste, then one approval round trip.
  await click(D, "#pair");
  const code = await poll(D, () => document.getElementById("code").textContent);
  await fill(P, "pair-input", await read(D, "offer"));
  await fill(P, "code", code);
  await click(P, "#pair");
  const answer = await poll(P, () => document.getElementById("answer").value);
  await fill(D, "answer", answer);
  await shot(D, "desktop-pairing");
  await click(D, "#connect");
  check("E1 desktop is linked", "linked to Phone", await text(D, "state", "linked"));
  check("E1 phone is linked", "linked to Firefox desktop", await text(P, "state", "linked"));
  check("E1 desktop lists the phone", true, (await poll(D, () => document.querySelector("#pairs li[data-id]")?.textContent)).startsWith("Phone (Ed25519)"));
  check("E1 phone lists the desktop", true, (await poll(P, () => document.querySelector("#devices li:not(.empty)")?.textContent)).startsWith("Firefox desktop (Ed25519)"));
  await click(D, "#ask");
  await phoneHas(P, "li.request button.approve");
  await shot(P, "phone-request");
  await click(P, "li.request button.approve");
  check("E1 approval arrives authenticated", "approve (authenticated)", await text(D, "decision", "approve"));
  await shot(D, "desktop-approved");

  // E2: flip one byte of the phone's next answer frame on the wire.
  await P.evaluate(() => {
    const send = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      if (window.tamper && data.byteLength > 60) {
        window.tamper = false;
        data[data.length - 1] ^= 1;
      }
      return send.call(this, data);
    };
    window.tamper = true;
  });
  await click(D, "#ask");
  await phoneHas(P, "li.request:first-child button.approve");
  await click(P, "li.request:first-child button.approve");
  check("E2 tampered answer is rejected", "rejected: bad-mac", await text(D, "decision", "rejected"));
  check("E2 desktop closes the link", "closed: bad-mac", await text(D, "state", "closed"));
  check("E2 phone sees the close", "closed: peer-closed", await text(P, "state", "closed"));
  await P.evaluate(() => (window.tamper = false));

  // E4 first needs a link to drop, so: reconnect, then E3 (close the page), then E5.
  const reconnectFlow = async (page) => {
    await click(page, "#pairs li[data-id] button");
    await fill(P, "ro-input", await poll(page, () => document.getElementById("ro-offer").value));
    await fill(P, "answer", "");
    await click(P, "#ro-accept");
  };
  await reconnectFlow(D);
  await fill(D, "ro-answer", await poll(P, () => document.getElementById("answer").value));
  await click(D, "#ro-connect");
  check("E4 reconnect links again", "linked to Phone", await text(D, "state", "linked"));
  await click(D, "#ask");
  await phoneHas(P, "li.request:first-child button.deny");
  await click(P, "li.request:first-child button.deny");
  check("E4 deny arrives authenticated", "deny (authenticated)", await text(D, "decision", "deny"));
  await shot(P, "phone-after");

  await D.close();
  check("E3 phone sees the desktop page close", "closed: peer-closed", await text(P, "state", "closed"));

  D = await openDesk();
  await poll(D, () => Boolean(document.querySelector("#pairs li[data-id]")));
  await click(P, "#devices li button");
  await phoneHas(P, "#devices li.empty");
  await reconnectFlow(D);
  check("E5 phone rejects a reconnect after forget", true, (await text(P, "status", "error")).includes("unknown-pair"));
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
} finally {
  await desk?.close();
  await phone?.close();
  await site?.close();
}
record.passed = !record.error && record.checks.length === 12 && record.checks.every((c) => c.ok);
const path = shots ? "(not written in --shots mode)" : writeArtifact("artifacts", "e2e", record);
for (const c of record.checks) console.log(`${c.ok ? "ok " : "BAD"} ${c.name}: ${c.actual}`);
console.log(`${record.passed ? "PASS" : "FAIL"}${record.error ? `: ${record.error}` : ""} | ${path}`);
process.exitCode = record.passed ? 0 : 1;
