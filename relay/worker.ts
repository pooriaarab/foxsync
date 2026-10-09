// The optional foxsync relay as a Cloudflare Worker. One Durable Object per
// box keeps its texts, and an alarm deletes them after 10 minutes.
// Deploy from this folder: npx wrangler deploy
import { TTL_MS, boxOf, handle, type Stored } from "./handler.js";

interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  deleteAll(): Promise<void>;
  setAlarm(time: number): Promise<void>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
}
interface Env {
  BOXES: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
}

export class Box {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const storage = this.state.storage;
    const response = await handle(
      request,
      {
        get: (key) => storage.get<Stored>(key),
        put: (key, value) => storage.put(key, value),
        delete: (key) => storage.delete(key).then(() => {}),
      },
      Date.now(),
    );
    if (request.method === "PUT" && response.status === 204) await storage.setAlarm(Date.now() + TTL_MS);
    return response;
  }

  async alarm(): Promise<void> {
    await this.state.storage.deleteAll();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const box = boxOf(request);
    if (!box) return handle(request, { get: async () => undefined, put: async () => {}, delete: async () => {} }, Date.now());
    return env.BOXES.get(env.BOXES.idFromName(box)).fetch(request);
  },
};
