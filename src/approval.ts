// Approval requests: the desktop asks, the phone answers. This is how an
// agent (foxmate with foxgate) can ask the user on the phone before it acts.
import { FoxsyncError } from "./errors.js";
import { randomId } from "./encoding.js";
import type { Link } from "./link.js";

export type Decision = "approve" | "deny";

export interface ApprovalRequest {
  id: string;
  title: string;
  detail?: string;
}

/** Ask the phone. Resolves with its decision. Rejects when the link closes or time runs out. */
export function askApproval(link: Link, request: { title: string; detail?: string }, options: { timeoutMs?: number } = {}): Promise<Decision> {
  const id = randomId();
  return new Promise((resolve, reject) => {
    const done = (fn: () => void) => {
      clearTimeout(timer);
      off();
      fn();
    };
    const off = link.on("approval.answer", (answer) => {
      const { id: answerId, decision } = (answer ?? {}) as { id?: unknown; decision?: unknown };
      if (answerId !== id || (decision !== "approve" && decision !== "deny")) return; // A4
      done(() => resolve(decision));
    });
    const ms = options.timeoutMs ?? 5 * 60_000;
    const timer = setTimeout(() => done(() => reject(new FoxsyncError("timeout", `no answer within ${ms} ms`))), ms);
    void link.closed.then((reason) => done(() => reject(reason ?? new FoxsyncError("closed", "the link is closed"))));
    link.send("approval.request", { id, title: request.title, detail: request.detail }).catch((error: unknown) => done(() => reject(error)));
  });
}

/** Answer approval requests on this end. The handler returns the decision. */
export function onApprovalRequest(link: Link, handler: (request: ApprovalRequest) => Decision | Promise<Decision>): () => void {
  return link.on("approval.request", (raw) => {
    const { id, title, detail } = (raw ?? {}) as Partial<ApprovalRequest>;
    if (typeof id !== "string" || typeof title !== "string") return;
    void Promise.resolve(handler({ id, title, ...(typeof detail === "string" ? { detail } : {}) }))
      .then((decision) => link.send("approval.answer", { id, decision }))
      .catch(() => {});
  });
}
