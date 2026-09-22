import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { Signature } from "./types.ts";

/** Deterministic JSON: sorted keys, no whitespace. Everything Merx signs goes through this. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const b64url = (b: Buffer) => b.toString("base64url");
export const newId = (prefix: string) => `${prefix}_${randomBytes(9).toString("base64url")}`;

export type KeyPair = { privateKey: KeyObject; publicKey: KeyObject; keyId: string; publicKeyB64: string };

export function generateKeys(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

export function loadKeyPair(privatePem: string): KeyPair {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ type: "spki", format: "der" });
  return { privateKey, publicKey, publicKeyB64: der.toString("base64"), keyId: `ed25519:${sha256(der.toString("base64")).slice(0, 16)}` };
}

export function publicKeyFromB64(b64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
}

export function signObject(obj: unknown, kp: KeyPair): Signature {
  const value = sign(null, Buffer.from(canonicalize(obj)), kp.privateKey).toString("base64");
  return { alg: "Ed25519", key_id: kp.keyId, value };
}

export function verifyObject(obj: unknown, signatureB64: string, publicKey: KeyObject): boolean {
  try {
    return verify(null, Buffer.from(canonicalize(obj)), publicKey, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** Compact signed token: base64url(canonical payload) + "." + base64url(signature). */
export function issueToken(payload: Record<string, unknown>, kp: KeyPair): string {
  const body = Buffer.from(canonicalize(payload));
  return `${b64url(body)}.${b64url(sign(null, body, kp.privateKey))}`;
}

export function readToken<T>(token: string, publicKey: KeyObject): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const raw = Buffer.from(body, "base64url");
  try {
    if (!verify(null, raw, publicKey, Buffer.from(sig, "base64url"))) return null;
    return JSON.parse(raw.toString()) as T;
  } catch {
    return null;
  }
}
