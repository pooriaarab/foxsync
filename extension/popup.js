// The demo page: pair a phone, list paired devices, send a test approval
// request and show the phone's answer. It runs as the popup, the sidebar,
// or a tab. The link lives in this page: when the page closes, the link
// drops, and "Reconnect" starts a new one with the stored keys.
import { encode } from "uqr";
import { askApproval, listPairs, pairDesktop, reconnect, unpair } from "../src/index.ts";

const $ = (id) => document.getElementById(id);
const say = (text) => ($("status").textContent = text);
const fail = (error) => say(`error: ${error?.message ?? error}`);
let pending = null;
let reconnecting = null;
let link = null;

function drawQr(text) {
  const canvas = $("qr");
  canvas.hidden = !text;
  if (!text) return;
  const { data, size } = encode(text, { ecc: "L", border: 2 });
  const cell = Math.max(2, Math.floor(360 / size));
  canvas.width = canvas.height = size * cell;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  data.forEach((row, y) => row.forEach((dark, x) => dark && ctx.fillRect(x * cell, y * cell, cell, cell)));
}

function useLink(next, peerName) {
  link?.close();
  link = next;
  $("state").textContent = `linked to ${peerName}`;
  $("ask").disabled = false;
  void next.closed.then((reason) => {
    if (link !== next) return;
    $("state").textContent = `closed: ${reason ? reason.code : "by this page"}`;
    $("ask").disabled = true;
  });
}

async function showPairs() {
  const list = $("pairs");
  list.replaceChildren();
  const pairs = await listPairs();
  if (!pairs.length) list.append(Object.assign(document.createElement("li"), { textContent: "No paired devices." }));
  for (const pair of pairs) {
    const li = document.createElement("li");
    li.dataset.id = pair.id;
    li.append(`${pair.peerName} (${pair.alg}) `);
    const again = Object.assign(document.createElement("button"), { type: "button", textContent: "Reconnect" });
    again.addEventListener("click", () => startReconnect(pair).catch(fail));
    const forget = Object.assign(document.createElement("button"), { type: "button", textContent: "Unpair" });
    forget.addEventListener("click", () => unpair(pair.id).then(showPairs).then(() => say(`unpaired ${pair.peerName}`), fail));
    li.append(again, forget);
    list.append(li);
  }
}

async function startReconnect(pair) {
  reconnecting?.cancel();
  reconnecting = await reconnect(pair.id);
  reconnecting.peerName = pair.peerName;
  $("ro-offer").value = reconnecting.offer;
  $("ro-answer").value = "";
  $("reconnecting").hidden = false;
  say(`copy the reconnect offer to ${pair.peerName}`);
}

for (const [id, key] of [["phone-url", "phoneUrl"], ["relay", "relay"]]) {
  $(id).value = localStorage.getItem(key) ?? "";
  $(id).addEventListener("change", (e) => localStorage.setItem(key, e.target.value.trim()));
}

$("pair").addEventListener("click", async () => {
  try {
    pending?.cancel();
    const relay = $("relay").value.trim() || undefined;
    pending = await pairDesktop({ name: "Firefox desktop", phoneUrl: $("phone-url").value.trim() || undefined, relay });
    drawQr(pending.qr);
    $("code").textContent = pending.code;
    $("offer").value = pending.offer;
    $("answer").value = "";
    $("pairing").hidden = false;
    say(pending.qr ? "scan the QR code, or copy the offer and type the code" : "the offer is too long for a QR code: copy it and type the code");
    if (relay) void finishPairing(pending.waitForPhone());
  } catch (error) {
    fail(error);
  }
});

$("connect").addEventListener("click", () => finishPairing(pending.waitForPhone($("answer").value)));

async function finishPairing(linking) {
  try {
    say("connecting");
    const next = await linking;
    const pair = (await listPairs()).find((p) => p.id === next.pairId);
    useLink(next, pair?.peerName ?? "phone");
    $("pairing").hidden = true;
    say("paired");
    await showPairs();
  } catch (error) {
    fail(error);
  }
}

$("ro-connect").addEventListener("click", async () => {
  try {
    say("connecting");
    useLink(await reconnecting.waitForAnswer($("ro-answer").value), reconnecting.peerName);
    $("reconnecting").hidden = true;
    say("reconnected");
  } catch (error) {
    fail(error);
  }
});

$("ask").addEventListener("click", async () => {
  $("decision").textContent = "waiting";
  try {
    const decision = await askApproval(link, { title: "Sample approval", detail: `Sent at ${new Date().toLocaleTimeString()}` });
    $("decision").textContent = `${decision} (authenticated)`;
  } catch (error) {
    $("decision").textContent = `rejected: ${error?.code ?? error}`;
  }
});

void showPairs().catch(fail);
