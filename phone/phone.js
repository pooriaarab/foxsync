// The phone page: pair from the QR text (or the code plus the offer), show
// messages from the desktop, and answer approval requests. It is a static
// page: it works from any static host or from file://. Keys stay in this
// browser's IndexedDB.
import { acceptReconnect, listPairs, onApprovalRequest, pairPhone, unpair } from "../src/index.ts";

const $ = (id) => document.getElementById(id);
const say = (text) => ($("status").textContent = text);
const fail = (error) => say(`error: ${error?.message ?? error}`);
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
let link = null;

function post(item) {
  $("feed").querySelector(".empty")?.remove();
  $("feed").prepend(item);
}

function useLink(next, peerName) {
  link?.close();
  link = next;
  $("state").textContent = `linked to ${peerName}`;
  $("answer-box").hidden = true;
  next.on("note", (note) => post(el("li", {}, el("div", { className: "title", textContent: String(note?.text ?? "") }))));
  onApprovalRequest(next, (request) => new Promise((decide) => {
    const result = el("div", { className: "result" });
    const buttons = ["approve", "deny"].map((decision) => {
      const button = el("button", { type: "button", className: decision, textContent: decision === "approve" ? "Approve" : "Deny" });
      button.dataset.decision = decision;
      button.addEventListener("click", () => {
        for (const b of buttons) b.remove();
        result.textContent = decision === "approve" ? "Approved" : "Denied";
        decide(decision);
      });
      return button;
    });
    post(el("li", { className: "request" }, el("div", { className: "title", textContent: request.title }), el("div", { className: "detail", textContent: request.detail ?? "" }), ...buttons, result));
  }));
  void next.closed.then((reason) => {
    if (link === next) $("state").textContent = `closed: ${reason ? reason.code : "by this page"}`;
  });
}

async function showDevices() {
  const list = $("devices");
  list.replaceChildren();
  const pairs = await listPairs();
  if (!pairs.length) list.append(el("li", { className: "empty", textContent: "No paired devices." }));
  for (const pair of pairs) {
    const forget = el("button", { type: "button", textContent: "Forget" });
    forget.addEventListener("click", () => unpair(pair.id).then(showDevices).then(() => say(`forgot ${pair.peerName}`), fail));
    list.append(el("li", { textContent: `${pair.peerName} (${pair.alg}) ` }, forget));
  }
}

function showAnswer(answer, relayed) {
  $("answer").value = answer;
  $("answer-box").hidden = false;
  say(relayed ? "the answer went to the relay; wait for the desktop" : "copy the answer to the desktop, then wait");
}

async function startPairing() {
  try {
    const text = $("pair-input").value.trim();
    const code = $("code").value.trim();
    const pairing = await pairPhone(code ? { code, offer: text } : text, { name: "Phone" });
    showAnswer(pairing.answer, pairing.relayed);
    const next = await pairing.waitForDesktop();
    const pair = (await listPairs()).find((p) => p.id === next.pairId);
    useLink(next, pair?.peerName ?? "desktop");
    $("pair-input").value = $("code").value = "";
    say("paired");
    await showDevices();
  } catch (error) {
    fail(error);
  }
}

$("pair").addEventListener("click", startPairing);
$("copy").addEventListener("click", () => navigator.clipboard.writeText($("answer").value).then(() => say("answer copied"), fail));
$("ro-accept").addEventListener("click", async () => {
  try {
    const answering = await acceptReconnect($("ro-input").value);
    showAnswer(answering.answer, answering.relayed);
    const pair = (await listPairs()).find((p) => p.id === answering.id);
    useLink(await answering.waitForLink(), pair?.peerName ?? "desktop");
    $("ro-input").value = "";
    say("reconnected");
  } catch (error) {
    fail(error);
  }
});

void showDevices().catch(fail);
// A QR code can hold this page's URL with the pairing text in the fragment.
// The fragment never goes to the web server.
if (location.hash.includes("fsy1.q.")) {
  $("pair-input").value = decodeURIComponent(location.hash.slice(1));
  history.replaceState(null, "", location.pathname);
  void startPairing();
}
