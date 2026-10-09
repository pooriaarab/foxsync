// The browser Wire: one RTCPeerConnection with one ordered data channel.
// With no ICE servers it uses host candidates only, so the two ends must
// reach each other directly (same network). Pass STUN or TURN servers in
// the config to go further. Signaling is not trickled: the SDP is sent once,
// after ICE gathering, inside the sealed text.
import { FoxsyncError } from "./errors.js";
import type { Transport } from "./link.js";
import type { Wire, WireFactory } from "./pair.js";

function gathered(pc: RTCPeerConnection, ms: number): Promise<void> {
  return new Promise((done) => {
    if (pc.iceGatheringState === "complete") return done();
    const timer = setTimeout(done, ms); // W2: use the candidates we have
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      done();
    });
  });
}

/** Wrap an open data channel. Frames that arrive before listen() wait in a queue (W3). */
function transportFor(pc: RTCPeerConnection, dc: RTCDataChannel): Promise<Transport> {
  dc.binaryType = "arraybuffer";
  const queue: Uint8Array[] = [];
  let onFrame: ((frame: Uint8Array) => void) | null = null;
  let onClose: (() => void) | null = null;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    pc.close();
    onClose?.();
  };
  dc.addEventListener("message", (event: MessageEvent<ArrayBuffer>) => {
    const frame = new Uint8Array(event.data);
    if (onFrame) onFrame(frame);
    else queue.push(frame);
  });
  dc.addEventListener("close", end);
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") end();
  });
  const transport: Transport = {
    send: (frame) => dc.send(frame as Uint8Array<ArrayBuffer>),
    close() {
      ended = true;
      dc.close();
      pc.close();
    },
    listen(frameFn, closeFn) {
      onFrame = frameFn;
      onClose = closeFn;
      for (const frame of queue.splice(0)) frameFn?.(frame);
      if (ended) closeFn?.();
    },
  };
  return new Promise((resolve) => {
    if (dc.readyState === "open") resolve(transport);
    else dc.addEventListener("open", () => resolve(transport), { once: true });
  });
}

async function setRemote(pc: RTCPeerConnection, type: "offer" | "answer", sdp: string): Promise<void> {
  try {
    await pc.setRemoteDescription({ type, sdp });
  } catch (error) {
    pc.close();
    throw new FoxsyncError("bad-input", `the ${type} SDP is not valid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The WebRTC Wire for browsers. Default config: no ICE servers. */
export function browserWire(config: RTCConfiguration = { iceServers: [] }, gatherMs = 5000): WireFactory {
  return {
    async offer(): Promise<Wire> {
      const pc = new RTCPeerConnection(config);
      const dc = pc.createDataChannel("foxsync", { ordered: true });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc, gatherMs);
      return {
        sdp: pc.localDescription!.sdp,
        accept: (sdp) => setRemote(pc, "answer", sdp),
        open: transportFor(pc, dc),
        close: () => pc.close(),
      };
    },
    async answer(offerSdp: string): Promise<Wire> {
      const pc = new RTCPeerConnection(config);
      const channel = new Promise<RTCDataChannel>((resolve) =>
        pc.addEventListener("datachannel", (event) => resolve(event.channel), { once: true }),
      );
      await setRemote(pc, "offer", offerSdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc, gatherMs);
      return {
        sdp: pc.localDescription!.sdp,
        accept: async () => {},
        open: channel.then((dc) => transportFor(pc, dc)),
        close: () => pc.close(),
      };
    },
  };
}
