// Web Crypto helpers. Every key that does not have to leave the browser is
// made non-extractable, so script cannot read its bytes.
import { FoxsyncError } from "./errors.js";
import { utf8, type Bytes } from "./encoding.js";

const subtle = () => globalThis.crypto.subtle;

export type IdentityAlg = "Ed25519" | "ECDSA-P256";
const GEN: Record<IdentityAlg, EcKeyGenParams | Algorithm> = {
  Ed25519: { name: "Ed25519" },
  "ECDSA-P256": { name: "ECDSA", namedCurve: "P-256" },
};
const SIGN: Record<IdentityAlg, Algorithm | EcdsaParams> = {
  Ed25519: { name: "Ed25519" },
  "ECDSA-P256": { name: "ECDSA", hash: "SHA-256" },
};

let ed25519: Promise<boolean> | undefined;
/** True when this browser can make Ed25519 keys (Firefox 129+). */
export function supportsEd25519(): Promise<boolean> {
  return (ed25519 ??= subtle()
    .generateKey(GEN.Ed25519, false, ["sign", "verify"])
    .then(() => true)
    .catch(() => false));
}

export interface Identity {
  alg: IdentityAlg;
  keys: CryptoKeyPair;
  /** The raw public key. */
  pub: Bytes;
}

/** A new signing key pair. Ed25519 when the browser has it, else ECDSA P-256. */
export async function newIdentity(alg?: IdentityAlg): Promise<Identity> {
  const chosen = alg ?? ((await supportsEd25519()) ? "Ed25519" : "ECDSA-P256");
  if (chosen === "Ed25519" && !(await supportsEd25519())) throw new FoxsyncError("unsupported", "this browser has no Ed25519");
  const keys = (await subtle().generateKey(GEN[chosen], false, ["sign", "verify"])) as CryptoKeyPair;
  return { alg: chosen, keys, pub: new Uint8Array(await subtle().exportKey("raw", keys.publicKey)) };
}

export async function sign(alg: IdentityAlg, key: CryptoKey, data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().sign(SIGN[alg], key, data));
}

export async function verify(alg: IdentityAlg, pub: Bytes, sig: Bytes, data: Bytes): Promise<boolean> {
  try {
    const key = await subtle().importKey("raw", pub, GEN[alg], false, ["verify"]);
    return await subtle().verify(SIGN[alg], key, sig, data);
  } catch {
    return false;
  }
}

/** An HKDF root key from secret bytes. Not extractable. */
export function rootKey(material: Bytes): Promise<CryptoKey> {
  return subtle().importKey("raw", material, "HKDF", false, ["deriveBits", "deriveKey"]);
}

const hkdf = (salt: Bytes, info: string): HkdfParams => ({ name: "HKDF", hash: "SHA-256", salt, info: utf8(info) });

export async function deriveBytes(root: CryptoKey, salt: Bytes, info: string, length = 32): Promise<Bytes> {
  return new Uint8Array(await subtle().deriveBits(hkdf(salt, info), root, length * 8));
}

/** An AES-256-GCM key from the root. Not extractable. */
export function deriveAes(root: CryptoKey, salt: Bytes, info: string): Promise<CryptoKey> {
  return subtle().deriveKey(hkdf(salt, info), root, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export interface Ephemeral {
  key: CryptoKey;
  pub: Bytes;
}

/** A one-use ECDH P-256 key pair, for forward secrecy of each session. */
export async function newEphemeral(): Promise<Ephemeral> {
  const pair = (await subtle().generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
  return { key: pair.privateKey, pub: new Uint8Array(await subtle().exportKey("raw", pair.publicKey)) };
}

export async function ecdh(own: CryptoKey, peerPub: Bytes): Promise<Bytes> {
  try {
    const peer = await subtle().importKey("raw", peerPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: peer }, own, 256));
  } catch {
    throw new FoxsyncError("bad-input", "the peer's key exchange value is not a P-256 point");
  }
}

export async function sha256(data: Bytes): Promise<Bytes> {
  return new Uint8Array(await subtle().digest("SHA-256", data));
}
