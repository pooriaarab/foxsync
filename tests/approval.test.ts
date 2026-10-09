import { afterEach, describe, expect, it } from "vitest";
import { askApproval, onApprovalRequest } from "../src/approval.js";
import { Link } from "../src/link.js";
import { pairDesktop, pairPhone } from "../src/pair.js";
import { MemoryStore } from "../src/store.js";
import { aesKey, memoryWire, sleep, transportPair } from "./helpers.js";

const open: Link[] = [];
afterEach(() => {
  for (const link of open.splice(0)) link.close();
});

async function pair() {
  const [ta, tb] = transportPair();
  const [ab, ba] = [await aesKey(), await aesKey()];
  const desk = new Link(ta, { send: ab, recv: ba }, { pairId: "t" });
  const phone = new Link(tb, { send: ba, recv: ab }, { pairId: "t" });
  open.push(desk, phone);
  return { desk, phone };
}

describe("approvals", () => {
  it("A1 resolves with the phone's decision", async () => {
    const { desk, phone } = await pair();
    const seen: string[] = [];
    onApprovalRequest(phone, (req) => {
      seen.push(req.title);
      return req.title === "Buy" ? "deny" : "approve";
    });
    expect(await askApproval(desk, { title: "Send email", detail: "to Sam" })).toBe("approve");
    expect(await askApproval(desk, { title: "Buy" })).toBe("deny");
    expect(seen).toEqual(["Send email", "Buy"]);
  });

  it("A2 rejects when the link closes first", async () => {
    const { desk, phone } = await pair();
    const asked = askApproval(desk, { title: "Send email" });
    phone.close();
    await expect(asked).rejects.toMatchObject({ code: "peer-closed" });
  });

  it("A3 rejects with timeout, and a late answer does nothing", async () => {
    const { desk, phone } = await pair();
    let answer!: (d: "approve") => void;
    onApprovalRequest(phone, () => new Promise((done) => (answer = done)));
    await expect(askApproval(desk, { title: "Send email" }, { timeoutMs: 50 })).rejects.toMatchObject({ code: "timeout" });
    answer("approve");
    await sleep(20);
    expect(desk.isOpen).toBe(true);
  });

  it("A4 ignores an answer with an unknown id or a bad decision", async () => {
    const { desk, phone } = await pair();
    let id = "";
    phone.on("approval.request", (req) => (id = (req as { id: string }).id));
    const asked = askApproval(desk, { title: "Send email" }, { timeoutMs: 300 });
    await sleep(20);
    await phone.send("approval.answer", { id: "other", decision: "approve" });
    await phone.send("approval.answer", { id, decision: "yes" });
    await expect(asked).rejects.toMatchObject({ code: "timeout" });
  });

  it("A5 sends each answer to its own request", async () => {
    const { desk, phone } = await pair();
    onApprovalRequest(phone, async (req) => {
      await sleep(req.title === "slow" ? 60 : 0);
      return req.title === "slow" ? "approve" : "deny";
    });
    expect(await Promise.all([askApproval(desk, { title: "slow" }), askApproval(desk, { title: "fast" })])).toEqual(["approve", "deny"]);
  });
});

describe("wire", () => {
  it("W1 fails with timeout when the channel never opens", async () => {
    const wire = memoryWire();
    const never = { ...wire, answer: async () => ({ sdp: "x", open: new Promise<never>(() => {}), accept: async () => {}, close() {} }) };
    const d = await pairDesktop({ wire, store: new MemoryStore(), handshakeMs: 100 });
    const p = await pairPhone(d.qr!, { wire: never, store: new MemoryStore(), handshakeMs: 100 });
    await expect(p.waitForDesktop()).rejects.toMatchObject({ code: "timeout" });
  });

  it("W5 rejects an SDP that is not valid", async () => {
    const { browserWire } = await import("../src/rtc.js");
    const RTC = class {
      async setRemoteDescription() {
        throw new Error("SyntaxError: bad SDP");
      }
      addEventListener() {}
      close() {}
    };
    (globalThis as Record<string, unknown>).RTCPeerConnection = RTC;
    try {
      await expect(browserWire().answer("v=0 junk")).rejects.toMatchObject({ code: "bad-input" });
    } finally {
      delete (globalThis as Record<string, unknown>).RTCPeerConnection;
    }
  });
});
