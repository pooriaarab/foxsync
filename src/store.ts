// Pair records: one per paired device, on each end. The default store is
// IndexedDB, which keeps CryptoKey objects without exposing their bytes.
import type { IdentityAlg } from "./crypto.js";
import type { Bytes } from "./encoding.js";

export interface PairRecord {
  id: string;
  role: "desktop" | "phone";
  /** This device's name, as the peer sees it. */
  name: string;
  peerName: string;
  alg: IdentityAlg;
  /** This device's identity keys for this pair. The private key is not extractable. */
  keys: CryptoKeyPair;
  /** The peer's raw public identity key. */
  peerPub: Bytes;
  /** The HKDF root shared by the two ends. Not extractable. */
  pairKey: CryptoKey;
  /** The time in the newest reconnect message accepted from the peer. */
  lastPeerTs: number;
  /** The time in the newest reconnect message this device sent. */
  lastOwnTs: number;
  createdAt: number;
}

export interface Store {
  get(id: string): Promise<PairRecord | undefined>;
  put(record: PairRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(): Promise<PairRecord[]>;
}

export class MemoryStore implements Store {
  private readonly records = new Map<string, PairRecord>();
  async get(id: string) {
    return this.records.get(id);
  }
  async put(record: PairRecord) {
    this.records.set(record.id, record);
  }
  async delete(id: string) {
    this.records.delete(id);
  }
  async list() {
    return [...this.records.values()];
  }
}

export class IdbStore implements Store {
  private db: Promise<IDBDatabase> | undefined;
  constructor(private readonly name = "foxsync") {}

  private run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.addEventListener("upgradeneeded", () => req.result.createObjectStore("pairs", { keyPath: "id" }));
      req.addEventListener("success", () => resolve(req.result));
      req.addEventListener("error", () => reject(req.error));
    });
    return this.db.then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const req = fn(db.transaction("pairs", mode).objectStore("pairs"));
          req.addEventListener("success", () => resolve(req.result as T));
          req.addEventListener("error", () => reject(req.error));
        }),
    );
  }
  get(id: string) {
    return this.run<PairRecord | undefined>("readonly", (s) => s.get(id));
  }
  put(record: PairRecord) {
    return this.run<void>("readwrite", (s) => s.put(record)).then(() => {});
  }
  delete(id: string) {
    return this.run<void>("readwrite", (s) => s.delete(id)).then(() => {});
  }
  list() {
    return this.run<PairRecord[]>("readonly", (s) => s.getAll());
  }
}

let shared: Store | undefined;
/** The store used when no store option is given: IndexedDB database "foxsync". */
export const defaultStore = (): Store => (shared ??= new IdbStore());

export interface PairInfo {
  id: string;
  role: "desktop" | "phone";
  name: string;
  peerName: string;
  alg: IdentityAlg;
  createdAt: number;
}

export async function listPairs(options: { store?: Store } = {}): Promise<PairInfo[]> {
  const records = await (options.store ?? defaultStore()).list();
  return records.map(({ id, role, name, peerName, alg, createdAt }) => ({ id, role, name, peerName, alg, createdAt }));
}

/** Forget a paired device and its keys. Returns false when the id is unknown. */
export async function unpair(id: string, options: { store?: Store } = {}): Promise<boolean> {
  const store = options.store ?? defaultStore();
  if (!(await store.get(id))) return false;
  await store.delete(id);
  return true;
}
